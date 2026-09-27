import { describe, expect, it } from 'vitest';
import { createEffect } from '../../src/core/effects';
import { createMask } from '../../src/core/masks';
import { CHUNK_SECONDS, chunkCount, chunkKey, hashString, isHeavyChunk } from '../../src/core/renderPlan';
import { findClip, setTransition, updateClip } from '../../src/core/timeline';
import { sampleProject } from './helpers';

describe('background render plan', () => {
  it('splits the timeline into chunks', () => {
    expect(chunkCount(0)).toBe(0);
    expect(chunkCount(CHUNK_SECONDS)).toBe(1);
    expect(chunkCount(CHUNK_SECONDS + 0.01)).toBe(2);
  });
  it('hashes deterministically', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).not.toBe(hashString('abd'));
  });
  it('changes a chunk key only for edits that change the picture there', () => {
    const { p, a } = sampleProject(); // A: 0–10 s, B: 10–16 s
    const k0 = chunkKey(p, 0), k7 = chunkKey(p, 7);
    // Volume, fades and names don't change the picture.
    const quiet = updateClip(p, a, { volume: 0.2, fadeIn: 1, name: 'renamed' });
    expect(chunkKey(quiet, 0)).toBe(k0);
    const vk = updateClip(p, a, (c) => ({ ...c, keyframes: { volume: [{ t: 0, v: 0, ease: 'linear' }] } }));
    expect(chunkKey(vk, 0)).toBe(k0);
    // A visual edit on clip A changes its chunks but not far-away ones.
    const moved = updateClip(p, a, (c) => ({ ...c, transform: { ...c.transform, x: 0.2 } }));
    expect(chunkKey(moved, 0)).not.toBe(k0);
    expect(chunkKey(moved, 7)).toBe(k7);
  });
  it('flags heavy chunks', () => {
    const { p, a, b } = sampleProject();
    expect(isHeavyChunk(p, 0)).toBe(false);
    const fx = updateClip(p, a, (c) => ({ ...c, effects: [createEffect('blur')] }));
    expect(isHeavyChunk(fx, 0)).toBe(true);
    expect(isHeavyChunk(fx, 6)).toBe(false); // clip B only
    const masked = updateClip(p, b, (c) => ({ ...c, masks: [createMask('ellipse')] }));
    expect(isHeavyChunk(masked, 6)).toBe(true);
    const tr = setTransition(p, a, { type: 'dissolve', duration: 1, params: {} } as never);
    const trackOk = findClip(tr, a)!.clip.transitionOut;
    expect(trackOk).toBeTruthy();
    expect(isHeavyChunk(tr, 4)).toBe(true); // cut at 10 s → chunk 4 (8–10) and 5 (10–12)
    expect(isHeavyChunk(tr, 5)).toBe(true);
    expect(isHeavyChunk(tr, 1)).toBe(false);
    // Motion-only effects are cheap.
    const shake = updateClip(p, a, (c) => ({ ...c, effects: [createEffect('shake')] }));
    expect(isHeavyChunk(shake, 0)).toBe(false);
  });
});
