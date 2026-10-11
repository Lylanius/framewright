/**
 * Kids Studio background tunes — written and synthesised here, from scratch
 * (no samples, no licences). Each tune is an 8-bar loop rendered "round the
 * clock" (notes that ring past the end carry on at the start), so copies laid
 * end to end loop with no seam. Pure maths → WAV, identical on every device.
 */
import { wavBytes } from './sfx';

const TAU = Math.PI * 2;
const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

function noise(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return (x / 4294967296) * 2 - 1; };
}

/** Mixes notes into a loop buffer; anything past the end wraps to the start. */
class Loop {
  readonly out: Float32Array;
  constructor(readonly rate: number, seconds: number) { this.out = new Float32Array(Math.round(seconds * rate)); }
  add(at: number, samples: Float32Array | number[], gain = 1): void {
    const o = this.out, L = o.length, s0 = Math.round(at * this.rate);
    for (let i = 0; i < samples.length; i++) o[(s0 + i) % L] += samples[i] * gain;
  }
}

/* ---------------- instruments ---------------- */

/** Plucked string (Karplus–Strong): ukulele / pizzicato. `hold` = how long before it's damped. */
function pluck(rate: number, f: number, hold: number, bright = 0.5, seed = 1): Float32Array {
  const n = Math.max(2, Math.round(rate / f));
  const buf = new Float32Array(n), rnd = noise(seed);
  let prev = 0;
  for (let i = 0; i < n; i++) { const r = rnd(); prev = prev + (r - prev) * (0.35 + bright * 0.6); buf[i] = prev; }
  const len = Math.round(rate * Math.min(2.4, hold + 0.15));
  const out = new Float32Array(len);
  const decay = 0.996 - (1 - bright) * 0.004, damp = Math.round(rate * hold);
  let i = 0;
  for (let k = 0; k < len; k++) {
    const a = buf[i], b = buf[(i + 1) % n];
    const y = (a + b) * 0.5 * (k > damp ? 0.97 : decay);
    buf[i] = y; i = (i + 1) % n;
    out[k] = a * Math.min(1, k / (rate * 0.002));
  }
  return out;
}

/** Round bass: sine with a little 2nd harmonic, short attack, gentle release. */
function bass(rate: number, f: number, dur: number, edge = 0.25): Float32Array {
  const len = Math.round(rate * (dur + 0.08)), out = new Float32Array(len);
  let ph = 0;
  for (let k = 0; k < len; k++) {
    const t = k / rate;
    ph += (TAU * f) / rate;
    const env = Math.min(1, t / 0.006) * (t < dur ? 1 - 0.3 * Math.min(1, t / 0.25) : 0.7 * Math.max(0, 1 - (t - dur) / 0.08));
    out[k] = (Math.sin(ph) + edge * Math.sin(2 * ph) + edge * 0.4 * Math.sin(3 * ph)) * env;
  }
  return out;
}

/** Music-box / glockenspiel bell. */
function bell(rate: number, f: number, ring = 1.2): Float32Array {
  const len = Math.round(rate * ring), out = new Float32Array(len);
  for (let k = 0; k < len; k++) {
    const t = k / rate, a = Math.min(1, t / 0.003);
    out[k] = a * (Math.sin(TAU * f * t) * Math.exp(-t * 3.2) + 0.35 * Math.sin(TAU * f * 2.76 * t) * Math.exp(-t * 9) + 0.12 * Math.sin(TAU * f * 5.4 * t) * Math.exp(-t * 18));
  }
  return out;
}

/** Bright brassy lead: filtered saw with a touch of vibrato. */
function lead(rate: number, f: number, dur: number): Float32Array {
  const len = Math.round(rate * (dur + 0.12)), out = new Float32Array(len);
  let ph = 0, lp = 0;
  for (let k = 0; k < len; k++) {
    const t = k / rate;
    const vib = 1 + 0.004 * Math.sin(TAU * 5.5 * t) * Math.min(1, t / 0.3);
    ph = (ph + (f * vib) / rate) % 1;
    const saw = 2 * ph - 1;
    const cut = 0.08 + 0.18 * Math.exp(-t * 6);
    lp += (saw - lp) * cut;
    const env = Math.min(1, t / 0.02) * (t < dur ? 1 : Math.max(0, 1 - (t - dur) / 0.12));
    out[k] = lp * env;
  }
  return out;
}

/** Soft string pad: a few detuned saws, slow in and out. */
function pad(rate: number, notes: number[], dur: number): Float32Array {
  const len = Math.round(rate * (dur + 0.5)), out = new Float32Array(len);
  const phs = notes.flatMap(() => [0, 0.33]);
  let lp = 0;
  for (let k = 0; k < len; k++) {
    const t = k / rate;
    let v = 0;
    notes.forEach((n, j) => {
      for (let d = 0; d < 2; d++) {
        const idx = j * 2 + d;
        phs[idx] = (phs[idx] + (hz(n) * (d ? 1.004 : 0.996)) / rate) % 1;
        v += 2 * phs[idx] - 1;
      }
    });
    lp += (v / (notes.length * 2) - lp) * 0.05;
    const env = Math.min(1, t / 0.35) * (t < dur ? 1 : Math.max(0, 1 - (t - dur) / 0.5));
    out[k] = lp * env;
  }
  return out;
}

function kick(rate: number): Float32Array {
  const len = Math.round(rate * 0.35), out = new Float32Array(len);
  let ph = 0;
  for (let k = 0; k < len; k++) { const t = k / rate; ph += (TAU * (45 + 90 * Math.exp(-t * 28))) / rate; out[k] = Math.sin(ph) * Math.exp(-t / 0.12); }
  return out;
}

function clap(rate: number, seed: number): Float32Array {
  const len = Math.round(rate * 0.18), out = new Float32Array(len), rnd = noise(seed);
  let lp = 0;
  for (let k = 0; k < len; k++) {
    const t = k / rate, x = rnd();
    lp += (x - lp) * 0.5;
    const env = Math.exp(-t / 0.05) * (t < 0.03 ? 0.6 + 0.4 * Math.sin(t * 400) : 1);
    out[k] = (x - lp) * env * 0.9 + Math.sin(TAU * 190 * t) * Math.exp(-t / 0.03) * 0.3;
  }
  return out;
}

function shaker(rate: number, seed: number, len = 0.05): Float32Array {
  const n = Math.round(rate * len), out = new Float32Array(n), rnd = noise(seed);
  let lp = 0;
  for (let k = 0; k < n; k++) { const x = rnd(); lp += (x - lp) * 0.3; const t = k / rate; out[k] = (x - lp) * Math.min(1, t / 0.008) * Math.exp(-t / (len * 0.35)); }
  return out;
}

function block(rate: number, f = 1100): Float32Array {
  const n = Math.round(rate * 0.08), out = new Float32Array(n);
  for (let k = 0; k < n; k++) { const t = k / rate; out[k] = Math.sin(TAU * f * t) * Math.exp(-t / 0.018) + 0.4 * Math.sin(TAU * f * 2.3 * t) * Math.exp(-t / 0.007); }
  return out;
}

/* ---------------- the tunes ---------------- */

type Note = [number | null, number]; // [midi or rest, length in eighths]
interface TuneDef {
  id: string; name: string; emoji: string; description: string; bpm: number;
  chords: number[][]; // 8 bars of chord notes (MIDI)
  melody: Note[][];   // 8 bars
  render: (l: Loop, d: TuneDef, eighth: number) => void;
}

const C = [60, 64, 67], G = [55, 59, 62, 67], Am = [57, 60, 64], F = [53, 57, 60, 65], Em = [52, 55, 59, 64];
const Dm = [50, 57, 62, 65], Bb = [46, 53, 58, 62], Cmaj = [48, 55, 60, 64], C7 = [48, 52, 55, 58], Fmaj = [41, 48, 53, 57];

function playMelody(l: Loop, d: TuneDef, eighth: number, voice: (f: number, dur: number) => Float32Array, gain: number, swing = 0): void {
  d.melody.forEach((bar, b) => {
    let pos = 0;
    for (const [n, len] of bar) {
      const at = (b * 8 + pos) * eighth + (pos % 2 === 1 ? swing * eighth : 0);
      if (n !== null) l.add(at, voice(hz(n), len * eighth * 0.92), gain);
      pos += len;
    }
  });
}

export const KID_TUNES: TuneDef[] = [
  {
    id: 'happy', name: 'Happy Hop', emoji: '🐸', description: 'Bouncy ukulele and claps', bpm: 118,
    chords: [C, G, Am, F, C, G, F, G],
    melody: [
      [[76, 1], [76, 1], [79, 2], [76, 1], [72, 1], [74, 2]],
      [[74, 1], [74, 1], [79, 2], [71, 2], [74, 2]],
      [[72, 1], [76, 1], [81, 2], [79, 1], [76, 1], [72, 2]],
      [[77, 2], [81, 2], [79, 3], [null, 1]],
      [[76, 1], [79, 1], [84, 2], [83, 1], [79, 1], [76, 2]],
      [[74, 1], [79, 1], [83, 2], [81, 1], [79, 1], [74, 2]],
      [[72, 1], [77, 1], [81, 2], [79, 1], [77, 1], [76, 1], [74, 1]],
      [[74, 2], [79, 2], [null, 4]],
    ],
    render(l, d, e) {
      const r = l.rate;
      d.chords.forEach((ch, b) => {
        const t0 = b * 8 * e;
        // Strum pattern: down, down-up, up-down-up.
        [0, 2, 3, 5, 6, 7].forEach((s, k) => {
          const notes = (k % 2 ? [...ch].reverse() : ch).map((n) => n + 12);
          notes.forEach((n, j) => l.add(t0 + s * e + j * 0.012, pluck(r, hz(n), e * 1.6, 0.55, b * 31 + k * 7 + j), k === 0 ? 0.22 : 0.15));
        });
        const root = 36 + (ch[0] % 12); // low C2–B2
        [0, 3, 4, 7].forEach((s, k) => l.add(t0 + s * e, bass(r, hz(k % 2 ? root + 12 : root), e * 0.8), 0.5));
        [0, 4].forEach((s) => l.add(t0 + s * e, kick(r), 0.55));
        [2, 6].forEach((s) => l.add(t0 + s * e, clap(r, b * 3 + s), 0.32));
        for (let s = 0; s < 8; s++) l.add(t0 + s * e, shaker(r, b * 8 + s), s % 2 ? 0.1 : 0.16);
      });
      playMelody(l, d, e, (f, dur) => bell(r, f, Math.max(0.5, dur + 0.4)), 0.3);
    },
  },
  {
    id: 'silly', name: 'Silly Walk', emoji: '🐧', description: 'Tiptoeing plucks and wobbly bass', bpm: 100,
    chords: [Fmaj, C7, Fmaj, C7, [46, 50, 53, 58], Fmaj, C7, Fmaj],
    melody: [
      [[69, 2], [72, 2], [69, 2], [65, 2]],
      [[64, 2], [67, 2], [70, 2], [67, 2]],
      [[69, 2], [72, 2], [77, 2], [72, 2]],
      [[76, 2], [74, 2], [72, 2], [70, 2]],
      [[74, 2], [77, 2], [74, 2], [70, 2]],
      [[72, 2], [69, 2], [65, 2], [69, 2]],
      [[67, 2], [69, 2], [70, 2], [71, 2]],
      [[72, 2], [65, 2], [null, 4]],
    ],
    render(l, d, e) {
      const r = l.rate;
      d.chords.forEach((ch, b) => {
        const t0 = b * 8 * e;
        // Walking bass: root, fifth, octave, fifth — short and bouncy.
        const root = ch[0] < 45 ? ch[0] : ch[0] - 12;
        [root, root + 7, root + 12, root + 7].forEach((n, k) => l.add(t0 + k * 2 * e, bass(r, hz(n), e * 0.7, 0.6), 0.55));
        // Off-beat "oom-pah" chord plucks.
        [2, 6].forEach((s, k) => ch.slice(1).forEach((n, j) => l.add(t0 + s * e + e * 0.33, pluck(r, hz(n + 12), e * 0.5, 0.35, b * 13 + k * 5 + j), 0.13)));
        [2, 6].forEach((s) => l.add(t0 + s * e, block(r, 1250), 0.18));
        l.add(t0, kick(r), 0.35);
        l.add(t0, pad(r, ch.slice(1).map((n) => n + 12), 8 * e - 0.2), 0.07); // soft bed so it never drops to silence
      });
      playMelody(l, d, e, (f, dur) => pluck(r, f, Math.min(dur, e * 0.9), 0.7, Math.round(f)), 0.42, 0.33);
    },
  },
  {
    id: 'adventure', name: 'Big Adventure', emoji: '🦖', description: 'Heroic trumpets and drums', bpm: 126,
    chords: [Dm, Bb, [41, 53, 57, 60], Cmaj, Dm, Bb, Cmaj, Cmaj],
    melody: [
      [[74, 2], [69, 2], [74, 1], [76, 1], [77, 2]],
      [[77, 2], [74, 2], [70, 2], [74, 2]],
      [[72, 2], [77, 2], [81, 2], [79, 1], [77, 1]],
      [[76, 4], [72, 4]],
      [[74, 1], [77, 1], [81, 2], [81, 1], [79, 1], [77, 1], [76, 1]],
      [[74, 2], [77, 2], [82, 2], [81, 1], [79, 1]],
      [[79, 2], [76, 2], [72, 2], [76, 2]],
      [[76, 4], [null, 4]],
    ],
    render(l, d, e) {
      const r = l.rate;
      d.chords.forEach((ch, b) => {
        const t0 = b * 8 * e;
        l.add(t0, pad(r, ch.slice(1).map((n) => n + 12), 8 * e - 0.2), 0.16);
        const root = ch[0] < 45 ? ch[0] + 12 : ch[0];
        for (let s = 0; s < 8; s++) l.add(t0 + s * e, bass(r, hz(root - 12), e * 0.6, 0.5), 0.42);
        [0, 3, 4].forEach((s) => l.add(t0 + s * e, kick(r), 0.6));
        [2, 6].forEach((s) => l.add(t0 + s * e, clap(r, b * 7 + s), 0.38));
        for (let s = 0; s < 8; s++) l.add(t0 + s * e, shaker(r, b * 9 + s, 0.035), 0.1);
      });
      playMelody(l, d, e, (f, dur) => lead(r, f, dur), 0.34);
    },
  },
  {
    id: 'dreamy', name: 'Sleepy Stars', emoji: '🌙', description: 'Gentle music box', bpm: 76,
    chords: [C, Am, F, G, C, Em, F, G],
    melody: [[[null, 8]], [[null, 8]], [[null, 8]], [[null, 8]], [[84, 4], [83, 4]], [[79, 8]], [[81, 4], [77, 4]], [[79, 8]]],
    render(l, d, e) {
      const r = l.rate;
      d.chords.forEach((ch, b) => {
        const t0 = b * 8 * e;
        const [n0, n1, n2] = ch.slice(-3).map((n) => n + 12);
        [n0, n2, n1 + 12, n2, n0 + 12, n2, n1 + 12, n2].forEach((n, s) => l.add(t0 + s * e, bell(r, hz(n), 1.6), 0.22));
        l.add(t0, pad(r, [ch[0], ch[0] + 7], 8 * e - 0.3), 0.12);
      });
      playMelody(l, d, e, (f) => bell(r, f, 2.2), 0.3);
    },
  },
];

/** One loop of a tune (8 bars), as samples peaking at 0.8. */
export function renderTune(id: string, rate = 44100): Float32Array {
  const d = KID_TUNES.find((t) => t.id === id) ?? KID_TUNES[0];
  const eighth = 30 / d.bpm;
  const l = new Loop(rate, 64 * eighth);
  d.render(l, d, eighth);
  // Gentle limiter, then level.
  const o = l.out;
  let max = 1e-9;
  for (let i = 0; i < o.length; i++) { o[i] = Math.tanh(o[i] * 1.1); max = Math.max(max, Math.abs(o[i])); }
  const g = 0.8 / max;
  for (let i = 0; i < o.length; i++) o[i] *= g;
  return o;
}

export function tuneSeconds(id: string): number {
  const d = KID_TUNES.find((t) => t.id === id) ?? KID_TUNES[0];
  return (64 * 30) / d.bpm;
}

export function tuneFile(id: string, rate = 44100): File {
  const d = KID_TUNES.find((t) => t.id === id) ?? KID_TUNES[0];
  return new File([wavBytes(renderTune(id, rate), rate)], `Music - ${d.name}.wav`, { type: 'audio/wav' });
}
