/**
 * Project file format (.framewright.json).
 *
 * The file stores the full edit plus media *references* (name, size,
 * fingerprint). Media bytes are kept separately (IndexedDB in the browser,
 * the original file on disk in desktop builds), so saving never touches the
 * user's originals. When a project is opened on another device, missing media
 * can be re-linked by fingerprint.
 */
import { defaultTextStyle, defaultTransform } from './defaults';
import { PROJECT_SCHEMA_VERSION, type Clip, type Project } from './types';

export const FILE_MAGIC = 'framewright-project';

export interface ProjectFile {
  magic: typeof FILE_MAGIC;
  schemaVersion: number;
  savedAt: number;
  project: Project;
}

export function serializeProject(p: Project): string {
  const file: ProjectFile = { magic: FILE_MAGIC, schemaVersion: PROJECT_SCHEMA_VERSION, savedAt: Date.now(), project: p };
  return JSON.stringify(file, null, 1);
}

export class ProjectFormatError extends Error {}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && isFinite(v) ? v : fallback;
}

/** Fill in any fields missing from older / hand-edited files so the editor never crashes on load. */
export function normaliseClip(raw: Partial<Clip> & { id: string; kind: Clip['kind'] }): Clip {
  const t = { ...defaultTransform(), ...(raw.transform ?? {}) };
  t.crop = { ...defaultTransform().crop, ...(raw.transform?.crop ?? {}) };
  return {
    id: raw.id,
    kind: raw.kind,
    name: raw.name ?? raw.kind,
    mediaId: raw.mediaId,
    start: Math.max(0, num(raw.start, 0)),
    duration: Math.max(1 / 60, num(raw.duration, 1)),
    sourceIn: Math.max(0, num(raw.sourceIn, 0)),
    speed: num(raw.speed, 1) || 1,
    reverse: !!raw.reverse,
    transform: t,
    fit: raw.fit ?? 'contain',
    volume: num(raw.volume, 1),
    muted: !!raw.muted,
    fadeIn: num(raw.fadeIn, 0),
    fadeOut: num(raw.fadeOut, 0),
    videoFadeIn: num(raw.videoFadeIn, 0),
    videoFadeOut: num(raw.videoFadeOut, 0),
    effects: Array.isArray(raw.effects) ? raw.effects : [],
    keyframes: raw.keyframes ?? {},
    text: raw.kind === 'text' ? { ...defaultTextStyle(), ...(raw.text ?? {}) } : raw.text,
    color: raw.color,
    locked: raw.locked,
    label: raw.label,
    transitionOut: raw.transitionOut && typeof raw.transitionOut.type === 'string'
      ? { type: raw.transitionOut.type, duration: Math.max(0.05, num(raw.transitionOut.duration, 0.5)), params: raw.transitionOut.params ?? {}, color: raw.transitionOut.color }
      : undefined,
    caption: raw.caption,
    words: Array.isArray(raw.words) ? raw.words : undefined,
  };
}

export function parseProject(json: string): Project {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new ProjectFormatError('This file is not valid JSON, so it can’t be opened as a project.');
  }
  const obj = data as Partial<ProjectFile> & Partial<Project>;
  const raw = (obj.magic === FILE_MAGIC ? obj.project : obj) as Partial<Project> | undefined;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.tracks) || !raw.settings) {
    throw new ProjectFormatError('This file doesn’t look like a Framewright project.');
  }
  const version = num(obj.schemaVersion ?? raw.schemaVersion, 1);
  if (version > PROJECT_SCHEMA_VERSION) {
    throw new ProjectFormatError(`This project was saved by a newer version of Framewright (format ${version}).`);
  }
  const s = raw.settings;
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: String(raw.id ?? `prj_${Date.now().toString(36)}`),
    name: String(raw.name ?? 'Untitled'),
    createdAt: num(raw.createdAt, Date.now()),
    updatedAt: num(raw.updatedAt, Date.now()),
    settings: {
      width: num(s.width, 1080),
      height: num(s.height, 1920),
      fps: num(s.fps, 30),
      background: s.background ?? '#000000',
      sampleRate: num(s.sampleRate, 48000),
    },
    tracks: raw.tracks.map((t) => ({
      id: String(t.id),
      kind: t.kind === 'audio' ? 'audio' : 'visual',
      name: String(t.name ?? 'Track'),
      locked: !!t.locked,
      hidden: !!t.hidden,
      muted: !!t.muted,
      role: t.role === 'captions' || t.role === 'background' ? t.role : undefined,
      clips: (Array.isArray(t.clips) ? t.clips : []).map((c) => normaliseClip(c)),
    })),
    media: Array.isArray(raw.media) ? raw.media : [],
    markers: Array.isArray(raw.markers) ? raw.markers : [],
    magnetic: !!raw.magnetic,
    folder: raw.folder,
  };
}
