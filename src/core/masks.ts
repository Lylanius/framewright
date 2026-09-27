/**
 * Masks: shapes that limit where a clip (and its effects) show.
 * Geometry lives in the clip's own picture space so masks follow the clip.
 */
import { uid } from './ids';
import { interpolate, setKey } from './keyframes';
import type { Mask, MaskType } from './types';

export const MASK_ANIMATABLE = ['x', 'y', 'w', 'h', 'rotation', 'feather', 'opacity', 'roundness'] as const;
export type MaskProp = (typeof MASK_ANIMATABLE)[number];

export function createMask(type: MaskType, n = 1): Mask {
  const base: Mask = {
    id: uid('msk'), name: `${{ rect: 'Rectangle', ellipse: 'Ellipse', polygon: 'Polygon', freeform: 'Freehand' }[type]} ${n}`,
    type, x: 0, y: 0, w: 0.5, h: 0.5, rotation: 0, roundness: 0,
    points: [], feather: 12, opacity: 1, invert: false, mode: 'add', keyframes: {},
  };
  if (type === 'polygon' || type === 'freeform') { base.w = 1; base.h = 1; }
  if (type === 'polygon') base.points = [{ x: 0.5, y: 0.25 }, { x: 0.72, y: 0.7 }, { x: 0.28, y: 0.7 }];
  if (type === 'ellipse') { base.w = 0.4; base.h = 0.4; }
  return base;
}

export function maskValue(m: Mask, prop: MaskProp, local: number): number {
  const keys = m.keyframes[prop];
  return keys && keys.length ? interpolate(keys, local) : (m[prop] as number);
}

/** Set a mask value: keyframed at `local` if that property is animated, else the static value. */
export function setMaskValue(m: Mask, prop: MaskProp, v: number, local: number): Mask {
  const keys = m.keyframes[prop];
  if (keys && keys.length) return { ...m, keyframes: { ...m.keyframes, [prop]: setKey(keys, local, v) } };
  return { ...m, [prop]: v };
}

/** Mask at a moment, with every animated value resolved. */
export function resolveMask(m: Mask, local: number): Mask {
  const out = { ...m };
  for (const p of MASK_ANIMATABLE) (out as Record<string, unknown>)[p] = maskValue(m, p, local);
  return out;
}

/**
 * Outline of a (resolved) mask as a polygon in picture pixels (w × h picture).
 * Rect/ellipse are sampled so every shape shares one drawing/hit-test path.
 */
export function maskOutline(m: Mask, W: number, H: number): { x: number; y: number }[] {
  const cx = W / 2 + m.x * W, cy = H / 2 + m.y * H;
  const hw = (m.w * W) / 2, hh = (m.h * H) / 2;
  const rot = (m.rotation * Math.PI) / 180;
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const place = (px: number, py: number) => ({ x: cx + px * cos - py * sin, y: cy + px * sin + py * cos });
  if (m.type === 'ellipse') {
    return Array.from({ length: 64 }, (_, i) => { const a = (i / 64) * Math.PI * 2; return place(Math.cos(a) * hw, Math.sin(a) * hh); });
  }
  if (m.type === 'rect') {
    const r = Math.min(hw, hh) * Math.max(0, Math.min(1, m.roundness));
    if (r < 0.5) return [place(-hw, -hh), place(hw, -hh), place(hw, hh), place(-hw, hh)];
    const pts: { x: number; y: number }[] = [];
    const corners: [number, number, number][] = [[hw - r, -hh + r, -90], [hw - r, hh - r, 0], [-hw + r, hh - r, 90], [-hw + r, -hh + r, 180]];
    for (const [ox, oy, a0] of corners) for (let k = 0; k <= 8; k++) {
      const a = ((a0 + (k / 8) * 90) * Math.PI) / 180;
      pts.push(place(ox + Math.cos(a) * r, oy + Math.sin(a) * r));
    }
    return pts;
  }
  // Polygon / freehand: points are in 0..1 of a unit box that x/y/w/h then place and scale.
  return m.points.map((p) => place((p.x - 0.5) * m.w * 2 * (W / 2), (p.y - 0.5) * m.h * 2 * (H / 2)));
}

/** Point-in-polygon (even-odd), for tests and hit-testing. */
export function insideOutline(pts: { x: number; y: number }[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Simplify a freehand stroke (Ramer–Douglas–Peucker) so saved masks stay small. */
export function simplifyStroke(points: { x: number; y: number }[], tolerance = 0.004): { x: number; y: number }[] {
  if (points.length < 3) return points;
  const keep = new Array(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const rec = (i: number, j: number) => {
    const a = points[i], b = points[j];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1e-9;
    let worst = -1, dist = tolerance;
    for (let k = i + 1; k < j; k++) {
      const d = Math.abs(dy * points[k].x - dx * points[k].y + b.x * a.y - b.y * a.x) / len;
      if (d > dist) { dist = d; worst = k; }
    }
    if (worst >= 0) { keep[worst] = true; rec(i, worst); rec(worst, j); }
  };
  rec(0, points.length - 1);
  return points.filter((_, i) => keep[i]);
}
