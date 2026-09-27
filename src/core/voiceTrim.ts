/**
 * Tidy a quick voice recording: cut the silence before and after the words
 * (keeping a short breath either side) and bring it up to a consistent level.
 * Pure maths, so it's unit-tested.
 */
export function tidyVoice(samples: Float32Array, rate: number, opts: { threshold?: number; pad?: number; peak?: number } = {}): Float32Array {
  const threshold = opts.threshold ?? 0.2; // fraction of the loudest moment counted as "talking"
  const pad = Math.round((opts.pad ?? 0.08) * rate);
  const peak = opts.peak ?? 0.9;
  let max = 0;
  for (const v of samples) max = Math.max(max, Math.abs(v));
  if (max < 1e-4) return new Float32Array(0); // nothing but silence
  // Loudness in 10 ms windows, so a single click doesn't count as speech.
  const win = Math.max(1, Math.round(rate * 0.01));
  const loud = (i: number) => {
    let m = 0;
    for (let j = i; j < Math.min(samples.length, i + win); j++) m = Math.max(m, Math.abs(samples[j]));
    return m >= max * threshold;
  };
  let start = 0, end = samples.length;
  for (let i = 0; i < samples.length; i += win) if (loud(i)) { start = i; break; }
  for (let i = Math.floor((samples.length - 1) / win) * win; i >= 0; i -= win) if (loud(i)) { end = Math.min(samples.length, i + win); break; }
  start = Math.max(0, start - pad);
  end = Math.min(samples.length, end + pad);
  const out = samples.slice(start, end);
  const g = peak / max;
  const fade = Math.min(out.length >> 1, Math.round(rate * 0.015));
  for (let i = 0; i < out.length; i++) out[i] *= g * Math.min(1, i / fade, (out.length - 1 - i) / fade);
  return out;
}

/** Mix any number of channels down to one. */
export function toMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (const c of channels) for (let i = 0; i < out.length; i++) out[i] += c[i] / channels.length;
  return out;
}
