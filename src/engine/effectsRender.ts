/**
 * Pixel side of the effects engine. Effects run on a clip's own layer canvas
 * (in output pixels) in the order they are stacked. Consecutive colour effects
 * are merged into a single colour-matrix pass for speed.
 *
 * Everything is deterministic for a given frame (random effects are seeded by
 * frame number) so preview and export look the same.
 */
import { effectMatrix, isIdentity, multiply, IDENTITY, type ColorMatrix } from '../core/effects';
import type { EffectInstance } from '../core/types';
import { applyChroma, applyGrade, bakeLut, chromaUniforms, gradeUniforms, sampleLut, type Lut3D, type RGB } from '../core/grade';
import { getLut, gpuAvailable, gpuChroma, gpuLut3D, gpuMatrix } from './gpu';

/**
 * Context settings for layer canvases: GPU-backed when the GPU path is fast,
 * CPU-backed (cheap pixel reads) when colour work runs on the CPU.
 */
export function layerContextSettings(): CanvasRenderingContext2DSettings {
  return gpuAvailable() ? {} : { willReadFrequently: true };
}

/* ---------- Colour fusion: consecutive colour effects become one pass ---------- */

type ColourOp = { kind: 'matrix'; m: ColorMatrix } | { kind: 'grade'; fx: EffectInstance } | { kind: 'lut'; fx: EffectInstance };

const baked = new Map<string, Lut3D>();
function bakeOps(ops: ColourOp[], key: string): Lut3D | null {
  const hit = baked.get(key);
  if (hit) { baked.delete(key); baked.set(key, hit); return hit; }
  const steps: ((c: RGB) => RGB)[] = [];
  for (const op of ops) {
    if (op.kind === 'matrix') {
      const m = op.m;
      steps.push(([r, g, b]) => [
        clamp01(m[0] * r + m[1] * g + m[2] * b + m[4] / 255),
        clamp01(m[5] * r + m[6] * g + m[7] * b + m[9] / 255),
        clamp01(m[10] * r + m[11] * g + m[12] * b + m[14] / 255),
      ]);
    } else if (op.kind === 'grade') {
      const u = gradeUniforms(op.fx);
      steps.push((c) => applyGrade(c, u));
    } else {
      const lut = getLut(op.fx.data?.lutId as string | undefined);
      const k = (op.fx.params.intensity ?? 100) / 100;
      if (lut) steps.push((c) => { const o = sampleLut(lut, c[0], c[1], c[2]); return [c[0] + (o[0] - c[0]) * k, c[1] + (o[1] - c[1]) * k, c[2] + (o[2] - c[2]) * k]; });
    }
  }
  if (!steps.length) return null;
  const lut = bakeLut((c) => steps.reduce((acc, f) => f(acc), c), 33, 'stack');
  baked.set(key, lut);
  if (baked.size > 24) baked.delete(baked.keys().next().value!);
  return lut;
}
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function opsKey(ops: ColourOp[]): string {
  return ops.map((o) => (o.kind === 'matrix' ? `m${o.m.map((v) => v.toFixed(5)).join(',')}`
    : o.kind === 'grade' ? `g${JSON.stringify(o.fx.params)}${JSON.stringify(o.fx.data?.curves ?? null)}`
    : `l${o.fx.data?.lutId}:${o.fx.params.intensity ?? 100}`)).join('|');
}

/** Tetrahedral 3D-LUT interpolation over 8-bit pixels (fast CPU path). */
const lut255 = new WeakMap<Lut3D, Float32Array>();
export function applyLutCpu(ctx: Ctx, w: number, h: number, lut: Lut3D): void {
  const img = ctx.getImageData(0, 0, w, h);
  lutPixels(img.data, lut);
  ctx.putImageData(img, 0, 0);
}

/** In-place tetrahedral LUT on RGBA bytes (pure; unit-tested). */
export function lutPixels(d: Uint8ClampedArray, lut: Lut3D): void {
  let L = lut255.get(lut);
  if (!L) { L = new Float32Array(lut.data.length); for (let i = 0; i < L.length; i++) L[i] = lut.data[i] * 255; lut255.set(lut, L); }
  const S = lut.size, n = S - 1;
  const idx = new Int32Array(256), fr = new Float32Array(256);
  for (let v = 0; v < 256; v++) { const f = (v / 255) * n; const i0 = Math.min(n - 1, Math.floor(f)); idx[v] = i0; fr[v] = f - i0; }
  const sR = 3, sG = S * 3, sB = S * S * 3;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const fr_ = fr[r], fg = fr[g], fb = fr[b];
    const base = idx[r] * sR + idx[g] * sG + idx[b] * sB;
    // Pick the tetrahedron containing the point; blend its 4 corners.
    let o1: number, o2: number, w0: number, w1: number, w2: number, w3: number;
    if (fr_ > fg) {
      if (fg > fb) { o1 = sR; o2 = sR + sG; w0 = 1 - fr_; w1 = fr_ - fg; w2 = fg - fb; w3 = fb; }
      else if (fr_ > fb) { o1 = sR; o2 = sR + sB; w0 = 1 - fr_; w1 = fr_ - fb; w2 = fb - fg; w3 = fg; }
      else { o1 = sB; o2 = sR + sB; w0 = 1 - fb; w1 = fb - fr_; w2 = fr_ - fg; w3 = fg; }
    } else {
      if (fb > fg) { o1 = sB; o2 = sG + sB; w0 = 1 - fb; w1 = fb - fg; w2 = fg - fr_; w3 = fr_; }
      else if (fb > fr_) { o1 = sG; o2 = sG + sB; w0 = 1 - fg; w1 = fg - fb; w2 = fb - fr_; w3 = fr_; }
      else { o1 = sG; o2 = sR + sG; w0 = 1 - fg; w1 = fg - fr_; w2 = fr_ - fb; w3 = fb; }
    }
    const o3 = sR + sG + sB;
    const a = base, b1 = base + o1, c = base + o2, e = base + o3;
    d[i] = w0 * L[a] + w1 * L[b1] + w2 * L[c] + w3 * L[e];
    d[i + 1] = w0 * L[a + 1] + w1 * L[b1 + 1] + w2 * L[c + 1] + w3 * L[e + 1];
    d[i + 2] = w0 * L[a + 2] + w1 * L[b1 + 2] + w2 * L[c + 2] + w3 * L[e + 2];
  }
}

function runColourOps(layer: HTMLCanvasElement, ctx: Ctx, ops: ColourOp[]): void {
  if (!ops.length) return;
  const w = layer.width, h = layer.height;
  if (ops.every((o) => o.kind === 'matrix')) {
    let m: ColorMatrix = IDENTITY;
    for (const o of ops) m = multiply((o as { m: ColorMatrix }).m, m);
    if (!isIdentity(m) && !gpuMatrix(layer, m)) applyMatrix(ctx, w, h, m);
    return;
  }
  const key = opsKey(ops);
  const lut = bakeOps(ops, key);
  if (!lut) return;
  if (!gpuLut3D(layer, lut, key)) applyLutCpu(ctx, w, h, lut);
}

/** CPU fallback for GPU colour passes (slow but identical maths). */
function cpuPixels(ctx: Ctx, w: number, h: number, fn: (r: number, g: number, b: number, a: number) => [number, number, number, number]): void {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const [r, g, b, a] = fn(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255, d[i + 3] / 255);
    d[i] = r * 255; d[i + 1] = g * 255; d[i + 2] = b * 255; d[i + 3] = a * 255;
  }
  ctx.putImageData(img, 0, 0);
}

function chromaPass(layer: HTMLCanvasElement, ctx: Ctx, fx: EffectInstance): void {
  if (gpuChroma(layer, fx)) return;
  const u = chromaUniforms(fx);
  cpuPixels(ctx, layer.width, layer.height, (r, g, b, a) => applyChroma([r, g, b], a, u));
}

type Ctx = CanvasRenderingContext2D;

let filterSupport: boolean | null = null;
export function canvasFilterSupported(): boolean {
  if (filterSupport !== null) return filterSupport;
  try {
    const c = document.createElement('canvas').getContext('2d')!;
    c.filter = 'blur(2px)';
    filterSupport = c.filter === 'blur(2px)';
  } catch {
    filterSupport = false;
  }
  return filterSupport;
}

const scratch: HTMLCanvasElement[] = [];
function tmp(i: number, w: number, h: number): { c: HTMLCanvasElement; ctx: Ctx } {
  let c = scratch[i];
  if (!c) { c = document.createElement('canvas'); scratch[i] = c; }
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const ctx = c.getContext('2d', layerContextSettings())!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.clearRect(0, 0, w, h);
  return { c, ctx };
}

/** Mulberry32 PRNG for seeded randomness. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function applyMatrix(ctx: Ctx, w: number, h: number, m: ColorMatrix): void {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const [a0, a1, a2, , a4, b0, b1, b2, , b4, c0, c1, c2, , c4] = m;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const r = d[i], g = d[i + 1], b = d[i + 2];
    d[i] = a0 * r + a1 * g + a2 * b + a4;
    d[i + 1] = b0 * r + b1 * g + b2 * b + b4;
    d[i + 2] = c0 * r + c1 * g + c2 * b + c4;
  }
  ctx.putImageData(img, 0, 0);
}

export function blur(layer: HTMLCanvasElement, ctx: Ctx, radius: number): void {
  if (radius <= 0.2) return;
  const w = layer.width, h = layer.height;
  // Big blurs are done on a smaller copy and scaled back up: visually the same, many times cheaper.
  const k = Math.min(1, Math.max(0.125, 2.5 / radius));
  const sw = Math.max(1, Math.round(w * k)), sh = Math.max(1, Math.round(h * k));
  if (canvasFilterSupported()) {
    const t = tmp(0, sw, sh);
    t.ctx.imageSmoothingQuality = 'low';
    if (k < 1) {
      // Blur while shrinking (filter applies to the drawn source), then scale up smoothly.
      t.ctx.filter = `blur(${radius * k}px)`;
      t.ctx.drawImage(layer, 0, 0, sw, sh);
      t.ctx.filter = 'none';
      ctx.save();
      ctx.clearRect(0, 0, w, h);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'low'; // bilinear: plenty for upscaling an already-smooth image
      ctx.drawImage(t.c, 0, 0, w, h);
      ctx.restore();
      return;
    }
    t.ctx.drawImage(layer, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.filter = `blur(${radius}px)`;
    ctx.drawImage(t.c, 0, 0);
    ctx.restore();
    return;
  }
  // Fallback (older Safari): successive downscale + smooth upscale approximates a Gaussian.
  const factor = Math.max(1, radius / 2);
  const fw = Math.max(1, Math.round(w / factor)), fh = Math.max(1, Math.round(h / factor));
  const t = tmp(0, fw, fh);
  t.ctx.imageSmoothingQuality = 'high';
  t.ctx.drawImage(layer, 0, 0, fw, fh);
  ctx.clearRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(t.c, 0, 0, w, h);
}

function sharpen(ctx: Ctx, w: number, h: number, amount: number): void {
  const k = amount / 100;
  if (k <= 0) return;
  const src = ctx.getImageData(0, 0, w, h);
  const out = ctx.createImageData(w, h);
  const s = src.data, o = out.data;
  const row = w * 4;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * row + x * 4;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) {
        o[i] = s[i]; o[i + 1] = s[i + 1]; o[i + 2] = s[i + 2]; o[i + 3] = s[i + 3];
        continue;
      }
      for (let c = 0; c < 3; c++) {
        const v = s[i + c] * (1 + 4 * k) - k * (s[i - 4 + c] + s[i + 4 + c] + s[i - row + c] + s[i + row + c]);
        o[i + c] = v;
      }
      o[i + 3] = s[i + 3];
    }
  }
  ctx.putImageData(out, 0, 0);
}

function vignette(ctx: Ctx, w: number, h: number, amount: number, size: number): void {
  const r = Math.hypot(w, h) / 2;
  const g = ctx.createRadialGradient(w / 2, h / 2, r * (size / 100) * 0.7, w / 2, h / 2, r);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, `rgba(0,0,0,${Math.min(1, amount / 100)})`);
  ctx.save();
  ctx.globalCompositeOperation = 'source-atop';
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

let noiseTile: HTMLCanvasElement | null = null;
export function getNoise(): HTMLCanvasElement {
  if (noiseTile) return noiseTile;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(256, 256);
  const rand = rng(1234);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.floor(rand() * 255);
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  noiseTile = c;
  return c;
}

function grain(ctx: Ctx, w: number, h: number, amount: number, size: number, frame: number): void {
  const r = rng(frame * 7919 + 17);
  const tile = getNoise();
  ctx.save();
  ctx.globalCompositeOperation = 'source-atop';
  ctx.globalAlpha = Math.min(1, amount / 100) * 0.55;
  const pat = ctx.createPattern(tile, 'repeat')!;
  const m = new DOMMatrix().translate(Math.floor(r() * 256), Math.floor(r() * 256)).scale(size, size);
  pat.setTransform(m);
  ctx.fillStyle = pat;
  ctx.globalCompositeOperation = 'overlay';
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

function glow(layer: HTMLCanvasElement, ctx: Ctx, amount: number, radius: number): void {
  const w = layer.width, h = layer.height;
  const t = tmp(1, w, h);
  t.ctx.drawImage(layer, 0, 0);
  blur(t.c, t.ctx, radius);
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = Math.min(1, amount / 100);
  ctx.drawImage(t.c, 0, 0);
  ctx.restore();
}

function pixelate(layer: HTMLCanvasElement, ctx: Ctx, size: number): void {
  const w = layer.width, h = layer.height;
  const sw = Math.max(1, Math.round(w / size)), sh = Math.max(1, Math.round(h / size));
  const t = tmp(0, sw, sh);
  t.ctx.imageSmoothingEnabled = true;
  t.ctx.drawImage(layer, 0, 0, sw, sh);
  ctx.save();
  ctx.clearRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(t.c, 0, 0, w, h);
  ctx.restore();
}

/** Split into R/G/B copies, offset them and add back together. */
export function rgbSplit(layer: HTMLCanvasElement, ctx: Ctx, amount: number, angleDeg: number): void {
  if (amount <= 0) return;
  const w = layer.width, h = layer.height;
  const src = tmp(0, w, h);
  src.ctx.drawImage(layer, 0, 0);
  const a = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(a) * amount, dy = Math.sin(a) * amount;
  const channel = tmp(1, w, h);
  ctx.save();
  ctx.clearRect(0, 0, w, h);
  const parts: [string, number, number][] = [['#ff0000', -dx, -dy], ['#00ff00', 0, 0], ['#0000ff', dx, dy]];
  for (const [color, ox, oy] of parts) {
    channel.ctx.globalCompositeOperation = 'source-over';
    channel.ctx.clearRect(0, 0, w, h);
    channel.ctx.drawImage(src.c, 0, 0);
    channel.ctx.globalCompositeOperation = 'multiply';
    channel.ctx.fillStyle = color;
    channel.ctx.fillRect(0, 0, w, h);
    channel.ctx.globalCompositeOperation = 'destination-in';
    channel.ctx.drawImage(src.c, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(channel.c, ox, oy);
  }
  ctx.restore();
}

function glitch(layer: HTMLCanvasElement, ctx: Ctx, amount: number, speed: number, time: number): void {
  const w = layer.width, h = layer.height;
  const step = Math.floor(time * speed);
  const r = rng(step * 31337 + 7);
  const intensity = amount / 100;
  // Occasional quiet frames make the glitch feel organic.
  if (r() > 0.35 + intensity * 0.6) return;
  const src = tmp(1, w, h);
  src.ctx.drawImage(layer, 0, 0);
  const slices = 3 + Math.floor(r() * 8 * intensity);
  for (let i = 0; i < slices; i++) {
    const sy = Math.floor(r() * h);
    const sh = Math.max(2, Math.floor(r() * h * 0.08 * (0.5 + intensity)));
    const off = (r() - 0.5) * w * 0.12 * intensity;
    ctx.clearRect(0, sy, w, sh);
    ctx.drawImage(src.c, 0, sy, w, sh, off, sy, w, sh);
  }
  rgbSplit(layer, ctx, 2 + 10 * intensity * r(), r() * 360);
}

/** Motion effects adjust the transform instead of the pixels. */
export function motionOffsets(effects: EffectInstance[], local: number, canvasMin: number): { dx: number; dy: number; dScale: number; dRot: number } {
  let dx = 0, dy = 0, dScale = 1, dRot = 0;
  for (const fx of effects) {
    if (!fx.enabled) continue;
    if (fx.type === 'shake') {
      const amt = (fx.params.amount ?? 30) / 100;
      const sp = fx.params.speed ?? 10;
      const k = Math.floor(local * sp);
      const r1 = rng(k * 101), r2 = rng(k * 101 + 1);
      const f = local * sp - k;
      const lerp = (a: number, b: number) => a + (b - a) * (f * f * (3 - 2 * f));
      const n = rng((k + 1) * 101), n2 = rng((k + 1) * 101 + 1);
      dx += lerp(r1() - 0.5, n() - 0.5) * canvasMin * 0.06 * amt;
      dy += lerp(r2() - 0.5, n2() - 0.5) * canvasMin * 0.06 * amt;
      dRot += lerp(r1() - 0.5, n() - 0.5) * 3 * amt;
      dScale *= 1 + 0.05 * amt; // hide edges while shaking
    } else if (fx.type === 'pulse') {
      const beat = 60 / (fx.params.bpm ?? 120);
      const ph = (local % beat) / beat;
      dScale *= 1 + ((fx.params.amount ?? 8) / 100) * Math.pow(1 - ph, 3);
    }
  }
  return { dx, dy, dScale, dRot };
}

export function hasPixelEffects(effects: EffectInstance[]): boolean {
  // (bgRemove counts: the mask is applied on the clip's layer.)
  return effects.some((e) => e.enabled && e.type !== 'shake' && e.type !== 'pulse');
}

/**
 * Run the effect stack on a layer. `pxScale` converts project pixels to layer
 * pixels so radius-type params look the same in preview and export.
 */
export function applyEffects(layer: HTMLCanvasElement, effects: EffectInstance[], local: number, frame: number, pxScale: number): void {
  const ctx = layer.getContext('2d', layerContextSettings())!;
  const w = layer.width, h = layer.height;
  if (!w || !h) return;
  let ops: ColourOp[] = [];
  const flush = () => { runColourOps(layer, ctx, ops); ops = []; };
  for (const fx of effects) {
    if (!fx.enabled) continue;
    const m = effectMatrix(fx);
    if (m) { ops.push({ kind: 'matrix', m }); continue; }
    if (fx.type === 'grade') { ops.push({ kind: 'grade', fx }); continue; }
    if (fx.type === 'lut') { if (getLut(fx.data?.lutId as string | undefined)) ops.push({ kind: 'lut', fx }); continue; }
    flush();
    const p = fx.params;
    switch (fx.type) {
      case 'blur': blur(layer, ctx, (p.radius ?? 8) * pxScale); break;
      case 'sharpen': sharpen(ctx, w, h, p.amount ?? 40); break;
      case 'vignette': vignette(ctx, w, h, p.amount ?? 50, p.size ?? 55); break;
      case 'grain': grain(ctx, w, h, p.amount ?? 30, Math.max(1, (p.size ?? 1) * pxScale), frame); break;
      case 'glow': glow(layer, ctx, p.amount ?? 40, (p.radius ?? 12) * pxScale); break;
      case 'pixelate': pixelate(layer, ctx, Math.max(2, (p.size ?? 12) * pxScale)); break;
      case 'rgbSplit': rgbSplit(layer, ctx, (p.amount ?? 8) * pxScale, p.angle ?? 0); break;
      case 'glitch': glitch(layer, ctx, p.amount ?? 40, p.speed ?? 12, local); break;
      case 'chroma': chromaPass(layer, ctx, fx); break;
      case 'silhouette': {
        // Solid-colour silhouette of whatever's opaque (cut-out PNGs, removed backgrounds).
        const a = Math.max(0, Math.min(1, (p.amount ?? 100) / 100));
        if (a <= 0) break;
        ctx.save();
        ctx.globalCompositeOperation = 'source-atop';
        ctx.globalAlpha = a;
        ctx.fillStyle = `rgb(${p.r ?? 20},${p.g ?? 20},${p.b ?? 40})`;
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
        break;
      }
      default: break; // motion effects handled by the compositor
    }
  }
  flush();
}
