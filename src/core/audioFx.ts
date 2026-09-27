/**
 * Audio effects catalogue and audio analysis helpers (normalise, ducking).
 * The same effect list drives preview and export (engine/audioChain.ts).
 */
import type { ParamDef } from './effects';
import { uid } from './ids';
import { mergeRanges, type Range } from './analysis';
import type { AudioEffect, AudioEffectType, Clip, Keyframe } from './types';

export interface AudioFxDef { type: AudioEffectType; name: string; description: string; params: ParamDef[] }

const p = (key: string, label: string, min: number, max: number, def: number, step = 1, unit?: string): ParamDef => ({ key, label, min, max, step, default: def, unit });

export const AUDIO_EFFECTS: AudioFxDef[] = [
  { type: 'voice', name: 'Voice enhance', description: 'Clearer, fuller speech: rumble cut, presence lift, gentle compression.', params: [p('amount', 'Amount', 0, 100, 70)] },
  { type: 'gate', name: 'Noise reduction', description: 'Turns down background hiss and room noise between words.', params: [p('threshold', 'Noise level', -80, -20, -50, 1, 'dB'), p('reduction', 'Reduction', 0, 40, 18, 1, 'dB'), p('hiss', 'Hiss cut', 0, 100, 40)] },
  { type: 'eq', name: 'Equaliser', description: 'Bass, mid and treble.', params: [p('low', 'Bass', -15, 15, 0, 0.5, 'dB'), p('mid', 'Mid', -15, 15, 0, 0.5, 'dB'), p('midFreq', 'Mid freq', 200, 5000, 1000, 10, 'Hz'), p('high', 'Treble', -15, 15, 0, 0.5, 'dB')] },
  { type: 'compressor', name: 'Compressor', description: 'Evens out loud and quiet parts.', params: [p('threshold', 'Threshold', -60, 0, -24, 1, 'dB'), p('ratio', 'Ratio', 1, 20, 4, 0.5, ':1'), p('attack', 'Attack', 0, 200, 10, 1, 'ms'), p('release', 'Release', 10, 1000, 250, 10, 'ms'), p('makeup', 'Make-up gain', 0, 24, 6, 0.5, 'dB')] },
  { type: 'limiter', name: 'Limiter', description: 'Stops peaks from clipping.', params: [p('ceiling', 'Ceiling', -12, 0, -1, 0.5, 'dB'), p('drive', 'Drive', 0, 18, 0, 0.5, 'dB')] },
  { type: 'highpass', name: 'Low cut', description: 'Removes rumble and wind.', params: [p('freq', 'Cut below', 20, 500, 90, 5, 'Hz')] },
  { type: 'lowpass', name: 'High cut', description: 'Softens harsh top end (or makes a “phone” sound).', params: [p('freq', 'Cut above', 1000, 20000, 12000, 100, 'Hz')] },
  { type: 'reverb', name: 'Reverb', description: 'Room or hall ambience.', params: [p('mix', 'Mix', 0, 100, 25, 1, '%'), p('size', 'Room size', 0.2, 6, 1.8, 0.1, 's')] },
  { type: 'echo', name: 'Echo', description: 'Repeating delay.', params: [p('delay', 'Delay', 20, 1500, 300, 10, 'ms'), p('feedback', 'Repeats', 0, 90, 35, 1, '%'), p('mix', 'Mix', 0, 100, 30, 1, '%')] },
  { type: 'pan', name: 'Stereo pan', description: 'Move the sound left or right.', params: [p('pan', 'Pan', -100, 100, 0, 1)] },
  { type: 'pitch', name: 'Pitch', description: 'Raise or lower the voice without changing speed.', params: [p('semitones', 'Pitch', -12, 12, 0, 0.5, 'st')] },
];

export function getAudioFxDef(type: string): AudioFxDef | undefined {
  return AUDIO_EFFECTS.find((e) => e.type === type);
}

export function createAudioEffect(type: AudioEffectType): AudioEffect {
  const def = getAudioFxDef(type);
  if (!def) throw new Error(`Unknown audio effect: ${type}`);
  const params: Record<string, number> = {};
  for (const prm of def.params) params[prm.key] = prm.default;
  return { id: uid('afx'), type, enabled: true, params };
}

export const dbToGain = (db: number) => Math.pow(10, db / 20);
export const gainToDb = (g: number) => 20 * Math.log10(Math.max(1e-9, g));

/**
 * Normalise: volume that brings typical speech/music loudness (the 70th
 * percentile of RMS) to `targetDb`, capped at +12 dB so noise isn't blown up.
 */
export function normaliseGain(loudness: number[], targetDb = -18): number {
  const vals = loudness.filter((v) => v > 1e-4).sort((a, b) => a - b);
  if (!vals.length) return 1;
  const typical = vals[Math.floor(vals.length * 0.7)];
  return Math.min(4, Math.max(0.05, dbToGain(targetDb) / typical));
}

/** Timeline ranges where something is loud enough to count as speech/foreground. */
export function activityRanges(loudness: number[], perSecond: number, clip: Clip, thresholdDb = -40, hold = 0.25): Range[] {
  const thr = dbToGain(thresholdDb);
  const ranges: Range[] = [];
  const s0 = clip.sourceIn, s1 = clip.sourceIn + clip.duration * clip.speed;
  let start = -1;
  for (let i = Math.floor(s0 * perSecond); i <= Math.ceil(s1 * perSecond); i++) {
    const on = i < loudness.length && loudness[i] >= thr && i / perSecond < s1;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      const a = clip.start + (start / perSecond - s0) / clip.speed, b = clip.start + (i / perSecond - s0) / clip.speed;
      ranges.push([Math.max(clip.start, a), Math.min(clip.start + clip.duration, b)]);
      start = -1;
    }
  }
  return mergeRanges(ranges, hold);
}

/**
 * Ducking: volume keyframes that dip a music clip by `amountDb` whenever the
 * foreground (speech) is active, with smooth fades in and out.
 */
export function duckingKeys(music: Clip, speech: Range[], amountDb = -12, attack = 0.15, release = 0.5): Keyframe[] {
  const base = music.volume;
  const low = base * dbToGain(amountDb);
  const keys: Keyframe[] = [{ t: 0, v: base, ease: 'linear' }];
  for (const [a, b] of mergeRanges(speech, attack + release)) {
    const s = Math.max(0, a - music.start - attack), e = Math.min(music.duration, b - music.start + release);
    if (e <= 0 || s >= music.duration) continue;
    const last = keys[keys.length - 1];
    if (s > last.t + 1e-3) keys.push({ t: s, v: base, ease: 'easeInOut' });
    keys.push({ t: Math.min(music.duration, s + attack), v: low, ease: 'linear' });
    keys.push({ t: Math.max(s + attack, e - release), v: low, ease: 'easeInOut' });
    keys.push({ t: e, v: base, ease: 'linear' });
  }
  if (keys[keys.length - 1].t < music.duration - 1e-3) keys.push({ t: music.duration, v: base, ease: 'linear' });
  // Remove keys that went backwards in time after clamping.
  return keys.filter((k, i) => i === 0 || k.t > keys[i - 1].t - 1e-6);
}
