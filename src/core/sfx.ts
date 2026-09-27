/**
 * Framewright's own sound effects, synthesised from scratch (no samples, no
 * licences to worry about). Pure maths → WAV bytes, so they're identical on
 * every device and can be unit-tested.
 */
export interface SfxDef { id: string; name: string; description: string; seconds: number; make: (rate: number) => Float32Array }

const TAU = Math.PI * 2;

function noise(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return (x / 4294967296) * 2 - 1; };
}

/**
 * Render a sound, normalise it to `peak` (so quiet sounds like ticks stay
 * quiet), and fade the first 2 ms and last 10 ms so there are no clicks.
 */
function render(seconds: number, rate: number, peak: number, fn: (t: number, i: number) => number): Float32Array {
  const n = Math.round(seconds * rate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = fn(i / rate, i);
  let max = 1e-9;
  for (const v of out) max = Math.max(max, Math.abs(v));
  const g = peak / max;
  const fin = Math.round(rate * 0.002), fout = Math.min(n, Math.round(rate * 0.01));
  for (let i = 0; i < n; i++) out[i] *= g * Math.min(1, i / fin, i > n - fout ? (n - i) / fout : 1);
  return out;
}

/** Resonant filter (RBJ biquad) whose frequency can change every sample. */
function biquad(kind: 'lp' | 'bp', rate: number) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x: number, hz: number, q: number) => {
    const w = (TAU * Math.min(hz, rate * 0.45)) / rate, a = Math.sin(w) / (2 * q), c = Math.cos(w);
    const b0 = kind === 'lp' ? (1 - c) / 2 : a, b1 = kind === 'lp' ? 1 - c : 0, b2 = kind === 'lp' ? (1 - c) / 2 : -a;
    const a0 = 1 + a, a1 = -2 * c, a2 = 1 - a;
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y;
  };
}

const env = (t: number, attack: number, decay: number) => (t < attack ? t / attack : Math.exp(-(t - attack) / decay));

/** A soft wooden "tock": two damped body tones, a little filtered knock, no hiss. */
function woodblock(hz: number) {
  return (r: number) => {
    const n = noise(3), lp = biquad('lp', r);
    return render(0.12, r, 0.5, (t) =>
      Math.sin(TAU * hz * t) * Math.exp(-t / 0.022)
      + 0.45 * Math.sin(TAU * hz * 2.3 * t) * Math.exp(-t / 0.009)
      + 0.5 * lp(n(), 2500, 0.7) * Math.exp(-t / 0.003));
  };
}

/** Warm bell note: mostly the fundamental, a touch of octave and fifth above. */
function bell(t: number, hz: number, decay: number): number {
  if (t <= 0) return 0;
  return (Math.sin(TAU * hz * t) + 0.25 * Math.sin(TAU * hz * 2 * t) * Math.exp(-t * 5) + 0.08 * Math.sin(TAU * hz * 3 * t) * Math.exp(-t * 9))
    * env(t, 0.004, decay);
}

export const SFX: SfxDef[] = [
  { id: 'tick', name: 'Tick', description: 'Soft clock tick for countdowns.', seconds: 0.12, make: woodblock(1250) },
  { id: 'tock', name: 'Tock', description: 'Lower partner to Tick — alternate them for tick-tock.', seconds: 0.12, make: woodblock(950) },
  {
    id: 'ding', name: 'Ding (correct)', description: 'Two-note chime for a right answer or reveal.', seconds: 1.5,
    make: (r) => render(1.5, r, 0.8, (t) => 0.8 * bell(t, 880, 0.25) + bell(t - 0.11, 1318.5, 0.5)),
  },
  {
    id: 'buzzer', name: 'Buzzer (wrong)', description: 'Low buzz for a wrong answer.', seconds: 0.6,
    make: (r) => {
      const lp = biquad('lp', r);
      return render(0.6, r, 0.7, (t) => {
        const s = Math.sign(Math.sin(TAU * 110 * t)) * 0.6 + Math.sign(Math.sin(TAU * 116 * t)) * 0.4;
        return lp(s, 1400, 0.7) * (t < 0.5 ? 1 : (0.6 - t) / 0.1);
      });
    },
  },
  {
    id: 'boom', name: 'Boom', description: 'Punchy impact for a title slamming in.', seconds: 1.2,
    make: (r) => {
      const n = noise(21), lp = biquad('lp', r); let ph = 0;
      return render(1.2, r, 0.8, (t) => {
        ph += (TAU * (38 + 110 * Math.exp(-t * 14))) / r; // pitch drops fast: a thump
        const body = Math.sin(ph) * Math.exp(-t / 0.35);
        const crack = lp(n(), 1800 + 3000 * Math.exp(-t * 30), 0.7) * Math.exp(-t / 0.06);
        const tail = lp(n(), 600, 0.7) * Math.exp(-t / 0.4) * 0.35;
        return body + crack * 0.7 + tail;
      });
    },
  },
  {
    // An original "who is it?!" sting: a quick swell that lands on two brassy
    // chord stabs with a thump. Hits at 0.38 s, when the intro title slams in.
    id: 'sting', name: 'Mystery sting', description: 'Dramatic “who is it?!” hit for quiz intros (lands at 0.38 s).', seconds: 2,
    make: (r) => {
      const HIT = 0.38, n = noise(33), bp = biquad('bp', r), lp1 = biquad('lp', r), lp2 = biquad('lp', r), lpc = biquad('lp', r);
      const saw = (hz: number[], t: number) => hz.reduce((v, f) => v + 2 * ((f * t) % 1) - 1 + 2 * ((f * 1.006 * t) % 1) - 1, 0) / (hz.length * 2);
      const stab1 = [146.83, 220, 293.66, 349.23], stab2 = [155.56, 233.08, 311.13, 392]; // D minor, then up a half-step
      let ph = 0;
      return render(2, r, 0.8, (t) => {
        const pre = t < HIT ? t / HIT : 0;
        const swell = pre > 0 ? bp(n(), 400 + 3200 * pre * pre, 1.4) * pre * pre * 1.3 : bp(0, 3600, 1.4);
        const a = t - HIT, b = t - HIT - 0.26;
        const c1 = a >= 0 ? lp1(saw(stab1, a), 600 + 3400 * Math.exp(-a * 9), 0.9) * (a < 0.26 ? 1 : Math.exp(-(a - 0.26) / 0.05)) : 0;
        const c2 = b >= 0 ? lp2(saw(stab2, b), 700 + 3800 * Math.exp(-b * 5), 0.9) * env(b, 0.006, 0.55) : 0;
        if (a >= 0) ph += (TAU * (40 + 90 * Math.exp(-a * 16))) / r;
        const thump = a >= 0 ? Math.sin(ph) * Math.exp(-a / 0.3) * 0.9 + lpc(n(), 2500, 0.7) * Math.exp(-a / 0.04) * 0.5 : 0;
        return swell + c1 * 0.9 + c2 * 0.9 + thump;
      });
    },
  },
  {
    id: 'whoosh', name: 'Whoosh', description: 'Airy swish for titles and transitions.', seconds: 0.6,
    make: (r) => {
      const n = noise(11), bp = biquad('bp', r), lp = biquad('lp', r);
      return render(0.6, r, 0.6, (t) => {
        const x = t / 0.6;
        const shape = Math.sin(Math.PI * Math.pow(x, 0.7)) ** 2; // swells then tails off
        const hz = 350 + 1900 * Math.sin(Math.PI * Math.pow(x, 0.8)); // sweeps up and back down
        return lp(bp(n(), hz, 1.6), 5000, 0.7) * shape;
      });
    },
  },
  {
    id: 'pop', name: 'Pop', description: 'Quick pop for stickers and text.', seconds: 0.15,
    make: (r) => { let ph = 0; return render(0.15, r, 0.7, (t) => { ph += (TAU * (900 * Math.exp(-t * 30) + 180)) / r; return Math.sin(ph) * env(t, 0.001, 0.035); }); },
  },
  {
    id: 'riser', name: 'Suspense riser', description: 'Builds tension before a reveal (2 s).', seconds: 2,
    make: (r) => {
      const n = noise(5), lp = biquad('lp', r); let ph = 0, ph2 = 0;
      return render(2, r, 0.7, (t) => {
        const x = t / 2;
        ph += (TAU * (180 + 700 * x * x)) / r; ph2 += (TAU * (181.5 + 706 * x * x)) / r;
        const trem = 0.6 + 0.4 * Math.sin(TAU * (6 + 18 * x) * t);
        return (Math.sin(ph) * 0.5 + Math.sin(ph2) * 0.5 + lp(n(), 1500 + 3000 * x, 0.7) * 0.25 * x) * x * trem;
      });
    },
  },
  {
    id: 'tada', name: 'Ta-da', description: 'Celebration chord.', seconds: 1.4,
    make: (r) => render(1.4, r, 0.8, (t) => {
      const notes: [number, number][] = [[523.25, 0], [659.25, 0], [783.99, 0], [1046.5, 0.12]];
      let v = 0;
      for (const [hz, at] of notes) v += bell(t - at, hz, 0.5);
      return v;
    }),
  },
];

/** Mono 16-bit WAV file bytes. */
export function wavBytes(samples: Float32Array, rate: number): Uint8Array<ArrayBuffer> {
  const bytes = 44 + samples.length * 2;
  const buf = new ArrayBuffer(bytes);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, bytes - 8, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  return new Uint8Array(buf);
}

export function sfxFile(def: SfxDef, rate = 48000): File {
  return new File([wavBytes(def.make(rate), rate)], `SFX - ${def.name.replace(/\s*\(.*\)/, '')}.wav`, { type: 'audio/wav' });
}
