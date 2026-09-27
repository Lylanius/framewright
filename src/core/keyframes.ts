import type { Clip, Easing, Keyframe, ParamPath, TextStyle } from './types';

/** Solve a CSS cubic-bezier(x1, y1, x2, y2) timing curve at progress x. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  // Newton-Raphson, then bisection as a safety net.
  let t = x;
  for (let i = 0; i < 8; i++) {
    const err = sx(t) - x;
    if (Math.abs(err) < 1e-6) break;
    const d = dx(t);
    if (Math.abs(d) < 1e-6) break;
    t -= err / d;
  }
  if (t < 0 || t > 1 || Math.abs(sx(t) - x) > 1e-4) {
    let lo = 0, hi = 1;
    t = x;
    for (let i = 0; i < 40; i++) {
      const v = sx(t);
      if (Math.abs(v - x) < 1e-6) break;
      if (v < x) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
  }
  return ((ay * t + by) * t + cy) * t;
}

export function ease(e: Easing, x: number, bez?: [number, number, number, number]): number {
  switch (e) {
    case 'linear': return x;
    case 'easeIn': return x * x * x;
    case 'easeOut': return 1 - Math.pow(1 - x, 3);
    case 'easeInOut': return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
    case 'hold': return 0;
    case 'bezier': return bez ? cubicBezier(bez[0], bez[1], bez[2], bez[3], x) : x;
    default: return x;
  }
}

/** Interpolate a sorted keyframe list at clip-local time t. The easing of the *earlier* key controls the segment. */
export function interpolate(keys: Keyframe[], t: number): number {
  if (keys.length === 0) return NaN;
  if (t <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.v;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t;
      const x = span <= 0 ? 1 : (t - a.t) / span;
      return a.v + (b.v - a.v) * ease(a.ease, x, a.bez);
    }
  }
  return last.v;
}

/* ------------------------------------------------------------------ */
/* Parameter paths                                                        */
/* ------------------------------------------------------------------ */

const TEXT_NUMERIC = ['fontSize', 'letterSpacing', 'lineHeight', 'strokeWidth', 'shadowBlur', 'shadowOffsetX', 'shadowOffsetY', 'glow', 'backgroundPadding', 'backgroundRadius', 'boxWidth'] as const;
export type TextNumericProp = (typeof TEXT_NUMERIC)[number];

/** Base (un-animated) value of any animatable path. */
export function baseValue(clip: Clip, path: ParamPath): number {
  switch (path) {
    case 'x': case 'y': case 'scale': case 'rotation': case 'opacity':
      return clip.transform[path];
    case 'volume':
      return clip.volume;
  }
  const [head, a, ...rest] = path.split('.');
  const b = rest.join('.');
  if (head === 'crop') return clip.transform.crop[a as keyof Clip['transform']['crop']] ?? 0;
  if (head === 'text' && clip.text) return (clip.text[a as TextNumericProp] as number) ?? 0;
  if (head === 'fx') return clip.effects.find((e) => e.id === a)?.params[b] ?? 0;
  if (head === 'afx') return clip.audioFx?.find((e) => e.id === a)?.params[b] ?? 0;
  return 0;
}

/** Return a copy of the clip with the base (un-animated) value of a path set. */
export function setBaseValue(clip: Clip, path: ParamPath, v: number): Clip {
  switch (path) {
    case 'x': case 'y': case 'scale': case 'rotation': case 'opacity':
      return { ...clip, transform: { ...clip.transform, [path]: v } };
    case 'volume':
      return { ...clip, volume: v };
  }
  const [head, a, ...rest] = path.split('.');
  const b = rest.join('.');
  if (head === 'crop') return { ...clip, transform: { ...clip.transform, crop: { ...clip.transform.crop, [a]: v } } };
  if (head === 'text' && clip.text) return { ...clip, text: { ...clip.text, [a]: v } as TextStyle };
  if (head === 'fx') return { ...clip, effects: clip.effects.map((e) => (e.id === a ? { ...e, params: { ...e.params, [b]: v } } : e)) };
  if (head === 'afx') return { ...clip, audioFx: clip.audioFx?.map((e) => (e.id === a ? { ...e, params: { ...e.params, [b]: v } } : e)) };
  return clip;
}

/** Value of a path at clip-local time, honouring keyframes when present. */
export function valueAt(clip: Clip, path: ParamPath, localT: number): number {
  const keys = clip.keyframes[path];
  if (keys && keys.length) return interpolate(keys, localT);
  return baseValue(clip, path);
}

/**
 * The clip as it looks at clip-local time t: every keyframed crop, text,
 * effect and audio-effect value is written into the base fields. (Transform
 * and volume are read with valueAt directly.)
 */
export function resolveAt(clip: Clip, localT: number): Clip {
  let out = clip;
  for (const path of Object.keys(clip.keyframes)) {
    if (!path.includes('.')) continue;
    const keys = clip.keyframes[path];
    if (keys && keys.length) out = setBaseValue(out, path, interpolate(keys, localT));
  }
  return out;
}

const KEY_TOLERANCE = 1 / 120;

export function findKeyIndex(keys: Keyframe[] | undefined, t: number): number {
  if (!keys) return -1;
  return keys.findIndex((k) => Math.abs(k.t - t) < KEY_TOLERANCE);
}

/** Returns a new keyframe list with a key set (added or replaced) at time t. */
export function setKey(keys: Keyframe[] | undefined, t: number, v: number, easing: Easing = 'easeInOut'): Keyframe[] {
  const list = keys ? keys.slice() : [];
  const i = findKeyIndex(list, t);
  if (i >= 0) list[i] = { ...list[i], v };
  else list.push({ t, v, ease: easing });
  list.sort((a, b) => a.t - b.t);
  return list;
}

export function removeKey(keys: Keyframe[] | undefined, t: number): Keyframe[] {
  if (!keys) return [];
  const i = findKeyIndex(keys, t);
  if (i < 0) return keys.slice();
  return keys.filter((_, j) => j !== i);
}

/** Shift and clip keyframes when a clip is trimmed or split. `offset` is subtracted from each key time. */
export function rebaseKeys(
  kf: Clip['keyframes'],
  offset: number,
  newDuration: number,
): Clip['keyframes'] {
  const out: Clip['keyframes'] = {};
  for (const prop of Object.keys(kf)) {
    const keys = kf[prop];
    if (!keys || keys.length === 0) continue;
    // Preserve the animated value at the new boundaries so the look doesn't jump.
    const startV = interpolate(keys, offset);
    const endV = interpolate(keys, offset + newDuration);
    const inside = keys
      .map((k) => ({ ...k, t: k.t - offset }))
      .filter((k) => k.t > 1e-4 && k.t < newDuration - 1e-4);
    const firstKey = [...keys].reverse().find((k) => k.t <= offset) ?? keys[0];
    const list: Keyframe[] = [{ t: 0, v: startV, ease: firstKey.ease, bez: firstKey.bez }, ...inside];
    if (newDuration > 1e-4) list.push({ t: newDuration, v: endV, ease: 'linear' });
    out[prop] = list;
  }
  return out;
}

/** Scale key times (used when speed changes alter a clip's timeline duration). */
export function scaleKeys(kf: Clip['keyframes'], factor: number): Clip['keyframes'] {
  const out: Clip['keyframes'] = {};
  for (const prop of Object.keys(kf)) {
    const keys = kf[prop];
    if (keys) out[prop] = keys.map((k) => ({ ...k, t: k.t * factor }));
  }
  return out;
}
