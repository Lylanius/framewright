/**
 * Timeline engine: pure, immutable operations on a Project.
 *
 * Every function returns a new Project (or null when an edit is not allowed),
 * which makes undo/redo trivial and keeps the engine easy to test.
 */
import { createClipFromMedia, createTrack } from './defaults';
import { uid } from './ids';
import { rebaseKeys, scaleKeys } from './keyframes';
import { EPS } from './time';
import type { Clip, ClipKind, Project, Track, TrackKind } from './types';

export const MIN_CLIP = 1 / 30;

export interface ClipLocation {
  track: Track;
  trackIndex: number;
  clip: Clip;
  clipIndex: number;
}

export function clipEnd(c: Clip): number {
  return c.start + c.duration;
}

export function trackKindFor(kind: ClipKind): TrackKind {
  return kind === 'audio' ? 'audio' : 'visual';
}

export function findClip(p: Project, clipId: string): ClipLocation | null {
  for (let ti = 0; ti < p.tracks.length; ti++) {
    const track = p.tracks[ti];
    const ci = track.clips.findIndex((c) => c.id === clipId);
    if (ci >= 0) return { track, trackIndex: ti, clip: track.clips[ci], clipIndex: ci };
  }
  return null;
}

export function allClips(p: Project): Clip[] {
  return p.tracks.flatMap((t) => t.clips);
}

export function projectDuration(p: Project): number {
  let end = 0;
  for (const t of p.tracks) for (const c of t.clips) end = Math.max(end, clipEnd(c));
  return end;
}

/** Longest the clip can be on the timeline given its source media (Infinity for stills/text). */
export function maxClipDuration(p: Project, c: Clip): number {
  if ((c.kind !== 'video' && c.kind !== 'audio') || c.freeze) return Infinity;
  const m = p.media.find((x) => x.id === c.mediaId);
  if (!m || !m.duration) return Infinity;
  return Math.max(MIN_CLIP, (m.duration - c.sourceIn) / c.speed);
}

/** Map a timeline time to the clip's source-media time. */
export function sourceTimeAt(c: Clip, t: number): number {
  if (c.freeze) return c.sourceIn;
  const local = Math.min(Math.max(0, t - c.start), c.duration);
  return c.reverse ? c.sourceIn + (c.duration - local) * c.speed : c.sourceIn + local * c.speed;
}

export function canPlace(track: Track, start: number, duration: number, excludeId?: string): boolean {
  if (start < -EPS) return false;
  const end = start + duration;
  return track.clips.every((c) => c.id === excludeId || end <= c.start + EPS || start >= clipEnd(c) - EPS);
}

function sortClips(clips: Clip[]): Clip[] {
  return clips.slice().sort((a, b) => a.start - b.start);
}

function replaceTrack(p: Project, trackIndex: number, track: Track): Project {
  const tracks = p.tracks.slice();
  tracks[trackIndex] = track;
  return { ...p, tracks };
}

/** Index of the bottom-most visual track: the magnetic "main" track. */
/** The main footage track: the lowest visual track that isn't a background layer. */
export function mainTrackIndex(p: Project): number {
  for (let i = p.tracks.length - 1; i >= 0; i--) if (p.tracks[i].kind === 'visual' && p.tracks[i].role !== 'background') return i;
  for (let i = p.tracks.length - 1; i >= 0; i--) if (p.tracks[i].kind === 'visual') return i;
  return -1;
}

/** Pack the clips of a track end-to-end from zero (magnetic behaviour). */
export function packTrack(track: Track): Track {
  let cursor = 0;
  const clips = sortClips(track.clips).map((c) => {
    const nc = { ...c, start: cursor };
    cursor += c.duration;
    return nc;
  });
  return { ...track, clips };
}

function applyMagnetic(p: Project): Project {
  if (!p.magnetic) return p;
  const mi = mainTrackIndex(p);
  if (mi < 0) return p;
  return replaceTrack(p, mi, packTrack(p.tracks[mi]));
}

export function updateClip(p: Project, clipId: string, patch: Partial<Clip> | ((c: Clip) => Clip)): Project {
  const loc = findClip(p, clipId);
  if (!loc) return p;
  const next = typeof patch === 'function' ? patch(loc.clip) : { ...loc.clip, ...patch };
  const clips = loc.track.clips.slice();
  clips[loc.clipIndex] = next;
  return replaceTrack(p, loc.trackIndex, { ...loc.track, clips: sortClips(clips) });
}

export function addClipToTrack(p: Project, trackId: string, clip: Clip): Project | null {
  const ti = p.tracks.findIndex((t) => t.id === trackId);
  if (ti < 0) return null;
  const track = p.tracks[ti];
  if (track.kind !== trackKindFor(clip.kind)) return null;
  if (!canPlace(track, clip.start, clip.duration)) return null;
  return applyMagnetic(replaceTrack(p, ti, { ...track, clips: sortClips([...track.clips, clip]) }));
}

/**
 * Put a clip on the first compatible, unlocked track with room at `clip.start`,
 * creating a new track when none has space. New visual tracks go on top so
 * overlays sit above the main footage.
 */
export function insertClipAuto(p: Project, clip: Clip, preferTrackId?: string): { project: Project; trackId: string } {
  const kind = trackKindFor(clip.kind);
  const candidates = p.tracks
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.kind === kind && !t.locked && t.role !== 'background');
  // Prefer the requested track, then the main track for visuals, then bottom-up.
  candidates.sort((a, b) => {
    if (a.t.id === preferTrackId) return -1;
    if (b.t.id === preferTrackId) return 1;
    return kind === 'visual' ? b.i - a.i : a.i - b.i;
  });
  for (const { t } of candidates) {
    const res = addClipToTrack(p, t.id, clip);
    if (res) return { project: res, trackId: t.id };
  }
  const track = createTrack(kind, kind === 'visual' ? `Overlay ${p.tracks.filter((t) => t.kind === 'visual').length}` : `Audio ${p.tracks.filter((t) => t.kind === 'audio').length + 1}`);
  track.clips = [clip];
  const tracks = p.tracks.slice();
  if (kind === 'visual') tracks.unshift(track);
  else tracks.push(track);
  return { project: applyMagnetic({ ...p, tracks }), trackId: track.id };
}

/**
 * Put an adjustment layer on top of everything: on the top visual track if it
 * already holds only adjustment clips and has room, otherwise on a new top track.
 */
export function addAdjustmentLayer(p: Project, clip: Clip): Project {
  const top = p.tracks.find((t) => t.kind === 'visual');
  if (top && !top.locked && top.clips.length && top.clips.every((c) => c.kind === 'adjustment')) {
    const r = addClipToTrack(p, top.id, clip);
    if (r) return r;
  }
  const track = createTrack('visual', 'Adjustments');
  track.clips = [clip];
  return applyMagnetic({ ...p, tracks: [track, ...p.tracks] });
}

/**
 * Put a clip above the main picture (stickers, logos, shapes): the highest
 * overlay track with room, or a new track on top.
 */
export function addOverlayClip(p: Project, clip: Clip): Project {
  const mi = mainTrackIndex(p);
  for (let i = 0; i < p.tracks.length; i++) {
    const t = p.tracks[i];
    if (i === mi || t.kind !== 'visual' || t.locked || t.role === 'captions' || t.role === 'background') continue;
    if (t.clips.length && t.clips.every((c) => c.kind === 'adjustment')) continue;
    const r = addClipToTrack(p, t.id, clip);
    if (r) return r;
  }
  const track = createTrack('visual', `Overlay ${p.tracks.filter((t) => t.kind === 'visual').length}`);
  track.clips = [clip];
  // Below any adjustment-only tracks so grades still apply on top.
  const at = p.tracks.findIndex((t) => !(t.kind === 'visual' && t.clips.length && t.clips.every((c) => c.kind === 'adjustment')));
  const tracks = p.tracks.slice();
  tracks.splice(Math.max(0, at), 0, track);
  return applyMagnetic({ ...p, tracks });
}

/** Insert a whole visual track on top of the stack (below adjustment-only tracks, so grades still apply). */
export function createTrackAbove(p: Project, track: Track): Project {
  const at = p.tracks.findIndex((t) => !(t.kind === 'visual' && t.clips.length && t.clips.every((c) => c.kind === 'adjustment')));
  const tracks = p.tracks.slice();
  tracks.splice(Math.max(0, at), 0, track);
  return { ...p, tracks };
}

/** Put a clip underneath everything (backgrounds): a visual track below the main one. */
export function addUnderlayClip(p: Project, clip: Clip): Project {
  const mi = mainTrackIndex(p);
  for (let i = mi + 1; i < p.tracks.length; i++) {
    const t = p.tracks[i];
    if (t.kind !== 'visual' || t.locked || t.role !== 'background') continue;
    const r = addClipToTrack(p, t.id, clip);
    if (r) return r;
  }
  const track = createTrack('visual', 'Background');
  track.role = 'background';
  track.clips = [clip];
  const tracks = p.tracks.slice();
  tracks.splice(mi + 1, 0, track);
  return { ...p, tracks };
}

/**
 * Layer order (Canva-style "bring forward / send backward"): move a visual clip
 * to the next track up or down that has room at its time, creating a track if
 * none does. 'front' / 'back' go past every other visual clip at that time.
 */
export function moveClipLayer(p: Project, clipId: string, dir: 'up' | 'down' | 'front' | 'back'): Project | null {
  const loc = findClip(p, clipId);
  if (!loc || loc.track.kind !== 'visual' || loc.clip.locked) return null;
  const c = loc.clip;
  const overlaps = (t: Track) => t.clips.some((x) => x.id !== c.id && x.start < c.start + c.duration - EPS && x.start + x.duration > c.start + EPS);
  const visual = p.tracks.map((t, i) => ({ t, i })).filter(({ t }) => t.kind === 'visual' && t.role !== 'captions');
  const pos = visual.findIndex((v) => v.i === loc.trackIndex);
  const without = (q: Project) => replaceTrack(q, loc.trackIndex, { ...loc.track, clips: loc.track.clips.filter((x) => x.id !== c.id) });
  const up = dir === 'up' || dir === 'front';
  // Tracks we'd have to pass: up = towards index 0.
  const path = up ? visual.slice(0, pos).reverse() : visual.slice(pos + 1);
  if (dir === 'up' || dir === 'down') {
    // Find the next track that has something at this time (the layer we're swapping with), then land just past it.
    const next = path.findIndex((v) => overlaps(v.t));
    if (next < 0) return null; // already top/bottom at this time
    const mi = mainTrackIndex(p);
    if (!up && path[next].i === mi) return null; // overlays stay above the main footage
    const beyond = path.slice(next + 1).find((v) => !overlaps(v.t) && !v.t.locked && v.t.role !== 'background' && v.i !== mi);
    if (beyond) return addClipToTrack(without(p), beyond.t.id, c);
    return newTrackBeside(without(p), path[next].t.id, c, up);
  }
  const mi0 = mainTrackIndex(p);
  const blockers = path.filter((v) => overlaps(v.t) && (up || v.i !== mi0) && v.t.role !== 'background');
  if (!blockers.length) return null;
  const last = blockers[blockers.length - 1];
  return newTrackBeside(without(p), last.t.id, c, up);
}

/** New track just above/below another. Never below the main footage track (so "main" stays main). */
function newTrackBeside(p: Project, trackId: string, clip: Clip, above: boolean): Project {
  const mi = mainTrackIndex(p);
  let i = p.tracks.findIndex((t) => t.id === trackId);
  if (!above && i >= mi) { i = mi; above = true; }
  const track = createTrack('visual', `Layer ${p.tracks.filter((t) => t.kind === 'visual').length + 1}`);
  track.clips = [clip];
  const tracks = p.tracks.slice();
  tracks.splice(above ? i : i + 1, 0, track);
  return { ...p, tracks };
}

/** Add media at a time (used by library "add" buttons and drag-drop). */
export function addMediaClip(p: Project, mediaId: string, at: number, preferTrackId?: string): { project: Project; clipId: string } | null {
  const media = p.media.find((m) => m.id === mediaId);
  if (!media) return null;
  const clip = createClipFromMedia(media, Math.max(0, at));
  const { project } = insertClipAuto(p, clip, preferTrackId);
  return { project, clipId: clip.id };
}

/** Move a clip to a new start (and optionally another track). Returns null if it would overlap. */
export function moveClip(p: Project, clipId: string, newStart: number, targetTrackId?: string): Project | null {
  const loc = findClip(p, clipId);
  if (!loc || loc.clip.locked || loc.track.locked) return null;
  const start = Math.max(0, newStart);
  const destIndex = targetTrackId ? p.tracks.findIndex((t) => t.id === targetTrackId) : loc.trackIndex;
  if (destIndex < 0) return null;
  const dest = p.tracks[destIndex];
  if (dest.locked || dest.kind !== loc.track.kind) return null;
  if (!canPlace(dest, start, loc.clip.duration, clipId)) return null;
  const moved = { ...loc.clip, start };
  if (destIndex === loc.trackIndex) {
    const clips = loc.track.clips.map((c) => (c.id === clipId ? moved : c));
    return applyMagnetic(replaceTrack(p, loc.trackIndex, { ...loc.track, clips: sortClips(clips) }));
  }
  const tracks = p.tracks.slice();
  tracks[loc.trackIndex] = { ...loc.track, clips: loc.track.clips.filter((c) => c.id !== clipId) };
  tracks[destIndex] = { ...dest, clips: sortClips([...dest.clips, moved]) };
  return applyMagnetic({ ...p, tracks });
}

function neighbourBounds(track: Track, clip: Clip): { prevEnd: number; nextStart: number } {
  let prevEnd = 0, nextStart = Infinity;
  for (const c of track.clips) {
    if (c.id === clip.id) continue;
    if (clipEnd(c) <= clip.start + EPS) prevEnd = Math.max(prevEnd, clipEnd(c));
    if (c.start >= clipEnd(clip) - EPS) nextStart = Math.min(nextStart, c.start);
  }
  return { prevEnd, nextStart };
}

/** Drag the left edge of a clip to `newStart` (timeline seconds). */
export function trimStart(p: Project, clipId: string, newStart: number): Project {
  const loc = findClip(p, clipId);
  if (!loc || loc.clip.locked || loc.track.locked) return p;
  const c = loc.clip;
  const { prevEnd } = neighbourBounds(loc.track, c);
  const end = clipEnd(c);
  let lo = prevEnd;
  const timed = (c.kind === 'video' || c.kind === 'audio') && !c.freeze;
  if (timed && !c.reverse) lo = Math.max(lo, c.start - c.sourceIn / c.speed);
  if (timed && c.reverse) lo = Math.max(lo, end - maxClipDuration(p, c));
  const start = Math.min(Math.max(newStart, lo, 0), end - MIN_CLIP);
  const delta = start - c.start; // + = shorter
  const duration = end - start;
  const sourceIn = c.reverse || c.freeze ? c.sourceIn : Math.max(0, c.sourceIn + delta * c.speed);
  const keyframes = rebaseKeys(c.keyframes, delta, duration);
  return applyMagnetic(updateClip(p, clipId, { start, duration, sourceIn, keyframes }));
}

/** Drag the right edge of a clip to `newEnd` (timeline seconds). */
export function trimEnd(p: Project, clipId: string, newEnd: number): Project {
  const loc = findClip(p, clipId);
  if (!loc || loc.clip.locked || loc.track.locked) return p;
  const c = loc.clip;
  const { nextStart } = neighbourBounds(loc.track, c);
  let hi = nextStart;
  if ((c.kind === 'video' || c.kind === 'audio') && !c.freeze) {
    if (!c.reverse) hi = Math.min(hi, c.start + maxClipDuration(p, c));
    else hi = Math.min(hi, c.start + c.duration + c.sourceIn / c.speed);
  }
  const end = Math.max(Math.min(newEnd, hi), c.start + MIN_CLIP);
  const duration = end - c.start;
  // In reverse mode the head of the source sits at the clip's end.
  const sourceIn = c.reverse && !c.freeze ? Math.max(0, c.sourceIn - (duration - c.duration) * c.speed) : c.sourceIn;
  const keyframes = rebaseKeys(c.keyframes, 0, duration);
  return applyMagnetic(updateClip(p, clipId, { duration, sourceIn, keyframes }));
}

/** Split one clip at a timeline time. Returns the id of the right-hand piece, or null if the time is outside it. */
export function splitClip(p: Project, clipId: string, time: number): { project: Project; rightId: string } | null {
  const loc = findClip(p, clipId);
  if (!loc || loc.clip.locked || loc.track.locked) return null;
  const c = loc.clip;
  const local = time - c.start;
  if (local < MIN_CLIP - EPS || c.duration - local < MIN_CLIP - EPS) return null;
  const leftDur = local, rightDur = c.duration - local;
  const left: Clip = {
    ...c,
    transitionOut: undefined,
    duration: leftDur,
    fadeOut: 0,
    videoFadeOut: 0,
    sourceIn: c.reverse && !c.freeze ? c.sourceIn + rightDur * c.speed : c.sourceIn,
    keyframes: rebaseKeys(c.keyframes, 0, leftDur),
  };
  const right: Clip = {
    ...c,
    id: uid('clp'),
    start: time,
    duration: rightDur,
    fadeIn: 0,
    videoFadeIn: 0,
    sourceIn: c.reverse || c.freeze ? c.sourceIn : c.sourceIn + leftDur * c.speed,
    effects: c.effects.map((e) => ({ ...e, id: uid('fx'), params: { ...e.params } })),
    keyframes: rebaseKeys(c.keyframes, leftDur, rightDur),
  };
  const clips = loc.track.clips.slice();
  clips.splice(loc.clipIndex, 1, left, right);
  return { project: replaceTrack(p, loc.trackIndex, { ...loc.track, clips }), rightId: right.id };
}

/** Split every unlocked clip under the playhead (or only `onlyIds` if given). */
export function splitAt(p: Project, time: number, onlyIds?: string[]): { project: Project; newIds: string[] } {
  let project = p;
  const newIds: string[] = [];
  for (const t of p.tracks) {
    if (t.locked) continue;
    for (const c of t.clips) {
      if (onlyIds && onlyIds.length && !onlyIds.includes(c.id)) continue;
      if (time > c.start + EPS && time < clipEnd(c) - EPS) {
        const r = splitClip(project, c.id, time);
        if (r) { project = r.project; newIds.push(r.rightId); }
      }
    }
  }
  return { project, newIds };
}

/** Delete clips. With ripple, later clips on the same track slide left to fill the gap. */
export function deleteClips(p: Project, ids: string[], ripple = false): Project {
  const idSet = new Set(ids);
  const tracks = p.tracks.map((t) => {
    if (t.locked) return t;
    const removed = t.clips.filter((c) => idSet.has(c.id) && !c.locked);
    if (!removed.length) return t;
    let clips = t.clips.filter((c) => !removed.includes(c));
    if (ripple) {
      clips = clips.map((c) => {
        let shift = 0;
        for (const r of removed) if (r.start < c.start) shift += r.duration;
        return shift ? { ...c, start: Math.max(0, c.start - shift) } : c;
      });
    }
    return { ...t, clips };
  });
  return applyMagnetic({ ...p, tracks });
}

/** Close the gap at `time` on a track (ripple-delete empty space). */
export function closeGapAt(p: Project, trackId: string, time: number): Project {
  const ti = p.tracks.findIndex((t) => t.id === trackId);
  if (ti < 0) return p;
  const t = p.tracks[ti];
  const sorted = sortClips(t.clips);
  let prevEnd = 0;
  for (const c of sorted) {
    if (c.start > time) {
      const gap = c.start - prevEnd;
      if (gap <= EPS || time < prevEnd) return p;
      return replaceTrack(p, ti, { ...t, clips: sorted.map((x) => (x.start >= c.start ? { ...x, start: x.start - gap } : x)) });
    }
    prevEnd = clipEnd(c);
  }
  return p;
}

/** Insert space: push every clip starting at/after `time` right by `amount` (ripple insert). */
export function rippleInsert(p: Project, time: number, amount: number, trackIds?: string[]): Project {
  return {
    ...p,
    tracks: p.tracks.map((t) => {
      if (t.locked || (trackIds && !trackIds.includes(t.id))) return t;
      return { ...t, clips: t.clips.map((c) => (c.start >= time - EPS ? { ...c, start: c.start + amount } : c)) };
    }),
  };
}

export function duplicateClip(p: Project, clipId: string): { project: Project; clipId: string } | null {
  const loc = findClip(p, clipId);
  if (!loc) return null;
  const copy: Clip = {
    ...structuredCloneSafe(loc.clip),
    id: uid('clp'),
    start: clipEnd(loc.clip),
    locked: false,
  };
  copy.effects = copy.effects.map((e) => ({ ...e, id: uid('fx') }));
  const direct = addClipToTrack(p, loc.track.id, copy);
  if (direct) return { project: direct, clipId: copy.id };
  const { project } = insertClipAuto(p, copy);
  return { project, clipId: copy.id };
}

/** Change playback speed. The clip's source range is kept; its timeline length changes. */
export function setSpeed(p: Project, clipId: string, speed: number): Project {
  const loc = findClip(p, clipId);
  if (!loc || loc.clip.locked) return p;
  const c = loc.clip;
  const s = Math.min(100, Math.max(0.05, speed));
  const sourceSpan = c.duration * c.speed;
  let duration = sourceSpan / s;
  const { nextStart } = neighbourBounds(loc.track, c);
  let project = p;
  if (c.start + duration > nextStart + EPS) {
    // Push following clips on this track right to make room.
    const shift = c.start + duration - nextStart;
    project = replaceTrack(p, loc.trackIndex, {
      ...loc.track,
      clips: loc.track.clips.map((x) => (x.start >= clipEnd(c) - EPS && x.id !== c.id ? { ...x, start: x.start + shift } : x)),
    });
  }
  duration = Math.max(MIN_CLIP, duration);
  const keyframes = scaleKeys(c.keyframes, duration / c.duration);
  return applyMagnetic(updateClip(project, clipId, { speed: s, duration, keyframes }));
}

/** Pull a video clip's sound onto its own audio track and mute the original. */
export function detachAudio(p: Project, clipId: string): { project: Project; audioClipId: string } | null {
  const loc = findClip(p, clipId);
  if (!loc || loc.clip.kind !== 'video') return null;
  const media = p.media.find((m) => m.id === loc.clip.mediaId);
  if (!media?.hasAudio) return null;
  const c = loc.clip;
  const audio: Clip = {
    ...structuredCloneSafe(c),
    id: uid('clp'),
    kind: 'audio',
    name: `${c.name} (audio)`,
    effects: [],
    keyframes: c.keyframes.volume ? { volume: c.keyframes.volume } : {},
  };
  let project = updateClip(p, clipId, { muted: true });
  const res = insertClipAuto(project, audio);
  project = res.project;
  return { project, audioClipId: audio.id };
}

/* ----------------------------- tracks ----------------------------- */

export function addTrack(p: Project, kind: TrackKind): Project {
  const n = p.tracks.filter((t) => t.kind === kind).length + 1;
  const track = createTrack(kind, kind === 'visual' ? `Overlay ${n - 1}` : `Audio ${n}`);
  const tracks = p.tracks.slice();
  if (kind === 'visual') tracks.unshift(track);
  else tracks.push(track);
  return { ...p, tracks };
}

export function updateTrack(p: Project, trackId: string, patch: Partial<Track>): Project {
  return { ...p, tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, ...patch } : t)) };
}

export function removeTrack(p: Project, trackId: string): Project {
  const t = p.tracks.find((x) => x.id === trackId);
  if (!t) return p;
  const sameKind = p.tracks.filter((x) => x.kind === t.kind);
  if (sameKind.length <= 1) return { ...p, tracks: p.tracks.map((x) => (x.id === trackId ? { ...x, clips: [] } : x)) };
  return { ...p, tracks: p.tracks.filter((x) => x.id !== trackId) };
}

/** Move a track up/down within tracks of its own kind. */
export function moveTrack(p: Project, trackId: string, dir: -1 | 1): Project {
  const i = p.tracks.findIndex((t) => t.id === trackId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= p.tracks.length || p.tracks[j].kind !== p.tracks[i].kind) return p;
  const tracks = p.tracks.slice();
  [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
  return { ...p, tracks };
}

/* ----------------------------- snapping ----------------------------- */

export function snapPoints(p: Project, excludeIds: string[] = [], extra: number[] = []): number[] {
  const pts = new Set<number>([0, ...extra]);
  for (const t of p.tracks) for (const c of t.clips) {
    if (excludeIds.includes(c.id)) continue;
    pts.add(c.start);
    pts.add(clipEnd(c));
  }
  for (const m of p.markers) pts.add(m.time);
  return [...pts];
}

/** Snap `t` to the nearest point within `threshold` seconds. */
export function snapTime(t: number, points: number[], threshold: number): { time: number; snapped: boolean } {
  let best = t, bestDist = threshold;
  for (const pt of points) {
    const d = Math.abs(pt - t);
    if (d <= bestDist) { best = pt; bestDist = d; }
  }
  return { time: best, snapped: best !== t };
}

/** Clips visible/audible at time t, in draw order (bottom track first). */
export function clipsAt(p: Project, t: number, kind?: TrackKind): { clip: Clip; track: Track }[] {
  const out: { clip: Clip; track: Track }[] = [];
  for (let i = p.tracks.length - 1; i >= 0; i--) {
    const track = p.tracks[i];
    if (kind && track.kind !== kind) continue;
    for (const clip of track.clips) if (t >= clip.start - EPS && t < clipEnd(clip) - EPS) out.push({ clip, track });
  }
  return out;
}

function structuredCloneSafe<T>(v: T): T {
  return typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v));
}

/** Shift several clips by the same amount on their own tracks. Returns null if anything would overlap or go below zero. */
export function moveClipsBy(p: Project, ids: string[], dt: number): Project | null {
  const idSet = new Set(ids);
  const tracks: Track[] = [];
  for (const t of p.tracks) {
    const moving = t.clips.filter((c) => idSet.has(c.id));
    if (!moving.length) { tracks.push(t); continue; }
    if (t.locked || moving.some((c) => c.locked)) return null;
    const moved = moving.map((c) => ({ ...c, start: c.start + dt }));
    if (moved.some((c) => c.start < -EPS)) return null;
    const staying = t.clips.filter((c) => !idSet.has(c.id));
    for (const m of moved) {
      if (!canPlace({ ...t, clips: staying }, m.start, m.duration)) return null;
    }
    tracks.push({ ...t, clips: sortClips([...staying, ...moved]) });
  }
  return applyMagnetic({ ...p, tracks });
}

/** Add, replace or remove (null) the transition on the cut after `clipId`. */
export function setTransition(p: Project, clipId: string, transition: Clip['transitionOut'] | null): Project {
  return updateClip(p, clipId, (c) => ({ ...c, transitionOut: transition ?? undefined }));
}

/**
 * Freeze frame: hold the picture at time t for `holdFor` seconds. The clip is
 * split at t, a still of that frame is inserted, and later clips on the track
 * slide right to make room.
 */
export function freezeFrame(p: Project, clipId: string, t: number, holdFor = 2): { project: Project; freezeId: string } | null {
  const loc = findClip(p, clipId);
  if (!loc || loc.clip.kind !== 'video' || loc.track.locked || loc.clip.locked) return null;
  const c = loc.clip;
  if (t < c.start - EPS || t > clipEnd(c) + EPS) return null;
  const at = Math.min(Math.max(t, c.start), clipEnd(c));
  let project = rippleInsert(p, at, holdFor, [loc.track.id]);
  // rippleInsert moved the clip itself if it starts at/after `at`; split what's left of it.
  const cur = findClip(project, clipId)!.clip;
  if (at > cur.start + MIN_CLIP && at < clipEnd(cur) - MIN_CLIP) {
    const r = splitClip(project, clipId, at);
    if (r) project = moveClip(r.project, r.rightId, at + holdFor) ?? r.project;
  }
  const freeze: Clip = {
    ...c,
    id: uid('clp'),
    name: `${c.name} (freeze)`,
    start: at,
    duration: holdFor,
    sourceIn: sourceTimeAt(c, Math.min(at, clipEnd(c) - 1e-3)),
    freeze: true,
    reverse: false,
    speed: 1,
    muted: true,
    fadeIn: 0, fadeOut: 0, videoFadeIn: 0, videoFadeOut: 0,
    transitionOut: undefined,
    keyframes: {},
    effects: c.effects.map((e) => ({ ...e, id: uid('fx'), params: { ...e.params } })),
  };
  const added = addClipToTrack(project, loc.track.id, freeze);
  if (!added) return null;
  return { project: added, freezeId: freeze.id };
}

export type RampPreset = 'speedUp' | 'slowDown' | 'hero' | 'bullet' | 'flashIn' | 'flashOut' | 'montage';

export const RAMP_PRESETS: { id: RampPreset; name: string; f: (u: number) => number }[] = [
  { id: 'speedUp', name: 'Speed up', f: (u) => 0.5 + 2.5 * u * u },
  { id: 'slowDown', name: 'Slow down', f: (u) => 3 - 2.5 * u * (2 - u) },
  { id: 'hero', name: 'Hero moment', f: (u) => 2 - 1.7 * Math.pow(Math.sin(Math.PI * u), 2) },
  { id: 'bullet', name: 'Bullet time', f: (u) => 1.2 - 1.0 * Math.exp(-Math.pow((u - 0.5) / 0.12, 2)) },
  { id: 'flashIn', name: 'Flash in', f: (u) => 1 + 4 * Math.pow(1 - u, 3) },
  { id: 'flashOut', name: 'Flash out', f: (u) => 1 + 4 * Math.pow(u, 3) },
  { id: 'montage', name: 'Montage', f: (u) => 1.6 + 1.2 * Math.sin(u * Math.PI * 4) },
];

/**
 * Speed ramp: rebuilds the clip as a run of short pieces whose speeds follow a
 * curve (multiplied by the clip's current speed). Later clips on the track
 * move to fit the new length. Works with every other feature unchanged.
 */
export function speedRamp(p: Project, clipId: string, curve: (u: number) => number, pieces = 12): Project | null {
  const loc = findClip(p, clipId);
  if (!loc || (loc.clip.kind !== 'video' && loc.clip.kind !== 'audio') || loc.clip.reverse || loc.clip.freeze || loc.track.locked) return null;
  const c = loc.clip;
  const srcLen = c.duration * c.speed;
  const parts: Clip[] = [];
  let t = c.start;
  for (let i = 0; i < pieces; i++) {
    const u = (i + 0.5) / pieces;
    const speed = Math.min(100, Math.max(0.05, c.speed * curve(u)));
    const dur = srcLen / pieces / speed;
    parts.push({
      ...c,
      id: i === 0 ? c.id : uid('clp'),
      start: t,
      duration: dur,
      sourceIn: c.sourceIn + (srcLen * i) / pieces,
      speed,
      keyframes: {},
      fadeIn: i === 0 ? c.fadeIn : 0, videoFadeIn: i === 0 ? c.videoFadeIn : 0,
      fadeOut: i === pieces - 1 ? c.fadeOut : 0, videoFadeOut: i === pieces - 1 ? c.videoFadeOut : 0,
      transitionOut: i === pieces - 1 ? c.transitionOut : undefined,
      effects: c.effects.map((e) => ({ ...e, id: i === 0 ? e.id : uid('fx'), params: { ...e.params } })),
      name: c.name,
    });
    t += dur;
  }
  const shift = t - clipEnd(c);
  const others = loc.track.clips.filter((x) => x.id !== c.id).map((x) => (x.start >= clipEnd(c) - EPS ? { ...x, start: x.start + shift } : x));
  return applyMagnetic(replaceTrack(p, loc.trackIndex, { ...loc.track, clips: sortClips([...others, ...parts]) }));
}
