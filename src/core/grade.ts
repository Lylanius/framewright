/**
 * Colour grading, LUTs and chroma key — reference maths.
 *
 * These pure functions define exactly what each control does. The GPU shader
 * (engine/gpu.ts) mirrors them for speed; this code is the fallback when WebGL
 * isn't available, bakes .cube exports, and is what the unit tests check.
 * All values are display-referred RGB in 0..1.
 */
import type { EffectInstance, LutAsset } from './types';

export type RGB = [number, number, number];

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/* ------------------------------------------------------------------ */
/* Curves                                                                 */
/* ------------------------------------------------------------------ */

export type CurvePoint = [number, number];
export interface Curves { master: CurvePoint[]; r: CurvePoint[]; g: CurvePoint[]; b: CurvePoint[] }
export const IDENTITY_CURVE: CurvePoint[] = [[0, 0], [1, 1]];
export const defaultCurves = (): Curves => ({ master: IDENTITY_CURVE.map((p) => [...p] as CurvePoint), r: IDENTITY_CURVE.map((p) => [...p] as CurvePoint), g: IDENTITY_CURVE.map((p) => [...p] as CurvePoint), b: IDENTITY_CURVE.map((p) => [...p] as CurvePoint) });

export function isIdentityCurve(pts: CurvePoint[]): boolean {
  return pts.every(([x, y]) => Math.abs(x - y) < 1e-4);
}

/** Monotone cubic (Fritsch–Carlson) sampled into a 256-entry table. Never overshoots. */
export function curveTable(points: CurvePoint[]): Float32Array {
  const pts = points.slice().sort((a, b) => a[0] - b[0]);
  const out = new Float32Array(256);
  if (pts.length < 2) { for (let i = 0; i < 256; i++) out[i] = i / 255; return out; }
  const n = pts.length;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const d: number[] = [], m: number[] = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(d[i]) < 1e-9) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  for (let k = 0; k < 256; k++) {
    const x = k / 255;
    if (x <= xs[0]) { out[k] = clamp01(ys[0]); continue; }
    if (x >= xs[n - 1]) { out[k] = clamp01(ys[n - 1]); continue; }
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h;
    const t2 = t * t, t3 = t2 * t;
    const v = (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
    out[k] = clamp01(v);
  }
  return out;
}

/** Combined per-channel tables: channel curve applied after the master curve. */
export function curveTables(c: Curves): [Float32Array, Float32Array, Float32Array] {
  const M = curveTable(c.master);
  const chans = [c.r, c.g, c.b].map(curveTable);
  return chans.map((ch) => {
    const out = new Float32Array(256);
    for (let i = 0; i < 256; i++) out[i] = sampleTable(ch, M[i]);
    return out;
  }) as [Float32Array, Float32Array, Float32Array];
}

export function sampleTable(t: Float32Array, v: number): number {
  const x = clamp01(v) * 255;
  const i = Math.floor(x), f = x - i;
  return i >= 255 ? t[255] : t[i] + (t[i + 1] - t[i]) * f;
}

/* ------------------------------------------------------------------ */
/* Grade (tones, wheels, HSL)                                            */
/* ------------------------------------------------------------------ */

export const HSL_BANDS = [
  { key: 'red', label: 'Red', hue: 0, swatch: '#e5484d' },
  { key: 'orange', label: 'Orange', hue: 30, swatch: '#f08c3b' },
  { key: 'yellow', label: 'Yellow', hue: 60, swatch: '#e9cf3c' },
  { key: 'green', label: 'Green', hue: 120, swatch: '#46a758' },
  { key: 'aqua', label: 'Aqua', hue: 180, swatch: '#3cc4c4' },
  { key: 'blue', label: 'Blue', hue: 225, swatch: '#3e63dd' },
  { key: 'purple', label: 'Purple', hue: 275, swatch: '#8e4ec6' },
  { key: 'magenta', label: 'Magenta', hue: 320, swatch: '#d6409f' },
] as const;

export interface GradeUniforms {
  tones: [number, number, number, number]; // shadows, highlights, blacks, whites (-1..1)
  lift: RGB; gamma: RGB; gain: RGB;
  hsl: Float32Array; // 8 × (hueShiftDeg, sat, lum)
  vibrance: number;
  curves: [Float32Array, Float32Array, Float32Array] | null;
}

/** Colour-wheel position (x, y in -1..1) → RGB push, using YUV colour directions. */
export function wheelToRgb(x: number, y: number): RGB {
  return [1.14 * y, -0.395 * x - 0.581 * y, 2.032 * x];
}

export function gradeUniforms(fx: EffectInstance): GradeUniforms {
  const p = fx.params;
  const g = (k: string) => (p[k] ?? 0);
  const wheel = (name: string, lumScale: number, chromaScale: number): RGB => {
    const [dr, dg, db] = wheelToRgb(g(`${name}X`), g(`${name}Y`));
    const L = g(`${name}L`) * lumScale;
    return [L + dr * chromaScale, L + dg * chromaScale, L + db * chromaScale];
  };
  const hsl = new Float32Array(24);
  HSL_BANDS.forEach((b, i) => { hsl[i * 3] = g(`hsl.${b.key}.h`); hsl[i * 3 + 1] = g(`hsl.${b.key}.s`) / 100; hsl[i * 3 + 2] = g(`hsl.${b.key}.l`) / 100; });
  const curves = fx.data?.curves as Curves | undefined;
  const useCurves = curves && !(isIdentityCurve(curves.master) && isIdentityCurve(curves.r) && isIdentityCurve(curves.g) && isIdentityCurve(curves.b));
  return {
    tones: [g('shadows') / 100, g('highlights') / 100, g('blacks') / 100, g('whites') / 100],
    lift: wheel('lift', 0.25, 0.12), gamma: wheel('gamma', 0.5, 0.25), gain: wheel('gain', 0.5, 0.25),
    hsl, vibrance: g('vibrance') / 100,
    curves: useCurves ? curveTables(curves!) : null,
  };
}

function tone(v: number, t: GradeUniforms['tones']): number {
  const [sh, hi, bl, wh] = t;
  let o = v;
  o += sh * 0.45 * (1 - v) * (1 - v) * v * 3.4;
  o += hi * 0.45 * v * v * (1 - v) * 3.4;
  o += bl * 0.25 * Math.pow(1 - v, 4);
  o += wh * 0.25 * Math.pow(v, 4);
  return o;
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx - mn < 1e-6) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

export function hslToRgb(h: number, s: number, l: number): RGB {
  if (s < 1e-6) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q, hh = (((h % 360) + 360) % 360) / 360;
  return [hue2rgb(p, q, hh + 1 / 3), hue2rgb(p, q, hh), hue2rgb(p, q, hh - 1 / 3)];
}

/** How much a hue belongs to each of the 8 bands (weights sum to 1). */
export function bandWeights(h: number): number[] {
  const w = new Array(8).fill(0);
  const hues = HSL_BANDS.map((b) => b.hue);
  const hh = ((h % 360) + 360) % 360;
  for (let i = 0; i < 8; i++) {
    const a = hues[i], b = i === 7 ? hues[0] + 360 : hues[i + 1];
    const x = hh < a ? hh + 360 : hh;
    if (x >= a && x < b) {
      const t = (x - a) / (b - a);
      const s = t * t * (3 - 2 * t);
      w[i] = 1 - s;
      w[(i + 1) % 8] = s;
      break;
    }
  }
  return w;
}

export function applyGrade(rgb: RGB, u: GradeUniforms): RGB {
  let [r, g, b] = rgb;
  // Tones
  r = tone(r, u.tones); g = tone(g, u.tones); b = tone(b, u.tones);
  // Lift / gamma / gain (per channel)
  const lgg = (v: number, i: number) => {
    let o = v + u.lift[i] * (1 - v);
    o = o * (1 + u.gain[i]);
    o = Math.pow(Math.max(0, o), 1 / Math.max(0.1, 1 + u.gamma[i]));
    return o;
  };
  r = lgg(r, 0); g = lgg(g, 1); b = lgg(b, 2);
  r = clamp01(r); g = clamp01(g); b = clamp01(b);
  // Curves
  if (u.curves) { r = sampleTable(u.curves[0], r); g = sampleTable(u.curves[1], g); b = sampleTable(u.curves[2], b); }
  // HSL + vibrance
  let hasHsl = u.vibrance !== 0;
  for (let i = 0; i < 24 && !hasHsl; i++) if (u.hsl[i] !== 0) hasHsl = true;
  if (hasHsl) {
    let [h, s, l] = rgbToHsl(r, g, b);
    if (s > 1e-4) {
      const w = bandWeights(h);
      let dh = 0, ds = 0, dl = 0;
      for (let i = 0; i < 8; i++) { dh += w[i] * u.hsl[i * 3]; ds += w[i] * u.hsl[i * 3 + 1]; dl += w[i] * u.hsl[i * 3 + 2]; }
      h += dh;
      s = s * (1 + ds);
      l = l + dl * 0.5 * s * (1 - Math.abs(2 * l - 1));
    }
    if (u.vibrance) s = s + u.vibrance * (1 - s) * s * 1.5 * (u.vibrance > 0 ? 1 : 0.7);
    [r, g, b] = hslToRgb(h, clamp01(s), clamp01(l));
  }
  return [clamp01(r), clamp01(g), clamp01(b)];
}

/* ------------------------------------------------------------------ */
/* 3D LUTs (.cube)                                                        */
/* ------------------------------------------------------------------ */

export interface Lut3D { size: number; data: Float32Array; name: string }

export class LutFormatError extends Error {}

export function parseCube(text: string, name = 'LUT'): Lut3D {
  let size = 0;
  let title = name;
  let domainMin: RGB = [0, 0, 0], domainMax: RGB = [1, 1, 1];
  const values: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const key = parts[0].toUpperCase();
    if (key === 'TITLE') { title = line.slice(5).trim().replace(/^"|"$/g, '') || name; continue; }
    if (key === 'LUT_3D_SIZE') { size = parseInt(parts[1], 10); continue; }
    if (key === 'LUT_1D_SIZE') throw new LutFormatError('1D LUTs aren’t supported — export a 3D .cube instead.');
    if (key === 'DOMAIN_MIN') { domainMin = parts.slice(1, 4).map(Number) as RGB; continue; }
    if (key === 'DOMAIN_MAX') { domainMax = parts.slice(1, 4).map(Number) as RGB; continue; }
    if (/^[A-Z_]+$/.test(key)) continue; // other keywords
    if (parts.length >= 3) for (let i = 0; i < 3; i++) values.push(parseFloat(parts[i]));
  }
  if (!size || size < 2 || size > 128) throw new LutFormatError('This .cube file has no valid LUT_3D_SIZE.');
  if (values.length !== size * size * size * 3 || values.some((v) => !isFinite(v))) throw new LutFormatError(`Expected ${size}³ colour entries in this .cube file.`);
  const data = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const c = i % 3;
    data[i] = clamp01((values[i] - domainMin[c]) / Math.max(1e-6, domainMax[c] - domainMin[c]));
  }
  return { size, data, name: title };
}

export function toCube(lut: Lut3D): string {
  const lines = [`TITLE "${lut.name.replace(/"/g, '')}"`, `# Made with Framewright`, `LUT_3D_SIZE ${lut.size}`, 'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0'];
  for (let i = 0; i < lut.data.length; i += 3) lines.push(`${lut.data[i].toFixed(6)} ${lut.data[i + 1].toFixed(6)} ${lut.data[i + 2].toFixed(6)}`);
  return lines.join('\n') + '\n';
}

/** Trilinear lookup (red varies fastest, as in .cube files). */
export function sampleLut(lut: Lut3D, r: number, g: number, b: number): RGB {
  const n = lut.size - 1;
  const fr = clamp01(r) * n, fg = clamp01(g) * n, fb = clamp01(b) * n;
  const r0 = Math.floor(fr), g0 = Math.floor(fg), b0 = Math.floor(fb);
  const r1 = Math.min(n, r0 + 1), g1 = Math.min(n, g0 + 1), b1 = Math.min(n, b0 + 1);
  const dr = fr - r0, dg = fg - g0, db = fb - b0;
  const S = lut.size, d = lut.data;
  const at = (ri: number, gi: number, bi: number, c: number) => d[(ri + gi * S + bi * S * S) * 3 + c];
  const out: RGB = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const c00 = at(r0, g0, b0, c) * (1 - dr) + at(r1, g0, b0, c) * dr;
    const c10 = at(r0, g1, b0, c) * (1 - dr) + at(r1, g1, b0, c) * dr;
    const c01 = at(r0, g0, b1, c) * (1 - dr) + at(r1, g0, b1, c) * dr;
    const c11 = at(r0, g1, b1, c) * (1 - dr) + at(r1, g1, b1, c) * dr;
    out[c] = (c00 * (1 - dg) + c10 * dg) * (1 - db) + (c01 * (1 - dg) + c11 * dg) * db;
  }
  return out;
}

/** Bake any colour transform into a LUT (used for "Export LUT"). */
export function bakeLut(fn: (c: RGB) => RGB, size = 33, name = 'Framewright grade'): Lut3D {
  const data = new Float32Array(size * size * size * 3);
  let i = 0;
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    const o = fn([r / (size - 1), g / (size - 1), b / (size - 1)]);
    data[i++] = o[0]; data[i++] = o[1]; data[i++] = o[2];
  }
  return { size, data, name };
}

/** Store a LUT compactly in the project (16-bit, base64). */
export function lutToAsset(id: string, lut: Lut3D): LutAsset {
  const u16 = new Uint16Array(lut.data.length);
  for (let i = 0; i < u16.length; i++) u16[i] = Math.round(clamp01(lut.data[i]) * 65535);
  const bytes = new Uint8Array(u16.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { id, name: lut.name, size: lut.size, data: btoa(bin) };
}

export function assetToLut(a: LutAsset): Lut3D {
  const bin = atob(a.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const u16 = new Uint16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
  const data = new Float32Array(u16.length);
  for (let i = 0; i < u16.length; i++) data[i] = u16[i] / 65535;
  return { size: a.size, data, name: a.name };
}

/* ------------------------------------------------------------------ */
/* Chroma key                                                             */
/* ------------------------------------------------------------------ */

export interface ChromaUniforms { key: RGB; tolerance: number; softness: number; spill: number; shrink: number }

export function chromaUniforms(fx: EffectInstance): ChromaUniforms {
  const p = fx.params;
  return {
    key: [(p.keyR ?? 0) / 255, (p.keyG ?? 255) / 255, (p.keyB ?? 0) / 255],
    tolerance: (p.tolerance ?? 30) / 100,
    softness: (p.softness ?? 15) / 100,
    spill: (p.spill ?? 50) / 100,
    shrink: (p.shrink ?? 0) / 100,
  };
}

const cb = (r: number, g: number, b: number) => -0.1146 * r - 0.3854 * g + 0.5 * b;
const cr = (r: number, g: number, b: number) => 0.5 * r - 0.4542 * g - 0.0458 * b;

/** Returns [r, g, b, alpha] for one pixel. */
export function applyChroma(rgb: RGB, a: number, u: ChromaUniforms): [number, number, number, number] {
  const [r, g, b] = rgb;
  const kb = cb(...u.key), kr = cr(...u.key);
  const d = Math.hypot(cb(r, g, b) - kb, cr(r, g, b) - kr);
  const lo = u.tolerance * 0.5, hi = lo + u.softness * 0.5 + 1e-4;
  let alpha = d <= lo ? 0 : d >= hi ? 1 : (d - lo) / (hi - lo);
  alpha = alpha * alpha * (3 - 2 * alpha);
  if (u.shrink > 0) alpha = clamp01((alpha - u.shrink) / Math.max(1e-4, 1 - u.shrink));
  // Spill suppression: pull the key colour's cast out of what's left.
  let o: RGB = [r, g, b];
  if (u.spill > 0) {
    const kl = luma(...u.key);
    const kc: RGB = [u.key[0] - kl, u.key[1] - kl, u.key[2] - kl];
    const kn = Math.hypot(...kc) || 1;
    const l = luma(r, g, b);
    const pc: RGB = [r - l, g - l, b - l];
    const along = (pc[0] * kc[0] + pc[1] * kc[1] + pc[2] * kc[2]) / kn;
    if (along > 0) {
      const k = (along / kn) * u.spill * (1 - alpha * 0.5);
      o = [clamp01(r - kc[0] * k), clamp01(g - kc[1] * k), clamp01(b - kc[2] * k)];
    }
  }
  return [o[0], o[1], o[2], a * alpha];
}
