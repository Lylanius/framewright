/**
 * Undoable edits to a clip's masks, shared by the Cutout tab and the preview overlay.
 */
import { findKeyIndex, removeKey, setKey } from '../core/keyframes';
import { createMask, maskValue, setMaskValue, type MaskProp } from '../core/masks';
import { updateClip } from '../core/timeline';
import type { Clip, Mask, MaskType } from '../core/types';
import { useApp, useTime } from './store';

export const localTime = (c: Clip) => Math.min(c.duration, Math.max(0, useTime.getState().time - c.start));

export function updateMask(clipId: string, maskId: string, fn: (m: Mask, c: Clip) => Mask, label: string, coalesce?: string): void {
  useApp.getState().apply(label, (p) => updateClip(p, clipId, (c) => ({
    ...c, masks: (c.masks ?? []).map((m) => (m.id === maskId ? fn(m, c) : m)),
  })), coalesce);
}

export function setMaskProps(clipId: string, maskId: string, values: Partial<Record<MaskProp, number>>, label: string, coalesce?: string): void {
  updateMask(clipId, maskId, (m, c) => {
    let out = m;
    for (const [k, v] of Object.entries(values)) if (typeof v === 'number') out = setMaskValue(out, k as MaskProp, v, localTime(c));
    return out;
  }, label, coalesce ?? `mask:${maskId}:${Object.keys(values).join()}`);
}

export function addMask(clipId: string, type: MaskType): string | null {
  let id: string | null = null;
  useApp.getState().apply('Add mask', (p) => updateClip(p, clipId, (c) => {
    const m = createMask(type, (c.masks?.length ?? 0) + 1);
    if (type === 'freeform') m.points = [];
    id = m.id;
    return { ...c, masks: [...(c.masks ?? []), m] };
  }));
  return id;
}

export function removeMask(clipId: string, maskId: string): void {
  useApp.getState().apply('Delete mask', (p) => updateClip(p, clipId, (c) => ({ ...c, masks: (c.masks ?? []).filter((m) => m.id !== maskId) })));
}

export function maskKeyState(c: Clip, m: Mask, prop: MaskProp): { has: boolean; on: boolean } {
  const keys = m.keyframes[prop];
  return { has: !!keys?.length, on: findKeyIndex(keys, localTime(c)) >= 0 };
}

export function toggleMaskKey(clipId: string, maskId: string, prop: MaskProp): void {
  updateMask(clipId, maskId, (m, c) => {
    const t = localTime(c);
    const keys = m.keyframes[prop];
    const cur = maskValue(m, prop, t);
    if (findKeyIndex(keys, t) >= 0) {
      const next = removeKey(keys, t);
      const kf = { ...m.keyframes };
      if (next.length) kf[prop] = next; else delete kf[prop];
      return { ...m, keyframes: kf, ...(next.length ? {} : { [prop]: cur }) };
    }
    return { ...m, keyframes: { ...m.keyframes, [prop]: setKey(keys, t, cur) } };
  }, 'Mask keyframe');
}

/** Key the whole shape (position, size, rotation) at the playhead — handy before moving it. */
export function keyWholeMask(clipId: string, maskId: string): void {
  updateMask(clipId, maskId, (m, c) => {
    const t = localTime(c);
    const kf = { ...m.keyframes };
    for (const p of ['x', 'y', 'w', 'h', 'rotation'] as MaskProp[]) kf[p] = setKey(kf[p], t, maskValue(m, p, t));
    return { ...m, keyframes: kf };
  }, 'Mask keyframe');
}
