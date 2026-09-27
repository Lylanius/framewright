/**
 * Background pre-rendering plan (pure logic, unit-tested).
 *
 * The timeline is cut into short chunks. A chunk is "heavy" when it's likely
 * to play below full speed (effects, masks, keying, adjustment layers,
 * transitions, lots of layers). Heavy chunks can be rendered to a small video
 * in the background and played back from that. Each chunk has a key: a hash of
 * everything that affects its picture, so any edit to that part of the
 * timeline automatically makes the old render stale.
 */
import { trackTransitions } from './transitions';
import type { Clip, Project } from './types';

export const CHUNK_SECONDS = 2;

export function chunkCount(duration: number): number {
  return Math.max(0, Math.ceil(duration / CHUNK_SECONDS - 1e-9));
}

export function chunkRange(i: number): [number, number] {
  return [i * CHUNK_SECONDS, (i + 1) * CHUNK_SECONDS];
}

/** The clip minus fields that only affect sound or labels (they don't change the picture). */
function visualJson(c: Clip): string {
  const { volume: _v, fadeIn: _fi, fadeOut: _fo, audioFx: _a, muted: _m, keepPitch: _k, name: _n, locked: _l, keyframes, ...rest } = c;
  void _v; void _fi; void _fo; void _a; void _m; void _k; void _n; void _l;
  const kf: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(keyframes)) if (k !== 'volume' && !k.startsWith('afx.')) kf[k] = v;
  return JSON.stringify({ ...rest, keyframes: kf });
}

/** 53-bit FNV-1a-style hash of a string, as hex. */
export function hashString(s: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822519);
  }
  return ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0'));
}

/** Visual clips that can show up in chunk i (with a margin for transitions, which extend clips). */
function clipsNear(p: Project, i: number): { clip: Clip; track: number }[] {
  const [a, b] = chunkRange(i);
  const out: { clip: Clip; track: number }[] = [];
  p.tracks.forEach((t, ti) => {
    if (t.kind !== 'visual' || t.hidden) return;
    for (const c of t.clips) if (c.start < b + 2.5 && c.start + c.duration > a - 2.5) out.push({ clip: c, track: ti });
  });
  return out;
}

export function chunkKey(p: Project, i: number): string {
  const s = p.settings;
  const parts = [`${s.width}x${s.height}@${s.fps}:${s.background}:${i}`];
  const media = new Set<string>();
  for (const { clip, track } of clipsNear(p, i)) {
    parts.push(`${track}:${visualJson(clip)}`);
    if (clip.mediaId) media.add(clip.mediaId);
  }
  for (const m of p.media) if (media.has(m.id)) parts.push(`m:${m.id}:${m.fingerprint}`);
  for (const l of p.luts ?? []) parts.push(`l:${l.id}:${l.size}`);
  return hashString(parts.join('\n'));
}

function heavyClip(c: Clip): boolean {
  if (c.kind === 'adjustment') return true;
  if (c.masks?.length) return true;
  return c.effects.some((e) => e.enabled && e.type !== 'shake' && e.type !== 'pulse');
}

/** Will this chunk probably play below full speed if drawn live? */
export function isHeavyChunk(p: Project, i: number): boolean {
  const [a, b] = chunkRange(i);
  let layers = 0;
  for (const { clip } of clipsNear(p, i)) {
    if (clip.start >= b || clip.start + clip.duration <= a) continue;
    if (heavyClip(clip)) return true;
    if (clip.kind === 'video' || clip.kind === 'image') layers++;
  }
  if (layers >= 3) return true;
  for (const t of p.tracks) {
    if (t.kind !== 'visual' || t.hidden) continue;
    for (const w of trackTransitions(t)) if (w.start < b && w.start + w.duration > a) return true;
  }
  return false;
}
