/**
 * Audio effect chain, built the same way for live preview (AudioContext) and
 * export (OfflineAudioContext) so what you hear is what you export.
 * Noise reduction and pitch use small AudioWorklet processors; if worklets
 * aren't available those two are skipped (and reported).
 */
import { dbToGain } from '../core/audioFx';
import type { AudioEffect, Clip } from '../core/types';

const WORKLET = `
class FwGate extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'threshold', defaultValue: -50 }, { name: 'reduction', defaultValue: 18 }]; }
  constructor() { super(); this.env = 0; this.gain = 1; }
  process(inputs, outputs, params) {
    const inp = inputs[0], out = outputs[0];
    if (!inp || !inp.length) return true;
    const thr = Math.pow(10, params.threshold[0] / 20), floor = Math.pow(10, -params.reduction[0] / 20);
    const att = Math.exp(-1 / (0.004 * sampleRate)), rel = Math.exp(-1 / (0.15 * sampleRate));
    const n = inp[0].length;
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let c = 0; c < inp.length; c++) { const v = Math.abs(inp[c][i]); if (v > m) m = v; }
      this.env = m > this.env ? att * this.env + (1 - att) * m : rel * this.env + (1 - rel) * m;
      const target = this.env >= thr ? 1 : Math.max(floor, Math.pow(this.env / thr, 1.5));
      this.gain += (target - this.gain) * (target < this.gain ? 0.0015 : 0.02);
      for (let c = 0; c < out.length; c++) out[c][i] = (inp[c] || inp[0])[i] * this.gain;
    }
    return true;
  }
}
registerProcessor('fw-gate', FwGate);

class FwPitch extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'ratio', defaultValue: 1 }]; }
  constructor() { super(); this.N = Math.round(sampleRate * 0.05); this.L = this.N * 2; this.buf = [new Float32Array(this.L), new Float32Array(this.L)]; this.w = 0; this.phase = 0; }
  process(inputs, outputs, params) {
    const inp = inputs[0], out = outputs[0];
    const ratio = params.ratio[0];
    const n = out[0].length, N = this.N, L = this.L;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 2; c++) { const ch = inp && (inp[c] || inp[0]); this.buf[c][this.w] = ch ? ch[i] : 0; }
      if (Math.abs(ratio - 1) < 1e-3) {
        for (let c = 0; c < out.length; c++) out[c][i] = this.buf[c][this.w];
      } else {
        this.phase += (1 - ratio) / N;
        this.phase -= Math.floor(this.phase);
        for (let c = 0; c < out.length; c++) {
          let s = 0;
          for (let k = 0; k < 2; k++) {
            const ph = (this.phase + k * 0.5) % 1;
            let r = this.w - ph * N;
            if (r < 0) r += L;
            const i0 = Math.floor(r), f = r - i0;
            const a = this.buf[c][i0 % L], b = this.buf[c][(i0 + 1) % L];
            const win = Math.sin(Math.PI * ph);
            s += (a + (b - a) * f) * win * win;
          }
          out[c][i] = s;
        }
      }
      this.w = (this.w + 1) % L;
    }
    return true;
  }
}
registerProcessor('fw-pitch', FwPitch);
`;

let moduleUrl: string | null = null;
const ready = new WeakMap<BaseAudioContext, Promise<boolean>>();

/** Load the worklet processors into a context (resolves false if unsupported). */
export function loadWorklets(ctx: BaseAudioContext): Promise<boolean> {
  let p = ready.get(ctx);
  if (!p) {
    p = (async () => {
      try {
        if (!ctx.audioWorklet) return false;
        moduleUrl ??= URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
        await ctx.audioWorklet.addModule(moduleUrl);
        return true;
      } catch {
        return false;
      }
    })();
    ready.set(ctx, p);
  }
  return p;
}

export function needsWorklet(clip: Clip): boolean {
  return !!clip.audioFx?.some((e) => e.enabled && (e.type === 'gate' || e.type === 'pitch')) || (clip.keepPitch !== false && Math.abs(clip.speed - 1) > 1e-3);
}

/** Effects whose output depends on earlier audio (export renders a little lead-in for these). */
export function hasTail(clip: Clip): boolean {
  return !!clip.audioFx?.some((e) => e.enabled && ['reverb', 'echo', 'gate', 'pitch', 'compressor', 'limiter', 'voice'].includes(e.type)) || needsWorklet(clip);
}

const impulseCache = new WeakMap<BaseAudioContext, Map<string, AudioBuffer>>();
function impulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  let m = impulseCache.get(ctx);
  if (!m) { m = new Map(); impulseCache.set(ctx, m); }
  const key = seconds.toFixed(1);
  let buf = m.get(key);
  if (!buf) {
    const len = Math.max(1, Math.round(ctx.sampleRate * seconds));
    buf = ctx.createBuffer(2, len, ctx.sampleRate);
    // Deterministic noise so export and preview reverbs are identical.
    let seed = 1234567;
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        d[i] = ((seed / 0x7fffffff) * 2 - 1) * Math.pow(1 - i / len, 3);
      }
    }
    m.set(key, buf);
  }
  return buf;
}

export interface Chain { input: AudioNode; output: AudioNode; skipped: string[] }

/**
 * Build the effect chain for a clip. `workletsOk` says whether the worklet
 * module is loaded in this context. `speedPitchComp` is the pitch ratio needed
 * to cancel a speed change (export only; preview uses the browser's own
 * pitch-preserving playback).
 */
export function buildChain(ctx: BaseAudioContext, clip: Clip, workletsOk: boolean, speedPitchComp = 1): Chain {
  const input = ctx.createGain();
  let node: AudioNode = input;
  const skipped: string[] = [];
  const then = (n: AudioNode) => { node.connect(n); node = n; return n; };
  const fx: AudioEffect[] = (clip.audioFx ?? []).filter((e) => e.enabled);

  let pitchRatio = speedPitchComp;
  for (const e of fx) if (e.type === 'pitch') pitchRatio *= Math.pow(2, (e.params.semitones ?? 0) / 12);

  for (const e of fx) {
    const p = e.params;
    switch (e.type) {
      case 'highpass': { const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = p.freq ?? 90; f.Q.value = 0.7; then(f); break; }
      case 'lowpass': { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = p.freq ?? 12000; f.Q.value = 0.7; then(f); break; }
      case 'eq': {
        const lo = ctx.createBiquadFilter(); lo.type = 'lowshelf'; lo.frequency.value = 200; lo.gain.value = p.low ?? 0; then(lo);
        const mid = ctx.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = p.midFreq ?? 1000; mid.Q.value = 0.8; mid.gain.value = p.mid ?? 0; then(mid);
        const hi = ctx.createBiquadFilter(); hi.type = 'highshelf'; hi.frequency.value = 4000; hi.gain.value = p.high ?? 0; then(hi);
        break;
      }
      case 'voice': {
        const k = (p.amount ?? 70) / 100;
        const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 85; then(hp);
        const mud = ctx.createBiquadFilter(); mud.type = 'peaking'; mud.frequency.value = 300; mud.Q.value = 1; mud.gain.value = -3 * k; then(mud);
        const pres = ctx.createBiquadFilter(); pres.type = 'peaking'; pres.frequency.value = 3200; pres.Q.value = 0.9; pres.gain.value = 4.5 * k; then(pres);
        const air = ctx.createBiquadFilter(); air.type = 'highshelf'; air.frequency.value = 9000; air.gain.value = 2 * k; then(air);
        const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -26; comp.ratio.value = 1 + 2.5 * k; comp.attack.value = 0.008; comp.release.value = 0.2; comp.knee.value = 8; then(comp);
        const mk = ctx.createGain(); mk.gain.value = dbToGain(4 * k); then(mk);
        break;
      }
      case 'gate': {
        const hiss = ctx.createBiquadFilter(); hiss.type = 'highshelf'; hiss.frequency.value = 7000; hiss.gain.value = -12 * ((p.hiss ?? 40) / 100); then(hiss);
        if (workletsOk) {
          const g = new AudioWorkletNode(ctx, 'fw-gate', { outputChannelCount: [2] });
          g.parameters.get('threshold')!.value = p.threshold ?? -50;
          g.parameters.get('reduction')!.value = p.reduction ?? 18;
          then(g);
        } else skipped.push('Noise reduction (gate)');
        break;
      }
      case 'compressor': {
        const c = ctx.createDynamicsCompressor();
        c.threshold.value = p.threshold ?? -24; c.ratio.value = p.ratio ?? 4; c.attack.value = (p.attack ?? 10) / 1000; c.release.value = (p.release ?? 250) / 1000; c.knee.value = 6;
        then(c);
        const mk = ctx.createGain(); mk.gain.value = dbToGain(p.makeup ?? 6); then(mk);
        break;
      }
      case 'limiter': {
        const drive = ctx.createGain(); drive.gain.value = dbToGain(p.drive ?? 0); then(drive);
        const c = ctx.createDynamicsCompressor();
        c.threshold.value = (p.ceiling ?? -1) - 1; c.ratio.value = 20; c.attack.value = 0.001; c.release.value = 0.08; c.knee.value = 0;
        then(c);
        const ceil = dbToGain(p.ceiling ?? -1);
        const clip2 = ctx.createWaveShaper();
        const curve = new Float32Array(1024);
        for (let i = 0; i < 1024; i++) { const x = ((i / 1023) * 2 - 1) * 2; curve[i] = ceil * Math.tanh(x / ceil); }
        clip2.curve = curve;
        then(clip2);
        break;
      }
      case 'pan': { const s = ctx.createStereoPanner(); s.pan.value = Math.max(-1, Math.min(1, (p.pan ?? 0) / 100)); then(s); break; }
      case 'echo': {
        const split = node;
        const out = ctx.createGain();
        const dry = ctx.createGain(); dry.gain.value = 1;
        const delay = ctx.createDelay(2); delay.delayTime.value = (p.delay ?? 300) / 1000;
        const fb = ctx.createGain(); fb.gain.value = Math.min(0.9, (p.feedback ?? 35) / 100);
        const wet = ctx.createGain(); wet.gain.value = (p.mix ?? 30) / 100;
        split.connect(dry).connect(out);
        split.connect(delay); delay.connect(fb).connect(delay); delay.connect(wet).connect(out);
        node = out;
        break;
      }
      case 'reverb': {
        const split = node;
        const out = ctx.createGain();
        const mix = (p.mix ?? 25) / 100;
        const dry = ctx.createGain(); dry.gain.value = 1 - mix * 0.5;
        const conv = ctx.createConvolver(); conv.buffer = impulse(ctx, p.size ?? 1.8);
        const wet = ctx.createGain(); wet.gain.value = mix * 0.6;
        split.connect(dry).connect(out);
        split.connect(conv).connect(wet).connect(out);
        node = out;
        break;
      }
      case 'pitch':
        break; // applied once below, combined with speed compensation
    }
  }
  if (Math.abs(pitchRatio - 1) > 1e-3) {
    if (workletsOk) {
      const ps = new AudioWorkletNode(ctx, 'fw-pitch', { outputChannelCount: [2] });
      ps.parameters.get('ratio')!.value = pitchRatio;
      then(ps);
    } else skipped.push('Pitch');
  }
  const output = ctx.createGain();
  node.connect(output);
  return { input, output, skipped };
}

/** Signature used by the preview to know when a clip's chain must be rebuilt. */
export function chainKey(clip: Clip): string {
  return JSON.stringify([clip.audioFx ?? [], clip.keepPitch !== false]);
}
