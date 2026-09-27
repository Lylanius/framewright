/**
 * Analysis maths for the AI tools. Everything here is pure and deterministic:
 * the heavy decoding happens in the media worker, and these functions turn its
 * measurements (loudness, frame differences, motion, word timings) into edits.
 */
import { findClip, updateClip } from './timeline';
import { EPS } from './time';
import type { Clip, EffectInstance, Keyframe, Project, WordTiming } from './types';
import { uid } from './ids';

export type Range = [number, number];

/* ------------------------------------------------------------------ */
/* Range helpers                                                          */
/* ------------------------------------------------------------------ */

export function mergeRanges(ranges: Range[], gap = 0): Range[] {
  const sorted = ranges.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + gap) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

export function totalLength(ranges: Range[]): number {
  return ranges.reduce((a, [s, e]) => a + (e - s), 0);
}

/** Convert source-media ranges to timeline ranges for a clip (clipped to the clip). */
export function sourceToTimeline(clip: Clip, ranges: Range[]): Range[] {
  const s0 = clip.sourceIn, s1 = clip.sourceIn + clip.duration * clip.speed;
  const out: Range[] = [];
  for (const [a, b] of ranges) {
    const lo = Math.max(a, s0), hi = Math.min(b, s1);
    if (hi - lo <= EPS) continue;
    if (!clip.reverse) out.push([clip.start + (lo - s0) / clip.speed, clip.start + (hi - s0) / clip.speed]);
    else out.push([clip.start + (s1 - hi) / clip.speed, clip.start + (s1 - lo) / clip.speed]);
  }
  return mergeRanges(out);
}

/* ------------------------------------------------------------------ */
/* Silence                                                                */
/* ------------------------------------------------------------------ */

export interface SilenceOptions {
  /** Anything quieter than this (dBFS) counts as silence. */
  thresholdDb: number;
  /** Only remove pauses at least this long (seconds). */
  minSilence: number;
  /** Keep this much breathing room either side of speech (seconds). */
  padding: number;
}

export const DEFAULT_SILENCE: SilenceOptions = { thresholdDb: -38, minSilence: 0.45, padding: 0.12 };

export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

/** Suggest a threshold from the file itself: a little above its quiet floor. */
export function suggestThresholdDb(loudness: number[]): number {
  const vals = loudness.filter((v) => v > 0).sort((a, b) => a - b);
  if (!vals.length) return DEFAULT_SILENCE.thresholdDb;
  const floor = vals[Math.floor(vals.length * 0.1)];
  const speech = vals[Math.floor(vals.length * 0.7)];
  const floorDb = 20 * Math.log10(Math.max(1e-6, floor));
  const speechDb = 20 * Math.log10(Math.max(1e-6, speech));
  // Sit about a third of the way from the floor to typical speech.
  return Math.round(Math.max(-60, Math.min(-18, floorDb + (speechDb - floorDb) * 0.35)));
}

/** Source-time ranges that are silent, already shrunk by the padding. */
export function detectSilence(loudness: number[], perSecond: number, opts: SilenceOptions = DEFAULT_SILENCE): Range[] {
  const thr = dbToLinear(opts.thresholdDb);
  const raw: Range[] = [];
  let start = -1;
  for (let i = 0; i <= loudness.length; i++) {
    const quiet = i < loudness.length && loudness[i] < thr;
    if (quiet && start < 0) start = i;
    if (!quiet && start >= 0) {
      raw.push([start / perSecond, i / perSecond]);
      start = -1;
    }
  }
  const duration = loudness.length / perSecond;
  return raw
    .filter(([a, b]) => b - a >= opts.minSilence)
    .map(([a, b]): Range => [a <= 0 ? 0 : a + opts.padding, b >= duration - 1e-6 ? duration : b - opts.padding])
    .filter(([a, b]) => b - a > 0.05);
}

/* ------------------------------------------------------------------ */
/* Cutting ranges out of the timeline                                     */
/* ------------------------------------------------------------------ */

/**
 * Remove timeline ranges from the given clips (and close the gaps on their
 * tracks). Clips on other tracks are left alone, so background music keeps
 * playing. Works from the end backwards so earlier ranges stay valid.
 */
export function cutRanges(p: Project, clipIds: string[], ranges: Range[]): Project {
  const cuts = mergeRanges(ranges).sort((x, y) => y[0] - x[0]);
  const targets = new Set(clipIds);
  const trackIds = new Set(clipIds.map((id) => findClip(p, id)?.track.id).filter(Boolean) as string[]);
  let project = p;
  for (const [a, b] of cuts) {
    const len = b - a;
    const shift = (c: Clip): Clip => ({ ...c, start: Math.max(0, c.start - len) });
    project = {
      ...project,
      tracks: project.tracks.map((t) => {
        if (!trackIds.has(t.id) || t.locked) return t;
        const clips: Clip[] = [];
        for (const c of t.clips) {
          const end = c.start + c.duration;
          if (!targets.has(c.id)) { clips.push(c.start >= b - EPS ? shift(c) : c); continue; }
          if (end <= a + EPS) { clips.push(c); continue; }
          if (c.start >= b - EPS) { clips.push(shift(c)); continue; }
          // The cut overlaps this clip: keep what's before a and after b.
          const hasLeft = c.start < a - EPS;
          if (hasLeft) clips.push(trimTo(c, c.start, a));
          if (end > b + EPS) {
            const right = trimTo(c, b, end);
            const id = hasLeft ? uid('clp') : c.id;
            targets.add(id);
            clips.push({ ...right, id, start: right.start - len });
          }
        }
        return { ...t, clips: clips.sort((x, y) => x.start - y.start) };
      }),
    };
  }
  return project;
}

/** A copy of a clip limited to timeline [a, b] (a, b inside the clip). */
function trimTo(c: Clip, a: number, b: number): Clip {
  const offset = a - c.start;
  const duration = b - a;
  const sourceIn = c.reverse ? c.sourceIn + (c.start + c.duration - b) * c.speed : c.sourceIn + offset * c.speed;
  const keyframes: Clip['keyframes'] = {};
  for (const [prop, keys] of Object.entries(c.keyframes)) {
    const shifted = (keys as Keyframe[]).map((k) => ({ ...k, t: k.t - offset })).filter((k) => k.t >= -EPS && k.t <= duration + EPS);
    if (shifted.length) keyframes[prop as keyof Clip['keyframes']] = shifted;
  }
  return {
    ...c,
    start: a,
    duration,
    sourceIn,
    keyframes,
    fadeIn: offset > EPS ? 0 : c.fadeIn,
    videoFadeIn: offset > EPS ? 0 : c.videoFadeIn,
    fadeOut: b < c.start + c.duration - EPS ? 0 : c.fadeOut,
    videoFadeOut: b < c.start + c.duration - EPS ? 0 : c.videoFadeOut,
    transitionOut: b < c.start + c.duration - EPS ? undefined : c.transitionOut,
  };
}

/** Clips that share media with `clipId` and overlap it in time (e.g. its detached audio). */
export function linkedClips(p: Project, clipId: string): string[] {
  const loc = findClip(p, clipId);
  if (!loc) return [];
  const c = loc.clip;
  return p.tracks.flatMap((t) => t.clips)
    .filter((x) => x.id === c.id || (x.mediaId && x.mediaId === c.mediaId && Math.abs(x.start - c.start) < 1e-3 && Math.abs(x.sourceIn - c.sourceIn) < 1e-3))
    .map((x) => x.id);
}

/* ------------------------------------------------------------------ */
/* Filler words                                                           */
/* ------------------------------------------------------------------ */

export const FILLER_WORDS = ['um', 'umm', 'uh', 'uhh', 'erm', 'er', 'ah', 'ahh', 'hmm', 'mm', 'uhm', 'eh'];

export function normaliseWord(w: string): string {
  return w.toLowerCase().replace(/[^\p{L}']/gu, '');
}

/** Words (clip-relative or absolute – whatever you pass in) that are fillers. */
export function findFillers(words: WordTiming[], extra: string[] = []): WordTiming[] {
  const set = new Set([...FILLER_WORDS, ...extra.map(normaliseWord)]);
  return words.filter((w) => set.has(normaliseWord(w.text)));
}

/* ------------------------------------------------------------------ */
/* Scene detection                                                        */
/* ------------------------------------------------------------------ */

/**
 * Pick scene cuts from frame-difference scores. `sensitivity` 0..1 (higher
 * finds more cuts). Uses a local adaptive threshold so a busy gameplay
 * section doesn't flood the result.
 */
export function detectScenes(diffs: number[], times: number[], sensitivity = 0.5, minScene = 0.6): number[] {
  const k = 4.5 - 3.5 * sensitivity;
  const floor = 0.06 + 0.14 * (1 - sensitivity);
  const cuts: number[] = [];
  const win = 15;
  for (let i = 1; i < diffs.length; i++) {
    const lo = Math.max(1, i - win), hi = Math.min(diffs.length, i + win + 1);
    let sum = 0, sq = 0, n = 0;
    for (let j = lo; j < hi; j++) if (j !== i) { sum += diffs[j]; sq += diffs[j] * diffs[j]; n++; }
    const mean = n ? sum / n : 0;
    const sd = n ? Math.sqrt(Math.max(0, sq / n - mean * mean)) : 0;
    const isPeak = diffs[i] >= (diffs[i - 1] ?? 0) && diffs[i] >= (diffs[i + 1] ?? 0);
    if (isPeak && diffs[i] > floor && diffs[i] > mean + k * sd) {
      const t = times[i];
      if (!cuts.length || t - cuts[cuts.length - 1] >= minScene) cuts.push(t);
    }
  }
  return cuts;
}

/* ------------------------------------------------------------------ */
/* Highlights                                                             */
/* ------------------------------------------------------------------ */

export interface Highlight { start: number; end: number; score: number; reason: string }

/**
 * Suggest the most lively stretches of a long recording: loud/excited audio,
 * lots of on-screen action and scene changes. Heuristic, not a neural model.
 */
export function suggestHighlights(opts: {
  duration: number;
  loudness?: number[]; perSecond?: number;
  diffs?: number[]; times?: number[];
  length: number; count: number;
}): Highlight[] {
  const { duration, length, count } = opts;
  if (duration <= length) return [{ start: 0, end: duration, score: 1, reason: 'Whole clip' }];
  const step = 0.5;
  const n = Math.floor(duration / step);
  const audio = new Float64Array(n), action = new Float64Array(n);
  if (opts.loudness && opts.perSecond) {
    const ps = opts.perSecond;
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let j = Math.floor(i * step * ps); j < Math.floor((i + 1) * step * ps) && j < opts.loudness.length; j++) { s += opts.loudness[j]; c++; }
      audio[i] = c ? s / c : 0;
    }
  }
  if (opts.diffs && opts.times) {
    for (let j = 0; j < opts.diffs.length; j++) {
      const i = Math.floor(opts.times[j] / step);
      if (i >= 0 && i < n) action[i] = Math.max(action[i], opts.diffs[j]);
    }
  }
  const norm = (a: Float64Array) => {
    const s = Array.from(a).sort((x, y) => x - y);
    const lo = s[Math.floor(s.length * 0.05)] ?? 0, hi = s[Math.floor(s.length * 0.95)] ?? 1;
    return Array.from(a, (v) => (hi > lo ? Math.max(0, Math.min(1, (v - lo) / (hi - lo))) : 0));
  };
  const A = norm(audio), M = norm(action);
  const hasA = !!opts.loudness, hasM = !!opts.diffs;
  const score = A.map((a, i) => (hasA ? a * 0.6 : 0) + (hasM ? M[i] * (hasA ? 0.4 : 1) : 0));
  const w = Math.max(1, Math.round(length / step));
  const windows: Highlight[] = [];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += score[i];
    if (i >= w) acc -= score[i - w];
    if (i >= w - 1) {
      const start = (i - w + 1) * step;
      const aAvg = A.slice(i - w + 1, i + 1).reduce((x, y) => x + y, 0) / w;
      const mAvg = M.slice(i - w + 1, i + 1).reduce((x, y) => x + y, 0) / w;
      windows.push({ start, end: Math.min(duration, start + length), score: acc / w, reason: hasA && aAvg >= mAvg ? 'Loud, energetic audio' : 'Lots of on-screen action' });
    }
  }
  windows.sort((x, y) => y.score - x.score);
  const picked: Highlight[] = [];
  for (const h of windows) {
    if (picked.length >= count) break;
    if (picked.some((p) => h.start < p.end && h.end > p.start)) continue;
    picked.push(h);
  }
  return picked.sort((x, y) => x.start - y.start);
}

/* ------------------------------------------------------------------ */
/* Reframing / tracking → keyframes                                       */
/* ------------------------------------------------------------------ */

/** Fill gaps (value < 0 = unknown) and smooth a 0..1 track. */
export function smoothTrack(values: number[], strength = 0.85): number[] {
  const out = values.slice();
  let last = out.find((v) => v >= 0) ?? 0.5;
  for (let i = 0; i < out.length; i++) { if (out[i] < 0) out[i] = last; else last = out[i]; }
  // Forward-backward exponential smoothing: no lag, gentle camera.
  const a = 1 - strength;
  for (let i = 1; i < out.length; i++) out[i] = out[i - 1] + a * (out[i] - out[i - 1]);
  for (let i = out.length - 2; i >= 0; i--) out[i] = out[i + 1] + a * (out[i] - out[i + 1]);
  return out;
}

/** Keep only the keyframes needed to stay within `tolerance` of the full curve. */
export function simplifyKeys(keys: Keyframe[], tolerance: number): Keyframe[] {
  if (keys.length <= 2) return keys;
  const keep = new Array(keys.length).fill(false);
  keep[0] = keep[keys.length - 1] = true;
  const rec = (i: number, j: number) => {
    let worst = -1, dist = tolerance;
    for (let k = i + 1; k < j; k++) {
      const x = (keys[k].t - keys[i].t) / (keys[j].t - keys[i].t || 1);
      const v = keys[i].v + (keys[j].v - keys[i].v) * x;
      const d = Math.abs(v - keys[k].v);
      if (d > dist) { dist = d; worst = k; }
    }
    if (worst >= 0) { keep[worst] = true; rec(i, worst); rec(worst, j); }
  };
  rec(0, keys.length - 1);
  return keys.filter((_, i) => keep[i]);
}

/**
 * Auto-reframe: given the subject's horizontal/vertical position in the source
 * over time (0..1, -1 = unknown), fill the frame (cover) and pan with
 * keyframes so the subject stays in shot. Returns the updated project.
 */
export function applyReframe(p: Project, clipId: string, times: number[], xs: number[], ys: number[] | null, smoothing = 0.85): Project {
  const loc = findClip(p, clipId);
  if (!loc || !loc.clip.mediaId) return p;
  const clip = loc.clip;
  const media = p.media.find((m) => m.id === clip.mediaId);
  if (!media?.width || !media.height) return p;
  const W = p.settings.width, H = p.settings.height;
  const s = Math.max(W / media.width, H / media.height);
  const dw = media.width * s * clip.transform.scale, dh = media.height * s * clip.transform.scale;
  const maxX = Math.max(0, (dw - W) / 2) / W, maxY = Math.max(0, (dh - H) / 2) / H;
  const sx = smoothTrack(xs, smoothing);
  const sy = ys ? smoothTrack(ys, smoothing) : null;
  const toKey = (i: number, v: number): Keyframe => ({ t: (times[i] - clip.sourceIn) / clip.speed, v, ease: 'linear' });
  const inClip = (i: number) => { const lt = (times[i] - clip.sourceIn) / clip.speed; return lt >= -EPS && lt <= clip.duration + EPS; };
  const xKeys: Keyframe[] = [], yKeys: Keyframe[] = [];
  for (let i = 0; i < times.length; i++) {
    if (!inClip(i)) continue;
    xKeys.push(toKey(i, Math.max(-maxX, Math.min(maxX, -((sx[i] - 0.5) * dw) / W))));
    if (sy) yKeys.push(toKey(i, Math.max(-maxY, Math.min(maxY, -((sy[i] - 0.5) * dh) / H))));
  }
  return updateClip(p, clipId, (c) => {
    const kf = { ...c.keyframes };
    if (maxX > 0 && xKeys.length) kf.x = simplifyKeys(xKeys, 0.004); else delete kf.x;
    if (sy && maxY > 0 && yKeys.length) kf.y = simplifyKeys(yKeys, 0.004); else if (sy) delete kf.y;
    return { ...c, fit: 'cover', keyframes: kf };
  });
}

/**
 * Make an overlay clip follow a tracked point on a video clip. `points` are
 * positions in the source frame (0..1) at source `times`.
 */
export function attachToTrack(p: Project, videoClipId: string, overlayId: string, times: number[], points: { x: number; y: number }[], offset = { x: 0, y: 0 }): Project {
  const base = findClip(p, videoClipId)?.clip;
  const over = findClip(p, overlayId)?.clip;
  if (!base || !over || !base.mediaId) return p;
  const media = p.media.find((m) => m.id === base.mediaId);
  if (!media?.width || !media.height) return p;
  const W = p.settings.width, H = p.settings.height;
  const fitScale = base.fit === 'cover' ? Math.max(W / media.width, H / media.height) : base.fit === 'fill' ? NaN : Math.min(W / media.width, H / media.height);
  const dw = (Number.isNaN(fitScale) ? W : media.width * fitScale) * base.transform.scale;
  const dh = (Number.isNaN(fitScale) ? H : media.height * fitScale) * base.transform.scale;
  const xKeys: Keyframe[] = [], yKeys: Keyframe[] = [];
  for (let i = 0; i < times.length; i++) {
    const tl = base.start + (times[i] - base.sourceIn) / base.speed; // timeline time
    const lt = tl - over.start;
    if (lt < -EPS || lt > over.duration + EPS) continue;
    const bx = base.keyframes.x ? interp(base.keyframes.x, tl - base.start) : base.transform.x;
    const by = base.keyframes.y ? interp(base.keyframes.y, tl - base.start) : base.transform.y;
    const px = bx + ((points[i].x - 0.5) * dw) / W * (base.transform.flipH ? -1 : 1);
    const py = by + ((points[i].y - 0.5) * dh) / H * (base.transform.flipV ? -1 : 1);
    xKeys.push({ t: lt, v: px + offset.x, ease: 'linear' });
    yKeys.push({ t: lt, v: py + offset.y, ease: 'linear' });
  }
  if (!xKeys.length) return p;
  return updateClip(p, overlayId, (c) => ({ ...c, keyframes: { ...c.keyframes, x: simplifyKeys(xKeys, 0.002), y: simplifyKeys(yKeys, 0.002) } }));
}

function interp(keys: Keyframe[], t: number): number {
  if (t <= keys[0].t) return keys[0].v;
  for (let i = 0; i < keys.length - 1; i++) {
    if (t <= keys[i + 1].t) {
      const x = (t - keys[i].t) / (keys[i + 1].t - keys[i].t || 1);
      return keys[i].v + (keys[i + 1].v - keys[i].v) * x;
    }
  }
  return keys[keys.length - 1].v;
}

/**
 * Tracked blur/pixelate: a muted copy of the clip on the track above, with a
 * blur (or pixelate) effect and an ellipse mask whose position follows the
 * tracked points. Returns the new clip's id.
 */
export function trackedBlur(
  p: Project, clipId: string, times: number[], points: { x: number; y: number }[],
  opts: { kind: 'blur' | 'pixelate'; size: number; amount: number },
): { project: Project; clipId: string } | null {
  const loc = findClip(p, clipId);
  if (!loc || loc.clip.kind !== 'video' || loc.clip.reverse) return null;
  const base = loc.clip;
  const cr = base.transform.crop;
  const cw = Math.max(1e-3, 1 - cr.left - cr.right), ch = Math.max(1e-3, 1 - cr.top - cr.bottom);
  const xKeys: Keyframe[] = [], yKeys: Keyframe[] = [];
  for (let i = 0; i < times.length; i++) {
    const lt = base.freeze ? 0 : (times[i] - base.sourceIn) / base.speed;
    if (lt < -EPS || lt > base.duration + EPS) continue;
    xKeys.push({ t: Math.max(0, lt), v: (points[i].x - cr.left) / cw - 0.5, ease: 'linear' });
    yKeys.push({ t: Math.max(0, lt), v: (points[i].y - cr.top) / ch - 0.5, ease: 'linear' });
  }
  if (!xKeys.length) return null;
  const media = p.media.find((m) => m.id === base.mediaId);
  // Picture aspect (after crop) so the ellipse comes out round.
  const aspect = media?.width && media.height ? (media.width * cw) / (media.height * ch) : 16 / 9;
  const fx: EffectInstance = opts.kind === 'blur'
    ? { id: uid('fx'), type: 'blur', enabled: true, params: { radius: opts.amount } }
    : { id: uid('fx'), type: 'pixelate', enabled: true, params: { size: opts.amount } };
  // Keep transform keyframes so the copy lines up exactly; drop effect/audio ones (they refer to the original's effects).
  const keyframes: Clip['keyframes'] = {};
  for (const [k, v] of Object.entries(base.keyframes)) if (!k.startsWith('fx.') && !k.startsWith('afx.') && k !== 'volume') keyframes[k] = v;
  const copy: Clip = {
    ...base,
    id: uid('clp'),
    name: `${base.name} (${opts.kind === 'blur' ? 'blur' : 'pixelate'})`,
    muted: true,
    audioFx: [],
    transitionOut: undefined,
    keyframes,
    effects: [fx],
    masks: [{
      id: uid('msk'), name: 'Tracked area', type: 'ellipse', x: xKeys[0].v, y: yKeys[0].v, w: opts.size, h: Math.min(2, opts.size * aspect),
      rotation: 0, roundness: 0, points: [], feather: 16, opacity: 1, invert: false, mode: 'add',
      keyframes: { x: simplifyKeys(xKeys, 0.002), y: simplifyKeys(yKeys, 0.002) },
    }],
  };
  // Track directly above the clip's own track (create one if it's busy there).
  const ti = loc.trackIndex;
  const tracks = p.tracks.slice();
  const above = ti > 0 ? tracks[ti - 1] : null;
  const fits = above && above.kind === 'visual' && !above.locked && above.clips.every((c) => c.start >= copy.start + copy.duration - EPS || c.start + c.duration <= copy.start + EPS);
  if (fits && above) tracks[ti - 1] = { ...above, clips: [...above.clips, copy].sort((a, b) => a.start - b.start) };
  else tracks.splice(ti, 0, { id: uid('trk'), kind: 'visual', name: 'Blur', clips: [copy], muted: false, hidden: false, locked: false });
  return { project: { ...p, tracks }, clipId: copy.id };
}
