/**
 * Templates: a finished edit with its footage swapped for numbered slots.
 * Using one makes a new project; you drop your own clips into the slots and
 * everything else (timing, text, effects, transitions, stickers) stays.
 */
import { createProject, createTrack } from './defaults';
import { uid } from './ids';
import type { Clip, MediaItem, Placeholder, Project, ProjectSettings, Track } from './types';

export interface TemplateSlot { index: number; label: string; accepts: Placeholder['accepts']; duration: number; clips: number }

export interface TemplateDoc {
  id: string;
  name: string;
  description: string;
  category: string;
  builtIn?: boolean;
  createdAt: number;
  settings: ProjectSettings;
  tracks: Track[];
  /** Small media kept inside the template (stickers, logos, music you chose to keep). */
  media: MediaItem[];
  /** fingerprint → data: URL for the kept media (saved templates only). */
  assets?: Record<string, string>;
  thumbnail?: string;
}

/** A placeholder slot clip. */
export function createSlotClip(index: number, label: string, start: number, duration: number, accepts: Placeholder['accepts'] = 'visual'): Clip {
  return {
    id: uid('clp'), kind: accepts === 'audio' ? 'audio' : 'video', name: `Slot ${index + 1}: ${label}`,
    start, duration, sourceIn: 0, speed: 1, reverse: false,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, flipH: false, flipV: false, crop: { left: 0, top: 0, right: 0, bottom: 0 } },
    fit: 'cover', volume: 1, muted: false, fadeIn: 0, fadeOut: 0, videoFadeIn: 0, videoFadeOut: 0,
    effects: [], keyframes: {}, placeholder: { index, label, accepts },
  };
}

export function isEmptySlot(c: Clip): boolean {
  return !!c.placeholder && !c.mediaId;
}

/** Empty slots in a project, in fill order. */
export function slotsOf(p: Project): TemplateSlot[] {
  const map = new Map<number, TemplateSlot>();
  for (const t of p.tracks) for (const c of t.clips) {
    if (!isEmptySlot(c)) continue;
    const ph = c.placeholder!;
    const s = map.get(ph.index) ?? { index: ph.index, label: ph.label, accepts: ph.accepts, duration: 0, clips: 0 };
    s.duration = Math.max(s.duration, c.duration * c.speed);
    s.clips++;
    map.set(ph.index, s);
  }
  return [...map.values()].sort((a, b) => a.index - b.index);
}

/**
 * Put a media item into a slot (every clip that uses that slot).
 * Footage shorter than the slot plays a little slower to fill it (never below 0.25×).
 */
export function fillSlot(p: Project, index: number, media: MediaItem): Project {
  const accepts = media.kind === 'audio' ? 'audio' : 'visual';
  return {
    ...p,
    tracks: p.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (!isEmptySlot(c) || c.placeholder!.index !== index || c.placeholder!.accepts !== accepts) return c;
        const out: Clip = { ...c, mediaId: media.id, name: media.name, kind: media.kind === 'image' ? 'image' : media.kind === 'audio' ? 'audio' : 'video', sourceIn: 0 };
        delete out.placeholder;
        if (media.kind !== 'image' && media.duration > 0) {
          const need = c.duration * c.speed;
          if (media.duration < need) out.speed = Math.max(0.25, (media.duration - 0.02) / c.duration);
          out.duration = Math.min(c.duration, Math.max(0.1, (media.duration - 0.02) / out.speed));
        }
        return out;
      }),
    })),
  };
}

/** Fill slots in order with the given media (visual media → visual slots, audio → audio slots). */
export function fillSlots(p: Project, media: MediaItem[]): { project: Project; filled: number } {
  let project = p, filled = 0;
  const queue = { visual: media.filter((m) => m.kind !== 'audio'), audio: media.filter((m) => m.kind === 'audio') };
  for (const s of slotsOf(p)) {
    const next = queue[s.accepts].shift();
    if (!next) continue;
    project = fillSlot(project, s.index, next);
    filled++;
  }
  return { project, filled };
}

/** Turn a filled clip back into its empty slot. */
export function emptySlot(p: Project, clipId: string, index: number, label: string): Project {
  return {
    ...p,
    tracks: p.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (c.id !== clipId) return c;
        const out: Clip = { ...c, kind: c.kind === 'audio' ? 'audio' : 'video', placeholder: { index, label, accepts: c.kind === 'audio' ? 'audio' : 'visual' }, name: `Slot ${index + 1}: ${label}` };
        delete out.mediaId;
        return out;
      }),
    })),
  };
}

export interface SaveTemplateOptions {
  name: string;
  description?: string;
  /** Media to keep inside the template instead of turning into a slot (e.g. stickers, logo, music). */
  keep: (m: MediaItem) => boolean;
  keepCaptions?: boolean;
}

/** Make a template from a project: footage becomes numbered slots (same footage → same slot). */
export function projectToTemplate(p: Project, o: SaveTemplateOptions): TemplateDoc {
  const slotFor = new Map<string, number>();
  const labelFor = (m: MediaItem | undefined, i: number) => (m?.kind === 'audio' ? 'Music' : m?.kind === 'image' ? `Photo ${i + 1}` : `Clip ${i + 1}`);
  // Number slots in time order (main track first) so "fill in order" feels natural.
  const ordered = p.tracks.flatMap((t, ti) => t.clips.map((c) => ({ c, ti }))).sort((a, b) => a.c.start - b.c.start || b.ti - a.ti);
  for (const { c } of ordered) {
    if (!c.mediaId || slotFor.has(c.mediaId)) continue;
    const m = p.media.find((x) => x.id === c.mediaId);
    if (m && o.keep(m)) continue;
    slotFor.set(c.mediaId, slotFor.size);
  }
  const kept = new Set<string>();
  const tracks = p.tracks.map((t) => ({
    ...t,
    id: uid('trk'),
    clips: t.clips
      .filter((c) => o.keepCaptions || !c.caption)
      .map((c): Clip => {
        const copy: Clip = { ...structuredClone(c), id: uid('clp') };
        if (!c.mediaId) return copy;
        const idx = slotFor.get(c.mediaId);
        if (idx === undefined) { kept.add(c.mediaId); return copy; }
        const m = p.media.find((x) => x.id === c.mediaId);
        const slot = createSlotClip(idx, labelFor(m, idx), c.start, c.duration, m?.kind === 'audio' ? 'audio' : 'visual');
        return { ...copy, kind: slot.kind, mediaId: undefined, name: slot.name, sourceIn: 0, reverse: false, freeze: false, placeholder: slot.placeholder, words: undefined };
      })
      .map((c) => { if (c.mediaId === undefined) delete c.mediaId; return c; }),
  }));
  return {
    id: uid('tpl'), name: o.name, description: o.description ?? '', category: 'Mine', createdAt: Date.now(),
    settings: { ...p.settings }, tracks, media: p.media.filter((m) => kept.has(m.id)).map((m) => ({ ...m, localPath: undefined })),
  };
}

/** New project from a template (fresh ids; kept media referenced as-is). */
export function templateToProject(doc: TemplateDoc, name = doc.name): Project {
  const base = createProject(name, doc.settings);
  return {
    ...base,
    tracks: doc.tracks.map((t) => ({ ...structuredClone(t), id: uid('trk'), clips: t.clips.map((c) => ({ ...structuredClone(c), id: uid('clp') })) })),
    media: doc.media.map((m) => ({ ...m })),
    magnetic: false,
  };
}

export function templateDuration(doc: Pick<TemplateDoc, 'tracks'>): number {
  return doc.tracks.reduce((a, t) => t.clips.reduce((b, c) => Math.max(b, c.start + c.duration), a), 0);
}

/** Helper for building templates in code. */
export function track(kind: Track['kind'], name: string, clips: Clip[]): Track {
  const t = createTrack(kind, name);
  t.clips = clips;
  return t;
}
