/**
 * Editing commands shared by toolbars, menus and keyboard shortcuts.
 */
import { createEffect, LOOKS } from '../core/effects';
import { createAdjustmentClip, createSolidClip, createTextClip, type TextPreset } from '../core/defaults';
import { uid } from '../core/ids';
import {
  addAdjustmentLayer as addAdjustmentToProject, addMediaClip, allClips, clipEnd, deleteClips, detachAudio, duplicateClip, findClip, insertClipAuto,
  projectDuration, splitAt, updateClip,
} from '../core/timeline';
import type { Clip, Project } from '../core/types';
import { prefs } from '../storage/db';
import { useApp, useTime } from './store';

const app = () => useApp.getState();
const now = () => useTime.getState().time;

export function seek(t: number): void {
  const player = app().player;
  if (player) player.seek(t);
  else useTime.getState().setTime(Math.max(0, t));
}

export function togglePlay(): void {
  app().player?.toggle();
}

export function splitAtPlayhead(): void {
  const { selection } = app();
  let newIds: string[] = [];
  const ok = app().apply('Split', (p) => {
    const r = splitAt(p, now(), selection.length ? selection : undefined);
    newIds = r.newIds;
    return r.newIds.length ? r.project : null;
  });
  if (ok && newIds.length) app().select(newIds);
  else if (!ok) app().toast(selection.length ? 'Move the playhead over the selected clip to split it.' : 'No clip under the playhead to split.');
}

export function deleteSelected(ripple = false): void {
  const { selection, project } = app();
  if (!selection.length || !project) return;
  app().apply(ripple ? 'Ripple delete' : 'Delete', (p) => deleteClips(p, selection, ripple));
  app().select([]);
}

export function duplicateSelected(): void {
  const { selection } = app();
  const ids: string[] = [];
  app().apply('Duplicate', (p) => {
    let proj = p;
    for (const id of selection) {
      const r = duplicateClip(proj, id);
      if (r) { proj = r.project; ids.push(r.clipId); }
    }
    return proj;
  });
  if (ids.length) app().select(ids);
}

export function detachSelectedAudio(): void {
  const { selection } = app();
  let done = 0;
  app().apply('Detach audio', (p) => {
    let proj = p;
    for (const id of selection) {
      const r = detachAudio(proj, id);
      if (r) { proj = r.project; done++; }
    }
    return done ? proj : null;
  });
  if (!done) app().toast('Select a video clip that has sound to detach its audio.');
}

export function addMediaToTimeline(mediaId: string, at?: number): void {
  let clipId = '';
  const start = at ?? now();
  app().apply('Add clip', (p) => {
    const r = addMediaClip(p, mediaId, start);
    if (!r) return null;
    clipId = r.clipId;
    return r.project;
  });
  if (clipId) app().select([clipId]);
}

export function addText(preset?: TextPreset): void {
  const p = app().project;
  if (!p) return;
  const k = p.settings.width / 1080;
  const style = preset ? { ...preset.style } : {};
  if (style.fontSize) style.fontSize = Math.round(style.fontSize * k);
  else style.fontSize = Math.round(96 * k);
  const clip = createTextClip(now(), style);
  if (preset?.y) clip.transform.y = preset.y;
  app().apply('Add text', (proj) => insertClipAuto(proj, clip).project);
  app().select([clip.id]);
}

export function addSolid(color: string): void {
  const clip = createSolidClip(color, now());
  app().apply('Add colour', (proj) => insertClipAuto(proj, clip).project);
  app().select([clip.id]);
}

/** Adjustment layer covering the selected clip, or the whole project (or 5 s from the playhead if empty). */
export function addAdjustmentLayer(): void {
  const p = app().project;
  if (!p) return;
  const sel = allClips(p).filter((c) => app().selection.includes(c.id));
  let start: number, dur: number;
  if (sel.length) { start = Math.min(...sel.map((c) => c.start)); dur = Math.max(...sel.map(clipEnd)) - start; }
  else if (projectDuration(p) > 0.1) { start = 0; dur = projectDuration(p); }
  else { start = now(); dur = 5; }
  const clip = createAdjustmentClip(start, Math.max(0.5, dur));
  app().apply('Add adjustment layer', (proj) => addAdjustmentToProject(proj, clip));
  app().select([clip.id]);
}

function visualSelection(p: Project): Clip[] {
  const sel = app().selection;
  return allClips(p).filter((c) => sel.includes(c.id) && c.kind !== 'audio');
}

export function addEffectToSelection(type: string, params: Record<string, number> = {}): boolean {
  const p = app().project;
  if (!p) return false;
  const targets = visualSelection(p);
  if (!targets.length) { app().toast('Select a video, image, text or colour clip first.'); return false; }
  app().apply('Add effect', (proj) => {
    let next = proj;
    for (const c of targets) next = updateClip(next, c.id, (cl) => ({ ...cl, effects: [...cl.effects, createEffect(type, params)] }));
    return next;
  });
  return true;
}

/** Filters replace any previous look on the clip rather than stacking. */
export function applyLook(lookIndex: number | null): void {
  const p = app().project;
  if (!p) return;
  const targets = visualSelection(p);
  if (!targets.length) { app().toast('Select a clip to apply a filter.'); return; }
  app().apply(lookIndex === null ? 'Remove filter' : `Filter: ${LOOKS[lookIndex].name}`, (proj) => {
    let next = proj;
    for (const c of targets) {
      next = updateClip(next, c.id, (cl) => {
        const effects = cl.effects.filter((e) => e.type !== 'look');
        if (lookIndex !== null) effects.unshift(createEffect('look', { look: lookIndex }));
        return { ...cl, effects };
      });
    }
    return next;
  });
}

export function addMarker(): void {
  const t = now();
  app().apply('Add marker', (p) => ({
    ...p,
    markers: [...p.markers, { id: uid('mk'), time: t, label: `Marker ${p.markers.length + 1}`, color: '#f2b544' }].sort((a, b) => a.time - b.time),
  }));
}

export function selectAll(): void {
  const p = app().project;
  if (p) app().select(allClips(p).map((c) => c.id));
}

export function zoomBy(factor: number): void {
  app().setZoom(app().zoom * factor);
}

export function zoomToFit(viewWidth: number): void {
  const p = app().project;
  if (!p) return;
  const d = Math.max(5, projectDuration(p));
  app().setZoom((viewWidth - 40) / d);
}

export function stepFrames(n: number): void {
  const p = app().project;
  if (!p) return;
  app().player ? app().player!.step(n) : seek(now() + n / p.settings.fps);
}

export function jumpToEdge(dir: -1 | 1): void {
  const p = app().project;
  if (!p) return;
  const t = now();
  const edges = [0, projectDuration(p), ...allClips(p).flatMap((c) => [c.start, clipEnd(c)]), ...p.markers.map((m) => m.time)].sort((a, b) => a - b);
  const target = dir > 0 ? edges.find((e) => e > t + 1e-3) : [...edges].reverse().find((e) => e < t - 1e-3);
  if (target !== undefined) seek(target);
}

/** Move selected clips by n frames. */
export function nudgeSelection(frames: number): void {
  const { project, selection } = app();
  if (!project || !selection.length) return;
  const d = frames / project.settings.fps;
  app().apply('Nudge', (p) => {
    let next = p;
    for (const id of selection) {
      const loc = findClip(next, id);
      if (!loc) continue;
      const trial = { ...next, tracks: next.tracks.map((t) => t.id === loc.track.id ? { ...t, clips: t.clips.map((c) => c.id === id ? { ...c, start: Math.max(0, c.start + d) } : c) } : t) };
      const moved = trial.tracks.find((t) => t.id === loc.track.id)!;
      const me = moved.clips.find((c) => c.id === id)!;
      const overlap = moved.clips.some((c) => c.id !== id && me.start < clipEnd(c) - 1e-6 && clipEnd(me) > c.start + 1e-6);
      if (!overlap) next = trial;
    }
    return next;
  }, 'nudge');
}

/* ------------------------------------------------------------------ */
/* Keyboard shortcuts (customisable)                                    */
/* ------------------------------------------------------------------ */

export interface ShortcutDef { id: string; label: string; keys: string[]; run: () => void }

export const SHORTCUTS: ShortcutDef[] = [
  { id: 'play', label: 'Play / pause', keys: ['Space'], run: togglePlay },
  { id: 'split', label: 'Split at playhead', keys: ['S', 'Mod+B'], run: splitAtPlayhead },
  { id: 'delete', label: 'Delete', keys: ['Delete', 'Backspace'], run: () => deleteSelected(false) },
  { id: 'rippleDelete', label: 'Ripple delete', keys: ['Shift+Delete', 'Shift+Backspace'], run: () => deleteSelected(true) },
  { id: 'duplicate', label: 'Duplicate', keys: ['Mod+D'], run: duplicateSelected },
  { id: 'undo', label: 'Undo', keys: ['Mod+Z'], run: () => app().undo() },
  { id: 'redo', label: 'Redo', keys: ['Mod+Shift+Z', 'Mod+Y'], run: () => app().redo() },
  { id: 'selectAll', label: 'Select all clips', keys: ['Mod+A'], run: selectAll },
  { id: 'deselect', label: 'Clear selection', keys: ['Escape'], run: () => app().select([]) },
  { id: 'frameBack', label: 'Back one frame', keys: ['ArrowLeft'], run: () => stepFrames(-1) },
  { id: 'frameFwd', label: 'Forward one frame', keys: ['ArrowRight'], run: () => stepFrames(1) },
  { id: 'secBack', label: 'Back one second', keys: ['Shift+ArrowLeft'], run: () => { const p = app().project; if (p) stepFrames(-Math.round(p.settings.fps)); } },
  { id: 'secFwd', label: 'Forward one second', keys: ['Shift+ArrowRight'], run: () => { const p = app().project; if (p) stepFrames(Math.round(p.settings.fps)); } },
  { id: 'prevEdit', label: 'Previous edit point', keys: ['ArrowUp'], run: () => jumpToEdge(-1) },
  { id: 'nextEdit', label: 'Next edit point', keys: ['ArrowDown'], run: () => jumpToEdge(1) },
  { id: 'nudgeLeft', label: 'Nudge clip left', keys: [','], run: () => nudgeSelection(-1) },
  { id: 'nudgeRight', label: 'Nudge clip right', keys: ['.'], run: () => nudgeSelection(1) },
  { id: 'home', label: 'Go to start', keys: ['Home'], run: () => seek(0) },
  { id: 'end', label: 'Go to end', keys: ['End'], run: () => { const p = app().project; if (p) seek(projectDuration(p)); } },
  { id: 'marker', label: 'Add marker', keys: ['M'], run: addMarker },
  { id: 'text', label: 'Add text', keys: ['T'], run: () => addText() },
  { id: 'zoomIn', label: 'Zoom timeline in', keys: ['=', '+'], run: () => zoomBy(1.4) },
  { id: 'zoomOut', label: 'Zoom timeline out', keys: ['-'], run: () => zoomBy(1 / 1.4) },
  { id: 'save', label: 'Save now', keys: ['Mod+S'], run: () => { void app().saveNow('Manual save').then(() => app().toast('Saved on this device.', 'success')); } },
  { id: 'export', label: 'Export', keys: ['Mod+E'], run: () => app().setExportOpen(true) },
  { id: 'shortcuts', label: 'Keyboard shortcuts', keys: ['?'], run: () => app().setShortcutsOpen(true) },
];

const OVERRIDES_KEY = 'shortcuts';

export function shortcutKeys(id: string): string[] {
  const o = prefs.get<Record<string, string[]>>(OVERRIDES_KEY, {});
  return o[id] ?? SHORTCUTS.find((s) => s.id === id)?.keys ?? [];
}

export function setShortcutKeys(id: string, keys: string[] | null): void {
  const o = prefs.get<Record<string, string[]>>(OVERRIDES_KEY, {});
  if (keys) o[id] = keys; else delete o[id];
  prefs.set(OVERRIDES_KEY, o);
}

export function comboFromEvent(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push('Mod');
  if (e.altKey) parts.push('Alt');
  let key = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (e.shiftKey && (key.length > 1 || /[A-Z]/.test(key))) parts.push('Shift');
  if (key === '?') parts.splice(parts.indexOf('Shift'), parts.includes('Shift') ? 1 : 0);
  if (['Control', 'Meta', 'Shift', 'Alt'].includes(key)) key = '';
  if (key) parts.push(key);
  return parts.join('+');
}

export function handleShortcut(e: KeyboardEvent): boolean {
  const target = e.target as HTMLElement | null;
  if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) {
    if (!(e.key === 'Escape')) return false;
  }
  const combo = comboFromEvent(e);
  if (!combo) return false;
  for (const s of SHORTCUTS) {
    if (shortcutKeys(s.id).includes(combo)) {
      e.preventDefault();
      s.run();
      return true;
    }
  }
  return false;
}

export function prettyCombo(c: string): string {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  return c
    .replace('Mod', mac ? '⌘' : 'Ctrl')
    .replace('Shift', mac ? '⇧' : 'Shift')
    .replace('ArrowLeft', '←').replace('ArrowRight', '→').replace('ArrowUp', '↑').replace('ArrowDown', '↓')
    .replace(/\+/g, mac ? '' : '+');
}

/** Save the project (edit decisions, not media) as a portable .framewright.json file. */
export async function saveProjectFile(): Promise<void> {
  const { exportProjectFile, project, toast } = app();
  const json = exportProjectFile();
  if (!json || !project) return;
  const { saveFile } = await import('../platform/download');
  try {
    const r = await saveFile(`${project.name.replace(/[^\w\- ]+/g, '').trim() || 'project'}.framewright.json`, json);
    if (r === 'saved') toast('Project file saved. Media stays on this device; re-link it if you open the file elsewhere.', 'success');
  } catch (e) { toast((e as Error).message, 'error'); }
}
