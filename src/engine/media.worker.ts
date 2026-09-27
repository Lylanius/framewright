/**
 * Background media worker. Heavy, long-running jobs run here so the editor and
 * the preview stay smooth while a big file is being "loaded up":
 *  - audio analysis: waveform peaks + loudness (for silence removal / highlights)
 *  - preview proxies: a light 540p copy of 4K/60fps footage for smooth playback
 *  - scene analysis: per-frame difference scores (scene detection, auto-reframe)
 */
import {
  ALL_FORMATS, AudioSampleSink, BufferTarget, CanvasSink, Conversion, EncodedPacketSink, Input, Mp4OutputFormat, Output, canEncodeVideo,
  type VideoCodec,
} from 'mediabunny';
import { toSource, type MediaData } from './mediaSource';

/** Result of probing a file off the main thread. */
export type ProbeOutcome =
  | { ok: true; duration: number; width?: number; height?: number; hasAudio: boolean; thumbnails: string[]; meta: Record<string, string | number>; warning?: string }
  | { ok: false; reason: 'unreadable' }
  | { ok: false; reason: 'nodecode'; codec: string; meta: Record<string, string | number> };

export type WorkerRequest =
  | { type: 'analyseAudio'; id: string; data: MediaData; perSecond: number }
  | { type: 'proxy'; id: string; data: MediaData; maxSide: number; maxFps: number }
  | { type: 'analyseVideo'; id: string; data: MediaData; perSecond: number; start: number; end: number; motion: boolean }
  | { type: 'track'; id: string; data: MediaData; start: number; end: number; perSecond: number; box: { x: number; y: number; w: number; h: number } }
  | { type: 'probe'; id: string; data: MediaData; kind: 'video' | 'audio'; thumbCount: number; thumbHeight: number }
  | { type: 'cancel'; id: string };

export type WorkerResponse =
  | { type: 'progress'; id: string; progress: number }
  | { type: 'audio'; id: string; peaks: number[]; loudness: number[] }
  | { type: 'proxy'; id: string; buffer: ArrayBuffer; mime: string; hasAudio: boolean }
  | { type: 'video'; id: string; diffs: number[]; motionX: number[]; motionY: number[]; times: number[] }
  | { type: 'track'; id: string; times: number[]; points: { x: number; y: number }[]; confidence: number[] }
  | { type: 'probe'; id: string; outcome: ProbeOutcome }
  | { type: 'error'; id: string; message: string };

const cancelled = new Set<string>();
const running = new Map<string, Conversion>();
const post = (m: WorkerResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

async function analyseAudio(id: string, blob: MediaData, perSecond: number): Promise<void> {
  const input = new Input({ source: toSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode())) throw new Error('no decodable audio');
    const duration = await input.computeDuration();
    const n = Math.max(1, Math.ceil(duration * perSecond));
    const peaks = new Float32Array(n);
    const sumSq = new Float64Array(n);
    const counts = new Uint32Array(n);
    const sink = new AudioSampleSink(track);
    let buf = new Float32Array(0);
    let lastReport = 0;
    for await (const sample of sink.samples()) {
      if (cancelled.has(id)) { sample.close(); throw new Error('cancelled'); }
      const frames = sample.numberOfFrames;
      if (buf.length < frames) buf = new Float32Array(frames);
      const view = buf.subarray(0, frames);
      const chans = Math.min(2, sample.numberOfChannels);
      const rate = sample.sampleRate;
      for (let c = 0; c < chans; c++) {
        sample.copyTo(view, { planeIndex: c, format: 'f32-planar' });
        for (let i = 0; i < frames; i += 2) {
          const idx = Math.floor((sample.timestamp + i / rate) * perSecond);
          if (idx < 0 || idx >= n) continue;
          const v = view[i];
          const a = v < 0 ? -v : v;
          if (a > peaks[idx]) peaks[idx] = a;
          sumSq[idx] += v * v;
          counts[idx]++;
        }
      }
      if (sample.timestamp - lastReport > 2) { lastReport = sample.timestamp; post({ type: 'progress', id, progress: Math.min(1, sample.timestamp / duration) }); }
      sample.close();
    }
    let max = 0;
    for (const v of peaks) if (v > max) max = v;
    const k = max > 0 ? 1 / max : 1;
    const outPeaks = Array.from(peaks, (v) => Math.round(v * k * 1000) / 1000);
    // Loudness is absolute (RMS, 0..1), not normalised, so silence thresholds mean the same across files.
    const loudness = Array.from(sumSq, (s, i) => Math.round(Math.sqrt(counts[i] ? s / counts[i] : 0) * 10000) / 10000);
    post({ type: 'audio', id, peaks: outPeaks, loudness });
  } finally {
    input.dispose();
  }
}

async function thumbFrom(canvas: OffscreenCanvas | HTMLCanvasElement, h: number): Promise<string> {
  const w = Math.max(1, Math.round((canvas.width / canvas.height) * h));
  const c = new OffscreenCanvas(w, h);
  c.getContext('2d')!.drawImage(canvas as OffscreenCanvas, 0, 0, w, h);
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/jpeg;base64,${btoa(bin)}`;
}

/** Metadata, keyframe spacing and filmstrip thumbnails, all off the main thread. */
async function probe(id: string, blob: MediaData, kind: 'video' | 'audio', thumbCount: number, thumbHeight: number): Promise<void> {
  const input = new Input({ source: toSource(blob), formats: ALL_FORMATS });
  const done = (outcome: ProbeOutcome) => post({ type: 'probe', id, outcome });
  try {
    if (!(await input.canRead())) return done({ ok: false, reason: 'unreadable' });
    const video = kind === 'video' ? await input.getPrimaryVideoTrack() : null;
    const audio = await input.getPrimaryAudioTrack();
    if ((kind === 'video' && !video) || (kind === 'audio' && !audio)) return done({ ok: false, reason: 'unreadable' });
    const duration = await input.computeDuration();
    const meta: Record<string, string | number> = { container: (await input.getMimeType()).split(';')[0] };
    const out: Extract<ProbeOutcome, { ok: true }> = { ok: true, duration, hasAudio: false, thumbnails: [], meta };
    if (audio) {
      meta.audioCodec = (await audio.getCodec()) ?? 'unknown';
      meta.sampleRate = await audio.getSampleRate();
      meta.channels = await audio.getNumberOfChannels();
      out.hasAudio = await audio.canDecode();
      if (!out.hasAudio) out.warning = `Audio (${meta.audioCodec}) can't be decoded in this browser, so the clip will be silent.`;
    }
    if (video) {
      out.width = await video.getDisplayWidth();
      out.height = await video.getDisplayHeight();
      meta.videoCodec = (await video.getCodec()) ?? 'unknown';
      try {
        const fr = await video.computeFrameRateMetrics();
        if (fr.bestGuessFrameRate) meta.fps = Math.round(fr.bestGuessFrameRate * 100) / 100;
      } catch { /* optional */ }
      // Keyframe spacing (seconds): long gaps make scrubbing slow, so such files get a preview proxy.
      try {
        const ps = new EncodedPacketSink(video);
        let k = await ps.getFirstPacket({ metadataOnly: true });
        const stamps: number[] = [];
        while (k && stamps.length < 6) {
          stamps.push(k.timestamp);
          k = await ps.getNextKeyPacket(k, { metadataOnly: true });
        }
        if (stamps.length >= 2) meta.gop = Math.round(((stamps[stamps.length - 1] - stamps[0]) / (stamps.length - 1)) * 100) / 100;
        else if (stamps.length === 1 && duration > 0) meta.gop = Math.round(duration * 100) / 100;
      } catch { /* optional */ }
      if (!(await video.canDecode())) return done({ ok: false, reason: 'nodecode', codec: String(meta.videoCodec), meta });
      const sink = new CanvasSink(video, { height: thumbHeight, poolSize: 0 });
      const first = await video.getFirstTimestamp();
      const stampsT = Array.from({ length: thumbCount }, (_, i) => first + ((i + 0.5) / thumbCount) * duration);
      for await (const wc of sink.canvasesAtTimestamps(stampsT)) {
        if (wc) out.thumbnails.push(await thumbFrom(wc.canvas, thumbHeight));
      }
    }
    done(out);
  } finally {
    input.dispose();
  }
}

async function makeProxy(id: string, blob: MediaData, maxSide: number, maxFps: number): Promise<void> {
  const input = new Input({ source: toSource(blob), formats: ALL_FORMATS });
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video) throw new Error('no video track');
    const w = await video.getDisplayWidth(), h = await video.getDisplayHeight();
    const s = Math.min(1, maxSide / Math.max(w, h));
    const even = (x: number) => Math.max(2, Math.round((x * s) / 2) * 2);
    const width = even(w), height = even(h);
    let codec: VideoCodec | undefined;
    for (const c of ['avc', 'vp9', 'av1'] as VideoCodec[]) {
      if (await canEncodeVideo(c, { width, height })) { codec = c; break; }
    }
    if (!codec) throw new Error('no video encoder available');
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
    const conversion = await Conversion.init({
      input, output,
      video: { width, height, fit: 'contain', frameRate: maxFps, codec, bitrate: Math.round(width * height * 30 * 0.1), keyFrameInterval: 1, forceTranscode: true },
      audio: { bitrate: 128000 },
    });
    if (!conversion.isValid) throw new Error('this file can’t be converted here');
    const hasAudio = conversion.utilizedTracks.some((t) => t.isAudioTrack());
    running.set(id, conversion);
    conversion.onProgress = (p) => post({ type: 'progress', id, progress: p });
    await conversion.execute();
    running.delete(id);
    const buffer = target.buffer!;
    post({ type: 'proxy', id, buffer, mime: 'video/mp4', hasAudio }, [buffer]);
  } finally {
    input.dispose();
  }
}

/**
 * Tiny grayscale frames → difference score between consecutive frames (scene
 * cuts) and the centroid of motion (where the action is, for auto-reframe).
 */
async function analyseVideo(id: string, blob: MediaData, perSecond: number, start: number, end: number, motion: boolean): Promise<void> {
  const input = new Input({ source: toSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) throw new Error('this video can’t be decoded here');
    const duration = await input.computeDuration();
    const first = await track.getFirstTimestamp();
    const W = 64, H = 36;
    const sink = new CanvasSink(track, { width: W, height: H, fit: 'fill', poolSize: 2 });
    const t1 = Math.min(end, duration);
    const times: number[] = [];
    for (let t = Math.max(0, start); t < t1; t += 1 / perSecond) times.push(t);
    const diffs: number[] = [], motionX: number[] = [], motionY: number[] = [];
    let prev: Float32Array | null = null;
    let prevHist: Float32Array | null = null;
    let i = 0;
    for await (const wc of sink.canvasesAtTimestamps(times.map((t) => t + first))) {
      if (cancelled.has(id)) throw new Error('cancelled');
      const cur = new Float32Array(W * H);
      const hist = new Float32Array(48);
      if (wc) {
        const ctx = (wc.canvas as OffscreenCanvas).getContext('2d') as OffscreenCanvasRenderingContext2D;
        const d = ctx.getImageData(0, 0, W, H).data;
        for (let p = 0, q = 0; p < d.length; p += 4, q++) {
          cur[q] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
          hist[d[p] >> 4]++; hist[16 + (d[p + 1] >> 4)]++; hist[32 + (d[p + 2] >> 4)]++;
        }
      }
      let diff = 0, mx = 0, my = 0, mw = 0;
      if (prev && prevHist) {
        // Histogram distance is robust to camera motion; pixel difference catches hard cuts in similar colours.
        let hd = 0;
        for (let k = 0; k < 48; k++) hd += Math.abs(hist[k] - prevHist[k]);
        hd /= 3 * W * H * 2;
        let pd = 0;
        for (let q = 0; q < cur.length; q++) {
          const dv = Math.abs(cur[q] - prev[q]);
          pd += dv;
          if (motion && dv > 18) { mx += (q % W) * dv; my += Math.floor(q / W) * dv; mw += dv; }
        }
        pd /= cur.length * 255;
        diff = 0.6 * hd + 0.4 * pd;
      }
      diffs.push(Math.round(diff * 10000) / 10000);
      motionX.push(mw > 0 ? Math.round((mx / mw / (W - 1)) * 1000) / 1000 : -1);
      motionY.push(mw > 0 ? Math.round((my / mw / (H - 1)) * 1000) / 1000 : -1);
      prev = cur; prevHist = hist;
      if (++i % 15 === 0) post({ type: 'progress', id, progress: i / times.length });
    }
    post({ type: 'video', id, diffs, motionX, motionY, times });
  } finally {
    input.dispose();
  }
}

/**
 * Point/box tracker: normalised cross-correlation template matching on small
 * grayscale frames, searching around the last position. The template adapts
 * slowly so the target can change a little as it moves.
 */
async function track(id: string, blob: MediaData, start: number, end: number, perSecond: number, box: { x: number; y: number; w: number; h: number }): Promise<void> {
  const input = new Input({ source: toSource(blob), formats: ALL_FORMATS });
  try {
    const vt = await input.getPrimaryVideoTrack();
    if (!vt || !(await vt.canDecode())) throw new Error('this video can’t be decoded here');
    const dw = await vt.getDisplayWidth(), dh = await vt.getDisplayHeight();
    const W = 320, H = Math.max(2, Math.round((320 * dh) / dw));
    const first = await vt.getFirstTimestamp();
    const duration = await input.computeDuration();
    const sink = new CanvasSink(vt, { width: W, height: H, fit: 'fill', poolSize: 2 });
    const times: number[] = [];
    // end < start tracks backwards in time (from the picked frame towards the clip start).
    if (end >= start) for (let t = Math.max(0, start); t < Math.min(end, duration); t += 1 / perSecond) times.push(t);
    else for (let t = Math.min(start, duration - 1e-3); t >= Math.max(0, end); t -= 1 / perSecond) times.push(t);
    const tw = Math.max(6, Math.round(box.w * W)), th = Math.max(6, Math.round(box.h * H));
    let cx = box.x * W, cy = box.y * H; // centre, in frame pixels
    let tmpl: Float32Array | null = null;
    const points: { x: number; y: number }[] = [];
    const confidence: number[] = [];
    const lum = (d: Uint8ClampedArray) => { const g = new Float32Array(W * H); for (let p = 0, q = 0; p < d.length; p += 4, q++) g[q] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]; return g; };
    const patch = (g: Float32Array, x0: number, y0: number) => {
      const out = new Float32Array(tw * th);
      for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
        const xx = Math.min(W - 1, Math.max(0, x0 + x)), yy = Math.min(H - 1, Math.max(0, y0 + y));
        out[y * tw + x] = g[yy * W + xx];
      }
      return out;
    };
    const ncc = (g: Float32Array, x0: number, y0: number, t: Float32Array, tMean: number, tStd: number) => {
      let s = 0, s2 = 0, st = 0;
      const n = tw * th;
      for (let y = 0; y < th; y += 2) for (let x = 0; x < tw; x += 2) {
        const v = g[(y0 + y) * W + (x0 + x)];
        s += v; s2 += v * v; st += v * t[y * tw + x];
      }
      const m = n / 4;
      const mean = s / m, sd = Math.sqrt(Math.max(1e-6, s2 / m - mean * mean));
      return (st / m - mean * tMean) / (sd * tStd);
    };
    let i = 0;
    for await (const wc of sink.canvasesAtTimestamps(times.map((t) => t + first))) {
      if (cancelled.has(id)) throw new Error('cancelled');
      if (!wc) { points.push({ x: cx / W, y: cy / H }); confidence.push(0); continue; }
      const ctx = (wc.canvas as OffscreenCanvas).getContext('2d') as OffscreenCanvasRenderingContext2D;
      const g = lum(ctx.getImageData(0, 0, W, H).data);
      if (!tmpl) {
        tmpl = patch(g, Math.round(cx - tw / 2), Math.round(cy - th / 2));
        confidence.push(1);
      } else {
        let tMean = 0, tSq = 0, c = 0;
        for (let y = 0; y < th; y += 2) for (let x = 0; x < tw; x += 2) { const v = tmpl[y * tw + x]; tMean += v; tSq += v * v; c++; }
        tMean /= c;
        const tStd = Math.sqrt(Math.max(1e-6, tSq / c - tMean * tMean));
        const rx = Math.max(8, tw), ry = Math.max(8, th);
        let best = -2, bx = cx, by = cy;
        const search = (step: number, x0: number, x1: number, y0: number, y1: number) => {
          for (let y = y0; y <= y1; y += step) for (let x = x0; x <= x1; x += step) {
            const px = Math.round(x - tw / 2), py = Math.round(y - th / 2);
            if (px < 0 || py < 0 || px + tw > W || py + th > H) continue;
            const v = ncc(g, px, py, tmpl!, tMean, tStd);
            if (v > best) { best = v; bx = x; by = y; }
          }
        };
        search(3, cx - rx, cx + rx, cy - ry, cy + ry);
        const fx = bx, fy = by;
        search(1, fx - 3, fx + 3, fy - 3, fy + 3);
        if (best > 0.35) {
          cx = bx; cy = by;
          const fresh = patch(g, Math.round(cx - tw / 2), Math.round(cy - th / 2));
          for (let k = 0; k < tmpl.length; k++) tmpl[k] = tmpl[k] * 0.9 + fresh[k] * 0.1;
        }
        confidence.push(Math.max(0, best));
      }
      points.push({ x: cx / W, y: cy / H });
      if (++i % 10 === 0) post({ type: 'progress', id, progress: i / times.length });
    }
    post({ type: 'track', id, times, points, confidence });
  } finally {
    input.dispose();
  }
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const m = e.data;
  if (m.type === 'cancel') {
    cancelled.add(m.id);
    await running.get(m.id)?.cancel().catch(() => undefined);
    return;
  }
  try {
    if (m.type === 'analyseAudio') await analyseAudio(m.id, m.data, m.perSecond);
    else if (m.type === 'proxy') await makeProxy(m.id, m.data, m.maxSide, m.maxFps);
    else if (m.type === 'analyseVideo') await analyseVideo(m.id, m.data, m.perSecond, m.start, m.end, m.motion);
    else if (m.type === 'probe') await probe(m.id, m.data, m.kind, m.thumbCount, m.thumbHeight);
    else if (m.type === 'track') await track(m.id, m.data, m.start, m.end, m.perSecond, m.box);
  } catch (err) {
    post({ type: 'error', id: m.id, message: (err as Error).message || String(err) });
  } finally {
    cancelled.delete(m.id);
  }
};
