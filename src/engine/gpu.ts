/**
 * GPU colour pipeline (WebGL). Runs colour matrices, grading (tones, wheels,
 * curves, HSL), 3D LUTs and chroma keying on a clip layer in one pass each.
 * Mirrors core/grade.ts exactly; if WebGL isn't available the caller falls
 * back to the CPU versions.
 */
import { assetToLut, chromaUniforms, gradeUniforms, type Lut3D } from '../core/grade';
import type { ColorMatrix } from '../core/effects';
import type { EffectInstance, LutAsset } from '../core/types';

const VS = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const FS = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_img;
uniform int u_mode;
uniform mat4 u_mat; uniform vec4 u_off;
uniform vec4 u_tones; uniform vec3 u_lift; uniform vec3 u_gamma; uniform vec3 u_gain;
uniform float u_hsl[24]; uniform float u_vib; uniform int u_useCurves; uniform sampler2D u_curves;
uniform sampler2D u_lut; uniform float u_lutSize; uniform float u_lutMix;
uniform vec3 u_key; uniform vec4 u_chroma;

float tone(float v) {
  float o = v;
  o += u_tones.x * 0.45 * (1.0 - v) * (1.0 - v) * v * 3.4;
  o += u_tones.y * 0.45 * v * v * (1.0 - v) * 3.4;
  o += u_tones.z * 0.25 * pow(1.0 - v, 4.0);
  o += u_tones.w * 0.25 * pow(v, 4.0);
  return o;
}
vec3 rgb2hsl(vec3 c) {
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
  float l = (mx + mn) * 0.5;
  if (mx - mn < 1e-6) return vec3(0.0, 0.0, l);
  float d = mx - mn;
  float s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
  float h;
  if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
  else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
  else h = (c.r - c.g) / d + 4.0;
  return vec3(h * 60.0, s, l);
}
float h2r(float p, float q, float t) {
  if (t < 0.0) t += 1.0; if (t > 1.0) t -= 1.0;
  if (t < 1.0/6.0) return p + (q - p) * 6.0 * t;
  if (t < 0.5) return q;
  if (t < 2.0/3.0) return p + (q - p) * (2.0/3.0 - t) * 6.0;
  return p;
}
vec3 hsl2rgb(vec3 c) {
  if (c.y < 1e-6) return vec3(c.z);
  float q = c.z < 0.5 ? c.z * (1.0 + c.y) : c.z + c.y - c.z * c.y;
  float p = 2.0 * c.z - q;
  float h = mod(mod(c.x, 360.0) + 360.0, 360.0) / 360.0;
  return vec3(h2r(p, q, h + 1.0/3.0), h2r(p, q, h), h2r(p, q, h - 1.0/3.0));
}
float bandHue(int i) {
  if (i == 0) return 0.0; if (i == 1) return 30.0; if (i == 2) return 60.0; if (i == 3) return 120.0;
  if (i == 4) return 180.0; if (i == 5) return 225.0; if (i == 6) return 275.0; if (i == 7) return 320.0;
  return 360.0;
}
float hslAt(int i) {
  for (int k = 0; k < 24; k++) if (k == i) return u_hsl[k];
  return 0.0;
}
vec3 grade(vec3 c) {
  c = vec3(tone(c.r), tone(c.g), tone(c.b));
  c = c + u_lift * (1.0 - c);
  c = c * (1.0 + u_gain);
  c = pow(max(c, 0.0), 1.0 / max(vec3(0.1), 1.0 + u_gamma));
  c = clamp(c, 0.0, 1.0);
  if (u_useCurves == 1) {
    c.r = texture2D(u_curves, vec2((c.r * 255.0 + 0.5) / 256.0, 0.5)).r;
    c.g = texture2D(u_curves, vec2((c.g * 255.0 + 0.5) / 256.0, 0.5)).g;
    c.b = texture2D(u_curves, vec2((c.b * 255.0 + 0.5) / 256.0, 0.5)).b;
  }
  bool any = u_vib != 0.0;
  for (int k = 0; k < 24; k++) if (u_hsl[k] != 0.0) any = true;
  if (any) {
    vec3 h = rgb2hsl(c);
    if (h.y > 1e-4) {
      float hh = mod(mod(h.x, 360.0) + 360.0, 360.0);
      float dh = 0.0, ds = 0.0, dl = 0.0;
      for (int i = 0; i < 8; i++) {
        float a = bandHue(i), b = i == 7 ? 360.0 : bandHue(i + 1);
        float x = hh < a ? hh + 360.0 : hh;
        if (x >= a && x < b) {
          float t = (x - a) / (b - a);
          float s = t * t * (3.0 - 2.0 * t);
          int j = i == 7 ? 0 : i + 1;
          dh = (1.0 - s) * hslAt(i * 3) + s * hslAt(j * 3);
          ds = (1.0 - s) * hslAt(i * 3 + 1) + s * hslAt(j * 3 + 1);
          dl = (1.0 - s) * hslAt(i * 3 + 2) + s * hslAt(j * 3 + 2);
        }
      }
      h.x += dh;
      h.y = h.y * (1.0 + ds);
      h.z = h.z + dl * 0.5 * h.y * (1.0 - abs(2.0 * h.z - 1.0));
    }
    if (u_vib != 0.0) h.y = h.y + u_vib * (1.0 - h.y) * h.y * 1.5 * (u_vib > 0.0 ? 1.0 : 0.7);
    c = hsl2rgb(vec3(h.x, clamp(h.y, 0.0, 1.0), clamp(h.z, 0.0, 1.0)));
  }
  return clamp(c, 0.0, 1.0);
}
vec3 lutAt(float r, float g, float bSlice) {
  float S = u_lutSize;
  vec2 uv = vec2((r * (S - 1.0) + 0.5 + bSlice * S) / (S * S), (g * (S - 1.0) + 0.5) / S);
  return texture2D(u_lut, uv).rgb;
}
vec3 lut(vec3 c) {
  float S = u_lutSize;
  float bf = clamp(c.b, 0.0, 1.0) * (S - 1.0);
  float b0 = floor(bf), b1 = min(S - 1.0, b0 + 1.0);
  vec3 a = lutAt(clamp(c.r, 0.0, 1.0), clamp(c.g, 0.0, 1.0), b0);
  vec3 b = lutAt(clamp(c.r, 0.0, 1.0), clamp(c.g, 0.0, 1.0), b1);
  return mix(a, b, bf - b0);
}
float cbOf(vec3 c) { return -0.1146 * c.r - 0.3854 * c.g + 0.5 * c.b; }
float crOf(vec3 c) { return 0.5 * c.r - 0.4542 * c.g - 0.0458 * c.b; }
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec4 chroma(vec4 px) {
  vec3 c = px.rgb;
  float d = distance(vec2(cbOf(c), crOf(c)), vec2(cbOf(u_key), crOf(u_key)));
  float lo = u_chroma.x * 0.5, hi = lo + u_chroma.y * 0.5 + 1e-4;
  float a = clamp((d - lo) / (hi - lo), 0.0, 1.0);
  a = a * a * (3.0 - 2.0 * a);
  if (u_chroma.w > 0.0) a = clamp((a - u_chroma.w) / max(1e-4, 1.0 - u_chroma.w), 0.0, 1.0);
  if (u_chroma.z > 0.0) {
    vec3 kc = u_key - lum(u_key);
    float kn = max(length(kc), 1e-6);
    vec3 pc = c - lum(c);
    float along = dot(pc, kc) / kn;
    if (along > 0.0) c = clamp(c - kc * (along / kn) * u_chroma.z * (1.0 - a * 0.5), 0.0, 1.0);
  }
  return vec4(c, px.a * a);
}
void main() {
  vec4 px = texture2D(u_img, vec2(v_uv.x, 1.0 - v_uv.y));
  if (u_mode == 0) px.rgb = grade(px.rgb);
  else if (u_mode == 1) px.rgb = mix(px.rgb, lut(px.rgb), u_lutMix);
  else if (u_mode == 2) px = chroma(px);
  else if (u_mode == 3) px.rgb = clamp((u_mat * vec4(px.rgb * 255.0, px.a * 255.0)).rgb / 255.0 + u_off.rgb / 255.0, 0.0, 1.0);
  gl_FragColor = px;
}`;

interface GL {
  gl: WebGLRenderingContext;
  canvas: HTMLCanvasElement;
  prog: WebGLProgram;
  img: WebGLTexture;
  curves: WebGLTexture;
  lut: WebGLTexture;
  loc: Record<string, WebGLUniformLocation | null>;
  lutLoaded: string | null;
}

let state: GL | null | undefined;
let disabled = false;

function init(): GL | null {
  if (state !== undefined) return state;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true, alpha: true, antialias: false }) as WebGLRenderingContext | null;
    if (!gl) return (state = null);
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link');
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    const tex = (unit: number, filter: number) => {
      const t = gl.createTexture()!;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    const img = tex(0, gl.LINEAR), curves = tex(1, gl.LINEAR), lut = tex(2, gl.LINEAR);
    const names = ['u_img', 'u_mode', 'u_mat', 'u_off', 'u_tones', 'u_lift', 'u_gamma', 'u_gain', 'u_hsl', 'u_vib', 'u_useCurves', 'u_curves', 'u_lut', 'u_lutSize', 'u_lutMix', 'u_key', 'u_chroma'];
    const loc: GL['loc'] = {};
    for (const n of names) loc[n] = gl.getUniformLocation(prog, n);
    gl.uniform1i(loc.u_img, 0);
    gl.uniform1i(loc.u_curves, 1);
    gl.uniform1i(loc.u_lut, 2);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    state = { gl, canvas, prog, img, curves, lut, loc, lutLoaded: null };
  } catch (e) {
    console.warn('WebGL colour pipeline unavailable, using CPU', e);
    state = null;
  }
  return state;
}

export function gpuAvailable(): boolean {
  return !disabled && !!init() && gpuFast();
}

/** Name of the WebGL renderer (e.g. "ANGLE (NVIDIA …)" or "SwiftShader"), if the browser tells us. */
export function gpuRenderer(): string {
  const g = init();
  if (!g) return 'none';
  try {
    const ext = g.gl.getExtension('WEBGL_debug_renderer_info');
    return String(ext ? g.gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : g.gl.getParameter(g.gl.RENDERER));
  } catch { return 'unknown'; }
}

let fast: boolean | undefined;
/**
 * Is the GPU path actually faster here? Software WebGL (SwiftShader, llvmpipe —
 * what browsers fall back to on blocklisted or missing GPUs) is slower than
 * our CPU code, so we time one pass of each on first use and keep the winner.
 */
export function gpuFast(): boolean {
  if (fast !== undefined) return fast;
  const g = init();
  if (!g) return (fast = false);
  if (forced !== null) return (fast = forced);
  if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/i.test(gpuRenderer())) return (fast = false);
  try {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 512;
    const x = c.getContext('2d')!;
    x.fillStyle = '#48c'; x.fillRect(0, 0, 512, 512);
    const m = [1.1, 0, 0, 0, 5, 0, 1.1, 0, 0, 5, 0, 0, 1.1, 0, 5, 0, 0, 0, 1, 0];
    fast = true; // allow gpuMatrix during the test
    const run = (fn: () => void) => { fn(); x.getImageData(0, 0, 1, 1); const t = performance.now(); for (let i = 0; i < 3; i++) { fn(); x.getImageData(0, 0, 1, 1); } return performance.now() - t; };
    const tg = run(() => gpuMatrix(c, m));
    const tc = run(() => {
      const img = x.getImageData(0, 0, 512, 512); const d = img.data;
      for (let i = 0; i < d.length; i += 4) { d[i] = d[i] * 1.1 + 5; d[i + 1] = d[i + 1] * 1.1 + 5; d[i + 2] = d[i + 2] * 1.1 + 5; }
      x.putImageData(img, 0, 0);
    });
    fast = tg < tc * 1.2;
  } catch { fast = false; }
  return fast;
}

let forced: boolean | null = null;
/** Settings / tests: force the GPU colour path on or off (null = automatic). */
export function setGpuMode(mode: 'auto' | 'on' | 'off'): void {
  forced = mode === 'auto' ? null : mode === 'on';
  fast = undefined;
  disabled = mode === 'off';
}

/** For tests / troubleshooting: force the CPU path. */
export function setGpuDisabled(v: boolean): void {
  disabled = v;
}

/* LUT registry (decoded from the project's LUT assets) ------------------- */

const luts = new Map<string, { asset: LutAsset; lut: Lut3D }>();

export function syncLuts(assets: LutAsset[] | undefined): void {
  const ids = new Set((assets ?? []).map((a) => a.id));
  for (const id of [...luts.keys()]) if (!ids.has(id)) luts.delete(id);
  for (const a of assets ?? []) if (!luts.has(a.id) || luts.get(a.id)!.asset !== a) luts.set(a.id, { asset: a, lut: assetToLut(a) });
}

export function getLut(id: string | undefined): Lut3D | null {
  return id ? luts.get(id)?.lut ?? null : null;
}

/* Running a pass ------------------------------------------------------------ */

function prepare(g: GL, layer: HTMLCanvasElement): void {
  const { gl, canvas } = g;
  if (canvas.width !== layer.width || canvas.height !== layer.height) { canvas.width = layer.width; canvas.height = layer.height; }
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, g.img);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, layer);
}

function finish(g: GL, layer: HTMLCanvasElement): void {
  const { gl } = g;
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  const ctx = layer.getContext('2d')!;
  ctx.save();
  ctx.globalCompositeOperation = 'copy';
  ctx.drawImage(g.canvas, 0, 0);
  ctx.restore();
}

export function gpuMatrix(layer: HTMLCanvasElement, m: ColorMatrix): boolean {
  const g = gpuAvailable() ? state! : null;
  if (!g) return false;
  const { gl, loc } = g;
  prepare(g, layer);
  gl.uniform1i(loc.u_mode, 3);
  // Column-major 4x4 from our row-major 4x5 (last column = offsets).
  gl.uniformMatrix4fv(loc.u_mat, false, new Float32Array([m[0], m[5], m[10], m[15], m[1], m[6], m[11], m[16], m[2], m[7], m[12], m[17], m[3], m[8], m[13], m[18]]));
  gl.uniform4f(loc.u_off, m[4], m[9], m[14], m[19]);
  finish(g, layer);
  return true;
}

export function gpuGrade(layer: HTMLCanvasElement, fx: EffectInstance): boolean {
  const g = gpuAvailable() ? state! : null;
  if (!g) return false;
  const { gl, loc } = g;
  const u = gradeUniforms(fx);
  prepare(g, layer);
  gl.uniform1i(loc.u_mode, 0);
  gl.uniform4f(loc.u_tones, ...u.tones);
  gl.uniform3f(loc.u_lift, ...u.lift);
  gl.uniform3f(loc.u_gamma, ...u.gamma);
  gl.uniform3f(loc.u_gain, ...u.gain);
  gl.uniform1fv(loc.u_hsl, u.hsl);
  gl.uniform1f(loc.u_vib, u.vibrance);
  gl.uniform1i(loc.u_useCurves, u.curves ? 1 : 0);
  if (u.curves) {
    const px = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      px[i * 4] = Math.round(u.curves[0][i] * 255); px[i * 4 + 1] = Math.round(u.curves[1][i] * 255); px[i * 4 + 2] = Math.round(u.curves[2][i] * 255); px[i * 4 + 3] = 255;
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, g.curves);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
  }
  finish(g, layer);
  return true;
}

export function gpuLut(layer: HTMLCanvasElement, fx: EffectInstance): boolean {
  const id = fx.data?.lutId as string | undefined;
  const lut = getLut(id);
  if (!gpuAvailable()) return false;
  if (!lut) return true; // no LUT chosen yet: nothing to do
  return gpuLut3D(layer, lut, `asset:${id}`, (fx.params.intensity ?? 100) / 100);
}

/** Apply any 3D LUT (imported, or a baked colour stack) in one pass. `key` identifies its contents for texture caching. */
export function gpuLut3D(layer: HTMLCanvasElement, lut: Lut3D, key: string, mix = 1): boolean {
  const g = gpuAvailable() ? state! : null;
  if (!g) return false;
  const { gl, loc } = g;
  prepare(g, layer);
  if (g.lutLoaded !== key) {
    const S = lut.size;
    const px = new Uint8Array(S * S * S * 4);
    // Atlas: x = r + b * S, y = g.
    for (let b = 0; b < S; b++) for (let gg = 0; gg < S; gg++) for (let r = 0; r < S; r++) {
      const src = (r + gg * S + b * S * S) * 3, dst = (gg * S * S + b * S + r) * 4;
      px[dst] = Math.round(lut.data[src] * 255); px[dst + 1] = Math.round(lut.data[src + 1] * 255); px[dst + 2] = Math.round(lut.data[src + 2] * 255); px[dst + 3] = 255;
    }
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, g.lut);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, S * S, S, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    g.lutLoaded = key;
  }
  gl.uniform1i(loc.u_mode, 1);
  gl.uniform1f(loc.u_lutSize, lut.size);
  gl.uniform1f(loc.u_lutMix, mix);
  finish(g, layer);
  return true;
}

export function gpuChroma(layer: HTMLCanvasElement, fx: EffectInstance): boolean {
  const g = gpuAvailable() ? state! : null;
  if (!g) return false;
  const { gl, loc } = g;
  const u = chromaUniforms(fx);
  prepare(g, layer);
  gl.uniform1i(loc.u_mode, 2);
  gl.uniform3f(loc.u_key, ...u.key);
  gl.uniform4f(loc.u_chroma, u.tolerance, u.softness, u.spill, u.shrink);
  finish(g, layer);
  return true;
}
