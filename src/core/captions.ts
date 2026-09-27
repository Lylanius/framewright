/**
 * Captions: subtitle file parsing/writing, word timing, chunking and the
 * operations behind the Captions panel. Captions are ordinary text clips
 * (flagged `caption: true`) on a track with `role: 'captions'`, so every text
 * style, animation and keyframe works on them too.
 */
import { createTrack, createTextClip } from './defaults';
import { findClip, splitClip, updateClip } from './timeline';
import type { Clip, Project, TextStyle, WordTiming } from './types';

export interface Cue {
  start: number;
  end: number;
  text: string;
  /** Word timings relative to `start`, when the source file provides them (VTT karaoke tags). */
  words?: WordTiming[];
}

/* ------------------------------------------------------------------ */
/* Parsing                                                               */
/* ------------------------------------------------------------------ */

const TS = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;

export function parseTimestamp(s: string): number | null {
  const m = s.trim().match(TS);
  if (!m) return null;
  const [, h, mm, ss, ms] = m;
  return (h ? +h * 3600 : 0) + +mm * 60 + +ss + +ms.padEnd(3, '0') / 1000;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\{\\[^}]*\}/g, '');
}

/** Parse SRT or WebVTT (auto-detected). Invalid blocks are skipped, never fatal. */
export function parseSubtitles(input: string): Cue[] {
  const text = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const blocks = text.split(/\n{2,}/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, b] = lines[ti].split('-->');
    const start = parseTimestamp(a), end = parseTimestamp(b ?? '');
    if (start === null || end === null || end <= start) continue;
    const raw = lines.slice(ti + 1).join('\n');
    const words = parseInlineTimings(raw, start, end);
    const clean = stripTags(raw).replace(/[ \t]+/g, ' ').trim();
    if (!clean) continue;
    cues.push({ start, end, text: clean, words });
  }
  return cues.sort((x, y) => x.start - y.start);
}

/** WebVTT karaoke: "<00:00:01.200>word" tags give per-word start times. */
function parseInlineTimings(raw: string, start: number, end: number): WordTiming[] | undefined {
  if (!/<\d{1,2}:\d{2}[:.]/.test(raw)) return undefined;
  const parts = raw.split(/(<\d[^>]*>)/);
  let t = start;
  const words: WordTiming[] = [];
  for (const part of parts) {
    const ts = part.startsWith('<') ? parseTimestamp(part.slice(1, -1)) : null;
    if (ts !== null) { t = ts; continue; }
    for (const w of stripTags(part).split(/\s+/).filter(Boolean)) words.push({ text: w, start: t - start, end: 0 });
  }
  for (let i = 0; i < words.length; i++) words[i].end = i + 1 < words.length ? Math.max(words[i].start, words[i + 1].start) : end - start;
  return words.length ? words : undefined;
}

/* ------------------------------------------------------------------ */
/* Writing                                                               */
/* ------------------------------------------------------------------ */

function stamp(t: number, sep: ',' | '.'): string {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, f = ms % 1000;
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(f, 3)}`;
}

export function toSRT(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${stamp(c.start, ',')} --> ${stamp(c.end, ',')}\n${c.text}\n`).join('\n');
}

export function toVTT(cues: Cue[]): string {
  return `WEBVTT\n\n${cues.map((c) => `${stamp(c.start, '.')} --> ${stamp(c.end, '.')}\n${c.text}\n`).join('\n')}`;
}

/* ------------------------------------------------------------------ */
/* Word timing                                                            */
/* ------------------------------------------------------------------ */

export function splitWords(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/** Spread words across a duration, weighting by length (longer words take longer to say). */
export function estimateWords(text: string, duration: number): WordTiming[] {
  const words = splitWords(text);
  if (!words.length) return [];
  const weights = words.map((w) => w.replace(/[^\p{L}\p{N}]/gu, '').length + 2);
  const total = weights.reduce((a, b) => a + b, 0);
  let t = 0;
  return words.map((w, i) => {
    const d = (weights[i] / total) * duration;
    const wt = { text: w, start: t, end: t + d };
    t += d;
    return wt;
  });
}

/** Word timings for a caption clip: real ones if they still match the text, else estimated. */
export function wordTimings(clip: Clip): WordTiming[] {
  const text = clip.text?.content ?? '';
  const count = splitWords(text).length;
  if (clip.words && clip.words.length === count) return clip.words;
  return estimateWords(text, clip.duration);
}

/** Index of the word being spoken at clip-local time, or -1. */
export function activeWordIndex(clip: Clip, local: number): number {
  const words = wordTimings(clip);
  for (let i = 0; i < words.length; i++) if (local >= words[i].start && local < words[i].end) return i;
  return local >= clip.duration ? words.length - 1 : -1;
}

/* ------------------------------------------------------------------ */
/* Chunking (1–3 word "TikTok" captions)                                  */
/* ------------------------------------------------------------------ */

export function chunkCue(cue: Cue, maxWords: number): Cue[] {
  const words = cue.words && cue.words.length === splitWords(cue.text).length ? cue.words : estimateWords(cue.text, cue.end - cue.start);
  if (maxWords <= 0 || words.length <= maxWords) return [cue];
  const out: Cue[] = [];
  for (let i = 0; i < words.length; i += maxWords) {
    const group = words.slice(i, i + maxWords);
    const s = group[0].start, e = i + maxWords >= words.length ? cue.end - cue.start : group[group.length - 1].end;
    out.push({
      start: cue.start + s,
      end: cue.start + e,
      text: group.map((w) => w.text).join(' '),
      words: cue.words ? group.map((w) => ({ ...w, start: w.start - s, end: w.end - s })) : undefined,
    });
  }
  return out;
}

export function chunkCues(cues: Cue[], maxWords: number): Cue[] {
  return cues.flatMap((c) => chunkCue(c, maxWords));
}

/* ------------------------------------------------------------------ */
/* Styles                                                                 */
/* ------------------------------------------------------------------ */

export interface CaptionStyle { id: string; name: string; style: Partial<TextStyle>; y: number }

/** Original caption looks. Sizes assume a 1080-wide canvas; they are scaled to the project. */
export const CAPTION_STYLES: CaptionStyle[] = [
  { id: 'punch', name: 'Punch', y: 0.18, style: { fontFamily: 'Archivo Black', fontSize: 84, uppercase: true, color: '#ffffff', strokeColor: '#000000', strokeWidth: 8, shadowBlur: 0, shadowOffsetY: 6, shadowColor: 'rgba(0,0,0,0.7)', highlightMode: 'color', highlightColor: '#ffd23f', animIn: 'pop', animOut: 'none', animDuration: 0.12 } },
  { id: 'boxed', name: 'Boxed word', y: 0.2, style: { fontFamily: 'Figtree', fontWeight: 800, fontSize: 70, color: '#ffffff', strokeWidth: 0, shadowBlur: 10, shadowOffsetY: 3, highlightMode: 'box', highlightColor: '#7c4dff', highlightTextColor: '#ffffff', animIn: 'none', animOut: 'none' } },
  { id: 'karaoke', name: 'Karaoke', y: 0.22, style: { fontFamily: 'Poppins', fontWeight: 800, fontSize: 72, color: 'rgba(255,255,255,0.55)', strokeColor: '#000000', strokeWidth: 5, shadowBlur: 0, shadowOffsetY: 0, highlightMode: 'karaoke', highlightColor: '#ffffff', animIn: 'none', animOut: 'none' } },
  { id: 'underline', name: 'Underline', y: 0.22, style: { fontFamily: 'Montserrat', fontWeight: 900, fontSize: 68, color: '#ffffff', strokeWidth: 0, shadowBlur: 14, shadowOffsetY: 4, highlightMode: 'underline', highlightColor: '#3cf0ff', animIn: 'fade', animOut: 'none', animDuration: 0.1 } },
  { id: 'gamer', name: 'Gamer', y: 0.2, style: { fontFamily: 'Bangers', fontSize: 96, letterSpacing: 2, color: '#ffffff', strokeColor: '#1b1b3a', strokeWidth: 9, shadowBlur: 0, shadowOffsetY: 7, shadowColor: '#ff3f7f', highlightMode: 'color', highlightColor: '#3cf0ff', animIn: 'pop', animOut: 'none', animDuration: 0.1 } },
  { id: 'clean', name: 'Clean subtitle', y: 0.36, style: { fontFamily: 'Figtree', fontWeight: 700, fontSize: 50, color: '#ffffff', background: 'rgba(0,0,0,0.6)', backgroundPadding: 12, backgroundRadius: 8, strokeWidth: 0, shadowBlur: 0, shadowOffsetY: 0, highlightMode: 'none', animIn: 'none', animOut: 'none' } },
];

export function captionTextStyle(styleId: string, projectWidth: number, text: string): { style: Partial<TextStyle>; y: number } {
  const cs = CAPTION_STYLES.find((s) => s.id === styleId) ?? CAPTION_STYLES[0];
  const k = projectWidth / 1080;
  const style: Partial<TextStyle> = { ...cs.style, content: text, boxWidth: 0.84 };
  for (const key of ['fontSize', 'strokeWidth', 'shadowBlur', 'shadowOffsetY', 'backgroundPadding', 'backgroundRadius', 'letterSpacing'] as const) {
    if (typeof style[key] === 'number') (style as Record<string, number>)[key] = Math.round((style[key] as number) * k * 10) / 10;
  }
  return { style, y: cs.y };
}

/* ------------------------------------------------------------------ */
/* Project operations                                                     */
/* ------------------------------------------------------------------ */

export function captionTrackIndex(p: Project): number {
  return p.tracks.findIndex((t) => t.role === 'captions');
}

export function captionClips(p: Project): Clip[] {
  return p.tracks.flatMap((t) => t.clips.filter((c) => c.caption)).sort((a, b) => a.start - b.start);
}

export function projectCues(p: Project): Cue[] {
  return captionClips(p).map((c) => ({ start: c.start, end: c.start + c.duration, text: c.text?.content ?? '' }));
}

/**
 * Put cues onto the caption track (created on top if missing). With
 * `replace`, existing captions are removed first. Overlapping cues are trimmed
 * so they don't collide.
 */
export function addCaptions(p: Project, cues: Cue[], styleId: string, replace = true): Project {
  let tracks = p.tracks.slice();
  let ti = tracks.findIndex((t) => t.role === 'captions');
  if (ti < 0) {
    const t = createTrack('visual', 'Captions');
    t.role = 'captions';
    tracks = [t, ...tracks];
    ti = 0;
  }
  const track = tracks[ti];
  const kept = replace ? [] : track.clips;
  const clips: Clip[] = [...kept];
  const sorted = cues.slice().sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length; i++) {
    const cue = sorted[i];
    const nextStart = sorted[i + 1]?.start ?? Infinity;
    const end = Math.min(cue.end, nextStart);
    if (end - cue.start < 0.05) continue;
    if (clips.some((c) => cue.start < c.start + c.duration - 1e-6 && end > c.start + 1e-6)) continue;
    const { style, y } = captionTextStyle(styleId, p.settings.width, cue.text);
    const clip = createTextClip(cue.start, style, end - cue.start);
    clip.caption = true;
    clip.name = cue.text.slice(0, 24);
    clip.transform.y = y;
    if (cue.words) clip.words = cue.words;
    clips.push(clip);
  }
  tracks[ti] = { ...track, clips: clips.sort((a, b) => a.start - b.start) };
  return { ...p, tracks };
}

/** Apply a caption look to every caption, keeping each one's text and timing. */
export function restyleCaptions(p: Project, styleId: string): Project {
  return {
    ...p,
    tracks: p.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (!c.caption || !c.text) return c;
        const { style, y } = captionTextStyle(styleId, p.settings.width, c.text.content);
        return { ...c, text: { ...c.text, highlightMode: 'none', background: null, gradient: null, glow: 0, ...style }, transform: { ...c.transform, y } };
      }),
    })),
  };
}

/** Apply the same partial style / vertical position to all captions (e.g. size or position for all). */
export function patchAllCaptions(p: Project, style: Partial<TextStyle>, y?: number): Project {
  return {
    ...p,
    tracks: p.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => (c.caption && c.text ? { ...c, text: { ...c.text, ...style }, transform: y === undefined ? c.transform : { ...c.transform, y } } : c)),
    })),
  };
}

/** Re-cut all captions into chunks of at most `maxWords` words. */
export function rechunkCaptions(p: Project, maxWords: number): Project {
  const clips = captionClips(p);
  if (!clips.length) return p;
  const templ = clips[0];
  const cues = clips.flatMap((c) => chunkCue({ start: c.start, end: c.start + c.duration, text: c.text!.content, words: c.words }, maxWords));
  const ti = captionTrackIndex(p);
  const cleared = { ...p, tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => !c.caption) })) };
  let next = addCaptions(cleared, cues, 'punch', false);
  // Keep the look of the existing captions.
  next = { ...next, tracks: next.tracks.map((t, i) => (i === (ti >= 0 ? ti : captionTrackIndex(next)) ? { ...t, clips: t.clips.map((c) => (c.caption ? { ...c, text: { ...templ.text!, content: c.text!.content }, transform: { ...templ.transform } } : c)) } : t)) };
  return next;
}

/** Split a caption at timeline time t: words before t stay, the rest move to a new caption. */
export function splitCaption(p: Project, clipId: string, t: number): { project: Project; rightId: string } | null {
  const loc = findClip(p, clipId);
  if (!loc || !loc.clip.text) return null;
  const c = loc.clip;
  const words = wordTimings(c);
  if (words.length < 2) return null;
  // Snap the split to the nearest word boundary.
  const local = t - c.start;
  let k = 1, best = Infinity;
  for (let i = 1; i < words.length; i++) {
    const d = Math.abs(words[i].start - local);
    if (d < best) { best = d; k = i; }
  }
  const at = c.start + words[k].start;
  const r = splitClip(p, clipId, at);
  if (!r) return null;
  const leftText = words.slice(0, k).map((w) => w.text).join(' ');
  const rightText = words.slice(k).map((w) => w.text).join(' ');
  const shift = words[k].start;
  let project = updateClip(r.project, clipId, (x) => ({ ...x, name: leftText.slice(0, 24), text: { ...x.text!, content: leftText }, words: c.words ? words.slice(0, k) : undefined }));
  project = updateClip(project, r.rightId, (x) => ({
    ...x, name: rightText.slice(0, 24), text: { ...x.text!, content: rightText },
    words: c.words ? words.slice(k).map((w) => ({ ...w, start: w.start - shift, end: w.end - shift })) : undefined,
  }));
  return { project, rightId: r.rightId };
}

/** Merge a caption with the next caption on its track. */
export function mergeCaptionWithNext(p: Project, clipId: string): Project | null {
  const loc = findClip(p, clipId);
  if (!loc || !loc.clip.text) return null;
  const c = loc.clip;
  const next = loc.track.clips.filter((x) => x.caption && x.start >= c.start + c.duration - 1e-6).sort((a, b) => a.start - b.start)[0];
  if (!next) return null;
  const duration = next.start + next.duration - c.start;
  const content = `${c.text!.content} ${next.text!.content}`.trim();
  const words = c.words && next.words ? [...c.words, ...next.words.map((w) => ({ ...w, start: w.start + next.start - c.start, end: w.end + next.start - c.start }))] : undefined;
  const tracks = p.tracks.map((t) => (t.id !== loc.track.id ? t : {
    ...t,
    clips: t.clips.filter((x) => x.id !== next.id).map((x) => (x.id === c.id ? { ...x, duration, name: content.slice(0, 24), text: { ...x.text!, content }, words } : x)),
  }));
  return { ...p, tracks };
}

/* ------------------------------------------------------------------ */
/* From transcription                                                     */
/* ------------------------------------------------------------------ */

/**
 * Group timed words into caption cues: at most `maxWords` per cue (0 = up to a
 * sentence, capped at 12 words), breaking early at sentence ends and pauses.
 */
export function cuesFromWords(words: WordTiming[], maxWords = 3, maxGap = 0.6): Cue[] {
  const cap = maxWords > 0 ? maxWords : 12;
  const cues: Cue[] = [];
  let group: WordTiming[] = [];
  const flush = () => {
    if (!group.length) return;
    const start = group[0].start, end = Math.max(group[group.length - 1].end, start + 0.2);
    cues.push({ start, end, text: group.map((w) => w.text).join(' '), words: group.map((w) => ({ text: w.text, start: w.start - start, end: w.end - start })) });
    group = [];
  };
  for (const w of words) {
    const prev = group[group.length - 1];
    if (prev && (w.start - prev.end > maxGap || group.length >= cap)) flush();
    group.push(w);
    if (maxWords <= 0 && /[.!?]$/.test(w.text)) flush();
  }
  flush();
  // Close tiny gaps so captions don't flicker between words.
  for (let i = 0; i < cues.length - 1; i++) {
    const gap = cues[i + 1].start - cues[i].end;
    if (gap > 0 && gap < 0.25) cues[i].end = cues[i + 1].start;
  }
  return cues;
}

/** Turn phrase-level timings (no word alignment) into estimated word timings. */
export function phrasesToWords(phrases: WordTiming[]): WordTiming[] {
  return phrases.flatMap((ph) => estimateWords(ph.text, Math.max(0.1, ph.end - ph.start)).map((w) => ({ ...w, start: w.start + ph.start, end: w.end + ph.start })));
}
