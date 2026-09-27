/**
 * Media engine: importing, probing, thumbnails, waveforms and the runtime
 * registry that maps a media id to its bytes and decoded resources.
 *
 * Import never modifies the source file. Probing uses Mediabunny (pure TS
 * demuxers + WebCodecs) first and falls back to the browser's own <video>/<img>
 * decoders for anything Mediabunny can't read.
 */
import { ALL_FORMATS, AudioBufferSink, CanvasSink, Input } from 'mediabunny';
import { uid } from '../core/ids';
import type { MediaItem, MediaKind } from '../core/types';
import type { ProbeOutcome, WorkerResponse } from './media.worker';
import { runJob } from './workerClient';
import { isRemote, toSource, type MediaData, type RemoteData } from './mediaSource';

export const PEAKS_PER_SECOND = 40;
const THUMB_HEIGHT = 90;
const THUMB_COUNT = 12;

/* ------------------------------------------------------------------ */
/* Registry                                                             */
/* ------------------------------------------------------------------ */

interface Entry {
  data: MediaData;
  url: string;
  image?: HTMLImageElement;
  imagePromise?: Promise<HTMLImageElement>;
}

const registry = new Map<string, Entry>();

export function registerBlob(mediaId: string, blob: Blob): void {
  const old = registry.get(mediaId);
  if (old?.url.startsWith('blob:')) URL.revokeObjectURL(old.url);
  registry.set(mediaId, { data: blob, url: URL.createObjectURL(blob) });
}

/** Desktop: a file used in place, read through a local URL. */
export function registerRemote(mediaId: string, data: RemoteData): void {
  const old = registry.get(mediaId);
  if (old?.url.startsWith('blob:')) URL.revokeObjectURL(old.url);
  registry.set(mediaId, { data, url: data.url });
}

export function hasMedia(mediaId: string): boolean {
  return registry.has(mediaId);
}

/** The media's bytes as a Blob, if they're held that way (not for desktop in-place files). */
export function getBlob(mediaId: string): Blob | null {
  const d = registry.get(mediaId)?.data;
  return d && !isRemote(d) ? d : null;
}

/** The media's bytes, however they're held (Blob or in-place URL). */
export function getData(mediaId: string): MediaData | null {
  return registry.get(mediaId)?.data ?? null;
}

export function getUrl(mediaId: string): string | null {
  return registry.get(mediaId)?.url ?? null;
}

/* Preview proxies ---------------------------------------------------- */

const proxies = new Map<string, { blob: Blob; url: string }>();

export function registerProxy(mediaId: string, blob: Blob): void {
  const old = proxies.get(mediaId);
  if (old) URL.revokeObjectURL(old.url);
  proxies.set(mediaId, { blob, url: URL.createObjectURL(blob) });
}

export function hasProxy(mediaId: string): boolean {
  return proxies.has(mediaId);
}

/** URL the live preview should play: the light proxy when there is one, else the original. */
export function getPlaybackUrl(mediaId: string): string | null {
  return proxies.get(mediaId)?.url ?? getUrl(mediaId);
}

/** Footage heavier than 1080p30 gets a proxy so the preview stays smooth on phones. */
export function needsProxy(m: MediaItem): boolean {
  if (m.kind !== 'video' || !m.width || !m.height) return false;
  const fps = typeof m.meta?.fps === 'number' ? m.meta.fps : 30;
  const gop = typeof m.meta?.gop === 'number' ? m.meta.gop : 0;
  // Heavy footage plays smoother from a light copy; footage with keyframes far apart scrubs much faster from one.
  return m.width * m.height > 1920 * 1088 || fps > 31 || m.size / Math.max(1, m.duration) > 2.5e6 || (gop > 2.5 && m.duration > 8);
}

export function unregister(mediaId: string): void {
  animated.get(mediaId)?.frames.forEach((f) => f.close());
  animated.delete(mediaId);
  const e = registry.get(mediaId);
  if (e?.url.startsWith('blob:')) URL.revokeObjectURL(e.url);
  registry.delete(mediaId);
}

/** Decoded <img> for still images, cached. */
export function getImage(mediaId: string): Promise<HTMLImageElement> | null {
  const e = registry.get(mediaId);
  if (!e) return null;
  if (!e.imagePromise) {
    e.imagePromise = loadImage(e.url).then((img) => (e.image = img));
  }
  return e.imagePromise;
}

/* Animated GIF / WebP / APNG ---------------------------------------- */

export interface AnimatedImage { frames: ImageBitmap[]; starts: number[]; duration: number; width: number; height: number }
const animated = new Map<string, AnimatedImage | null>();
const animatedLoading = new Map<string, Promise<AnimatedImage | null>>();

/**
 * Decode every frame of an animated image once (with ImageDecoder, where the
 * browser has it). Large animations are scaled down so memory stays bounded.
 * Returns null for still images or when the browser can't decode frames
 * (then the first frame is shown, as before).
 */
export function loadAnimated(mediaId: string): Promise<AnimatedImage | null> {
  if (animated.has(mediaId)) return Promise.resolve(animated.get(mediaId)!);
  const pending = animatedLoading.get(mediaId);
  if (pending) return pending;
  const e = registry.get(mediaId);
  const ID = (globalThis as unknown as { ImageDecoder?: new (o: object) => ImageDecoderLike }).ImageDecoder;
  if (!e || !ID) { animated.set(mediaId, null); return Promise.resolve(null); }
  const job = (async (): Promise<AnimatedImage | null> => {
    try {
      const bytes = isRemote(e.data) ? await (await fetch(e.data.url)).arrayBuffer() : await e.data.arrayBuffer();
      const type = isRemote(e.data) ? guessImageType(e.url) : (e.data.type || guessImageType(e.url));
      if (!/gif|webp|png|apng/.test(type)) return null;
      const dec = new ID({ data: bytes, type });
      await dec.tracks.ready;
      const track = dec.tracks.selectedTrack;
      if (!track?.animated || track.frameCount < 2) { dec.close(); return null; }
      const count = Math.min(track.frameCount, 900);
      const first = (await dec.decode({ frameIndex: 0 })).image;
      const W = first.displayWidth, H = first.displayHeight;
      // Keep all frames under ~160 megapixels of memory.
      const k = Math.min(1, Math.sqrt(160e6 / Math.max(1, W * H * count)));
      const rw = Math.max(1, Math.round(W * k)), rh = Math.max(1, Math.round(H * k));
      const frames: ImageBitmap[] = [], starts: number[] = [];
      let t = 0;
      for (let i = 0; i < count; i++) {
        const f = i === 0 ? first : (await dec.decode({ frameIndex: i })).image;
        frames.push(await createImageBitmap(f as unknown as ImageBitmapSource, { resizeWidth: rw, resizeHeight: rh, resizeQuality: 'medium' }));
        starts.push(t);
        t += Math.max(0.02, (f.duration ?? 100000) / 1e6); // browsers treat <20 ms frame delays as 100 ms-ish; keep them sane
        f.close();
      }
      dec.close();
      return { frames, starts, duration: t, width: W, height: H };
    } catch {
      return null;
    }
  })().then((r) => { animated.set(mediaId, r); animatedLoading.delete(mediaId); return r; });
  animatedLoading.set(mediaId, job);
  return job;
}

export function getAnimatedSync(mediaId: string): AnimatedImage | null | undefined {
  if (!animated.has(mediaId) && !animatedLoading.has(mediaId)) void loadAnimated(mediaId);
  return animated.get(mediaId);
}

/** Frame of an animated image at `t` seconds (loops). */
export function animatedFrame(a: AnimatedImage, t: number): ImageBitmap {
  const x = ((t % a.duration) + a.duration) % a.duration;
  let lo = 0, hi = a.starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (a.starts[mid] <= x) lo = mid; else hi = mid - 1; }
  return a.frames[lo];
}

interface ImageDecoderLike {
  tracks: { ready: Promise<void>; selectedTrack: { animated: boolean; frameCount: number } | null };
  decode(o: { frameIndex: number }): Promise<{ image: VideoFrame }>;
  close(): void;
}

function guessImageType(url: string): string {
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
  return ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : ext === 'png' || ext === 'apng' ? 'image/png' : '';
}

export function getImageSync(mediaId: string): HTMLImageElement | null {
  const e = registry.get(mediaId);
  if (!e) return null;
  if (!e.image && !e.imagePromise) void getImage(mediaId);
  return e.image ?? null;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous'; // desktop in-place files come from fw-media:// (CORS-enabled)
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The browser could not decode this image.'));
    img.src = url;
  });
}

/* ------------------------------------------------------------------ */
/* Classification                                                       */
/* ------------------------------------------------------------------ */

const EXT_KIND: Record<string, MediaKind> = {
  mp4: 'video', mov: 'video', mkv: 'video', webm: 'video', avi: 'video', mpeg: 'video', mpg: 'video', m4v: 'video', ts: 'video',
  gif: 'image', webp: 'image', jpg: 'image', jpeg: 'image', png: 'image', heic: 'image', heif: 'image', avif: 'image', bmp: 'image', svg: 'image',
  wav: 'audio', mp3: 'audio', aac: 'audio', m4a: 'audio', flac: 'audio', ogg: 'audio', opus: 'audio',
};

export const ACCEPT_ATTR =
  'video/*,audio/*,image/*,.mkv,.avi,.mpeg,.mpg,.m4v,.heic,.heif,.flac,.m4a,.aac,.opus';

export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function classify(file: { name: string; type: string }): MediaKind | null {
  // Containers like WebM/MP4 can hold sound only; trust an explicit audio type.
  if (file.type.startsWith('audio/')) return 'audio';
  const byExt = EXT_KIND[extensionOf(file.name)];
  if (byExt) return byExt;
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  if (file.type.startsWith('image/')) return 'image';
  return null;
}

/* ------------------------------------------------------------------ */
/* Fingerprint (duplicate detection)                                    */
/* ------------------------------------------------------------------ */

/** A file used in place by the desktop app (e.g. one FFmpeg converted), read over a local URL. */
export interface InPlaceFile { name: string; type: string; size: number; data: RemoteData; path: string }

async function readRange(src: Blob | RemoteData, start: number, end: number): Promise<ArrayBuffer> {
  if (!isRemote(src)) return src.slice(start, end).arrayBuffer();
  if (end <= start) return new ArrayBuffer(0);
  const r = await fetch(src.url, { headers: { Range: `bytes=${start}-${end - 1}` } });
  return r.arrayBuffer();
}

export async function fingerprint(blob: Blob | RemoteData): Promise<string> {
  const CHUNK = 256 * 1024;
  const size = blob.size;
  const head = await readRange(blob, 0, Math.min(CHUNK, size));
  const tail = size > CHUNK ? await readRange(blob, Math.max(CHUNK, size - CHUNK), size) : new ArrayBuffer(0);
  const sizeBytes = new TextEncoder().encode(String(size));
  const all = new Uint8Array(head.byteLength + tail.byteLength + sizeBytes.byteLength);
  all.set(new Uint8Array(head), 0);
  all.set(new Uint8Array(tail), head.byteLength);
  all.set(sizeBytes, head.byteLength + tail.byteLength);
  if (globalThis.crypto?.subtle) {
    const hash = await crypto.subtle.digest('SHA-256', all);
    return [...new Uint8Array(hash)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Non-secure context fallback: FNV-1a.
  let h = 0x811c9dc5;
  for (let i = 0; i < all.length; i++) { h ^= all[i]; h = Math.imul(h, 0x01000193); }
  return `fnv${(h >>> 0).toString(16)}_${size}`;
}

/* ------------------------------------------------------------------ */
/* Probing                                                              */
/* ------------------------------------------------------------------ */

export class ImportError extends Error {}

export interface ProbeResult {
  duration: number;
  width?: number;
  height?: number;
  hasAudio: boolean;
  thumbnails: string[];
  meta: Record<string, string | number>;
  warning?: string;
}

function canvasToThumb(src: CanvasImageSource, sw: number, sh: number): string {
  const h = THUMB_HEIGHT;
  const w = Math.max(1, Math.round((sw / sh) * h));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(src, 0, 0, w, h);
  return c.toDataURL('image/jpeg', 0.7);
}

/** Probe in the background worker so big files never freeze the editor; falls back to the main thread. */
async function probeInWorker(blob: MediaData, kind: 'video' | 'audio'): Promise<ProbeResult | null | undefined> {
  let outcome: ProbeOutcome;
  try {
    const r = await runJob<Extract<WorkerResponse, { type: 'probe' }>>({ type: 'probe', data: blob, kind, thumbCount: THUMB_COUNT, thumbHeight: THUMB_HEIGHT }).promise;
    outcome = r.outcome;
  } catch {
    return undefined; // worker unavailable: caller probes on the main thread
  }
  if (outcome.ok) return { duration: outcome.duration, width: outcome.width, height: outcome.height, hasAudio: outcome.hasAudio, thumbnails: outcome.thumbnails, meta: outcome.meta, warning: outcome.warning };
  if (outcome.reason === 'unreadable') return null;
  // WebCodecs can't decode the video; the browser's own player might (extra decoders on some platforms).
  const url = isRemote(blob) ? blob.url : URL.createObjectURL(blob);
  try {
    const viaElement = await probeWithElement(url, 'video');
    return { ...viaElement, meta: { ...outcome.meta, decoder: 'browser' }, warning: `Export of ${outcome.codec.toUpperCase()} video will be slower on this browser.` };
  } catch {
    throw new ImportError(`this browser can't decode ${outcome.codec.toUpperCase()} video. Try Chrome, Edge or Safari, or convert the file to WebM (VP9).`);
  } finally {
    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
  }
}

async function probeWithMediabunny(blob: MediaData, kind: MediaKind): Promise<ProbeResult | null> {
  let input: Input | null = null;
  try {
    input = new Input({ source: toSource(blob), formats: ALL_FORMATS });
    if (!(await input.canRead())) return null;
    const video = kind === 'video' ? await input.getPrimaryVideoTrack() : null;
    const audio = await input.getPrimaryAudioTrack();
    if (kind === 'video' && !video) return null;
    if (kind === 'audio' && !audio) return null;
    const duration = await input.computeDuration();
    const meta: Record<string, string | number> = { container: (await input.getMimeType()).split(';')[0] };
    let warning: string | undefined;
    const res: ProbeResult = { duration, hasAudio: false, thumbnails: [], meta };
    if (video) {
      res.width = await video.getDisplayWidth();
      res.height = await video.getDisplayHeight();
      meta.videoCodec = (await video.getCodec()) ?? 'unknown';
      try {
        const fr = await video.computeFrameRateMetrics();
        if (fr.bestGuessFrameRate) meta.fps = Math.round(fr.bestGuessFrameRate * 100) / 100;
      } catch { /* optional */ }
      if (await video.canDecode()) {
        const sink = new CanvasSink(video, { height: THUMB_HEIGHT, poolSize: 0 });
        const first = await video.getFirstTimestamp();
        const stamps = Array.from({ length: THUMB_COUNT }, (_, i) => first + ((i + 0.5) / THUMB_COUNT) * duration);
        for await (const wc of sink.canvasesAtTimestamps(stamps)) {
          if (wc) res.thumbnails.push(canvasToThumb(wc.canvas, wc.canvas.width, wc.canvas.height));
        }
      } else {
        // WebCodecs can't decode it; the browser's own player might (it has extra decoders on some platforms).
        const url = isRemote(blob) ? blob.url : URL.createObjectURL(blob);
        try {
          const viaElement = await probeWithElement(url, 'video');
          res.thumbnails = viaElement.thumbnails;
          meta.decoder = 'browser';
          warning = `Export of ${String(meta.videoCodec).toUpperCase()} video will be slower on this browser.`;
        } catch {
          throw new ImportError(`this browser can't decode ${String(meta.videoCodec).toUpperCase()} video. Try Chrome, Edge or Safari, or convert the file to WebM (VP9).`);
        } finally {
          if (url.startsWith('blob:')) URL.revokeObjectURL(url);
        }
      }
    }
    if (audio) {
      meta.audioCodec = (await audio.getCodec()) ?? 'unknown';
      meta.sampleRate = await audio.getSampleRate();
      meta.channels = await audio.getNumberOfChannels();
      res.hasAudio = await audio.canDecode();
      if (!res.hasAudio) warning = (warning ? warning + ' ' : '') + `Audio (${meta.audioCodec}) can't be decoded in this browser, so the clip will be silent.`;
    }
    res.warning = warning;
    return res;
  } catch (e) {
    if (e instanceof ImportError) throw e;
    return null;
  } finally {
    input?.dispose();
  }
}

function probeWithElement(url: string, kind: 'video' | 'audio'): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const el = document.createElement(kind);
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    el.muted = true;
    (el as HTMLVideoElement).playsInline = true;
    const fail = () => reject(new ImportError(`this ${kind} can't be read — it may be damaged, or its format isn't supported by this browser. Try converting it to MP4 (H.264) or WebM.`));
    const timer = setTimeout(fail, 15000);
    el.onerror = () => { clearTimeout(timer); fail(); };
    el.onloadedmetadata = async () => {
      const duration = isFinite(el.duration) ? el.duration : 0;
      const res: ProbeResult = { duration, hasAudio: kind === 'audio', thumbnails: [], meta: { decoder: 'browser' } };
      if (kind === 'video') {
        const v = el as HTMLVideoElement;
        res.width = v.videoWidth; res.height = v.videoHeight;
        // Browsers don't expose audio-track presence consistently; assume yes and let decode decide.
        res.hasAudio = true;
        for (let i = 0; i < 6 && duration > 0; i++) {
          v.currentTime = ((i + 0.5) / 6) * duration;
          await new Promise((r) => { v.onseeked = r; setTimeout(r, 3000); });
          if (v.videoWidth) res.thumbnails.push(canvasToThumb(v, v.videoWidth, v.videoHeight));
        }
      }
      clearTimeout(timer);
      el.removeAttribute('src'); el.load();
      resolve(res);
    };
    el.src = url;
  });
}

async function probeImage(url: string): Promise<ProbeResult> {
  try {
    const img = await loadImage(url);
    return {
      duration: 0, width: img.naturalWidth, height: img.naturalHeight, hasAudio: false,
      thumbnails: [canvasToThumb(img, img.naturalWidth || 1, img.naturalHeight || 1)], meta: {},
    };
  } catch {
    throw new ImportError('This image format can’t be decoded in this browser (HEIC works in Safari; convert to JPEG or PNG elsewhere).');
  }
}

/* ------------------------------------------------------------------ */
/* Waveform peaks                                                        */
/* ------------------------------------------------------------------ */

/** Stream-decode audio and reduce it to peak values. Memory stays flat for long files. */
export async function computePeaks(blob: MediaData, onProgress?: (f: number) => void): Promise<number[] | null> {
  let input: Input | null = null;
  try {
    input = new Input({ source: toSource(blob), formats: ALL_FORMATS });
    const track = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode())) return await computePeaksFallback(blob);
    const duration = await input.computeDuration();
    const n = Math.max(1, Math.ceil(duration * PEAKS_PER_SECOND));
    const peaks = new Float32Array(n);
    const sink = new AudioBufferSink(track);
    for await (const { buffer, timestamp } of sink.buffers()) {
      const ch0 = buffer.getChannelData(0);
      const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;
      const sr = buffer.sampleRate;
      for (let i = 0; i < ch0.length; i += 4) {
        const idx = Math.floor((timestamp + i / sr) * PEAKS_PER_SECOND);
        if (idx < 0 || idx >= n) continue;
        const v = Math.max(Math.abs(ch0[i]), Math.abs(ch1[i]));
        if (v > peaks[idx]) peaks[idx] = v;
      }
      onProgress?.(Math.min(1, timestamp / duration));
    }
    return normalisePeaks(peaks);
  } catch {
    return computePeaksFallback(blob);
  } finally {
    input?.dispose();
  }
}

async function computePeaksFallback(blob: MediaData): Promise<number[] | null> {
  if (isRemote(blob) || blob.size > 400 * 1024 * 1024) return null; // too large to decode in one go
  try {
    const Ctx = window.OfflineAudioContext || (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
    const ctx = new Ctx(1, 1, 44100);
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const n = Math.max(1, Math.ceil(buf.duration * PEAKS_PER_SECOND));
    const peaks = new Float32Array(n);
    const data = buf.getChannelData(0);
    const per = buf.sampleRate / PEAKS_PER_SECOND;
    for (let i = 0; i < data.length; i += 2) {
      const idx = Math.floor(i / per);
      const v = Math.abs(data[i]);
      if (idx < n && v > peaks[idx]) peaks[idx] = v;
    }
    return normalisePeaks(peaks);
  } catch {
    return null;
  }
}

export function normalisePeaks(peaks: Float32Array | number[]): number[] {
  let max = 0;
  for (const v of peaks) if (v > max) max = v;
  const scale = max > 0 ? 1 / max : 1;
  return Array.from(peaks, (v) => Math.round(v * scale * 1000) / 1000);
}

/* ------------------------------------------------------------------ */
/* Import                                                                */
/* ------------------------------------------------------------------ */

export interface ImportOutcome {
  item?: MediaItem;
  duplicateOf?: string;
  error?: string;
  /** The file's format isn't readable here (a converter such as FFmpeg could help). */
  unsupported?: boolean;
  file: File | InPlaceFile;
}

/**
 * Import one file: classify, fingerprint, probe and register it.
 * `existing` lets us skip files already in the project (duplicate detection).
 */
export async function importFile(file: File | InPlaceFile, existing: MediaItem[]): Promise<ImportOutcome> {
  const inPlace = !(file instanceof Blob);
  const data: MediaData = inPlace ? (file as InPlaceFile).data : (file as File);
  const kind = classify(file);
  if (!kind) return { file, error: `${file.name}: unsupported file type.`, unsupported: true };
  if (file.size === 0) return { file, error: `${file.name}: the file is empty.` };
  let fp: string;
  try {
    fp = await fingerprint(data);
  } catch {
    return { file, error: `${file.name}: the file couldn't be read.` };
  }
  const dup = existing.find((m) => m.fingerprint === fp);
  if (dup) return { file, duplicateOf: dup.id };

  const id = uid('med');
  if (inPlace) registerRemote(id, (file as InPlaceFile).data);
  else registerBlob(id, file as File);
  const url = getUrl(id)!;
  try {
    let probe: ProbeResult | null = null;
    if (kind === 'image') probe = await probeImage(url);
    else {
      const viaWorker = typeof OffscreenCanvas !== 'undefined' ? await probeInWorker(data, kind) : undefined;
      probe = viaWorker === undefined ? await probeWithMediabunny(data, kind) : viaWorker;
      if (!probe) probe = await probeWithElement(url, kind);
    }
    if (kind !== 'image' && !(probe.duration > 0)) throw new ImportError(`${file.name}: couldn't work out how long this file is — it may be damaged.`);
    const item: MediaItem = {
      id, name: file.name, kind, mimeType: file.type || kind, size: file.size,
      duration: probe.duration, width: probe.width, height: probe.height, hasAudio: probe.hasAudio,
      fingerprint: fp, importedAt: Date.now(), thumbnails: probe.thumbnails, meta: probe.meta,
      warning: probe.warning,
    };
    if (inPlace) item.localPath = (file as InPlaceFile).path;
    if (/^(gif|webp|png|apng)$/.test(extensionOf(file.name))) {
      const a = await loadAnimated(id);
      if (a) { item.duration = a.duration; item.meta = { ...(item.meta ?? {}), animated: 1, frames: a.frames.length }; }
      else if (extensionOf(file.name) === 'gif' && !(globalThis as { ImageDecoder?: unknown }).ImageDecoder) item.warning = 'This browser can only show the first frame of animated GIFs (Chrome, Edge, Firefox and the desktop app play them).';
    }
    return { file, item };
  } catch (e) {
    unregister(id);
    const msg = e instanceof ImportError ? e.message : `couldn't be imported (${(e as Error).message}).`;
    const unsupported = e instanceof ImportError && /can't be read|can't decode|format isn't supported/i.test(msg);
    return { file, error: msg.startsWith(file.name) ? msg : `${file.name}: ${msg}`, unsupported };
  }
}

/** Collect files from a drag-and-drop, walking into dropped folders. */
export async function filesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  const items = Array.from(dt.items ?? []);
  const entries = items
    .map((i) => (i.kind === 'file' ? (i as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.() : null))
    .filter(Boolean) as FileSystemEntry[];
  if (!entries.length) return Array.from(dt.files ?? []);
  const out: File[] = [];
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      out.push(await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej)));
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      let batch: FileSystemEntry[];
      do {
        batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        for (const e of batch) await walk(e);
      } while (batch.length);
    }
  };
  for (const e of entries) {
    try { await walk(e); } catch { /* unreadable entry: skip */ }
  }
  return out.filter((f) => classify(f));
}
