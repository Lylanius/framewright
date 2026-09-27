/**
 * AI tools orchestration (main thread side).
 *
 * Where each tool runs:
 *  - Silence removal, scene detection, highlights, motion reframe, tracking:
 *    measured in the background media worker, entirely on this device.
 *  - Transcription (auto-captions, filler words): Whisper in its own worker.
 *    The model is downloaded once from Hugging Face and cached; audio never
 *    leaves the device.
 *  - Background removal and face finding: MediaPipe models bundled with the app.
 *  - Image generation: only through a server *you* run (e.g. Stable Diffusion
 *    on your PC), and only when you set it up.
 */
import { ALL_FORMATS, AudioSampleSink, CanvasSink, Input } from 'mediabunny';
import { toSource, type MediaData } from './mediaSource';
import type { WordTiming } from '../core/types';
import { inArtifactHost } from '../platform/download';
import type { AsrRequest, AsrResponse } from './asr.worker';
import { getData } from './media';
import { runJob } from './workerClient';
import type { WorkerResponse } from './media.worker';

/* ------------------------------------------------------------------ */
/* Capabilities                                                           */
/* ------------------------------------------------------------------ */

export function vendorBase(): string {
  return new URL('./vendor/', location.href).href;
}

/** Background removal and face finding load bundled model files that only the installed app serves. */
export function bundledModelsAvailable(): { ok: boolean; reason?: string } {
  if (inArtifactHost() || import.meta.env.MODE === 'single') {
    return { ok: false, reason: 'Background removal and face finding use model files that ship with the installed Framewright app, so they aren’t available in this embedded view.' };
  }
  return { ok: true };
}

/** Transcription needs the model download + ONNX runtime files, which only the installed/standalone app can reach. */
export function transcriptionAvailable(): { ok: boolean; reason?: string } {
  if (inArtifactHost() || import.meta.env.MODE === 'single') {
    return { ok: false, reason: 'Auto-captions need the installed Framewright app (the speech model is a one-time ~40–80 MB download, which this embedded view can’t fetch).' };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Video analysis (worker)                                                */
/* ------------------------------------------------------------------ */

type VideoResult = Extract<WorkerResponse, { type: 'video' }>;
const videoCache = new Map<string, Promise<VideoResult>>();

export function analyseVideo(mediaId: string, opts: { start?: number; end?: number; perSecond?: number } = {}, onProgress?: (p: number) => void): Promise<VideoResult> {
  const blob = getData(mediaId);
  if (!blob) return Promise.reject(new Error('The media file isn’t available on this device.'));
  const perSecond = opts.perSecond ?? 10;
  const key = `${mediaId}|${opts.start ?? 0}|${opts.end ?? 'end'}|${perSecond}`;
  let p = videoCache.get(key);
  if (!p) {
    p = runJob<VideoResult>({ type: 'analyseVideo', data: blob, perSecond, start: opts.start ?? 0, end: opts.end ?? 1e9, motion: true }, onProgress).promise;
    videoCache.set(key, p);
    p.catch(() => videoCache.delete(key));
  }
  return p;
}

export function trackPoint(mediaId: string, start: number, end: number, box: { x: number; y: number; w: number; h: number }, onProgress?: (p: number) => void) {
  const blob = getData(mediaId);
  if (!blob) return Promise.reject(new Error('The media file isn’t available on this device.'));
  return runJob<Extract<WorkerResponse, { type: 'track' }>>({ type: 'track', data: blob, start, end, perSecond: 15, box }, onProgress).promise;
}

/* ------------------------------------------------------------------ */
/* Transcription                                                           */
/* ------------------------------------------------------------------ */

export interface AsrModel { id: string; label: string; size: string; english: boolean }
export const ASR_MODELS: AsrModel[] = [
  { id: 'Xenova/whisper-tiny.en', label: 'Fast · English', size: '~40 MB', english: true },
  { id: 'Xenova/whisper-base.en', label: 'Accurate · English', size: '~80 MB', english: true },
  { id: 'Xenova/whisper-tiny', label: 'Fast · any language', size: '~40 MB', english: false },
  { id: 'Xenova/whisper-base', label: 'Accurate · any language', size: '~80 MB', english: false },
];

export interface TranscribeProgress {
  stage: 'audio' | 'download' | 'loading' | 'transcribing';
  fraction: number;
  detail?: string;
}

/** Decode a source range as 16 kHz mono (what Whisper expects). */
export async function decodeMono16k(blob: MediaData, from: number, to: number): Promise<Float32Array> {
  const input = new Input({ source: toSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode())) throw new Error('This file has no sound this browser can decode.');
    const rate = await track.getSampleRate();
    const chunks: Float32Array[] = [];
    let total = 0;
    let firstTs: number | null = null;
    const sink = new AudioSampleSink(track);
    for await (const sample of sink.samples(from, to)) {
      if (firstTs === null) firstTs = sample.timestamp;
      const n = sample.numberOfFrames, ch = sample.numberOfChannels;
      const mono = new Float32Array(n);
      const tmp = new Float32Array(n);
      for (let c = 0; c < ch; c++) {
        sample.copyTo(tmp, { planeIndex: c, format: 'f32-planar' });
        for (let i = 0; i < n; i++) mono[i] += tmp[i] / ch;
      }
      chunks.push(mono);
      total += n;
      sample.close();
    }
    if (!total) return new Float32Array(0);
    const joined = new Float32Array(total);
    let o = 0;
    for (const c of chunks) { joined.set(c, o); o += c.length; }
    // Trim to the exact start, then resample with the browser's high-quality resampler.
    const skip = Math.max(0, Math.round(((from - (firstTs ?? from)) * rate)));
    const src = joined.subarray(skip);
    const outLen = Math.max(1, Math.ceil((src.length * 16000) / rate));
    const ctx = new OfflineAudioContext(1, outLen, 16000);
    const buf = ctx.createBuffer(1, src.length, rate);
    buf.copyToChannel(src, 0);
    const node = ctx.createBufferSource();
    node.buffer = buf;
    node.connect(ctx.destination);
    node.start();
    return (await ctx.startRendering()).getChannelData(0).slice();
  } finally {
    input.dispose();
  }
}

let asrWorker: Worker | null = null;
async function getAsrWorker(): Promise<Worker> {
  if (asrWorker) return asrWorker;
  // Not bundled into the single-file (embedded) build, which can't download models anyway.
  if (import.meta.env.MODE !== 'single') {
    const mod = await import('./asr.worker?worker');
    asrWorker = new mod.default();
    return asrWorker;
  }
  throw new Error('Auto-captions need the installed Framewright app.');
}

export function cancelTranscription(): void {
  asrWorker?.terminate();
  asrWorker = null;
}

/**
 * Transcribe a whole media file (source time). Long files are processed in
 * 10-minute pieces to keep memory bounded.
 */
export async function transcribeMedia(
  mediaId: string, duration: number, model: string, language: string | null,
  onProgress: (p: TranscribeProgress) => void,
): Promise<{ words: WordTiming[]; wordLevel: boolean }> {
  const avail = transcriptionAvailable();
  if (!avail.ok) throw new Error(avail.reason);
  const blob = getData(mediaId);
  if (!blob) throw new Error('The media file isn’t available on this device.');
  const SEG = 600;
  const words: WordTiming[] = [];
  let wordLevel = true;
  const webgpu = 'gpu' in navigator;
  for (let s = 0; s < duration; s += SEG) {
    const e = Math.min(duration, s + SEG);
    const segFrac = (x: number) => (s + x * (e - s)) / duration;
    onProgress({ stage: 'audio', fraction: segFrac(0), detail: 'Reading the audio' });
    const audio = await decodeMono16k(blob, s, e);
    if (audio.length < 1600) continue;
    const id = `asr${Date.now()}${Math.random()}`;
    const w = await getAsrWorker();
    const res = await new Promise<Extract<AsrResponse, { type: 'result' }>>((resolve, reject) => {
      const onMsg = (ev: MessageEvent<AsrResponse>) => {
        const m = ev.data;
        if (m.id !== id) return;
        if (m.type === 'download') onProgress({ stage: 'download', fraction: m.progress / 100, detail: m.file });
        else if (m.type === 'stage') onProgress({ stage: m.stage, fraction: m.stage === 'transcribing' ? segFrac(0.1) : 0, detail: m.device === 'webgpu' ? 'Using your graphics chip' : 'Using your processor' });
        else if (m.type === 'result') { w.removeEventListener('message', onMsg); resolve(m); }
        else if (m.type === 'error') { w.removeEventListener('message', onMsg); reject(new Error(friendlyAsrError(m.message))); }
      };
      w.addEventListener('message', onMsg);
      w.onerror = () => reject(new Error('The speech engine stopped unexpectedly.'));
      const req: AsrRequest = { type: 'transcribe', id, audio, model, language, wasmBase: `${vendorBase()}ort/`, webgpu };
      w.postMessage(req, [audio.buffer]);
    });
    if (!res.wordLevel) wordLevel = false;
    for (const x of res.words) words.push({ text: x.text, start: x.start + s, end: x.end + s });
    onProgress({ stage: 'transcribing', fraction: segFrac(1) });
  }
  return { words, wordLevel };
}

function friendlyAsrError(msg: string): string {
  if (/fetch|network|Failed to load|404|Could not locate/i.test(msg)) return 'Couldn’t download the speech model. Check your internet connection (it’s only needed once), then try again.';
  if (/memory|allocation/i.test(msg)) return 'Ran out of memory. Try the Fast model or a shorter clip.';
  return `Transcription failed: ${msg}`;
}

/* ------------------------------------------------------------------ */
/* MediaPipe (bundled models): background removal + face finding          */
/* ------------------------------------------------------------------ */

interface MpResults { segmentationMask?: CanvasImageSource; detections?: { boundingBox: { xCenter: number; yCenter: number; width: number; height: number } }[] }
interface MpSolution {
  setOptions(o: Record<string, unknown>): void;
  onResults(cb: (r: MpResults) => void): void;
  send(i: { image: CanvasImageSource }): Promise<void>;
  initialize(): Promise<void>;
  close(): Promise<void>;
}

const scripts = new Map<string, Promise<void>>();
function loadScript(src: string): Promise<void> {
  if (!scripts.has(src)) {
    scripts.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.crossOrigin = 'anonymous';
      s.onload = () => resolve();
      s.onerror = () => { scripts.delete(src); reject(new Error('This part of the app couldn’t be loaded here. Background removal and face finding work in the installed app.')); };
      document.head.appendChild(s);
    }));
  }
  return scripts.get(src)!;
}

/** Runs a MediaPipe solution one frame at a time (it isn't re-entrant). */
class MpRunner {
  private sol: Promise<MpSolution> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private last: MpResults | null = null;
  constructor(private folder: string, private script: string, private globalName: string, private options: Record<string, unknown>) {}

  private init(): Promise<MpSolution> {
    this.sol ??= (async () => {
      const avail = bundledModelsAvailable();
      if (!avail.ok) throw new Error(avail.reason);
      const base = `${vendorBase()}mediapipe/${this.folder}/`;
      await loadScript(`${base}${this.script}`);
      const Ctor = (window as unknown as Record<string, new (o: { locateFile: (f: string) => string }) => MpSolution>)[this.globalName];
      if (!Ctor) throw new Error('The model didn’t load.');
      const sol = new Ctor({ locateFile: (f) => `${base}${f}` });
      sol.setOptions(this.options);
      sol.onResults((r) => { this.last = r; });
      await sol.initialize();
      return sol;
    })();
    this.sol.catch(() => { this.sol = null; });
    return this.sol;
  }

  run(image: CanvasImageSource): Promise<MpResults> {
    const job = this.queue.then(async () => {
      const sol = await this.init();
      this.last = null;
      await sol.send({ image });
      return this.last ?? {};
    });
    this.queue = job.catch(() => undefined);
    return job;
  }
}

const segmenter = new MpRunner('selfie_segmentation', 'selfie_segmentation.js', 'SelfieSegmentation', { modelSelection: 1, selfieMode: false });
const faces = new MpRunner('face_detection', 'face_detection.js', 'FaceDetection', { model: 'full', minDetectionConfidence: 0.5, selfieMode: false });

/** Person mask for a frame (white = person). Resolves to a small canvas you can reuse. */
export async function segmentPerson(image: CanvasImageSource, w: number, h: number): Promise<HTMLCanvasElement> {
  const scale = Math.min(1, 512 / Math.max(w, h));
  const sw = Math.max(2, Math.round(w * scale)), sh = Math.max(2, Math.round(h * scale));
  const input = document.createElement('canvas');
  input.width = sw; input.height = sh;
  input.getContext('2d')!.drawImage(image, 0, 0, sw, sh);
  const r = await segmenter.run(input);
  if (!r.segmentationMask) throw new Error('No mask produced.');
  const out = document.createElement('canvas');
  out.width = sw; out.height = sh;
  out.getContext('2d')!.drawImage(r.segmentationMask, 0, 0, sw, sh);
  return out;
}

export async function findFaces(image: CanvasImageSource): Promise<{ x: number; y: number; w: number; h: number }[]> {
  const r = await faces.run(image);
  return (r.detections ?? []).map((d) => ({ x: d.boundingBox.xCenter, y: d.boundingBox.yCenter, w: d.boundingBox.width, h: d.boundingBox.height }));
}

/** Sample a video and return the main face's centre over time (-1 where none). */
export async function faceTrack(mediaId: string, from: number, to: number, perSecond = 4, onProgress?: (p: number) => void): Promise<{ times: number[]; xs: number[]; ys: number[]; found: number }> {
  const blob = getData(mediaId);
  if (!blob) throw new Error('The media file isn’t available on this device.');
  const input = new Input({ source: toSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) throw new Error('This video can’t be decoded here.');
    const first = await track.getFirstTimestamp();
    const sink = new CanvasSink(track, { width: 480, poolSize: 2 });
    const times: number[] = [];
    for (let t = from; t < to; t += 1 / perSecond) times.push(t);
    const xs: number[] = [], ys: number[] = [];
    let found = 0, i = 0;
    for await (const wc of sink.canvasesAtTimestamps(times.map((t) => t + first))) {
      let x = -1, y = -1;
      if (wc) {
        const dets = await findFaces(wc.canvas as HTMLCanvasElement);
        const main = dets.sort((a, b) => b.w * b.h - a.w * a.h)[0];
        if (main) { x = main.x; y = main.y; found++; }
      }
      xs.push(x); ys.push(y);
      onProgress?.(++i / times.length);
    }
    return { times, xs, ys, found };
  } finally {
    input.dispose();
  }
}

/* ------------------------------------------------------------------ */
/* Local image generation (your own server)                               */
/* ------------------------------------------------------------------ */

export type GenProvider = 'automatic1111' | 'openai-compatible';
export interface GenSettings { provider: GenProvider; url: string; model?: string; apiKey?: string }

/**
 * Generate an image with a model you host yourself. The prompt (never your
 * media) is sent to the address you configured.
 */
export async function generateImage(settings: GenSettings, prompt: string, width: number, height: number, signal?: AbortSignal): Promise<Blob> {
  const base = settings.url.replace(/\/+$/, '');
  const round = (n: number) => Math.max(64, Math.round(n / 64) * 64);
  let b64: string | undefined;
  if (settings.provider === 'automatic1111') {
    const res = await fetch(`${base}/sdapi/v1/txt2img`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ prompt, width: round(width), height: round(height), steps: 25 }),
    });
    if (!res.ok) throw new Error(`Your image server replied ${res.status}.`);
    b64 = (await res.json()).images?.[0];
  } else {
    const res = await fetch(`${base}/v1/images/generations`, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}) },
      body: JSON.stringify({ prompt, model: settings.model || undefined, size: `${round(width)}x${round(height)}`, response_format: 'b64_json', n: 1 }),
    });
    if (!res.ok) throw new Error(`Your image server replied ${res.status}.`);
    b64 = (await res.json()).data?.[0]?.b64_json;
  }
  if (!b64) throw new Error('The server didn’t return an image.');
  const bin = atob(b64.replace(/^data:image\/\w+;base64,/, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: 'image/png' });
}

/**
 * Video generation: architecture hook only (TODO). A provider will take a
 * prompt (and optionally a start image) and return a video Blob that is
 * imported like any other media. No provider is implemented yet.
 */
export interface VideoGenProvider {
  id: string;
  label: string;
  generate(prompt: string, opts: { seconds: number; width: number; height: number; image?: Blob }, signal?: AbortSignal): Promise<Blob>;
}
export const VIDEO_GEN_PROVIDERS: VideoGenProvider[] = [];
