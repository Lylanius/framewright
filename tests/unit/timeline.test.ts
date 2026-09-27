import { describe, expect, it } from 'vitest';
import {
  addMediaClip, canPlace, clipEnd, closeGapAt, deleteClips, detachAudio, duplicateClip, findClip, insertClipAuto,
  maxClipDuration, moveClip, moveClipsBy, projectDuration, rippleInsert, setSpeed, snapTime, sourceTimeAt, splitAt,
  splitClip, trimEnd, trimStart, clipsAt, updateTrack,
} from '../../src/core/timeline';
import { createProject } from '../../src/core/defaults';
import { createTextClip, sampleProject } from './helpers';

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

describe('project creation', () => {
  it('starts with a main video track and an audio track', () => {
    const p = createProject('X', { width: 1080, height: 1920, fps: 30, background: '#000', sampleRate: 48000 });
    expect(p.tracks.map((t) => t.kind)).toEqual(['visual', 'audio']);
    expect(projectDuration(p)).toBe(0);
    expect(p.schemaVersion).toBe(1);
  });
});

describe('adding clips', () => {
  it('places media clips end to end and measures duration', () => {
    const { p } = sampleProject();
    expect(projectDuration(p)).toBe(16);
  });
  it('creates an overlay track when the main track is occupied', () => {
    const { p } = sampleProject();
    const r = addMediaClip(p, 'B', 2)!;
    expect(r.project.tracks.filter((t) => t.kind === 'visual')).toHaveLength(2);
    // Overlay goes on top (index 0) so it draws above the main footage.
    expect(r.project.tracks[0].clips[0].id).toBe(r.clipId);
  });
  it('puts audio media on an audio track', () => {
    const { p } = sampleProject();
    const r = addMediaClip(p, 'M', 0)!;
    expect(findClip(r.project, r.clipId)!.track.kind).toBe('audio');
  });
  it('refuses overlaps', () => {
    const { p } = sampleProject();
    const main = p.tracks.find((t) => t.kind === 'visual')!;
    expect(canPlace(main, 5, 2)).toBe(false);
    expect(canPlace(main, 16, 2)).toBe(true);
  });
});

describe('split', () => {
  it('splits a clip into two contiguous parts with correct source offsets', () => {
    const { p, a } = sampleProject();
    const r = splitClip(p, a, 4)!;
    const left = findClip(r.project, a)!.clip;
    const right = findClip(r.project, r.rightId)!.clip;
    close(left.duration, 4);
    close(right.start, 4);
    close(right.duration, 6);
    close(right.sourceIn, 4);
    close(sourceTimeAt(right, 5), 5);
    expect(projectDuration(r.project)).toBe(16);
  });
  it('accounts for speed when splitting', () => {
    const { p, a } = sampleProject();
    const fast = setSpeed(p, a, 2); // 10s source -> 5s
    const r = splitClip(fast, a, 2)!;
    close(findClip(r.project, r.rightId)!.clip.sourceIn, 4);
  });
  it('splits everything under the playhead', () => {
    const { p } = sampleProject();
    const withOverlay = addMediaClip(p, 'B', 1)!.project;
    const r = splitAt(withOverlay, 3);
    expect(r.newIds).toHaveLength(2);
  });
  it('ignores splits at the very edge', () => {
    const { p, a } = sampleProject();
    expect(splitClip(p, a, 0)).toBeNull();
    expect(splitClip(p, a, 10)).toBeNull();
  });
  it('keeps reversed clips mapping to the right source', () => {
    const { p, a } = sampleProject();
    const rev = { ...p, tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === a ? { ...c, reverse: true } : c)) })) };
    const before = sourceTimeAt(findClip(rev, a)!.clip, 7);
    const r = splitClip(rev, a, 4)!;
    close(sourceTimeAt(findClip(r.project, r.rightId)!.clip, 7), before);
    close(sourceTimeAt(findClip(r.project, a)!.clip, 1), sourceTimeAt(findClip(rev, a)!.clip, 1));
  });
});

describe('trim', () => {
  it('trims the start and advances the source in-point', () => {
    const { p, a } = sampleProject();
    const q = trimStart(p, a, 2);
    const c = findClip(q, a)!.clip;
    close(c.start, 2); close(c.duration, 8); close(c.sourceIn, 2);
  });
  it('cannot extend beyond the start of the media', () => {
    const { p, a } = sampleProject();
    const q = trimStart(trimStart(p, a, 2), a, -5);
    const c = findClip(q, a)!.clip;
    close(c.start, 0); close(c.sourceIn, 0);
  });
  it('cannot extend the end beyond the media or into the next clip', () => {
    const { p, a, b } = sampleProject();
    const shorter = trimEnd(p, a, 7);
    close(findClip(shorter, a)!.clip.duration, 7);
    const back = trimEnd(shorter, a, 30);
    close(clipEnd(findClip(back, a)!.clip), 10); // media is 10s and B starts at 10
    const moved = moveClip(back, b, 20)!;
    const end = trimEnd(moved, a, 30);
    close(findClip(end, a)!.clip.duration, maxClipDuration(end, findClip(end, a)!.clip));
  });
  it('enforces a minimum length', () => {
    const { p, a } = sampleProject();
    const q = trimEnd(p, a, -1);
    expect(findClip(q, a)!.clip.duration).toBeGreaterThan(0);
  });
});

describe('move', () => {
  it('moves into free space and refuses overlaps', () => {
    const { p, b } = sampleProject();
    expect(moveClip(p, b, 5)).toBeNull();
    const q = moveClip(p, b, 12)!;
    close(findClip(q, b)!.clip.start, 12);
  });
  it('moves across tracks of the same kind only', () => {
    const { p, b } = sampleProject();
    const audio = p.tracks.find((t) => t.kind === 'audio')!;
    expect(moveClip(p, b, 0, audio.id)).toBeNull();
  });
  it('respects locked tracks', () => {
    const { p, b } = sampleProject();
    const main = p.tracks.find((t) => t.kind === 'visual')!;
    expect(moveClip(updateTrack(p, main.id, { locked: true }), b, 20)).toBeNull();
  });
  it('moves groups together', () => {
    const { p, a, b } = sampleProject();
    const q = moveClipsBy(p, [a, b], 3)!;
    close(findClip(q, a)!.clip.start, 3);
    close(findClip(q, b)!.clip.start, 13);
    expect(moveClipsBy(p, [a, b], -1)).toBeNull();
  });
});

describe('delete, ripple and magnetic', () => {
  it('deletes without closing the gap', () => {
    const { p, a, b } = sampleProject();
    const q = deleteClips(p, [a]);
    expect(findClip(q, a)).toBeNull();
    close(findClip(q, b)!.clip.start, 10);
  });
  it('ripple deletes and closes the gap', () => {
    const { p, a, b } = sampleProject();
    const q = deleteClips(p, [a], true);
    close(findClip(q, b)!.clip.start, 0);
  });
  it('magnetic main track packs clips', () => {
    const { p, a, b } = sampleProject();
    const mag = { ...p, magnetic: true };
    const q = trimEnd(mag, a, 4);
    close(findClip(q, b)!.clip.start, 4);
  });
  it('closes a gap and ripple-inserts space', () => {
    const { p, b } = sampleProject();
    const gap = moveClip(p, b, 14)!;
    const main = gap.tracks.find((t) => t.kind === 'visual')!;
    close(findClip(closeGapAt(gap, main.id, 12), b)!.clip.start, 10);
    close(findClip(rippleInsert(p, 10, 2), b)!.clip.start, 12);
  });
});

describe('duplicate, speed, detach', () => {
  it('duplicates right after the original', () => {
    const { p, b } = sampleProject();
    const r = duplicateClip(p, b)!;
    close(findClip(r.project, r.clipId)!.clip.start, 16);
  });
  it('changes speed and pushes following clips', () => {
    const { p, a, b } = sampleProject();
    const q = setSpeed(p, a, 0.5);
    close(findClip(q, a)!.clip.duration, 20);
    close(findClip(q, b)!.clip.start, 20);
  });
  it('detaches audio and mutes the video', () => {
    const { p, a } = sampleProject();
    const r = detachAudio(p, a)!;
    expect(findClip(r.project, a)!.clip.muted).toBe(true);
    const audio = findClip(r.project, r.audioClipId)!;
    expect(audio.track.kind).toBe('audio');
    expect(audio.clip.kind).toBe('audio');
  });
});

describe('queries', () => {
  it('snaps to nearby points', () => {
    expect(snapTime(9.95, [0, 10], 0.1)).toEqual({ time: 10, snapped: true });
    expect(snapTime(9.5, [0, 10], 0.1).snapped).toBe(false);
  });
  it('returns clips at a time in draw order', () => {
    const { p } = sampleProject();
    const text = createTextClip(1, { content: 'hi' });
    const q = insertClipAuto(p, text).project;
    const at = clipsAt(q, 2, 'visual').map((x) => x.clip.kind);
    expect(at).toEqual(['video', 'text']);
  });
});
