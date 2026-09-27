/**
 * Effect catalogue. Definitions are pure data so they can be listed in the UI,
 * saved in projects and unit-tested; the pixel work lives in
 * engine/effectsRender.ts.
 */
import { uid } from './ids';
import type { EffectInstance } from './types';

export interface ParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  unit?: string;
}

export type EffectCategory = 'adjust' | 'blur' | 'stylise' | 'distort' | 'motion' | 'look' | 'ai';

export interface EffectDef {
  type: string;
  name: string;
  category: EffectCategory;
  description: string;
  params: ParamDef[];
}

const p = (key: string, label: string, min: number, max: number, def: number, step = 1, unit?: string): ParamDef => ({
  key, label, min, max, step, default: def, unit,
});

export const EFFECTS: EffectDef[] = [
  {
    type: 'adjust', name: 'Colour adjust', category: 'adjust',
    description: 'Exposure, contrast, saturation, temperature and tint in one pass.',
    params: [
      p('exposure', 'Exposure', -100, 100, 0),
      p('brightness', 'Brightness', -100, 100, 0),
      p('contrast', 'Contrast', -100, 100, 0),
      p('saturation', 'Saturation', -100, 100, 0),
      p('hue', 'Hue', -180, 180, 0, 1, '°'),
      p('temperature', 'Temperature', -100, 100, 0),
      p('tint', 'Tint', -100, 100, 0),
    ],
  },
  { type: 'blur', name: 'Blur', category: 'blur', description: 'Soft Gaussian-style blur.', params: [p('radius', 'Radius', 0, 60, 8, 0.5, 'px')] },
  { type: 'sharpen', name: 'Sharpen', category: 'blur', description: 'Crisp up soft footage.', params: [p('amount', 'Amount', 0, 100, 40)] },
  { type: 'vignette', name: 'Vignette', category: 'stylise', description: 'Darkened corners.', params: [p('amount', 'Amount', 0, 100, 50), p('size', 'Size', 0, 100, 55)] },
  { type: 'grain', name: 'Film grain', category: 'stylise', description: 'Animated film noise.', params: [p('amount', 'Amount', 0, 100, 30), p('size', 'Size', 1, 4, 1, 1)] },
  { type: 'glow', name: 'Glow', category: 'stylise', description: 'Bright areas bloom outward.', params: [p('amount', 'Amount', 0, 100, 40), p('radius', 'Radius', 1, 40, 12)] },
  { type: 'pixelate', name: 'Pixelate', category: 'distort', description: 'Chunky pixels.', params: [p('size', 'Block size', 2, 80, 12, 1, 'px')] },
  { type: 'rgbSplit', name: 'RGB split', category: 'distort', description: 'Offset colour channels.', params: [p('amount', 'Offset', 0, 40, 8, 0.5, 'px'), p('angle', 'Angle', 0, 360, 0, 1, '°')] },
  { type: 'glitch', name: 'Glitch', category: 'distort', description: 'Digital slice tearing that changes every frame.', params: [p('amount', 'Intensity', 0, 100, 40), p('speed', 'Speed', 1, 30, 12)] },
  { type: 'shake', name: 'Camera shake', category: 'motion', description: 'Handheld wobble.', params: [p('amount', 'Amount', 0, 100, 30), p('speed', 'Speed', 1, 30, 10)] },
  { type: 'pulse', name: 'Zoom pulse', category: 'motion', description: 'Rhythmic punch-in.', params: [p('amount', 'Amount', 0, 50, 8, 1, '%'), p('bpm', 'Beats/min', 30, 200, 120)] },
  { type: 'invert', name: 'Invert', category: 'adjust', description: 'Negative image.', params: [p('amount', 'Amount', 0, 100, 100)] },
  { type: 'mono', name: 'Black & white', category: 'adjust', description: 'Remove colour.', params: [p('amount', 'Amount', 0, 100, 100)] },
  { type: 'sepia', name: 'Sepia', category: 'adjust', description: 'Old photo tone.', params: [p('amount', 'Amount', 0, 100, 80)] },
  {
    type: 'grade', name: 'Colour grade', category: 'adjust', description: 'Tones, colour wheels, curves and HSL.',
    params: [
      p('shadows', 'Shadows', -100, 100, 0), p('highlights', 'Highlights', -100, 100, 0), p('blacks', 'Blacks', -100, 100, 0), p('whites', 'Whites', -100, 100, 0),
      p('vibrance', 'Vibrance', -100, 100, 0),
      ...['lift', 'gamma', 'gain'].flatMap((w) => [p(`${w}X`, `${w} X`, -1, 1, 0, 0.01), p(`${w}Y`, `${w} Y`, -1, 1, 0, 0.01), p(`${w}L`, `${w} level`, -1, 1, 0, 0.01)]),
      ...['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'].flatMap((b) => [p(`hsl.${b}.h`, `${b} hue`, -30, 30, 0, 1, '°'), p(`hsl.${b}.s`, `${b} saturation`, -100, 100, 0), p(`hsl.${b}.l`, `${b} luminance`, -100, 100, 0)]),
    ],
  },
  { type: 'lut', name: 'LUT', category: 'adjust', description: 'Apply a .cube colour lookup table.', params: [p('intensity', 'Intensity', 0, 100, 100, 1, '%')] },
  {
    type: 'chroma', name: 'Green screen', category: 'adjust', description: 'Key out a background colour.',
    params: [p('keyR', 'Key red', 0, 255, 0), p('keyG', 'Key green', 0, 255, 200), p('keyB', 'Key blue', 0, 255, 60), p('tolerance', 'Strength', 0, 100, 30), p('softness', 'Edge softness', 0, 100, 15), p('spill', 'Spill removal', 0, 100, 50), p('shrink', 'Shrink edges', 0, 100, 0)],
  },
  {
    type: 'silhouette', name: 'Silhouette', category: 'stylise', description: 'Turn a cut-out picture into a solid shape — keyframe Amount to reveal it.',
    params: [p('amount', 'Amount', 0, 100, 100, 1, '%'), p('r', 'Red', 0, 255, 16), p('g', 'Green', 0, 255, 18), p('b', 'Blue', 0, 255, 40)],
  },
  { type: 'bgRemove', name: 'Remove background', category: 'ai', description: 'Cut out people with an on-device model.', params: [p('feather', 'Edge softness', 0, 20, 3, 0.5, 'px'), p('invert', 'Keep background instead', 0, 1, 0, 1)] },
];

/** "Filters" panel: one-tap looks built from the colour matrix. */
export interface LookDef { id: string; name: string; swatch: [string, string] }
export const LOOKS: LookDef[] = [
  { id: 'sunlit', name: 'Sunlit', swatch: ['#f6c56b', '#c8643b'] },
  { id: 'harbour', name: 'Harbour', swatch: ['#6fb3d9', '#1f4b6e'] },
  { id: 'ember', name: 'Ember', swatch: ['#f08a4b', '#2c6f75'] },
  { id: 'chalk', name: 'Chalk', swatch: ['#eeeeee', '#555555'] },
  { id: 'inkwell', name: 'Inkwell', swatch: ['#bbbbbb', '#111111'] },
  { id: 'polaroid', name: 'Polaroid', swatch: ['#f1dfb8', '#8a6d4a'] },
  { id: 'arcade', name: 'Arcade', swatch: ['#ff4fd8', '#3cf0ff'] },
  { id: 'faded', name: 'Faded', swatch: ['#d9d2c5', '#8b8f96'] },
  { id: 'forest', name: 'Forest', swatch: ['#9ccf7a', '#2d5031'] },
  { id: 'dusk', name: 'Dusk', swatch: ['#c38fd6', '#3d2f63'] },
];
EFFECTS.push({
  type: 'look', name: 'Filter look', category: 'look', description: 'Preset colour grade.',
  params: [p('look', 'Look', 0, LOOKS.length - 1, 0, 1), p('strength', 'Strength', 0, 100, 80)],
});

export function getEffectDef(type: string): EffectDef | undefined {
  return EFFECTS.find((e) => e.type === type);
}

export function createEffect(type: string, overrides: Record<string, number> = {}): EffectInstance {
  const def = getEffectDef(type);
  if (!def) throw new Error(`Unknown effect: ${type}`);
  const params: Record<string, number> = {};
  for (const prm of def.params) params[prm.key] = prm.default;
  return { id: uid('fx'), type, enabled: true, params: { ...params, ...overrides } };
}

/* ------------------------------------------------------------------ */
/* Colour matrix maths (4x5, row-major, RGBA in 0..255 space)          */
/* ------------------------------------------------------------------ */

export type ColorMatrix = number[]; // length 20

export const IDENTITY: ColorMatrix = [
  1, 0, 0, 0, 0,
  0, 1, 0, 0, 0,
  0, 0, 1, 0, 0,
  0, 0, 0, 1, 0,
];

/** result = a ∘ b  (apply b first, then a) */
export function multiply(a: ColorMatrix, b: ColorMatrix): ColorMatrix {
  const out = new Array(20).fill(0);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 5; c++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[r * 5 + k] * b[k * 5 + c];
      if (c === 4) sum += a[r * 5 + 4];
      out[r * 5 + c] = sum;
    }
  }
  return out;
}

export function lerpMatrix(m: ColorMatrix, t: number): ColorMatrix {
  return m.map((v, i) => IDENTITY[i] + (v - IDENTITY[i]) * t);
}

export function isIdentity(m: ColorMatrix): boolean {
  return m.every((v, i) => Math.abs(v - IDENTITY[i]) < 1e-6);
}

const LR = 0.2126, LG = 0.7152, LB = 0.0722;

export function saturationMatrix(s: number): ColorMatrix {
  // s = 1 identity, 0 greyscale
  const ir = (1 - s) * LR, ig = (1 - s) * LG, ib = (1 - s) * LB;
  return [
    ir + s, ig, ib, 0, 0,
    ir, ig + s, ib, 0, 0,
    ir, ig, ib + s, 0, 0,
    0, 0, 0, 1, 0,
  ];
}

export function brightnessMatrix(offset: number): ColorMatrix {
  return [1, 0, 0, 0, offset, 0, 1, 0, 0, offset, 0, 0, 1, 0, offset, 0, 0, 0, 1, 0];
}

export function scaleMatrix(r: number, g = r, b = r): ColorMatrix {
  return [r, 0, 0, 0, 0, 0, g, 0, 0, 0, 0, 0, b, 0, 0, 0, 0, 0, 1, 0];
}

export function contrastMatrix(c: number): ColorMatrix {
  const o = 128 * (1 - c);
  return [c, 0, 0, 0, o, 0, c, 0, 0, o, 0, 0, c, 0, o, 0, 0, 0, 1, 0];
}

export function hueMatrix(deg: number): ColorMatrix {
  const a = (deg * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  // Same constants as the SVG feColorMatrix hueRotate definition.
  return [
    0.213 + cos * 0.787 - sin * 0.213, 0.715 - cos * 0.715 - sin * 0.715, 0.072 - cos * 0.072 + sin * 0.928, 0, 0,
    0.213 - cos * 0.213 + sin * 0.143, 0.715 + cos * 0.285 + sin * 0.14, 0.072 - cos * 0.072 - sin * 0.283, 0, 0,
    0.213 - cos * 0.213 - sin * 0.787, 0.715 - cos * 0.715 + sin * 0.715, 0.072 + cos * 0.928 + sin * 0.072, 0, 0,
    0, 0, 0, 1, 0,
  ];
}

export function sepiaMatrix(): ColorMatrix {
  return [0.393, 0.769, 0.189, 0, 0, 0.349, 0.686, 0.168, 0, 0, 0.272, 0.534, 0.131, 0, 0, 0, 0, 0, 1, 0];
}

export function invertMatrix(): ColorMatrix {
  return [-1, 0, 0, 0, 255, 0, -1, 0, 0, 255, 0, 0, -1, 0, 255, 0, 0, 0, 1, 0];
}

/** Temperature (-100 cool .. +100 warm) and tint (-100 green .. +100 magenta). */
export function temperatureTintMatrix(temp: number, tint: number): ColorMatrix {
  const t = temp / 100, g = tint / 100;
  return scaleMatrix(1 + 0.18 * t + 0.06 * g, 1 - 0.14 * g, 1 - 0.18 * t + 0.06 * g);
}

export function adjustMatrix(params: Record<string, number>): ColorMatrix {
  let m = IDENTITY;
  const ex = params.exposure ?? 0;
  if (ex) m = multiply(scaleMatrix(Math.pow(2, ex / 50)), m);
  const br = params.brightness ?? 0;
  if (br) m = multiply(brightnessMatrix(br * 1.28), m);
  const ct = params.contrast ?? 0;
  if (ct) m = multiply(contrastMatrix(ct >= 0 ? 1 + ct / 50 : 1 + ct / 110), m);
  const sat = params.saturation ?? 0;
  if (sat) m = multiply(saturationMatrix(1 + sat / 100), m);
  const hue = params.hue ?? 0;
  if (hue) m = multiply(hueMatrix(hue), m);
  const tp = params.temperature ?? 0, tn = params.tint ?? 0;
  if (tp || tn) m = multiply(temperatureTintMatrix(tp, tn), m);
  return m;
}

export function lookMatrix(lookIndex: number): ColorMatrix {
  const id = LOOKS[Math.round(lookIndex)]?.id;
  switch (id) {
    case 'sunlit': return adjustMatrix({ temperature: 45, saturation: 15, contrast: 8, brightness: 4 });
    case 'harbour': return adjustMatrix({ temperature: -45, saturation: -5, contrast: 10 });
    case 'ember': {
      // teal shadows / orange skin: warm + push blue in shadows via offset
      const m = adjustMatrix({ temperature: 30, saturation: 20, contrast: 18 });
      return multiply([1, 0, 0, 0, -6, 0, 1, 0, 0, 4, 0, 0, 1, 0, 14, 0, 0, 0, 1, 0], m);
    }
    case 'chalk': return multiply(contrastMatrix(0.85), saturationMatrix(0.25));
    case 'inkwell': return multiply(contrastMatrix(1.45), saturationMatrix(0));
    case 'polaroid': return multiply(lerpMatrix(sepiaMatrix(), 0.35), adjustMatrix({ contrast: -12, brightness: 8 }));
    case 'arcade': return multiply(hueMatrix(-18), adjustMatrix({ saturation: 70, contrast: 22 }));
    case 'faded': return multiply([0.82, 0, 0, 0, 30, 0, 0.82, 0, 0, 30, 0, 0, 0.85, 0, 34, 0, 0, 0, 1, 0], saturationMatrix(0.7));
    case 'forest': return adjustMatrix({ temperature: -8, tint: -30, saturation: 12, contrast: 6 });
    case 'dusk': return adjustMatrix({ temperature: -20, tint: 40, saturation: 10, brightness: -4 });
    default: return IDENTITY;
  }
}

/** Colour-matrix contribution of one effect, or null if it isn't a matrix effect. */
export function effectMatrix(fx: EffectInstance): ColorMatrix | null {
  const prm = fx.params;
  switch (fx.type) {
    case 'adjust': return adjustMatrix(prm);
    case 'mono': return lerpMatrix(saturationMatrix(0), (prm.amount ?? 100) / 100);
    case 'sepia': return lerpMatrix(sepiaMatrix(), (prm.amount ?? 80) / 100);
    case 'invert': return lerpMatrix(invertMatrix(), (prm.amount ?? 100) / 100);
    case 'look': return lerpMatrix(lookMatrix(prm.look ?? 0), (prm.strength ?? 80) / 100);
    default: return null;
  }
}

/** Apply a matrix to one RGBA pixel (used by tests and the software renderer). */
export function applyMatrixToPixel(m: ColorMatrix, r: number, g: number, b: number, a: number): [number, number, number, number] {
  const c = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
  return [
    c(m[0] * r + m[1] * g + m[2] * b + m[3] * a + m[4]),
    c(m[5] * r + m[6] * g + m[7] * b + m[8] * a + m[9]),
    c(m[10] * r + m[11] * g + m[12] * b + m[13] * a + m[14]),
    c(m[15] * r + m[16] * g + m[17] * b + m[18] * a + m[19]),
  ];
}
