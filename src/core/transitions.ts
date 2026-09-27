/**
 * Transitions: catalogue and timing.
 *
 * A transition lives on the *outgoing* clip (`clip.transitionOut`) and applies
 * to the cut where that clip meets the next clip on the same track. It is
 * centred on the cut, so neither clip gets shorter: during the transition the
 * outgoing clip keeps playing past its end and the incoming clip starts a
 * little early (frozen at the media's first/last frame if there is no spare
 * footage). This matches how phone editors behave.
 */
import type { ParamDef } from './effects';
import { EPS } from './time';
import type { Clip, MediaItem, Project, Track, TransitionInstance } from './types';

export type TransitionCategory =
  | 'basic' | 'slide' | 'zoom' | 'spin' | 'blur' | 'distort' | 'glitch' | 'light' | 'shape' | 'motion' | 'cinematic';

export interface TransitionDef {
  type: string;
  name: string;
  category: TransitionCategory;
  params: ParamDef[];
  /** Uses a colour (dip to colour, flash). */
  color?: string;
}

const p = (key: string, label: string, min: number, max: number, def: number, step = 1, unit?: string): ParamDef => ({ key, label, min, max, step, default: def, unit });
const DIR = p('dir', 'Direction', 0, 3, 0, 1); // 0 left, 1 right, 2 up, 3 down
const EASE = p('ease', 'Easing', 0, 1, 1, 1); // 0 linear, 1 smooth

export const DIRECTION_LABELS = ['Left', 'Right', 'Up', 'Down'];

export const TRANSITIONS: TransitionDef[] = [
  { type: 'dissolve', name: 'Dissolve', category: 'basic', params: [EASE] },
  { type: 'dip', name: 'Dip to colour', category: 'basic', params: [EASE], color: '#000000' },
  { type: 'slide', name: 'Slide', category: 'slide', params: [DIR, EASE] },
  { type: 'push', name: 'Push', category: 'slide', params: [DIR, EASE] },
  { type: 'wipe', name: 'Wipe', category: 'slide', params: [DIR, p('soft', 'Softness', 0, 100, 20)] },
  { type: 'zoomIn', name: 'Zoom in', category: 'zoom', params: [p('amount', 'Amount', 10, 300, 120, 5, '%'), EASE] },
  { type: 'zoomOut', name: 'Zoom out', category: 'zoom', params: [p('amount', 'Amount', 10, 300, 120, 5, '%'), EASE] },
  { type: 'spin', name: 'Spin', category: 'spin', params: [p('turns', 'Turns', 0.25, 3, 1, 0.25), p('clockwise', 'Clockwise', 0, 1, 1, 1)] },
  { type: 'blur', name: 'Blur', category: 'blur', params: [p('amount', 'Blur', 2, 80, 30, 1, 'px')] },
  { type: 'ripple', name: 'Warp', category: 'distort', params: [p('amount', 'Strength', 1, 100, 40)] },
  { type: 'glitch', name: 'Glitch', category: 'glitch', params: [p('amount', 'Intensity', 10, 100, 60)] },
  { type: 'flash', name: 'Flash', category: 'light', params: [p('amount', 'Brightness', 10, 100, 90)], color: '#ffffff' },
  { type: 'burn', name: 'Light burn', category: 'light', params: [p('amount', 'Glow', 10, 100, 70)], color: '#ffb347' },
  { type: 'iris', name: 'Circle reveal', category: 'shape', params: [p('soft', 'Softness', 0, 100, 10)] },
  { type: 'diamond', name: 'Diamond reveal', category: 'shape', params: [p('soft', 'Softness', 0, 100, 10)] },
  { type: 'clock', name: 'Clock wipe', category: 'shape', params: [p('clockwise', 'Clockwise', 0, 1, 1, 1)] },
  { type: 'whip', name: 'Whip pan', category: 'motion', params: [DIR, p('streak', 'Motion blur', 0, 100, 60)] },
  { type: 'bars', name: 'Letterbox', category: 'cinematic', params: [p('ease', 'Easing', 0, 1, 1, 1)] },
  { type: 'fadeThrough', name: 'Film fade', category: 'cinematic', params: [p('grain', 'Grain', 0, 100, 40)] },
];

export const TRANSITION_CATEGORIES: { id: TransitionCategory; label: string }[] = [
  { id: 'basic', label: 'Dissolve & fade' }, { id: 'slide', label: 'Slide, push & wipe' }, { id: 'zoom', label: 'Zoom' },
  { id: 'spin', label: 'Spin' }, { id: 'blur', label: 'Blur' }, { id: 'distort', label: 'Distortion' }, { id: 'glitch', label: 'Glitch' },
  { id: 'light', label: 'Light' }, { id: 'shape', label: 'Shape' }, { id: 'motion', label: 'Motion' }, { id: 'cinematic', label: 'Cinematic' },
];

export const DEFAULT_TRANSITION_DURATION = 0.5;
export const MIN_TRANSITION = 0.1;

export function getTransitionDef(type: string): TransitionDef | undefined {
  return TRANSITIONS.find((t) => t.type === type);
}

export function createTransition(type: string, duration = DEFAULT_TRANSITION_DURATION): TransitionInstance {
  const def = getTransitionDef(type);
  if (!def) throw new Error(`Unknown transition: ${type}`);
  const params: Record<string, number> = {};
  for (const prm of def.params) params[prm.key] = prm.default;
  return { type, duration, params, color: def.color };
}

/** Clip following `clip` on the same track if they touch, else null. */
export function nextAdjacent(track: Track, clip: Clip): Clip | null {
  const end = clip.start + clip.duration;
  return track.clips.find((c) => c.id !== clip.id && Math.abs(c.start - end) < 1e-3) ?? null;
}

/** Longest transition allowed at a cut: it can't reach past the middle of either clip. */
export function maxTransitionDuration(a: Clip, b: Clip): number {
  return Math.max(MIN_TRANSITION, Math.min(a.duration, b.duration, 5));
}

export interface TransitionWindow {
  a: Clip;
  b: Clip;
  transition: TransitionInstance;
  cut: number;
  start: number;
  end: number;
  duration: number;
}

/** All active transitions on a track (only where clips actually touch). */
export function trackTransitions(track: Track): TransitionWindow[] {
  if (track.kind !== 'visual') return [];
  const out: TransitionWindow[] = [];
  const sorted = track.clips.slice().sort((x, y) => x.start - y.start);
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    if (!a.transitionOut) continue;
    const b = sorted[i + 1];
    const cut = a.start + a.duration;
    if (Math.abs(b.start - cut) > 1e-3) continue;
    // Never let two transitions on one clip overlap.
    const prevHalf = i > 0 && sorted[i - 1].transitionOut && Math.abs(sorted[i - 1].start + sorted[i - 1].duration - a.start) < 1e-3
      ? Math.min(sorted[i - 1].transitionOut!.duration, maxTransitionDuration(sorted[i - 1], a)) / 2 : 0;
    const d = Math.min(a.transitionOut.duration, maxTransitionDuration(a, b), 2 * Math.max(0, a.duration - prevHalf));
    if (d < MIN_TRANSITION - EPS) continue;
    out.push({ a, b, transition: a.transitionOut, cut, start: cut - d / 2, end: cut + d / 2, duration: d });
  }
  return out;
}

export function transitionAt(track: Track, t: number): TransitionWindow | null {
  return trackTransitions(track).find((w) => t >= w.start - EPS && t < w.end - EPS) ?? null;
}

/** Time range in which a clip must be decoded/drawn, including transition overlap. */
export function clipActiveRanges(project: Project): Map<string, [number, number]> {
  const m = new Map<string, [number, number]>();
  for (const track of project.tracks) {
    for (const c of track.clips) m.set(c.id, [c.start, c.start + c.duration]);
    for (const w of trackTransitions(track)) {
      m.get(w.a.id)![1] = Math.max(m.get(w.a.id)![1], w.end);
      m.get(w.b.id)![0] = Math.min(m.get(w.b.id)![0], w.start);
    }
  }
  return m;
}

/**
 * Source-media time for a clip at timeline time t, allowing t to run past the
 * clip's edges (for transitions) but never past the media itself.
 */
export function sourceTimeExtended(clip: Clip, t: number, media?: MediaItem): number {
  if (clip.freeze) return clip.sourceIn;
  const local = t - clip.start;
  let s = clip.reverse ? clip.sourceIn + (clip.duration - local) * clip.speed : clip.sourceIn + local * clip.speed;
  const max = media?.duration ? media.duration - 0.001 : Infinity;
  if (clip.kind === 'image') return Math.max(0, local * clip.speed); // animated GIF/WebP time
  s = Math.max(0, Math.min(max, s));
  return s;
}

/** Eased transition progress 0..1. */
export function transitionProgress(w: TransitionWindow, t: number): number {
  const x = Math.min(1, Math.max(0, (t - w.start) / w.duration));
  return (w.transition.params.ease ?? 1) >= 1 ? (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2) : x;
}
