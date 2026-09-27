import { describe, expect, it } from 'vitest';
import { ease, interpolate, rebaseKeys, removeKey, setKey, valueAt } from '../../src/core/keyframes';
import { findClip, splitClip, updateClip } from '../../src/core/timeline';
import { sampleProject } from './helpers';

describe('keyframes', () => {
  it('interpolates linearly and holds outside the range', () => {
    const keys = [{ t: 0, v: 0, ease: 'linear' as const }, { t: 2, v: 10, ease: 'linear' as const }];
    expect(interpolate(keys, -1)).toBe(0);
    expect(interpolate(keys, 1)).toBe(5);
    expect(interpolate(keys, 5)).toBe(10);
  });
  it('applies easing curves', () => {
    expect(ease('easeIn', 0.5)).toBeLessThan(0.5);
    expect(ease('easeOut', 0.5)).toBeGreaterThan(0.5);
    expect(ease('easeInOut', 0.5)).toBeCloseTo(0.5);
    expect(ease('hold', 0.9)).toBe(0);
  });
  it('adds, replaces and removes keys', () => {
    let k = setKey(undefined, 1, 5);
    k = setKey(k, 0, 1);
    k = setKey(k, 1, 7);
    expect(k.map((x) => x.v)).toEqual([1, 7]);
    k = removeKey(k, 0);
    expect(k).toHaveLength(1);
  });
  it('drives clip properties', () => {
    const { p, a } = sampleProject();
    const q = updateClip(p, a, (c) => ({ ...c, keyframes: { scale: [{ t: 0, v: 1, ease: 'linear' }, { t: 10, v: 2, ease: 'linear' }] } }));
    const c = findClip(q, a)!.clip;
    expect(valueAt(c, 'scale', 5)).toBeCloseTo(1.5);
    expect(valueAt(c, 'opacity', 5)).toBe(1);
  });
  it('keeps animated values continuous across a split', () => {
    const { p, a } = sampleProject();
    const q = updateClip(p, a, (c) => ({ ...c, keyframes: { x: [{ t: 0, v: 0, ease: 'linear' }, { t: 10, v: 1, ease: 'linear' }] } }));
    const r = splitClip(q, a, 4)!;
    const left = findClip(r.project, a)!.clip, right = findClip(r.project, r.rightId)!.clip;
    expect(valueAt(left, 'x', 2)).toBeCloseTo(0.2);
    expect(valueAt(right, 'x', 0)).toBeCloseTo(0.4);
    expect(valueAt(right, 'x', 3)).toBeCloseTo(0.7);
  });
  it('rebases keys to a window', () => {
    const r = rebaseKeys({ opacity: [{ t: 0, v: 0, ease: 'linear' }, { t: 4, v: 1, ease: 'linear' }] }, 1, 2);
    expect(r.opacity![0]).toMatchObject({ t: 0, v: 0.25 });
    expect(r.opacity![r.opacity!.length - 1]).toMatchObject({ t: 2, v: 0.75 });
  });
});
