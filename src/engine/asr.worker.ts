/**
 * Speech-to-text worker (Whisper via transformers.js / ONNX Runtime Web).
 *
 * Runs entirely on the device. The only network use is the one-time download
 * of the model files from Hugging Face, which the browser then caches; the
 * audio itself never leaves this worker.
 */
import { env, pipeline } from '@huggingface/transformers';

export type AsrRequest =
  | { type: 'transcribe'; id: string; audio: Float32Array; model: string; language: string | null; wasmBase: string; webgpu: boolean }
  | { type: 'cancel'; id: string };

export interface AsrWord { text: string; start: number; end: number }

export type AsrResponse =
  | { type: 'download'; id: string; file: string; progress: number; loaded: number; total: number }
  | { type: 'stage'; id: string; stage: 'loading' | 'transcribing'; device: string }
  | { type: 'partial'; id: string; progress: number }
  | { type: 'result'; id: string; text: string; words: AsrWord[]; wordLevel: boolean }
  | { type: 'error'; id: string; message: string };

const post = (m: AsrResponse) => (self as unknown as Worker).postMessage(m);

type Transcriber = (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string; chunks?: { text: string; timestamp: [number, number | null] }[] }>;
const loaded = new Map<string, Promise<Transcriber>>();

function configure(wasmBase: string): void {
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.useBrowserCache = true;
  const onnx = env.backends.onnx as { wasm?: { wasmPaths?: unknown; numThreads?: number } };
  if (onnx.wasm && wasmBase) {
    const safariOld = /^((?!chrome|android).)*safari/i.test(navigator.userAgent) && !('gpu' in navigator);
    const suffix = safariOld ? '' : '.asyncify';
    onnx.wasm.wasmPaths = { mjs: `${wasmBase}ort-wasm-simd-threaded${suffix}.mjs`, wasm: `${wasmBase}ort-wasm-simd-threaded${suffix}.wasm` };
    if (!(self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated) onnx.wasm.numThreads = 1;
  }
}

async function getTranscriber(id: string, model: string, webgpu: boolean): Promise<{ run: Transcriber; device: string }> {
  const device = webgpu ? 'webgpu' : 'wasm';
  const key = `${model}|${device}`;
  if (!loaded.has(key)) {
    const p = pipeline('automatic-speech-recognition', model, {
      device,
      dtype: webgpu ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8',
      progress_callback: (info: { status: string; file?: string; progress?: number; loaded?: number; total?: number }) => {
        if (info.status === 'progress' && info.file) post({ type: 'download', id, file: info.file, progress: info.progress ?? 0, loaded: info.loaded ?? 0, total: info.total ?? 0 });
      },
    } as Record<string, unknown>) as unknown as Promise<Transcriber>;
    loaded.set(key, p);
    p.catch(() => loaded.delete(key));
  }
  return { run: await loaded.get(key)!, device };
}

self.onmessage = async (e: MessageEvent<AsrRequest>) => {
  const m = e.data;
  if (m.type !== 'transcribe') return;
  try {
    configure(m.wasmBase);
    post({ type: 'stage', id: m.id, stage: 'loading', device: m.webgpu ? 'webgpu' : 'wasm' });
    let t: { run: Transcriber; device: string };
    try {
      t = await getTranscriber(m.id, m.model, m.webgpu);
    } catch (err) {
      if (!m.webgpu) throw err;
      t = await getTranscriber(m.id, m.model, false); // WebGPU unavailable/failed: fall back to CPU
    }
    post({ type: 'stage', id: m.id, stage: 'transcribing', device: t.device });
    const base: Record<string, unknown> = { chunk_length_s: 30, stride_length_s: 5 };
    if (m.language && !m.model.endsWith('.en')) { base.language = m.language; base.task = 'transcribe'; }
    let wordLevel = true;
    let out: Awaited<ReturnType<Transcriber>>;
    try {
      out = await t.run(m.audio, { ...base, return_timestamps: 'word' });
    } catch (err) {
      // Models exported without attention outputs can't align words: fall back to phrase timings.
      if (!/cross attentions|output_attentions|alignment/i.test(String((err as Error).message))) throw err;
      wordLevel = false;
      out = await t.run(m.audio, { ...base, return_timestamps: true });
    }
    const words: AsrWord[] = [];
    for (const c of out.chunks ?? []) {
      const [s, e2] = c.timestamp;
      const text = c.text.trim();
      if (!text) continue;
      words.push({ text, start: s ?? 0, end: e2 ?? (s ?? 0) + 0.3 });
    }
    post({ type: 'result', id: m.id, text: out.text.trim(), words, wordLevel });
  } catch (err) {
    post({ type: 'error', id: m.id, message: (err as Error).message || String(err) });
  }
};
