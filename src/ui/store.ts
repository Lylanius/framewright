/**
 * Application state (Zustand). The project itself is immutable data; every
 * edit goes through `apply()`, which records undo history and schedules an
 * autosave. High-frequency playhead time lives in its own tiny store so the
 * whole UI doesn't re-render 60 times a second.
 */
import { create } from 'zustand';
import { createProject } from '../core/defaults';
import { emptyHistory, record, redo as historyRedo, undo as historyUndo, type HistoryState } from '../core/history';
import { uid } from '../core/ids';
import { parseProject, serializeProject } from '../core/projectIO';
import { addMediaClip, projectDuration } from '../core/timeline';
import type { MediaItem, Project, ProjectSettings, ProjectSummary } from '../core/types';
import { computePeaks, fingerprint, getBlob as getMediaBlob, getData as getMediaData, registerRemote, type InPlaceFile, hasMedia, hasProxy, importFile, needsProxy, registerBlob, registerProxy, PEAKS_PER_SECOND } from '../engine/media';
import { runJob } from '../engine/workerClient';
import type { MediaData } from '../engine/mediaSource';
import type { Player } from '../engine/player';
import { renderCache } from '../engine/renderCache';
import * as db from '../storage/db';
import { markSessionClosed, markSessionOpen, noteSaved } from '../storage/recovery';
import { nativeBridge } from '../platform/native';

export type PanelId =
  | 'media' | 'audio' | 'text' | 'stickers' | 'effects' | 'transitions' | 'filters' | 'adjust'
  | 'ai' | 'templates' | 'captions' | 'canvas' | 'brand';

export interface Toast { id: string; text: string; kind: 'info' | 'error' | 'success' }

interface TimeState { time: number; setTime: (t: number) => void }
export const useTime = create<TimeState>((set) => ({ time: 0, setTime: (time) => set({ time }) }));

export interface ImportJob { total: number; done: number; current: string }

interface AppState {
  screen: 'home' | 'editor';
  project: Project | null;
  history: HistoryState;
  selection: string[];
  /** Outgoing clip id of the selected transition (cut), if a transition is being edited. */
  selectedTransition: string | null;
  /** Timeline zoom: pixels per second. */
  zoom: number;
  snapping: boolean;
  panel: PanelId;
  mobileSheet: 'panel' | 'inspector' | null;
  toasts: Toast[];
  importJob: ImportJob | null;
  saveState: 'saved' | 'saving' | 'unsaved' | 'memory-only';
  storageOk: boolean;
  summaries: ProjectSummary[];
  exportOpen: boolean;
  shortcutsOpen: boolean;
  player: Player | null;
  /** Media ids whose bytes aren't available on this device. */
  missingMedia: string[];
  /** Progress (0..1) of preview proxies being made, by media id. */
  proxyProgress: Record<string, number>;
  /** When set, the next click on the preview picks a point on this clip (tracking). */
  pickMode: { clipId: string; label: string; onPick: (u: number, v: number) => void } | null;
  setPickMode(m: AppState['pickMode']): void;
  /** Mask being edited on the preview (Cutout tab). `draw` = freehand drawing mode. */
  maskEdit: { clipId: string; maskId: string; draw?: boolean } | null;
  setMaskEdit(m: AppState['maskEdit']): void;
  /** Video scopes under the preview. */
  scopes: 'off' | 'histogram' | 'waveform' | 'vectorscope';
  /** Recorder dialog (screen / camera / voiceover). */
  recorder: 'screen' | 'camera' | 'voice' | null;
  setRecorder(r: AppState['recorder']): void;
  setScopes(s: AppState['scopes']): void;

  refreshSummaries(): Promise<void>;
  newProject(name: string, settings: ProjectSettings): Promise<void>;
  openProject(id: string): Promise<void>;
  openProjectFile(file: File): Promise<void>;
  /** Open a project built in memory (e.g. from a template) and save it. */
  openProjectData(p: Project): Promise<void>;
  closeProject(): Promise<void>;
  duplicateProject(id: string): Promise<void>;
  renameProject(id: string, name: string): Promise<void>;
  removeProject(id: string): Promise<void>;
  exportProjectFile(): string | null;

  apply(label: string, fn: (p: Project) => Project | null | undefined, coalesceKey?: string): boolean;
  /** Update media metadata without an undo step (thumbnails, waveforms). */
  patchMedia(mediaId: string, patch: Partial<MediaItem>): void;
  undo(): void;
  redo(): void;

  select(ids: string[], additive?: boolean): void;
  selectTransition(clipId: string | null): void;
  setZoom(z: number): void;
  setPanel(p: PanelId): void;
  setMobileSheet(s: AppState['mobileSheet']): void;
  toast(text: string, kind?: Toast['kind']): void;
  dismissToast(id: string): void;
  setPlayer(p: Player | null): void;
  setExportOpen(v: boolean): void;
  setShortcutsOpen(v: boolean): void;
  setSnapping(v: boolean): void;

  importFiles(files: (File | InPlaceFile)[], addToTimelineAt?: number): Promise<string[]>;
  relinkMedia(mediaId: string, file: File): Promise<boolean>;
  saveNow(label?: string, pinned?: boolean): Promise<void>;
}

let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
let lastBackupAt = 0;
const AUTOSAVE_MS = 1200;
const BACKUP_EVERY_MS = 5 * 60 * 1000;

function summarise(p: Project): ProjectSummary {
  const firstVisual = p.media.find((m) => m.kind !== 'audio' && m.thumbnails?.length);
  return {
    id: p.id, name: p.name, updatedAt: p.updatedAt, createdAt: p.createdAt,
    width: p.settings.width, height: p.settings.height, duration: projectDuration(p),
    folder: p.folder, thumbnail: firstVisual?.thumbnails?.[Math.floor((firstVisual.thumbnails.length - 1) / 2)],
  };
}

async function loadMediaBytes(p: Project): Promise<string[]> {
  const missing: string[] = [];
  const native = nativeBridge();
  for (const m of p.media) {
    if (!hasMedia(m.id) && m.localPath && native?.reopenMedia) {
      // Desktop: the original file is used where it lives.
      const ref = await native.reopenMedia(m.localPath).catch(() => null);
      if (ref && ref.size === m.size) registerRemote(m.id, { url: ref.url, size: ref.size });
    }
    if (!hasMedia(m.id)) {
      const blob = await db.getBlob(m.fingerprint);
      if (blob) registerBlob(m.id, blob);
      else { missing.push(m.id); continue; }
    }
    if (m.proxy === 'ready' && !hasProxy(m.id)) {
      const px = await db.getBlob(`proxy_${m.fingerprint}`);
      if (px) registerProxy(m.id, px);
    }
  }
  return missing;
}

/** Desktop: convert a file the editor can't read with the computer's FFmpeg. */
async function convertWithFfmpeg(f: File, onProgress: (f: number) => void): Promise<InPlaceFile | 'no-ffmpeg' | null> {
  const native = nativeBridge();
  if (!native?.convertForEditing || !native.ffmpegInfo || !native.pathForFile) return null;
  let info = await native.ffmpegInfo().catch(() => ({ available: false }));
  if (!info.available && native.downloadFfmpeg) {
    // Only ever downloaded when the person says yes; media is never sent anywhere.
    const ok = window.confirm(`${f.name} is in a format the editor can't read directly.\n\nDownload the free FFmpeg converter (about 30 MB, one time) so Framewright can convert it? Your video stays on this computer.`);
    if (ok) {
      try {
        info = await native.downloadFfmpeg((fr) => useApp.setState({ importJob: { total: 1, done: 0, current: `Downloading FFmpeg… ${Math.round(fr * 100)}%` } }));
      } catch (e) {
        useApp.getState().toast(`FFmpeg download failed: ${(e as Error).message}`, 'error');
      }
    }
  }
  if (!info.available) return 'no-ffmpeg';
  // Registers the file with the desktop app (it only converts files the person picked).
  const src = (await native.refForFile?.(f).catch(() => null))?.path ?? '';
  if (!src) return null;
  try {
    const ref = await native.convertForEditing(src, onProgress);
    return { name: f.name.replace(/\.[^.]+$/, '') + '.mp4', type: 'video/mp4', size: ref.size, data: { url: ref.url, size: ref.size }, path: ref.path };
  } catch (e) {
    useApp.getState().toast(`FFmpeg couldn't convert ${f.name}: ${(e as Error).message}`, 'error');
    return null;
  }
}

/* ---------------- background media jobs (off the main thread) ---------------- */

let proxyChain: Promise<void> = Promise.resolve();

function analyseAudioInBackground(item: MediaItem, blob: MediaData): void {
  const st = useApp.getState;
  const job = runJob<Extract<import('../engine/media.worker').WorkerResponse, { type: 'audio' }>>({ type: 'analyseAudio', data: blob, perSecond: PEAKS_PER_SECOND });
  job.promise
    .then((r) => st().patchMedia(item.id, { peaks: r.peaks, loudness: r.loudness, peaksPerSecond: PEAKS_PER_SECOND }))
    .catch(() => computePeaks(blob).then((peaks) => { if (peaks) st().patchMedia(item.id, { peaks, peaksPerSecond: PEAKS_PER_SECOND }); }));
}

/** Queue a preview proxy for heavy footage. Jobs run one at a time in the worker. */
function queueProxy(item: MediaItem): void {
  if (!needsProxy(item) || hasProxy(item.id) || !db.prefs.get('proxies', true)) return;
  const st = useApp.getState;
  st().patchMedia(item.id, { proxy: 'pending' });
  proxyChain = proxyChain.then(async () => {
    const blob = getMediaData(item.id);
    if (!blob || !st().project?.media.some((m) => m.id === item.id)) return;
    const job = runJob<Extract<import('../engine/media.worker').WorkerResponse, { type: 'proxy' }>>(
      { type: 'proxy', data: blob, maxSide: 960, maxFps: 30 },
      (p) => useApp.setState({ proxyProgress: { ...st().proxyProgress, [item.id]: p } }),
    );
    try {
      const r = await job.promise;
      if (!r.hasAudio && item.hasAudio) throw new Error('proxy has no sound');
      const px = new Blob([r.buffer], { type: r.mime });
      registerProxy(item.id, px);
      await db.putBlob(`proxy_${item.fingerprint}`, px);
      st().patchMedia(item.id, { proxy: 'ready' });
      st().player?.invalidateMedia(item.id);
    } catch {
      st().patchMedia(item.id, { proxy: 'failed' });
    } finally {
      const { [item.id]: _, ...rest } = st().proxyProgress;
      void _;
      useApp.setState({ proxyProgress: rest });
    }
  });
}

export function startBackgroundJobs(p: Project): void {
  for (const m of p.media) {
    const blob = getMediaData(m.id);
    if (!blob) continue;
    if ((m.hasAudio || m.kind === 'audio') && !m.loudness) analyseAudioInBackground(m, blob);
    if (m.proxy !== 'ready' && m.proxy !== 'failed') queueProxy(m);
    else if (m.proxy === 'ready' && !hasProxy(m.id)) queueProxy(m);
  }
}

export const useApp = create<AppState>((set, get) => {
  const scheduleSave = () => {
    if (!get().storageOk) { set({ saveState: 'memory-only' }); return; }
    set({ saveState: 'unsaved' });
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => void get().saveNow(), AUTOSAVE_MS);
  };

  return {
    screen: 'home',
    project: null,
    history: emptyHistory(),
    selection: [],
    selectedTransition: null,
    zoom: 80,
    snapping: true,
    panel: 'media',
    mobileSheet: null,
    toasts: [],
    importJob: null,
    saveState: 'saved',
    storageOk: true,
    summaries: [],
    exportOpen: false,
    shortcutsOpen: false,
    player: null,
    missingMedia: [],
    proxyProgress: {},
    pickMode: null,
    setPickMode(pickMode) { set({ pickMode }); },
    maskEdit: null,
    setMaskEdit(maskEdit) { set({ maskEdit }); },
    scopes: 'off',
    recorder: null,
    setRecorder(recorder) { get().player?.pause(); set({ recorder }); },
    setScopes(scopes) { set({ scopes }); },

    async refreshSummaries() {
      const ok = await db.storageAvailable();
      set({ storageOk: ok, summaries: ok ? await db.listProjects() : [] });
    },

    async newProject(name, settings) {
      const p = createProject(name, settings);
      set({ project: p, history: emptyHistory(), selection: [], selectedTransition: null, screen: 'editor', missingMedia: [], zoom: 80, panel: 'media' });
      markSessionOpen(p.id, p.name);
      useTime.getState().setTime(0);
      lastBackupAt = Date.now();
      await get().saveNow('Created');
      void db.requestPersistence();
    },

    async openProjectData(p) {
      set({ project: p, history: emptyHistory(), selection: [], selectedTransition: null, screen: 'editor', missingMedia: [], panel: 'templates' });
      markSessionOpen(p.id, p.name);
      useTime.getState().setTime(0);
      lastBackupAt = Date.now();
      await get().saveNow('Created from template');
      startBackgroundJobs(p);
    },

    async openProject(id) {
      const p = await db.loadProject(id);
      if (!p) { get().toast('That project could not be found on this device.', 'error'); return; }
      const project = parseProject(JSON.stringify(p));
      const missing = await loadMediaBytes(project);
      set({ project, history: emptyHistory(), selection: [], selectedTransition: null, screen: 'editor', missingMedia: missing, panel: 'media' });
      markSessionOpen(project.id, project.name);
      useTime.getState().setTime(0);
      lastBackupAt = Date.now();
      if (missing.length) get().toast(`${missing.length} media file${missing.length > 1 ? 's are' : ' is'} missing on this device. Re-link from the Media panel.`, 'error');
      startBackgroundJobs(project);
    },

    async openProjectFile(file) {
      try {
        const project = parseProject(await file.text());
        const missing = await loadMediaBytes(project);
        set({ project, history: emptyHistory(), selection: [], selectedTransition: null, screen: 'editor', missingMedia: missing });
        markSessionOpen(project.id, project.name);
        useTime.getState().setTime(0);
        await get().saveNow('Opened from file');
        if (missing.length) get().toast(`Project opened. ${missing.length} media file(s) need re-linking.`, 'info');
      } catch (e) {
        get().toast((e as Error).message, 'error');
      }
    },

    async closeProject() {
      if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; await get().saveNow(); }
      get().player?.pause();
      markSessionClosed();
      set({ screen: 'home', project: null, selection: [], history: emptyHistory(), exportOpen: false });
      await get().refreshSummaries();
    },

    async duplicateProject(id) {
      const p = await db.loadProject(id);
      if (!p) return;
      const copy: Project = { ...p, id: uid('prj'), name: `${p.name} copy`, createdAt: Date.now(), updatedAt: Date.now() };
      await db.saveProject(copy, summarise(copy));
      await get().refreshSummaries();
    },

    async renameProject(id, name) {
      const p = await db.loadProject(id);
      if (!p) return;
      const next = { ...p, name, updatedAt: Date.now() };
      await db.saveProject(next, summarise(next));
      await get().refreshSummaries();
    },

    async removeProject(id) {
      await db.deleteProject(id);
      await db.pruneBlobs();
      await get().refreshSummaries();
    },

    exportProjectFile() {
      const p = get().project;
      return p ? serializeProject(p) : null;
    },

    apply(label, fn, coalesceKey) {
      const before = get().project;
      if (!before) return false;
      const after = fn(before);
      if (!after || after === before) return false;
      const project = { ...after, updatedAt: Date.now() };
      const ids = new Set(project.tracks.flatMap((t) => t.clips.map((c) => c.id)));
      set({
        project,
        history: record(get().history, before, label, coalesceKey),
        selection: get().selection.filter((id) => ids.has(id)),
      });
      scheduleSave();
      return true;
    },

    patchMedia(mediaId, patch) {
      const p = get().project;
      if (!p) return;
      const media = p.media.map((m) => (m.id === mediaId ? { ...m, ...patch } : m));
      // Keep history snapshots in sync so undo doesn't drop freshly computed waveforms.
      const fix = (proj: Project): Project => ({ ...proj, media: proj.media.map((m) => (m.id === mediaId ? { ...m, ...patch } : m)) });
      const h = get().history;
      set({
        project: { ...p, media },
        history: { ...h, past: h.past.map((e) => ({ ...e, project: fix(e.project) })), future: h.future.map((e) => ({ ...e, project: fix(e.project) })) },
      });
      scheduleSave();
    },

    undo() {
      const p = get().project;
      if (!p) return;
      const r = historyUndo(get().history, p);
      if (!r) return;
      set({ project: r.project, history: r.history });
      get().toast(`Undid ${r.label.toLowerCase()}`);
      scheduleSave();
    },

    redo() {
      const p = get().project;
      if (!p) return;
      const r = historyRedo(get().history, p);
      if (!r) return;
      set({ project: r.project, history: r.history });
      get().toast(`Redid ${r.label.toLowerCase()}`);
      scheduleSave();
    },

    selectTransition(clipId) { set({ selectedTransition: clipId, selection: clipId ? [] : get().selection }); },

    select(ids, additive) {
      set({ selectedTransition: null });
      if (additive) {
        const cur = new Set(get().selection);
        ids.forEach((id) => (cur.has(id) ? cur.delete(id) : cur.add(id)));
        set({ selection: [...cur] });
      } else set({ selection: ids });
    },

    setZoom(z) { set({ zoom: Math.min(800, Math.max(2, z)) }); },
    setPanel(panel) { set({ panel }); },
    setMobileSheet(mobileSheet) { set({ mobileSheet }); },
    toast(text, kind = 'info') {
      const t = { id: uid('t'), text, kind };
      set({ toasts: [...get().toasts.slice(-1), t] });
      setTimeout(() => get().dismissToast(t.id), kind === 'error' ? 7000 : 2600);
    },
    dismissToast(id) { set({ toasts: get().toasts.filter((t) => t.id !== id) }); },
    setPlayer(player) { set({ player }); },
    setExportOpen(exportOpen) { get().player?.pause(); renderCache.setPaused(exportOpen); set({ exportOpen }); },
    setShortcutsOpen(shortcutsOpen) { set({ shortcutsOpen }); },
    setSnapping(snapping) { set({ snapping }); },

    async importFiles(files, addToTimelineAt) {
      const added: string[] = [];
      if (!files.length || !get().project) return added;
      set({ importJob: { total: files.length, done: 0, current: files[0].name } });
      const errors: string[] = [];
      const later: (() => void)[] = [];
      let dups = 0;
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        set({ importJob: { total: files.length, done: i, current: f.name } });
        const existing = get().project?.media ?? [];
        let res = await importFile(f, existing);
        if (res.error && res.unsupported && f instanceof File) {
          // Desktop app: formats the editor can't read (MKV, AVI, WMV, ProRes…) go through FFmpeg if it's installed.
          const converted = await convertWithFfmpeg(f, (frac) => set({ importJob: { total: files.length, done: i, current: `Converting ${f.name} with FFmpeg… ${Math.round(frac * 100)}%` } }));
          if (converted === 'no-ffmpeg') res = { ...res, error: `${res.error} Install FFmpeg (Windows: winget install Gyan.FFmpeg · Mac: brew install ffmpeg · Linux: your package manager) and Framewright will convert it automatically.` };
          else if (converted) res = await importFile(converted, existing);
        }
        if (res.error) { errors.push(res.error); continue; }
        if (res.duplicateOf) { dups++; added.push(res.duplicateOf); continue; }
        const item = res.item!;
        // Desktop app: use the file where it is (no second copy on disk). Web: keep a copy in browser storage.
        const ref = item.localPath || !(f instanceof File) ? null : await nativeBridge()?.refForFile?.(f).catch(() => null);
        if (ref) item.localPath = ref.path;
        else if (!item.localPath && f instanceof File) {
          const stored = await db.putBlob(item.fingerprint, f);
          if (!stored && get().storageOk) errors.push(`${f.name}: not enough storage space to keep a copy — it will need re-linking after a reload.`);
        }
        get().apply('Import media', (p) => ({ ...p, media: [...p.media, item] }));
        added.push(item.id);
        const data = getMediaData(item.id);
        later.push(() => { if (data && (item.hasAudio || item.kind === 'audio')) analyseAudioInBackground(item, data); queueProxy(item); });
      }
      set({ importJob: null });
      // Waveforms and proxies start once the whole batch is in, so they don't slow the import itself.
      later.forEach((fn) => fn());
      if (addToTimelineAt !== undefined) {
        let at = addToTimelineAt;
        for (const id of added) {
          let newId = '';
          get().apply('Add to timeline', (p) => {
            const r = addMediaClip(p, id, at);
            if (!r) return null;
            newId = r.clipId;
            const c = r.project.tracks.flatMap((t) => t.clips).find((x) => x.id === r.clipId);
            if (c) at = c.start + c.duration;
            return r.project;
          });
          if (newId) get().select([newId]);
        }
      }
      if (errors.length) get().toast(errors.join(' '), 'error');
      else if (dups && dups === files.length) get().toast(dups === 1 ? 'Already in this project — reused the existing copy.' : `${dups} files were already in this project.`);
      else get().toast(`Imported ${added.length - dups} file${added.length - dups === 1 ? '' : 's'}${dups ? ` (${dups} duplicate${dups > 1 ? 's' : ''} skipped)` : ''}.`, 'success');
      return added;
    },

    async relinkMedia(mediaId, file) {
      const p = get().project;
      const m = p?.media.find((x) => x.id === mediaId);
      if (!p || !m) return false;
      const fp = await fingerprint(file);
      if (fp !== m.fingerprint && file.size !== m.size) {
        get().toast(`${file.name} doesn't match the original file (${m.name}).`, 'error');
        return false;
      }
      registerBlob(mediaId, file);
      const ref = await nativeBridge()?.refForFile?.(file).catch(() => null);
      if (ref) get().patchMedia(mediaId, { localPath: ref.path });
      else await db.putBlob(m.fingerprint, file);
      set({ missingMedia: get().missingMedia.filter((x) => x !== mediaId) });
      get().player?.setProject(get().project!);
      get().toast(`Re-linked ${m.name}.`, 'success');
      return true;
    },

    async saveNow(label, pinned) {
      const p = get().project;
      if (!p) return;
      if (!get().storageOk) { set({ saveState: 'memory-only' }); return; }
      set({ saveState: 'saving' });
      const ok = await db.saveProject(p, summarise(p));
      if (ok) noteSaved(p.id, p.name);
      if (label || Date.now() - lastBackupAt > BACKUP_EVERY_MS) {
        lastBackupAt = Date.now();
        await db.pushBackup(p, label ?? 'Autosave', pinned);
      }
      // Make sure every media file has a stored copy (e.g. after re-link or file open).
      for (const m of p.media) {
        const b = getMediaBlob(m.id);
        if (b && label && !m.localPath) await db.putBlob(m.fingerprint, b);
      }
      set({ saveState: ok ? 'saved' : 'memory-only', storageOk: ok });
      if (ok) scheduleSyncPush(p);
    },
  };
});

/* Optional sync folder: push the project a few seconds after it settles. */
let syncTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSyncPush(p: Project): void {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncTimer = null; void import('../storage/syncFolder').then((m) => m.pushProject(useApp.getState().project?.id === p.id ? useApp.getState().project! : p)); }, 4000);
}

/** Convenience selector for the selected clips. */
export function selectedClips(p: Project | null, ids: string[]) {
  if (!p) return [];
  return p.tracks.flatMap((t) => t.clips.filter((c) => ids.includes(c.id)).map((clip) => ({ clip, track: t })));
}

// Debug/test hook: the dev console and the benchmark suite drive the app through this.
if (typeof window !== 'undefined') (window as unknown as { __fw?: unknown }).__fw = { app: useApp, time: useTime };
