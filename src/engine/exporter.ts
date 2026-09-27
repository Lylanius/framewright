/**
 * Export engine.
 *
 * Video: every frame is rendered by the same compositor as the preview, with
 * frame-accurate source frames decoded by Mediabunny (WebCodecs), then encoded
 * with the browser's hardware/software encoders and muxed to MP4/MOV/WebM.
 * Audio: mixed offline in 5-second chunks and encoded alongside.
 *
 * No watermark, no length limit, nothing leaves the device.
 */
import {
  ALL_FORMATS, AudioBufferSource, BufferTarget, CanvasSink, CanvasSource, Input, Mp3OutputFormat, StreamTarget,
  Mp4OutputFormat, MovOutputFormat, Output, WavOutputFormat, WebMOutputFormat, canEncodeAudio, canEncodeVideo,
  type AudioCodec, type VideoCodec, type WrappedCanvas,
} from 'mediabunny';
import { GIFEncoder, applyPalette, quantize } from 'gifenc';
import { clipEnd, projectDuration } from '../core/timeline';
import { clipActiveRanges, sourceTimeExtended } from '../core/transitions';
import type { Clip, Project } from '../core/types';
import { ensureFont } from '../styles/fonts';
import { AudioMixer, audibleClips } from './audio';
import { renderFrame, type FrameSources, type VisualFrame } from './compositor';
import { animatedFrame, getData, getImage, getUrl, loadAnimated, type AnimatedImage } from './media';
import { toSource } from './mediaSource';
import { segmentPerson } from './ai';
import { syncLuts } from './gpu';
import { createExportSink, type ExportSink } from '../platform/exportSink';

export type ExportFormat = 'mp4' | 'mov' | 'webm' | 'gif' | 'png' | 'jpeg' | 'wav' | 'mp3';

export interface ExportSettings {
  format: ExportFormat;
  width: number;
  height: number;
  fps: number;
  videoCodec: VideoCodec;
  /** bits per second; 0 = automatic from quality */
  videoBitrate: number;
  quality: 'low' | 'medium' | 'high' | 'max';
  audioCodec?: AudioCodec;
  audioBitrate: number;
  sampleRate: 44100 | 48000;
  hardware: 'no-preference' | 'prefer-hardware' | 'prefer-software';
  /** Export only this time range; null = whole timeline. */
  range: [number, number] | null;
  /** Still-frame time for PNG/JPEG. */
  stillTime?: number;
  includeAudio: boolean;
  /** false = always assemble in memory (tests/troubleshooting). Default: stream to disk when possible. */
  streamToDisk?: boolean;
}

export interface ExportProgress {
  phase: 'preparing' | 'video' | 'audio' | 'finalising' | 'done';
  fraction: number;
  framesDone?: number;
  framesTotal?: number;
  etaSeconds?: number;
}

export interface ExportResult {
  blob: Blob;
  filename: string;
  mime: string;
  seconds: number;
  /** Bytes (for files kept on disk by the desktop app, `blob` is empty). */
  size: number;
  /** Desktop app: the export sits in a temp file until saved. */
  native?: { token: string; url: string; size: number };
  /** Where the bytes were assembled: streamed to disk, or in memory. */
  via: 'disk' | 'memory';
}

export class ExportCancelled extends Error {
  constructor() { super('Export cancelled'); }
}

export const RESOLUTION_PRESETS = [
  { label: '720p', short: 720 },
  { label: '1080p', short: 1080 },
  { label: '1440p', short: 1440 },
  { label: '4K', short: 2160 },
];

/** Output size for a resolution preset, keeping the project's aspect ratio. */
export function sizeForShortSide(project: Project, short: number): { width: number; height: number } {
  const { width, height } = project.settings;
  const s = short / Math.min(width, height);
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return { width: even(width * s), height: even(height * s) };
}

/** Rough bitrate targets (bits/s) at 30 fps, scaled by pixel count and fps. */
export function autoBitrate(width: number, height: number, fps: number, quality: ExportSettings['quality'], codec: VideoCodec): number {
  const bppf = { low: 0.05, medium: 0.08, high: 0.12, max: 0.2 }[quality];
  const efficiency = codec === 'avc' ? 1 : codec === 'vp9' ? 0.7 : 0.6; // hevc/av1 need less
  return Math.round(width * height * fps * bppf * efficiency);
}

export async function supportedVideoCodecs(format: ExportFormat, width: number, height: number): Promise<VideoCodec[]> {
  const candidates: VideoCodec[] = format === 'webm' ? ['vp9', 'av1', 'vp8'] : ['avc', 'hevc', 'av1'];
  const out: VideoCodec[] = [];
  for (const c of candidates) {
    try { if (await canEncodeVideo(c, { width, height })) out.push(c); } catch { /* unsupported */ }
  }
  return out;
}

let encodersRegistered = false;
/** Load WASM fallback encoders (AAC/MP3) only when the browser lacks a native one. */
async function ensureAudioEncoders(codec: AudioCodec, sampleRate: number): Promise<void> {
  if (await canEncodeAudio(codec, { sampleRate, numberOfChannels: 2 })) return;
  if (encodersRegistered) return;
  encodersRegistered = true;
  const [{ registerAacEncoder }, { registerMp3Encoder }] = await Promise.all([
    import('@mediabunny/aac-encoder'),
    import('@mediabunny/mp3-encoder'),
  ]);
  registerAacEncoder();
  registerMp3Encoder();
}

function slug(name: string): string {
  return name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'framewright-export';
}

/* ------------------------------------------------------------------ */
/* Frame sources for export                                             */
/* ------------------------------------------------------------------ */

interface ClipStream {
  iterator: AsyncGenerator<WrappedCanvas | null, void, unknown> | null;
  current: VisualFrame | null;
  /** Fallback when Mediabunny can't read the file: seek a <video>. */
  video?: HTMLVideoElement;
  input?: Input;
}

export class ExportSources {
  private streams = new Map<string, ClipStream>();
  private images = new Map<string, HTMLImageElement>();
  private animations = new Map<string, AnimatedImage>();
  private frameValues = new Map<string, VisualFrame | null>();

  private ranges: Map<string, [number, number]>;
  constructor(private project: Project, private frameTimes: number[]) {
    this.ranges = clipActiveRanges(project);
  }

  private inRange(clip: Clip, t: number): boolean {
    const [a, b] = this.ranges.get(clip.id) ?? [clip.start, clipEnd(clip)];
    return t >= a - 1e-6 && t < b - 1e-6;
  }

  private src(clip: Clip, t: number): number {
    return sourceTimeExtended(clip, t, this.project.media.find((m) => m.id === clip.mediaId));
  }

  async prepare(): Promise<void> {
    const imageIds = new Set<string>();
    for (const t of this.project.tracks) for (const c of t.clips) if (c.kind === 'image' && c.mediaId) imageIds.add(c.mediaId);
    for (const id of imageIds) {
      const p = getImage(id);
      if (p) { try { this.images.set(id, await p); } catch { /* missing image renders as empty */ } }
      if (this.project.media.find((m) => m.id === id)?.meta?.animated) {
        const a = await loadAnimated(id);
        if (a) this.animations.set(id, a);
      }
    }
    const fonts = new Set<string>();
    for (const t of this.project.tracks) for (const c of t.clips) if (c.text) fonts.add(JSON.stringify([c.text.fontFamily, c.text.fontWeight, c.text.italic]));
    for (const f of fonts) { const [fam, w, it] = JSON.parse(f); await ensureFont(fam, w, it); }
  }

  private async openStream(clip: Clip): Promise<ClipStream> {
    const stream: ClipStream = { iterator: null, current: null };
    this.streams.set(clip.id, stream);
    const blob = clip.mediaId ? getData(clip.mediaId) : null;
    if (!blob) return stream;
    try {
      const input = new Input({ source: toSource(blob), formats: ALL_FORMATS });
      const track = await input.getPrimaryVideoTrack();
      if (track && (await track.canDecode())) {
        stream.input = input;
        const sink = new CanvasSink(track, { poolSize: 3 });
        const first = await track.getFirstTimestamp();
        const times = this.frameTimes
          .filter((t) => this.inRange(clip, t))
          .map((t) => this.src(clip, t) + first);
        stream.iterator = sink.canvasesAtTimestamps(times);
        return stream;
      }
      input.dispose();
    } catch { /* fall back */ }
    // Fallback: seek a video element frame by frame (slower, still exact enough).
    const url = clip.mediaId ? getUrl(clip.mediaId) : null;
    if (url) {
      const v = document.createElement('video');
      v.crossOrigin = 'anonymous';
      v.muted = true; v.preload = 'auto'; v.playsInline = true; v.src = url;
      const ok = await new Promise<boolean>((res) => { v.onloadeddata = () => res(true); v.onerror = () => res(false); setTimeout(() => res(v.readyState >= 2), 10000); });
      // If the browser can't play it either, render this clip as empty rather than stalling every frame.
      if (ok) stream.video = v;
      else { v.removeAttribute('src'); v.load(); }
    }
    return stream;
  }

  /** Decode everything needed for frame time t. */
  async load(t: number): Promise<void> {
    this.frameValues.clear();
    for (const track of this.project.tracks) {
      if (track.kind !== 'visual' || track.hidden) continue;
      for (const clip of track.clips) {
        if (clip.kind !== 'video') continue;
        if (!this.inRange(clip, t)) continue;
        const stream = this.streams.get(clip.id) ?? (await this.openStream(clip));
        if (stream.iterator) {
          const r = await stream.iterator.next();
          if (!r.done && r.value) {
            const c = r.value.canvas;
            stream.current = { src: c, width: c.width, height: c.height };
          }
        } else if (stream.video) {
          const v = stream.video;
          const target = this.src(clip, t);
          if (Math.abs(v.currentTime - target) > 1e-3) {
            const seeked = await new Promise<boolean>((res) => { v.onseeked = () => res(true); v.currentTime = target; setTimeout(() => res(false), 2000); });
            if (!seeked) { stream.video = undefined; stream.current = null; }
          }
          if (v.videoWidth) stream.current = { src: v, width: v.videoWidth, height: v.videoHeight };
        }
        this.frameValues.set(clip.id, stream.current);
      }
    }
    // Background removal: segment exactly the frames being exported.
    for (const track of this.project.tracks) {
      if (track.kind !== 'visual' || track.hidden) continue;
      for (const clip of track.clips) {
        if (!clip.effects.some((e) => e.type === 'bgRemove' && e.enabled) || !this.inRange(clip, t)) continue;
        if (clip.kind === 'image' && this.masks.has(clip.id)) continue;
        const vf = this.sources.getVisual(clip, 0);
        if (vf) this.masks.set(clip.id, await segmentPerson(vf.src, vf.width, vf.height));
      }
    }
  }

  private masks = new Map<string, HTMLCanvasElement>();

  readonly sources: FrameSources = {
    getMask: (clip) => this.masks.get(clip.id) ?? null,
    getVisual: (clip, st) => {
      if (clip.kind === 'image') {
        const anim = clip.mediaId ? this.animations.get(clip.mediaId) : undefined;
        if (anim) { const f = animatedFrame(anim, st); return { src: f, width: f.width, height: f.height, displayWidth: anim.width, displayHeight: anim.height }; }
        const img = clip.mediaId ? this.images.get(clip.mediaId) : undefined;
        return img ? { src: img, width: img.naturalWidth, height: img.naturalHeight } : null;
      }
      return this.frameValues.get(clip.id) ?? null;
    },
  };

  dispose(): void {
    for (const s of this.streams.values()) {
      void s.iterator?.return();
      s.input?.dispose();
      if (s.video) { s.video.removeAttribute('src'); s.video.load(); }
    }
    this.streams.clear();
  }
}

/* ------------------------------------------------------------------ */
/* Main entry                                                            */
/* ------------------------------------------------------------------ */

export async function exportProject(
  project: Project,
  settings: ExportSettings,
  onProgress: (p: ExportProgress) => void,
  signal?: AbortSignal,
): Promise<ExportResult> {
  const began = performance.now();
  syncLuts(project.luts);
  const check = () => { if (signal?.aborted) throw new ExportCancelled(); };
  const duration = projectDuration(project);
  const [r0, r1] = settings.range ?? [0, duration];
  const base = slug(project.name);
  onProgress({ phase: 'preparing', fraction: 0 });

  if (settings.format === 'png' || settings.format === 'jpeg') {
    const blob = await exportStill(project, settings);
    return { blob, filename: `${base}.${settings.format === 'png' ? 'png' : 'jpg'}`, mime: blob.type, seconds: (performance.now() - began) / 1000, size: blob.size, via: 'memory' };
  }
  if (r1 - r0 <= 0) throw new Error('The timeline is empty — add some clips before exporting.');

  if (settings.format === 'wav' || settings.format === 'mp3') {
    const blob = await exportAudioOnly(project, settings, r0, r1, onProgress, check);
    return { blob, filename: `${base}.${settings.format}`, mime: blob.type, seconds: (performance.now() - began) / 1000, size: blob.size, via: 'memory' };
  }
  if (settings.format === 'gif') {
    const blob = await exportGif(project, settings, r0, r1, onProgress, check);
    return { blob, filename: `${base}.gif`, mime: 'image/gif', seconds: (performance.now() - began) / 1000, size: blob.size, via: 'memory' };
  }

  if (typeof VideoEncoder === 'undefined') {
    throw new Error('This browser has no video encoder (WebCodecs). Use a current Chrome, Edge, Safari 16.4+ or Firefox 130+.');
  }

  const { width, height, fps } = settings;
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: false })!;
  const scale = width / project.settings.width;

  const total = Math.max(1, Math.round((r1 - r0) * fps));
  // Stream to disk when we can (memory stays flat for long exports); else assemble in memory.
  const sink: ExportSink | null = settings.streamToDisk === false ? null : await createExportSink(settings.format);
  // Streaming MP4/MOV reserve room for the index up front ("fast start") using the known packet counts.
  const fast = sink ? 'reserve' as const : 'in-memory' as const;
  const format = settings.format === 'webm' ? new WebMOutputFormat()
    : settings.format === 'mov' ? new MovOutputFormat({ fastStart: fast })
    : new Mp4OutputFormat({ fastStart: fast });
  const target = sink ? new StreamTarget(sink.writable, { chunked: true, chunkSize: 4 * 1024 * 1024 }) : new BufferTarget();
  const output = new Output({ format, target });
  const maxAudioPackets = Math.ceil((r1 - r0) * Math.max(settings.sampleRate / 960, 50) * 1.1) + 64;

  const bitrate = settings.videoBitrate || autoBitrate(width, height, fps, settings.quality, settings.videoCodec);
  if (!(await canEncodeVideo(settings.videoCodec, { width, height, bitrate }))) {
    throw new Error(`This device can't encode ${settings.videoCodec.toUpperCase()} at ${width}×${height}. Try H.264 or a lower resolution.`);
  }
  const videoSource = new CanvasSource(canvas, {
    codec: settings.videoCodec,
    bitrate,
    keyFrameInterval: 2,
    hardwareAcceleration: settings.hardware,
    latencyMode: 'quality',
  });
  output.addVideoTrack(videoSource, { frameRate: fps, maximumPacketCount: total + 16 });

  const wantAudio = settings.includeAudio && audibleClips(project).some((c) => c.start < r1 && clipEnd(c) > r0);
  let audioSource: AudioBufferSource | null = null;
  if (wantAudio) {
    const codec: AudioCodec = settings.audioCodec ?? (settings.format === 'webm' ? 'opus' : 'aac');
    await ensureAudioEncoders(codec, settings.sampleRate);
    // Constant bitrate: some phone encoders otherwise starve short, busy sounds (whooshes turn to crackle).
    audioSource = new AudioBufferSource({ codec, bitrate: settings.audioBitrate, bitrateMode: 'constant' });
    output.addAudioTrack(audioSource, { maximumPacketCount: maxAudioPackets });
  }
  await output.start();

  const frameTimes = Array.from({ length: total }, (_, i) => r0 + i / fps);
  const sources = new ExportSources(project, frameTimes);
  const mixer = wantAudio ? new AudioMixer(project, settings.sampleRate) : null;
  try {
    await sources.prepare();
    const CHUNK = 5;
    let audioDone = r0;
    // Pipeline: while frame i is being encoded, frame i+1 is already decoding.
    let loading: Promise<void> | null = sources.load(frameTimes[0]);
    for (let i = 0; i < total; i++) {
      check();
      const t = frameTimes[i];
      await loading;
      renderFrame(ctx, project, t, sources.sources, { scale });
      const adding = videoSource.add(i / fps, 1 / fps); // the canvas is captured synchronously
      loading = i + 1 < total ? sources.load(frameTimes[i + 1]) : null;
      loading?.catch(() => undefined); // surfaced by the next await; avoids an unhandled rejection if encoding fails first
      await adding;
      // Interleave audio so the muxer never buffers too much.
      if (audioSource && mixer && t + 1 / fps >= audioDone && audioDone < r1) {
        const end = Math.min(r1, audioDone + CHUNK);
        await audioSource.add(await mixer.renderRange(audioDone, end));
        audioDone = end;
      }
      if (i % 3 === 0 || i === total - 1) {
        const elapsed = (performance.now() - began) / 1000;
        const frac = (i + 1) / total;
        onProgress({ phase: 'video', fraction: frac * 0.97, framesDone: i + 1, framesTotal: total, etaSeconds: frac > 0.02 ? (elapsed / frac) * (1 - frac) : undefined });
      }
    }
    while (audioSource && mixer && audioDone < r1 - 1e-6) {
      check();
      const end = Math.min(r1, audioDone + CHUNK);
      await audioSource.add(await mixer.renderRange(audioDone, end));
      audioDone = end;
    }
    onProgress({ phase: 'finalising', fraction: 0.98 });
    await output.finalize();
  } catch (e) {
    if (output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => undefined);
    await sink?.abort();
    throw e;
  } finally {
    sources.dispose();
    mixer?.dispose();
  }
  const mime = settings.format === 'webm' ? 'video/webm' : settings.format === 'mov' ? 'video/quicktime' : 'video/mp4';
  onProgress({ phase: 'done', fraction: 1 });
  const seconds = (performance.now() - began) / 1000;
  const filename = `${base}.${settings.format}`;
  if (sink) {
    const f = await sink.finish(mime);
    return { blob: f.blob, native: f.native, size: f.native?.size ?? f.blob.size, filename, mime, seconds, via: 'disk' };
  }
  const blob = new Blob([(target as BufferTarget).buffer!], { type: mime });
  return { blob, filename, mime, seconds, size: blob.size, via: 'memory' };
}

async function exportStill(project: Project, settings: ExportSettings): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = settings.width; canvas.height = settings.height;
  const ctx = canvas.getContext('2d')!;
  const t = settings.stillTime ?? 0;
  const fps = project.settings.fps;
  const sources = new ExportSources(project, [t]);
  try {
    await sources.prepare();
    await sources.load(t);
    renderFrame(ctx, project, t, sources.sources, { scale: settings.width / project.settings.width });
  } finally {
    sources.dispose();
  }
  void fps;
  const type = settings.format === 'png' ? 'image/png' : 'image/jpeg';
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, type, 0.95));
  if (!blob) throw new Error('Could not encode the still image.');
  return blob;
}

async function exportAudioOnly(
  project: Project, settings: ExportSettings, r0: number, r1: number,
  onProgress: (p: ExportProgress) => void, check: () => void,
): Promise<Blob> {
  const isMp3 = settings.format === 'mp3';
  const codec: AudioCodec = isMp3 ? 'mp3' : 'pcm-s16';
  if (isMp3) await ensureAudioEncoders('mp3', settings.sampleRate);
  const target = new BufferTarget();
  const output = new Output({ format: isMp3 ? new Mp3OutputFormat() : new WavOutputFormat(), target });
  const src = new AudioBufferSource(isMp3 ? { codec, bitrate: settings.audioBitrate } : { codec });
  output.addAudioTrack(src);
  await output.start();
  const mixer = new AudioMixer(project, settings.sampleRate);
  try {
    const CHUNK = 10;
    for (let t = r0; t < r1 - 1e-6; t += CHUNK) {
      check();
      await src.add(await mixer.renderRange(t, Math.min(r1, t + CHUNK)));
      onProgress({ phase: 'audio', fraction: Math.min(0.97, (t + CHUNK - r0) / (r1 - r0)) });
    }
    await output.finalize();
  } catch (e) {
    await output.cancel().catch(() => undefined);
    throw e;
  } finally {
    mixer.dispose();
  }
  onProgress({ phase: 'done', fraction: 1 });
  return new Blob([target.buffer!], { type: isMp3 ? 'audio/mpeg' : 'audio/wav' });
}

async function exportGif(
  project: Project, settings: ExportSettings, r0: number, r1: number,
  onProgress: (p: ExportProgress) => void, check: () => void,
): Promise<Blob> {
  // GIFs get big fast: cap size and frame rate.
  const maxSide = 540;
  const s = Math.min(1, maxSide / Math.max(settings.width, settings.height));
  const width = Math.max(2, Math.round(settings.width * s)), height = Math.max(2, Math.round(settings.height * s));
  const fps = Math.min(settings.fps, 15);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const total = Math.max(1, Math.round((r1 - r0) * fps));
  const times = Array.from({ length: total }, (_, i) => r0 + i / fps);
  const sources = new ExportSources(project, times);
  const gif = GIFEncoder();
  const delay = Math.round(1000 / fps);
  try {
    await sources.prepare();
    for (let i = 0; i < total; i++) {
      check();
      await sources.load(times[i]);
      renderFrame(ctx, project, times[i], sources.sources, { scale: width / project.settings.width });
      const { data } = ctx.getImageData(0, 0, width, height);
      const palette = quantize(data, 256);
      gif.writeFrame(applyPalette(data, palette), width, height, { palette, delay });
      if (i % 2 === 0) onProgress({ phase: 'video', fraction: (i + 1) / total * 0.97, framesDone: i + 1, framesTotal: total });
      if (i % 10 === 0) await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    sources.dispose();
  }
  gif.finish();
  onProgress({ phase: 'done', fraction: 1 });
  return new Blob([gif.bytes()], { type: 'image/gif' });
}
