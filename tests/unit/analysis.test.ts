import { describe, expect, it } from 'vitest';
import {
  applyReframe, attachToTrack, cutRanges, detectScenes, detectSilence, findFillers, linkedClips, mergeRanges, simplifyKeys, smoothTrack,
  sourceToTimeline, suggestHighlights, suggestThresholdDb, totalLength,
} from '../../src/core/analysis';
import { createTextClip } from '../../src/core/defaults';
import { valueAt } from '../../src/core/keyframes';
import { detachAudio, findClip, insertClipAuto, projectDuration, setSpeed } from '../../src/core/timeline';
import { sampleProject } from './helpers';

const PS = 40;
/** 10 s of loudness: speech with a 2 s pause at 3–5 s and a 0.3 s blip-gap at 7 s. */
function speechLoudness(): number[] {
  return Array.from({ length: 10 * PS }, (_, i) => {
    const t = i / PS;
    if (t >= 3 && t < 5) return 0.001;
    if (t >= 7 && t < 7.3) return 0.002;
    return 0.2;
  });
}

describe('silence detection', () => {
  it('finds long pauses only, with padding', () => {
    const r = detectSilence(speechLoudness(), PS, { thresholdDb: -38, minSilence: 0.45, padding: 0.1 });
    expect(r).toHaveLength(1);
    expect(r[0][0]).toBeCloseTo(3.1);
    expect(r[0][1]).toBeCloseTo(4.9);
  });
  it('trims silence at the very start and end without padding', () => {
    const l = [...Array(40).fill(0), ...Array(80).fill(0.3), ...Array(40).fill(0)];
    const r = detectSilence(l, PS, { thresholdDb: -38, minSilence: 0.5, padding: 0.1 });
    expect(r[0][0]).toBe(0);
    expect(r[r.length - 1][1]).toBe(4);
  });
  it('suggests a threshold between the noise floor and speech', () => {
    const db = suggestThresholdDb(speechLoudness());
    expect(db).toBeGreaterThan(-60);
    expect(db).toBeLessThan(-14);
  });
});

describe('ranges and cutting', () => {
  it('merges ranges and maps source time to the timeline (incl. speed)', () => {
    expect(mergeRanges([[0, 1], [0.9, 2], [3, 4]])).toEqual([[0, 2], [3, 4]]);
    const { p, a } = sampleProject();
    const fast = setSpeed(p, a, 2);
    const c = findClip(fast, a)!.clip;
    expect(sourceToTimeline(c, [[2, 4]])).toEqual([[1, 2]]);
  });
  it('cuts ranges out of a clip and closes the gaps on its track only', () => {
    let { p, a, b } = sampleProject();
    p = insertClipAuto(p, { ...createTextClip(12, { content: 'title' }) }).project; // other track, should not move
    const before = projectDuration(p);
    const q = cutRanges(p, [a], [[2, 3], [5, 6.5]]);
    const main = q.tracks.find((t) => t.clips.some((c) => c.id === b))!;
    expect(main.clips).toHaveLength(4); // three pieces of A + B
    const pieces = main.clips.slice(0, 3);
    expect(pieces.map((c) => [c.start, c.duration, c.sourceIn].map((v) => +v.toFixed(3)))).toEqual([[0, 2, 0], [2, 2, 3], [4, 3.5, 6.5]]);
    expect(findClip(q, b)!.clip.start).toBeCloseTo(7.5);
    expect(projectDuration(q)).toBeLessThanOrEqual(before);
    expect(q.tracks.flatMap((t) => t.clips).find((c) => c.kind === 'text')!.start).toBe(12);
  });
  it('cuts detached audio in step with its video', () => {
    const { p, a } = sampleProject();
    const d = detachAudio(p, a)!;
    const ids = linkedClips(d.project, a);
    expect(ids).toHaveLength(2);
    const q = cutRanges(d.project, ids, [[1, 2]]);
    const audio = q.tracks.find((t) => t.kind === 'audio')!.clips;
    const video = q.tracks.find((t) => t.clips.some((c) => c.id === a))!.clips;
    expect(audio.map((c) => c.start)).toEqual(video.filter((c) => c.mediaId === 'A').map((c) => c.start));
  });
  it('totals range length', () => expect(totalLength([[0, 1], [2, 2.5]])).toBe(1.5));
});

describe('fillers, scenes and highlights', () => {
  it('finds filler words regardless of case and punctuation', () => {
    const words = ['So,', 'um,', 'this', 'is', 'UH', 'erm...', 'great'].map((text, i) => ({ text, start: i, end: i + 0.5 }));
    expect(findFillers(words).map((w) => w.text)).toEqual(['um,', 'UH', 'erm...']);
    expect(findFillers(words, ['great']).length).toBe(4);
  });
  it('detects hard cuts but not steady motion', () => {
    const times = Array.from({ length: 100 }, (_, i) => i / 10);
    const diffs = times.map((_, i) => (i === 30 || i === 70 ? 0.6 : 0.03 + (i % 3) * 0.01));
    expect(detectScenes(diffs, times, 0.5)).toEqual([3, 7]);
    expect(detectScenes(times.map(() => 0.05), times, 0.5)).toEqual([]);
  });
  it('suggests non-overlapping highlights around the loud part', () => {
    const duration = 120;
    const loudness = Array.from({ length: duration * PS }, (_, i) => (i / PS > 60 && i / PS < 75 ? 0.5 : 0.05));
    const hl = suggestHighlights({ duration, loudness, perSecond: PS, length: 15, count: 3 });
    expect(hl).toHaveLength(3);
    const best = [...hl].sort((a, b) => b.score - a.score)[0];
    expect(best.start).toBeGreaterThanOrEqual(58);
    expect(best.start).toBeLessThanOrEqual(62);
    for (let i = 1; i < hl.length; i++) expect(hl[i].start).toBeGreaterThanOrEqual(hl[i - 1].end);
  });
});

describe('reframe and tracking', () => {
  it('smooths and fills unknown positions', () => {
    const s = smoothTrack([-1, 0.2, -1, 0.8, 0.8], 0.5);
    expect(s.every((v) => v >= 0 && v <= 1)).toBe(true);
  });
  it('simplifies straight lines to two keys', () => {
    const keys = Array.from({ length: 20 }, (_, i) => ({ t: i, v: i * 0.1, ease: 'linear' as const }));
    expect(simplifyKeys(keys, 0.001)).toHaveLength(2);
  });
  it('reframes a landscape clip for vertical by panning with keyframes', () => {
    const { p, a } = sampleProject(); // 1920x1080 media in a 1080x1920 project
    const times = [0, 2, 4, 6, 8];
    const q = applyReframe(p, a, times, [0.2, 0.2, 0.8, 0.8, 0.8], null, 0);
    const c = findClip(q, a)!.clip;
    expect(c.fit).toBe('cover');
    expect(valueAt(c, 'x', 0)).toBeGreaterThan(0); // subject on the left → shift picture right
    expect(valueAt(c, 'x', 8)).toBeLessThan(0);
    // Never pans past the edge of the footage.
    const maxX = ((1920 * (1920 / 1080) - 1080) / 2) / 1080;
    expect(Math.abs(valueAt(c, 'x', 0))).toBeLessThanOrEqual(maxX + 1e-9);
  });
  it('makes an overlay follow a tracked point', () => {
    let { p, a } = sampleProject();
    const text = createTextClip(0, { content: 'target' }, 4);
    p = insertClipAuto(p, text).project;
    const q = attachToTrack(p, a, text.id, [0, 1, 2, 3], [{ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.5 }, { x: 0.7, y: 0.5 }, { x: 0.8, y: 0.5 }]);
    const t = findClip(q, text.id)!.clip;
    expect(valueAt(t, 'x', 0)).toBeCloseTo(0);
    expect(valueAt(t, 'x', 3)).toBeGreaterThan(valueAt(t, 'x', 1));
    expect(valueAt(t, 'y', 2)).toBeCloseTo(0);
  });
});
