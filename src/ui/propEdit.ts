import { findKeyIndex, removeKey, setBaseValue, setKey, valueAt } from '../core/keyframes';
import { findClip, updateClip } from '../core/timeline';
import type { Clip, Easing, ParamPath } from '../core/types';
import { useApp, useTime } from './store';

const localTime = (c: Clip) => Math.min(c.duration, Math.max(0, useTime.getState().time - c.start));

/** Current value of a property (transform prop or path such as 'fx.<id>.radius') at the playhead. */
export function propValue(c: Clip, prop: ParamPath): number {
  return valueAt(c, prop, localTime(c));
}

function writeValue(c: Clip, prop: ParamPath, value: number): Clip {
  const keys = c.keyframes[prop];
  if (keys && keys.length) return { ...c, keyframes: { ...c.keyframes, [prop]: setKey(keys, localTime(c), value) } };
  return setBaseValue(c, prop, value);
}

/**
 * Set an animatable property. If the property already has keyframes, this
 * adds/updates a key at the playhead; otherwise it sets the static value.
 */
export function setProp(clipId: string, prop: ParamPath, value: number, label?: string): void {
  useApp.getState().apply(label ?? `Change ${prop}`, (p) => {
    if (!findClip(p, clipId)) return null;
    return updateClip(p, clipId, (c) => writeValue(c, prop, value));
  }, `prop:${clipId}:${prop}`);
}

export function keyframeState(c: Clip, prop: ParamPath): { has: boolean; on: boolean } {
  const keys = c.keyframes[prop];
  return { has: !!keys?.length, on: findKeyIndex(keys, localTime(c)) >= 0 };
}

/** Toggle a keyframe at the playhead for a property. */
export function toggleKeyframe(clipId: string, prop: ParamPath): void {
  useApp.getState().apply('Keyframe', (p) => updateClip(p, clipId, (c) => {
    const t = localTime(c);
    const keys = c.keyframes[prop];
    const current = valueAt(c, prop, t);
    if (findKeyIndex(keys, t) >= 0) {
      const next = removeKey(keys, t);
      const kf = { ...c.keyframes };
      if (next.length) { kf[prop] = next; return { ...c, keyframes: kf }; }
      delete kf[prop];
      // Keep the look when the last key goes away.
      return setBaseValue({ ...c, keyframes: kf }, prop, current);
    }
    return { ...c, keyframes: { ...c.keyframes, [prop]: setKey(keys, t, current) } };
  }));
}

/** Change the easing of the keyframe under the playhead (for every property keyed there). */
export function setKeyEasing(clipId: string, easing: Easing, bez?: [number, number, number, number]): void {
  useApp.getState().apply('Keyframe easing', (p) => updateClip(p, clipId, (c) => {
    const t = localTime(c);
    const kf = { ...c.keyframes };
    let changed = false;
    for (const [path, keys] of Object.entries(kf)) {
      const i = findKeyIndex(keys, t);
      if (!keys || i < 0) continue;
      kf[path] = keys.map((k, j) => (j === i ? { ...k, ease: easing, bez: easing === 'bezier' ? bez : undefined } : k));
      changed = true;
    }
    return changed ? { ...c, keyframes: kf } : c;
  }), `ease:${clipId}`);
}

export function patchClip(clipId: string, patch: Partial<Clip> | ((c: Clip) => Clip), label: string, coalesce?: string): void {
  useApp.getState().apply(label, (p) => updateClip(p, clipId, patch), coalesce);
}

/** Set several animatable properties in one undo step (e.g. x+y while dragging). */
export function setProps(clipId: string, values: Partial<Record<ParamPath, number>>, label: string): void {
  useApp.getState().apply(label, (p) => updateClip(p, clipId, (c) => {
    let next = c;
    for (const [prop, v] of Object.entries(values)) if (typeof v === 'number') next = writeValue(next, prop, v);
    return next;
  }), `props:${clipId}:${label}`);
}
