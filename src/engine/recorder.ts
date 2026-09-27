/**
 * Recording from the screen, camera or microphone straight into a project.
 *
 * MediaRecorder output is streamed as it's made (to a temp file in the desktop
 * app, to memory in the browser), then re-packaged without re-encoding so the
 * file has a proper length and seek index (raw MediaRecorder WebM has neither,
 * which makes scrubbing slow). Nothing is uploaded anywhere.
 */
import { ALL_FORMATS, BufferTarget, Conversion, Input, Mp4OutputFormat, Output, StreamTarget, WebMOutputFormat } from 'mediabunny';
import type { InPlaceFile } from './media';
import { toSource, type MediaData } from './mediaSource';
import { createExportSink } from '../platform/exportSink';
import { nativeBridge, type TempWriter } from '../platform/native';

export type RecordKind = 'video' | 'audio';

export function pickRecordingFormat(kind: RecordKind): { mime: string; ext: 'mp4' | 'webm' | 'm4a' } {
  const MR = typeof MediaRecorder !== 'undefined' ? MediaRecorder : null;
  const ok = (m: string) => !!MR?.isTypeSupported?.(m);
  if (kind === 'video') {
    // H.264 first: usually hardware-encoded, so recording gameplay costs less CPU.
    for (const m of ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,opus', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']) {
      if (ok(m)) return { mime: m, ext: m.startsWith('video/mp4') ? 'mp4' : 'webm' };
    }
    return { mime: '', ext: 'webm' };
  }
  for (const m of ['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm']) {
    if (ok(m)) return { mime: m, ext: m.startsWith('audio/mp4') ? 'm4a' : 'webm' };
  }
  return { mime: '', ext: 'webm' };
}

export interface RecordingResult { file: File | InPlaceFile; seconds: number }

/**
 * One recording. `start()` begins capturing; `stop()` finishes and returns an
 * importable file. Pause/resume are supported (paused time isn't recorded).
 */
export class Recording {
  private rec: MediaRecorder;
  private chunks: Blob[] = [];
  private writer: TempWriter | null = null;
  private written = 0;
  private writes: Promise<void> = Promise.resolve();
  private startedAt = 0;
  private pausedFor = 0;
  private pausedAt = 0;
  readonly format: { mime: string; ext: 'mp4' | 'webm' | 'm4a' };
  private failed: Error | null = null;

  constructor(private stream: MediaStream, kind: RecordKind, private baseName: string, bitrate?: number) {
    this.format = pickRecordingFormat(kind);
    this.rec = new MediaRecorder(stream, {
      mimeType: this.format.mime || undefined,
      videoBitsPerSecond: kind === 'video' ? bitrate ?? 12_000_000 : undefined,
      audioBitsPerSecond: 192_000,
    });
    this.rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      if (this.writer) {
        const w = this.writer, pos = this.written;
        this.written += e.data.size;
        this.writes = this.writes.then(async () => w.write(new Uint8Array(await e.data.arrayBuffer()), pos)).catch((err) => { this.failed = err as Error; });
      } else this.chunks.push(e.data);
    };
  }

  async start(): Promise<void> {
    // Desktop: stream to disk so an hour of gameplay never sits in memory.
    this.writer = (await nativeBridge()?.tempWriter?.(this.format.ext).catch(() => null)) ?? null;
    this.rec.start(1000);
    this.startedAt = performance.now();
  }

  get state(): RecordingState { return this.rec.state; }

  elapsed(): number {
    const now = this.rec.state === 'paused' ? this.pausedAt : performance.now();
    return this.startedAt ? (now - this.startedAt - this.pausedFor) / 1000 : 0;
  }

  pause(): void { if (this.rec.state === 'recording') { this.rec.pause(); this.pausedAt = performance.now(); } }
  resume(): void { if (this.rec.state === 'paused') { this.pausedFor += performance.now() - this.pausedAt; this.rec.resume(); } }

  /** Stop recording (and the capture) and return the finished, importable file. */
  async stop(onProgress?: (f: number) => void): Promise<RecordingResult> {
    const seconds = this.elapsed();
    if (this.rec.state !== 'inactive') {
      await new Promise<void>((resolve) => { this.rec.onstop = () => resolve(); this.rec.stop(); });
    }
    this.stream.getTracks().forEach((t) => t.stop());
    await this.writes;
    if (this.failed) throw this.failed;
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '.');
    const name = `${this.baseName} ${stamp}.${this.format.ext}`;
    const type = this.format.mime.split(';')[0] || (this.format.ext === 'm4a' ? 'audio/mp4' : `video/${this.format.ext}`);
    const native = nativeBridge();
    if (this.writer) {
      await this.writer.finish(type);
      const raw: MediaData = { url: this.writer.url, size: this.written };
      const fixed = await remux(raw, this.format.ext, onProgress).catch(() => null);
      const token = fixed?.native?.token ?? this.writer.token;
      if (fixed?.native) await this.writer.abort();
      const ref = await native!.keepRecording!(token, name);
      return { seconds, file: { name, type, size: ref.size, data: { url: ref.url, size: ref.size }, path: ref.path } };
    }
    const blob = new Blob(this.chunks, { type });
    this.chunks = [];
    const fixed = await remux(blob, this.format.ext, onProgress).catch(() => null);
    return { seconds, file: new File([fixed?.blob ?? blob], name, { type }) };
  }

  /** Throw the recording away. */
  async cancel(): Promise<void> {
    if (this.rec.state !== 'inactive') {
      await new Promise<void>((resolve) => { this.rec.onstop = () => resolve(); this.rec.stop(); });
    }
    this.stream.getTracks().forEach((t) => t.stop());
    await this.writes;
    await this.writer?.abort().catch(() => undefined);
    this.chunks = [];
  }
}

type RecordingState = MediaRecorder['state'];

/**
 * Re-package (no re-encode) so the file has a duration and seek index.
 * Returns null if the recording can't be read back (the raw file is used as-is).
 */
async function remux(data: MediaData, ext: string, onProgress?: (f: number) => void): Promise<{ blob?: Blob; native?: { token: string } } | null> {
  const input = new Input({ source: toSource(data), formats: ALL_FORMATS });
  const sink = nativeBridge()?.tempWriter ? await createExportSink(ext) : null;
  const target = sink ? new StreamTarget(sink.writable, { chunked: true, chunkSize: 4 * 1024 * 1024 }) : new BufferTarget();
  const output = new Output({ format: ext === 'webm' ? new WebMOutputFormat() : new Mp4OutputFormat({ fastStart: sink ? false : 'in-memory' }), target });
  try {
    const conv = await Conversion.init({ input, output });
    if (!conv.isValid) { await sink?.abort(); return null; }
    if (onProgress) conv.onProgress = onProgress;
    await conv.execute();
    if (sink) {
      const done = await sink.finish(ext === 'webm' ? 'video/webm' : 'video/mp4');
      return done.native ? { native: { token: done.native.token } } : { blob: done.blob };
    }
    return { blob: new Blob([(target as BufferTarget).buffer!]) };
  } catch (e) {
    await sink?.abort().catch(() => undefined);
    throw e;
  } finally {
    input.dispose?.();
  }
}

/* ------------------------------------------------------------------ */
/* Capture helpers                                                      */
/* ------------------------------------------------------------------ */

export function recordingSupported(): { ok: boolean; reason?: string } {
  if (typeof MediaRecorder === 'undefined') return { ok: false, reason: 'Recording isn’t supported in this browser.' };
  if (!window.isSecureContext) return { ok: false, reason: 'Recording needs a secure (https) page.' };
  return { ok: true };
}

export function screenSupported(): boolean {
  return !!navigator.mediaDevices?.getDisplayMedia && !/Android|iPhone|iPad/i.test(navigator.userAgent);
}

export async function listDevices(): Promise<{ cams: MediaDeviceInfo[]; mics: MediaDeviceInfo[] }> {
  const all = await navigator.mediaDevices.enumerateDevices();
  return { cams: all.filter((d) => d.kind === 'videoinput'), mics: all.filter((d) => d.kind === 'audioinput') };
}

/** Mix several audio tracks (e.g. system sound + microphone) into one. */
export function mixAudio(streams: MediaStream[]): { track: MediaStreamTrack | null; close: () => void } {
  const withAudio = streams.filter((s) => s.getAudioTracks().length);
  if (withAudio.length === 0) return { track: null, close: () => undefined };
  if (withAudio.length === 1) return { track: withAudio[0].getAudioTracks()[0], close: () => undefined };
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  for (const s of withAudio) ctx.createMediaStreamSource(s).connect(dest);
  return { track: dest.stream.getAudioTracks()[0], close: () => void ctx.close() };
}

/** Level (0..1) of a stream's audio, for the recording meter. */
export function levelMeter(stream: MediaStream): { read: () => number; close: () => void } {
  if (!stream.getAudioTracks().length) return { read: () => 0, close: () => undefined };
  const ctx = new AudioContext();
  const an = ctx.createAnalyser();
  an.fftSize = 512;
  ctx.createMediaStreamSource(stream).connect(an);
  const buf = new Float32Array(an.fftSize);
  return {
    read: () => { an.getFloatTimeDomainData(buf); let p = 0; for (const v of buf) p = Math.max(p, Math.abs(v)); return p; },
    close: () => void ctx.close(),
  };
}
