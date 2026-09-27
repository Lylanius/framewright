import { describe, expect, it } from 'vitest';
import {
  clipActiveRanges, createTransition, maxTransitionDuration, sourceTimeExtended, trackTransitions, transitionAt, TRANSITIONS, transitionProgress,
} from '../../src/core/transitions';
import { findClip, moveClip, setTransition, splitClip } from '../../src/core/timeline';
import { parseProject, serializeProject } from '../../src/core/projectIO';
import { sampleProject } from './helpers';

const withDissolve = (d = 1) => {
  const { p, a, b } = sampleProject();
  return { p: setTransition(p, a, createTransition('dissolve', d)), a, b };
};
const mainTrack = (p: ReturnType<typeof sampleProject>['p']) => p.tracks.find((t) => t.kind === 'visual')!;

describe('transitions', () => {
  it('creates every transition with default params', () => {
    for (const def of TRANSITIONS) {
      const t = createTransition(def.type);
      for (const prm of def.params) expect(t.params[prm.key]).toBe(prm.default);
    }
  });
  it('centres the window on the cut without changing clip lengths', () => {
    const { p } = withDissolve(1);
    const [w] = trackTransitions(mainTrack(p));
    expect(w.cut).toBe(10);
    expect(w.start).toBe(9.5);
    expect(w.end).toBe(10.5);
    expect(transitionAt(mainTrack(p), 10)).not.toBeNull();
    expect(transitionAt(mainTrack(p), 11)).toBeNull();
  });
  it('clamps to what the clips allow', () => {
    const { p } = withDissolve(30);
    const [w] = trackTransitions(mainTrack(p));
    expect(w.duration).toBe(maxTransitionDuration(findClip(p, w.a.id)!.clip, findClip(p, w.b.id)!.clip));
    expect(w.duration).toBeLessThanOrEqual(5);
  });
  it('goes dormant when the clips stop touching, and comes back', () => {
    const { p, b } = withDissolve();
    const apart = moveClip(p, b, 12)!;
    expect(trackTransitions(mainTrack(apart))).toHaveLength(0);
    const back = moveClip(apart, b, 10)!;
    expect(trackTransitions(mainTrack(back))).toHaveLength(1);
  });
  it('extends the decode range of both clips', () => {
    const { p, a, b } = withDissolve(1);
    const r = clipActiveRanges(p);
    expect(r.get(a)).toEqual([0, 10.5]);
    expect(r.get(b)).toEqual([9.5, 16]);
  });
  it('holds the first/last media frame when there is no spare footage', () => {
    const { p, a, b } = withDissolve(1);
    const ca = findClip(p, a)!.clip, cb = findClip(p, b)!.clip;
    const ma = p.media.find((m) => m.id === ca.mediaId), mb = p.media.find((m) => m.id === cb.mediaId);
    expect(sourceTimeExtended(ca, 10.4, ma)).toBeLessThanOrEqual(10);
    expect(sourceTimeExtended(cb, 9.6, mb)).toBe(0);
    expect(sourceTimeExtended(ca, 5, ma)).toBe(5);
  });
  it('progress eases from 0 to 1', () => {
    const { p } = withDissolve(1);
    const [w] = trackTransitions(mainTrack(p));
    expect(transitionProgress(w, 9.5)).toBe(0);
    expect(transitionProgress(w, 10)).toBeCloseTo(0.5);
    expect(transitionProgress(w, 10.5)).toBe(1);
  });
  it('split keeps the transition on the right-hand piece only', () => {
    const { p, a } = withDissolve();
    const r = splitClip(p, a, 4)!;
    expect(findClip(r.project, a)!.clip.transitionOut).toBeUndefined();
    expect(findClip(r.project, r.rightId)!.clip.transitionOut?.type).toBe('dissolve');
  });
  it('is saved in the project file', () => {
    const { p, a } = withDissolve(0.8);
    const back = parseProject(serializeProject(p));
    expect(findClip(back, a)!.clip.transitionOut).toMatchObject({ type: 'dissolve', duration: 0.8 });
  });
});
