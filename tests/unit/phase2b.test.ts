import { describe, expect, it } from 'vitest';
import { trackedBlur } from '../../src/core/analysis';
import { activityRanges, AUDIO_EFFECTS, createAudioEffect, dbToGain, duckingKeys, gainToDb, normaliseGain } from '../../src/core/audioFx';
import { createAdjustmentClip, createClipFromMedia } from '../../src/core/defaults';
import { cubicBezier, ease, interpolate, resolveAt, setBaseValue, valueAt } from '../../src/core/keyframes';
import { createMask, insideOutline, maskOutline, resolveMask, setMaskValue, simplifyStroke } from '../../src/core/masks';
import {
  addAdjustmentLayer, clipEnd, findClip, freezeFrame, projectDuration, RAMP_PRESETS, sourceTimeAt, speedRamp,
} from '../../src/core/timeline';
import { sampleProject } from './helpers';

describe('bezier easing', () => {
  it('matches the endpoints and linear control points', () => {
    expect(cubicBezier(0.3, 0.3, 0.7, 0.7, 0)).toBeCloseTo(0);
    expect(cubicBezier(0.3, 0.3, 0.7, 0.7, 1)).toBeCloseTo(1);
    expect(cubicBezier(1 / 3, 1 / 3, 2 / 3, 2 / 3, 0.4)).toBeCloseTo(0.4, 3);
  });
  it('matches CSS ease-in-out at the midpoint and can overshoot', () => {
    expect(cubicBezier(0.42, 0, 0.58, 1, 0.5)).toBeCloseTo(0.5, 3);
    const peak = Math.max(...Array.from({ length: 50 }, (_, i) => ease('bezier', i / 49, [0.34, 1.56, 0.64, 1])));
    expect(peak).toBeGreaterThan(1.05);
  });
  it('drives keyframe interpolation', () => {
    const keys = [{ t: 0, v: 0, ease: 'bezier' as const, bez: [0.9, 0, 1, 0.1] as [number, number, number, number] }, { t: 1, v: 100, ease: 'linear' as const }];
    expect(interpolate(keys, 0.5)).toBeLessThan(20); // slow start
    expect(interpolate(keys, 1)).toBe(100);
  });
});

describe('keyframes on any parameter', () => {
  it('animates effect params and crop via paths', () => {
    const { p, a } = sampleProject();
    let c = findClip(p, a)!.clip;
    c = { ...c, effects: [{ id: 'fx1', type: 'blur', enabled: true, params: { radius: 4 } }] };
    c = { ...c, keyframes: { 'fx.fx1.radius': [{ t: 0, v: 0, ease: 'linear' }, { t: 2, v: 20, ease: 'linear' }], 'crop.left': [{ t: 0, v: 0, ease: 'linear' }, { t: 1, v: 0.2, ease: 'linear' }] } };
    expect(valueAt(c, 'fx.fx1.radius', 1)).toBeCloseTo(10);
    const r = resolveAt(c, 0.5);
    expect(r.effects[0].params.radius).toBeCloseTo(5);
    expect(r.transform.crop.left).toBeCloseTo(0.1);
    expect(setBaseValue(c, 'fx.fx1.radius', 9).effects[0].params.radius).toBe(9);
  });
});

describe('masks', () => {
  it('builds outlines that contain their centre and respect invert-free geometry', () => {
    for (const type of ['rect', 'ellipse', 'polygon'] as const) {
      const m = createMask(type);
      const pts = maskOutline(m, 1000, 500);
      expect(pts.length).toBeGreaterThanOrEqual(3);
      expect(insideOutline(pts, 500, 250 + (type === 'polygon' ? 30 : 0))).toBe(true);
      expect(insideOutline(pts, 5, 5)).toBe(false);
    }
  });
  it('places and rotates rectangles', () => {
    const m = { ...createMask('rect'), x: 0.25, w: 0.2, h: 0.2 };
    const pts = maskOutline(m, 1000, 1000);
    expect(insideOutline(pts, 750, 500)).toBe(true);
    expect(insideOutline(pts, 500, 500)).toBe(false);
    const rot = maskOutline({ ...createMask('rect'), w: 0.8, h: 0.1, rotation: 90 }, 1000, 1000);
    expect(insideOutline(rot, 500, 850)).toBe(true);
    expect(insideOutline(rot, 850, 500)).toBe(false);
  });
  it('animates mask values', () => {
    let m = createMask('ellipse');
    m = { ...m, keyframes: { x: [{ t: 0, v: -0.5, ease: 'linear' }, { t: 2, v: 0.5, ease: 'linear' }] } };
    expect(resolveMask(m, 1).x).toBeCloseTo(0);
    m = setMaskValue(m, 'x', 0.1, 1);
    expect(m.keyframes.x).toHaveLength(3);
    expect(setMaskValue(createMask('rect'), 'w', 0.3, 1).w).toBe(0.3);
  });
  it('simplifies freehand strokes but keeps the shape', () => {
    const circle = Array.from({ length: 400 }, (_, i) => ({ x: 0.5 + 0.3 * Math.cos((i / 400) * Math.PI * 2), y: 0.5 + 0.3 * Math.sin((i / 400) * Math.PI * 2) }));
    const s = simplifyStroke(circle);
    expect(s.length).toBeLessThan(120);
    expect(s.length).toBeGreaterThan(12);
    const m = { ...createMask('freeform'), points: s };
    expect(insideOutline(maskOutline(m, 100, 100), 50, 50)).toBe(true);
  });
});

describe('audio tools', () => {
  it('has a definition with defaults for every effect', () => {
    for (const d of AUDIO_EFFECTS) {
      const e = createAudioEffect(d.type);
      expect(Object.keys(e.params)).toEqual(d.params.map((p) => p.key));
    }
  });
  it('converts dB', () => {
    expect(dbToGain(-6)).toBeCloseTo(0.501, 2);
    expect(gainToDb(dbToGain(-18))).toBeCloseTo(-18);
  });
  it('normalises quiet audio up and loud audio down, with a cap', () => {
    const quiet = Array(100).fill(dbToGain(-30));
    expect(gainToDb(normaliseGain(quiet))).toBeCloseTo(12, 0);
    const loud = Array(100).fill(dbToGain(-6));
    expect(gainToDb(normaliseGain(loud))).toBeCloseTo(-12, 0);
    expect(normaliseGain(Array(100).fill(dbToGain(-70)))).toBe(4);
    expect(normaliseGain([])).toBe(1);
  });
  it('finds speech and ducks music under it', () => {
    const { p, a } = sampleProject();
    const clip = findClip(p, a)!.clip; // 0–10 s
    const loud = Array.from({ length: 400 }, (_, i) => (i >= 80 && i < 160 ? 0.2 : 0.0005)); // speech 2–4 s
    const r = activityRanges(loud, 40, clip);
    expect(r).toHaveLength(1);
    expect(r[0][0]).toBeCloseTo(2, 1);
    expect(r[0][1]).toBeCloseTo(4, 1);
    const music = { ...createClipFromMedia(p.media[2], 0), duration: 10 };
    const keys = duckingKeys(music, r, -12);
    const vol = (t: number) => interpolate(keys, t);
    expect(vol(0.5)).toBeCloseTo(1);
    expect(gainToDb(vol(3))).toBeCloseTo(-12, 0);
    expect(vol(8)).toBeCloseTo(1);
    for (let i = 1; i < keys.length; i++) expect(keys[i].t).toBeGreaterThan(keys[i - 1].t - 1e-6);
  });
});

describe('freeze frames', () => {
  it('inserts a still, pushes later clips and keeps the source in sync', () => {
    const { p, a, b } = sampleProject();
    const before = projectDuration(p);
    const r = freezeFrame(p, a, 4, 2)!;
    expect(r).not.toBeNull();
    const fz = findClip(r.project, r.freezeId)!.clip;
    expect(fz.start).toBeCloseTo(4);
    expect(fz.duration).toBeCloseTo(2);
    expect(fz.freeze).toBe(true);
    expect(fz.muted).toBe(true);
    expect(sourceTimeAt(fz, 5)).toBeCloseTo(4);
    expect(projectDuration(r.project)).toBeCloseTo(before + 2);
    expect(findClip(r.project, b)!.clip.start).toBeCloseTo(12);
    // The part after the freeze continues from 4 s in the source.
    const after = findClip(r.project, r.freezeId)!.track.clips.find((c) => Math.abs(c.start - 6) < 1e-6 && c.id !== r.freezeId)!;
    expect(after.sourceIn).toBeCloseTo(4);
  });
  it('refuses when the playhead is outside the clip', () => {
    const { p, a } = sampleProject();
    expect(freezeFrame(p, a, 50)).toBeNull();
  });
});

describe('speed ramps', () => {
  it('keeps the source range, changes the length, moves later clips', () => {
    const { p, a, b } = sampleProject();
    const preset = RAMP_PRESETS.find((r) => r.id === 'bullet')!;
    const r = speedRamp(p, a, preset.f, 12)!;
    const track = findClip(r, a)!.track;
    const pieces = track.clips.filter((c) => c.mediaId === 'A');
    expect(pieces).toHaveLength(12);
    const srcTotal = pieces.reduce((s, c) => s + c.duration * c.speed, 0);
    expect(srcTotal).toBeCloseTo(10, 5);
    for (let i = 1; i < pieces.length; i++) {
      expect(pieces[i].start).toBeCloseTo(clipEnd(pieces[i - 1]), 6);
      expect(pieces[i].sourceIn).toBeCloseTo(pieces[i - 1].sourceIn + pieces[i - 1].duration * pieces[i - 1].speed, 6);
    }
    const mid = pieces[6];
    expect(mid.speed).toBeLessThan(pieces[0].speed);
    expect(findClip(r, b)!.clip.start).toBeCloseTo(clipEnd(pieces[11]), 6);
  });
  it('every preset stays within sane speeds', () => {
    for (const r of RAMP_PRESETS) for (let u = 0; u <= 1; u += 0.05) {
      expect(r.f(u)).toBeGreaterThan(0.05);
      expect(r.f(u)).toBeLessThan(10);
    }
  });
});

describe('adjustment layers and tracked blur', () => {
  it('adds adjustment layers on a top track, reusing it', () => {
    const { p } = sampleProject();
    const p1 = addAdjustmentLayer(p, createAdjustmentClip(0, 4));
    expect(p1.tracks[0].clips[0].kind).toBe('adjustment');
    const p2 = addAdjustmentLayer(p1, createAdjustmentClip(5, 2));
    expect(p2.tracks.length).toBe(p1.tracks.length);
    expect(p2.tracks[0].clips).toHaveLength(2);
    const p3 = addAdjustmentLayer(p2, createAdjustmentClip(1, 2)); // overlaps → new track
    expect(p3.tracks.length).toBe(p2.tracks.length + 1);
  });
  it('builds a muted, masked copy that follows the tracked points', () => {
    const { p, a } = sampleProject();
    const times = [0, 1, 2, 3];
    const pts = [{ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.5 }, { x: 0.7, y: 0.4 }, { x: 0.8, y: 0.3 }];
    const r = trackedBlur(p, a, times, pts, { kind: 'pixelate', size: 0.1, amount: 16 })!;
    const loc = findClip(r.project, r.clipId)!;
    const base = findClip(r.project, a)!;
    expect(loc.trackIndex).toBe(base.trackIndex - 1);
    const c = loc.clip;
    expect(c.muted).toBe(true);
    expect(c.start).toBe(base.clip.start);
    expect(c.effects[0].type).toBe('pixelate');
    const m = c.masks![0];
    expect(m.type).toBe('ellipse');
    expect(resolveMask(m, 0).x).toBeCloseTo(0);
    expect(resolveMask(m, 3).x).toBeCloseTo(0.3);
    expect(resolveMask(m, 3).y).toBeCloseTo(-0.2);
    // 16:9 source: height fraction is scaled so the ellipse is round.
    expect(m.h).toBeCloseTo(0.1 * (16 / 9), 3);
  });
});
