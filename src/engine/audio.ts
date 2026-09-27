/**
 * Audio engine.
 *
 * - clipGain(): the volume envelope of a clip (volume keyframes × fades); used by
 *   both preview and export.
 * - AudioMixer: offline, chunked mixdown for export. Only a few seconds of audio
 *   are decoded at once, so hour-long gaming recordings don't exhaust memory.
 */
import { ALL_FORMATS, AudioBufferSink, Input } from 'mediabunny';
import { valueAt } from '../core/keyframes';
import { clipEnd } from '../core/timeline';
import type { Clip, Project } from '../core/types';
import { getData } from './media';
import { isRemote, toSource } from './mediaSource';
import { buildChain, hasTail, loadWorklets, needsWorklet } from './audioChain';

export function clipGain(clip: Clip, local: number): number {
  let g = Math.max(0, valueAt(clip, 'volume', local));
  if (clip.fadeIn > 0 && local < clip.fadeIn) g *= Math.max(0, local / clip.fadeIn);
  if (clip.fadeOut > 0 && local > clip.duration - clip.fadeOut) g *= Math.max(0, (clip.duration - local) / clip.fadeOut);
  return g;
}

/** Clips that produce sound (video clips with audio, audio clips), excluding muted ones. */
export function audibleClips(p: Project): Clip[] {
  const out: Clip[] = [];
  for (const t of p.tracks) {
    if (t.muted) continue;
    for (const c of t.clips) {
      if (c.muted || !c.mediaId) continue;
      if (c.kind !== 'audio' && c.kind !== 'video') continue;
      const m = p.media.find((x) => x.id === c.mediaId);
      if (!m?.hasAudio) continue;
      out.push(c);
    }
  }
  return out;
}

interface Decoder {
  input?: Input;
  sink?: AudioBufferSink;
  /** Fallback: whole file decoded by the browser. */
  whole?: AudioBuffer;
  failed?: boolean;
}

export class AudioMixer {
  private decoders = new Map<string, Decoder>();
  constructor(private project: Project, private sampleRate: number, private channels = 2) {}

  private async decoder(mediaId: string): Promise<Decoder> {
    let d = this.decoders.get(mediaId);
    if (d) return d;
    d = {};
    this.decoders.set(mediaId, d);
    const blob = getData(mediaId);
    if (!blob) { d.failed = true; return d; }
    try {
      const input = new Input({ source: toSource(blob), formats: ALL_FORMATS });
      const track = await input.getPrimaryAudioTrack();
      if (track && (await track.canDecode())) {
        d.input = input;
        d.sink = new AudioBufferSink(track);
        return d;
      }
      input.dispose();
    } catch { /* fall through */ }
    try {
      const ctx = new OfflineAudioContext(1, 1, this.sampleRate);
      d.whole = await ctx.decodeAudioData(await (isRemote(blob) ? (await fetch(blob.url)).arrayBuffer() : blob.arrayBuffer()));
    } catch {
      d.failed = true;
    }
    return d;
  }

  /** Decode [from, to) seconds of a media file's audio into planar channel arrays. */
  private async decodeRange(mediaId: string, from: number, to: number): Promise<{ data: Float32Array[]; rate: number; start: number } | null> {
    const d = await this.decoder(mediaId);
    if (d.failed) return null;
    if (d.whole) {
      const rate = d.whole.sampleRate;
      const a = Math.max(0, Math.floor(from * rate)), b = Math.min(d.whole.length, Math.ceil(to * rate));
      if (b <= a) return null;
      const data = [] as Float32Array[];
      for (let c = 0; c < d.whole.numberOfChannels; c++) data.push(d.whole.getChannelData(c).slice(a, b));
      return { data, rate, start: a / rate };
    }
    const pieces: { buffer: AudioBuffer; timestamp: number }[] = [];
    for await (const wb of d.sink!.buffers(Math.max(0, from), to)) pieces.push(wb);
    if (!pieces.length) return null;
    const rate = pieces[0].buffer.sampleRate;
    const start = pieces[0].timestamp;
    const total = Math.ceil((pieces[pieces.length - 1].timestamp + pieces[pieces.length - 1].buffer.duration - start) * rate) + 1;
    const nCh = Math.max(...pieces.map((p) => p.buffer.numberOfChannels));
    const data = Array.from({ length: nCh }, () => new Float32Array(total));
    for (const pc of pieces) {
      const off = Math.round((pc.timestamp - start) * rate);
      for (let c = 0; c < nCh; c++) {
        const ch = pc.buffer.getChannelData(Math.min(c, pc.buffer.numberOfChannels - 1));
        data[c].set(ch.subarray(0, Math.max(0, Math.min(ch.length, total - off))), Math.max(0, off));
      }
    }
    return { data, rate, start };
  }

  /** Mix the timeline range [t0, t1) into an AudioBuffer. */
  async renderRange(t0: number, t1: number): Promise<AudioBuffer> {
    const clips = audibleClips(this.project);
    // Reverb/echo tails and compressor/pitch state carry over from earlier audio:
    // render a lead-in before the chunk and keep only the chunk itself.
    const pre = clips.some((c) => hasTail(c) && c.start < t1 && clipEnd(c) > t0 - 4) ? Math.min(4, t0) : 0;
    const T0 = t0 - pre;
    const len = Math.max(1, Math.round((t1 - T0) * this.sampleRate));
    const ctx = new OfflineAudioContext(this.channels, len, this.sampleRate);
    const workletsOk = clips.some(needsWorklet) ? await loadWorklets(ctx) : false;
    const master = ctx.createGain();
    master.connect(ctx.destination);
    for (const clip of clips) {
      const a = Math.max(clip.start, T0), b = Math.min(clipEnd(clip), t1);
      if (b - a <= 1e-4) continue;
      const localA = a - clip.start, localB = b - clip.start;
      // Source-time range covered by this slice.
      const srcA = clip.reverse ? clip.sourceIn + (clip.duration - localB) * clip.speed : clip.sourceIn + localA * clip.speed;
      const srcB = srcA + (localB - localA) * clip.speed;
      const dec = await this.decodeRange(clip.mediaId!, srcA - 0.05, srcB + 0.05);
      if (!dec) continue;
      const buf = ctx.createBuffer(dec.data.length, dec.data[0].length, dec.rate);
      dec.data.forEach((ch, i) => {
        if (clip.reverse) ch.reverse();
        buf.copyToChannel(ch as Float32Array<ArrayBuffer>, i);
      });
      const node = ctx.createBufferSource();
      node.buffer = buf;
      node.playbackRate.value = clip.speed;
      const comp = clip.keepPitch !== false && Math.abs(clip.speed - 1) > 1e-3 ? 1 / clip.speed : 1;
      const chain = buildChain(ctx, clip, workletsOk, comp);
      const gain = ctx.createGain();
      node.connect(chain.input);
      chain.output.connect(gain).connect(master);
      // Volume envelope, sampled every 20 ms (covers keyframes and fades).
      const step = 0.02;
      gain.gain.setValueAtTime(clipGain(clip, localA), a - T0);
      for (let lt = localA + step; lt <= localB + step; lt += step) {
        const when = Math.max(0, lt - localA + (a - T0));
        gain.gain.linearRampToValueAtTime(clipGain(clip, Math.min(lt, clip.duration)), when);
      }
      const bufDur = dec.data[0].length / dec.rate;
      const offset = clip.reverse ? bufDur - (srcB - dec.start) : srcA - dec.start;
      node.start(a - T0, Math.max(0, offset), srcB - srcA);
    }
    const out = await ctx.startRendering();
    if (!pre) return out;
    const skip = Math.round(pre * this.sampleRate);
    const keep = Math.max(1, out.length - skip);
    const trimmed = new AudioBuffer({ numberOfChannels: out.numberOfChannels, length: keep, sampleRate: out.sampleRate });
    for (let c = 0; c < out.numberOfChannels; c++) trimmed.copyToChannel(out.getChannelData(c).subarray(skip, skip + keep), c);
    return trimmed;
  }

  dispose(): void {
    for (const d of this.decoders.values()) d.input?.dispose();
    this.decoders.clear();
  }
}

/** Encode an AudioBuffer as a 16-bit PCM WAV (used by tests and simple exports). */
export function encodeWav(buf: AudioBuffer): Blob {
  const nCh = buf.numberOfChannels, len = buf.length, rate = buf.sampleRate;
  const bytes = 44 + len * nCh * 2;
  const view = new DataView(new ArrayBuffer(bytes));
  const w = (o: number, s: string) => [...s].forEach((ch, i) => view.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF'); view.setUint32(4, bytes - 8, true); w(8, 'WAVE'); w(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, nCh, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * nCh * 2, true); view.setUint16(32, nCh * 2, true);
  view.setUint16(34, 16, true); w(36, 'data'); view.setUint32(40, len * nCh * 2, true);
  const chans = Array.from({ length: nCh }, (_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nCh; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([view.buffer], { type: 'audio/wav' });
}
