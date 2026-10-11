/**
 * Kids Studio: the simple editor's rules, on top of the normal project model.
 *
 * - Photos and videos sit end to end on the main track (magnetic), in order.
 * - Stickers, words, sounds and voice recordings sit on top at a moment in time.
 * - One background tune can play under the whole video.
 * After every change `tidyKids` keeps it all neat: nothing hangs off the end,
 * the tune always covers the whole video, and the chosen "joins" stay on.
 * A project made here is still an ordinary project — a grown-up can open it in
 * the full editor at any time.
 */
import { createClipFromMedia, createShapeClip, createTextClip, createTrack, defaultShape } from './defaults';
import { createEffect, LOOKS } from './effects';
import { uid } from './ids';
import { addOverlayClip, clipEnd, findClip, insertClipAuto, mainTrackIndex, packTrack, setSpeed, splitClip, updateClip } from './timeline';
import { createTransition, maxTransitionDuration } from './transitions';
import type { Clip, EffectInstance, Keyframe, MediaItem, MotionLoop, Project, TextAnimation, TextStyle, Track } from './types';

export const MUSIC_TRACK = 'Music';
const KID_FX = 'kid-';

/* ---------------- the main strip (photos + videos in order) ---------------- */

export function mainTrack(p: Project): Track | null {
  const i = mainTrackIndex(p);
  return i < 0 ? null : p.tracks[i];
}

/** Photos and videos, in the order they play. */
export function mainClips(p: Project): Clip[] {
  return [...(mainTrack(p)?.clips ?? [])].sort((a, b) => a.start - b.start);
}

/** Where the video ends (the end of the last photo or video). */
export function kidsLength(p: Project): number {
  return mainClips(p).reduce((e, c) => Math.max(e, clipEnd(c)), 0);
}

function setMain(p: Project, clips: Clip[]): Project {
  const i = mainTrackIndex(p);
  if (i < 0) return p;
  const tracks = p.tracks.slice();
  tracks[i] = packTrack({ ...tracks[i], clips });
  return { ...p, tracks };
}

/**
 * Fill the screen when the picture is roughly the same shape as the video (a
 * little trimmed off the sides is better than big black bars); show all of it
 * when the shapes are very different (a wide video in a tall one).
 */
export function fitFor(p: Project, m: MediaItem): Clip['fit'] {
  if (!m.width || !m.height) return 'contain';
  const a = m.width / m.height, f = p.settings.width / p.settings.height;
  return Math.max(a / f, f / a) <= 1.4 ? 'cover' : 'contain';
}

/** Add photos/videos to the end of the strip, in the order given. */
export function addToStrip(p: Project, media: MediaItem[]): { project: Project; ids: string[] } {
  let q = p;
  const ids: string[] = [];
  for (const m of media) {
    if (m.kind === 'audio') continue;
    const clip = createClipFromMedia(m, kidsLength(q));
    if (m.kind === 'image') clip.duration = 3;
    clip.fit = fitFor(q, m);
    const main = mainTrack(q);
    if (!main) continue;
    q = setMain(q, [...main.clips, clip]);
    ids.push(clip.id);
  }
  return { project: tidyKids(q), ids };
}

/** Swap a photo/video with its neighbour (dir -1 = earlier, +1 = later). */
export function moveInStrip(p: Project, clipId: string, dir: -1 | 1): Project {
  const clips = mainClips(p);
  const i = clips.findIndex((c) => c.id === clipId), j = i + dir;
  if (i < 0 || j < 0 || j >= clips.length) return p;
  [clips[i], clips[j]] = [clips[j], clips[i]];
  // Give them their new order before packing (packTrack sorts by start).
  return tidyKids(setMain(p, clips.map((c, k) => ({ ...c, start: k }))));
}

export function removeFromStrip(p: Project, clipId: string): Project {
  return tidyKids(setMain(p, mainClips(p).filter((c) => c.id !== clipId)));
}

/** Split a photo/video in two at a moment in the video. Returns the new right-hand piece's id. */
export function splitInStrip(p: Project, clipId: string, at: number): { project: Project; id: string } | null {
  const c = mainClips(p).find((x) => x.id === clipId);
  if (!c || at < c.start + 0.2 || at > clipEnd(c) - 0.2) return null;
  const r = splitClip(p, clipId, at);
  return r ? { project: tidyKids(r.project), id: r.rightId } : null;
}

/** Copy a photo/video; the copy goes straight after it. */
export function copyInStrip(p: Project, clipId: string): { project: Project; id: string } | null {
  const clips = mainClips(p);
  const i = clips.findIndex((c) => c.id === clipId);
  if (i < 0) return null;
  const src = clips[i];
  const copy: Clip = JSON.parse(JSON.stringify(src));
  copy.id = uid('clp');
  copy.effects = copy.effects.map((e) => {
    const id = uid(e.id.startsWith(KID_FX) ? KID_FX : 'fx');
    // Effect keyframes follow the effect's new id.
    for (const k of Object.keys(copy.keyframes)) if (k.startsWith(`fx.${e.id}.`)) { copy.keyframes[k.replace(`fx.${e.id}.`, `fx.${id}.`) as keyof Clip['keyframes']] = copy.keyframes[k as keyof Clip['keyframes']]; delete copy.keyframes[k as keyof Clip['keyframes']]; }
    return { ...e, id };
  });
  const next = [...clips.slice(0, i + 1), copy, ...clips.slice(i + 1)].map((c, k) => ({ ...c, start: k }));
  return { project: tidyKids(setMain(p, next)), id: copy.id };
}

/** How loud a video's own sound is (0 = off). */
export function setClipVolume(p: Project, clipId: string, volume: number): Project {
  return updateClip(p, clipId, { volume: Math.max(0, volume), muted: volume <= 0 });
}

/**
 * "Make it shorter": keep the part of a video between `from` and `to`
 * (seconds in the original video). Photos: how long it shows (`to - from`).
 */
export function trimInStrip(p: Project, clipId: string, from: number, to: number): Project {
  const loc = findClip(p, clipId);
  if (!loc) return p;
  const c = loc.clip;
  const media = p.media.find((m) => m.id === c.mediaId);
  const span = Math.max(0.3, to - from);
  if (c.kind === 'image' || !media) return tidyKids(updateClip(p, clipId, { duration: span }));
  const total = media.duration || span;
  const a = Math.max(0, Math.min(from, total - 0.3)), b = Math.min(total, Math.max(a + 0.3, to));
  const q = updateClip(p, clipId, { sourceIn: a, duration: (b - a) / c.speed });
  return tidyKids(setMain(q, mainClips(q)));
}

/** The part of the original video a clip uses: [from, to] in seconds. */
export function clipRange(p: Project, c: Clip): { from: number; to: number; total: number } {
  const media = p.media.find((m) => m.id === c.mediaId);
  if (c.kind !== 'video' || !media) return { from: 0, to: c.duration, total: Math.max(10, c.duration) };
  return { from: c.sourceIn, to: c.sourceIn + c.duration * c.speed, total: media.duration };
}

/* ---------------- speed ---------------- */

export const KID_SPEEDS = [
  { id: 'slow', speed: 0.5, emoji: '🐢', name: 'Slow-mo' },
  { id: 'normal', speed: 1, emoji: '🚶', name: 'Normal' },
  { id: 'fast', speed: 2, emoji: '🐇', name: 'Fast' },
  { id: 'rocket', speed: 4, emoji: '🚀', name: 'Super fast' },
] as const;

export function setKidSpeed(p: Project, clipId: string, speed: number): Project {
  return tidyKids(setSpeed(p, clipId, speed));
}

export function setBackwards(p: Project, clipId: string, on: boolean): Project {
  return tidyKids(updateClip(p, clipId, { reverse: on }));
}

/* ---------------- colours (filters) ---------------- */

export interface KidLook { id: string; name: string; emoji: string; swatch: [string, string] }
export const KID_LOOKS: KidLook[] = [
  { id: 'none', name: 'Normal', emoji: '🙂', swatch: ['#e6e8ee', '#9aa3b5'] },
  { id: 'bright', name: 'Bright', emoji: '🍭', swatch: ['#ff5fa2', '#ffd23f'] },
  { id: 'sunny', name: 'Sunny', emoji: '☀️', swatch: ['#f6c56b', '#c8643b'] },
  { id: 'icy', name: 'Icy', emoji: '🧊', swatch: ['#9fe3ff', '#1f4b6e'] },
  { id: 'party', name: 'Party', emoji: '🪩', swatch: ['#ff4fd8', '#3cf0ff'] },
  { id: 'rainbow', name: 'Rainbow', emoji: '🌈', swatch: ['#ff5f6d', '#4fc3ff'] },
  { id: 'dreamy', name: 'Dreamy', emoji: '☁️', swatch: ['#c38fd6', '#f4d6ff'] },
  { id: 'bw', name: 'Black & white', emoji: '🐼', swatch: ['#eeeeee', '#222222'] },
  { id: 'old', name: 'Old times', emoji: '📜', swatch: ['#f1dfb8', '#8a6d4a'] },
  { id: 'pixel', name: 'Pixels', emoji: '👾', swatch: ['#7be08a', '#2d5031'] },
  { id: 'spooky', name: 'Spooky', emoji: '👻', swatch: ['#2a2a40', '#9fffb0'] },
];

const lookIndex = (id: string) => Math.max(0, LOOKS.findIndex((l) => l.id === id));
const fx = (type: string, params: Record<string, number> = {}): EffectInstance => ({ ...createEffect(type, params), id: uid(KID_FX) });

/** The effects behind a kid colour look (and any keyframes it animates). */
export function lookEffects(id: string, duration: number): { effects: EffectInstance[]; keyframes: Record<string, Keyframe[]> } {
  switch (id) {
    case 'bright': return { effects: [fx('adjust', { saturation: 55, contrast: 15 })], keyframes: {} };
    case 'sunny': return { effects: [fx('look', { look: lookIndex('sunlit'), strength: 85 })], keyframes: {} };
    case 'icy': return { effects: [fx('look', { look: lookIndex('harbour'), strength: 90 })], keyframes: {} };
    case 'party': return { effects: [fx('look', { look: lookIndex('arcade'), strength: 90 })], keyframes: {} };
    case 'dreamy': return { effects: [fx('look', { look: lookIndex('dusk'), strength: 60 }), fx('glow', { amount: 45, radius: 14 })], keyframes: {} };
    case 'bw': return { effects: [fx('mono', { amount: 100 })], keyframes: {} };
    case 'old': return { effects: [fx('sepia', { amount: 85 }), fx('grain', { amount: 25 })], keyframes: {} };
    case 'pixel': return { effects: [fx('pixelate', { size: 14 })], keyframes: {} };
    case 'spooky': return { effects: [fx('invert', { amount: 100 })], keyframes: {} };
    case 'rainbow': {
      // Colours keep turning round the rainbow while it plays.
      const a = fx('adjust', { saturation: 30 });
      return { effects: [a], keyframes: { [`fx.${a.id}.hue`]: [{ t: 0, v: -180, ease: 'linear' }, { t: Math.max(0.5, duration), v: 180, ease: 'linear' }] } };
    }
    default: return { effects: [], keyframes: {} };
  }
}

/** Which kid look a clip has ('none' if it has none). */
export function currentLook(c: Clip): string {
  const mine = c.effects.filter((e) => e.id.startsWith(KID_FX));
  if (!mine.length) return 'none';
  const types = mine.map((e) => e.type).join('+');
  if (types === 'adjust') return Object.keys(c.keyframes).some((k) => k.startsWith(`fx.${mine[0].id}.`)) ? 'rainbow' : 'bright';
  if (types === 'look') return LOOKS[mine[0].params.look]?.id === 'sunlit' ? 'sunny' : LOOKS[mine[0].params.look]?.id === 'harbour' ? 'icy' : 'party';
  return ({ 'look+glow': 'dreamy', mono: 'bw', 'sepia+grain': 'old', pixelate: 'pixel', invert: 'spooky' } as Record<string, string>)[types] ?? 'none';
}

/** Put a colour look on one clip, or on every photo/video when `clipId` is null. */
export function setLook(p: Project, clipId: string | null, id: string): Project {
  const ids = clipId ? [clipId] : mainClips(p).map((c) => c.id);
  let q = p;
  for (const cid of ids) {
    q = updateClip(q, cid, (c) => {
      const old = c.effects.filter((e) => e.id.startsWith(KID_FX)).map((e) => e.id);
      const keyframes = Object.fromEntries(Object.entries(c.keyframes).filter(([k]) => !old.some((o) => k.startsWith(`fx.${o}.`))));
      const look = lookEffects(id, c.duration);
      return { ...c, effects: [...c.effects.filter((e) => !old.includes(e.id)), ...look.effects], keyframes: { ...keyframes, ...look.keyframes } };
    });
  }
  return q;
}

/* ---------------- joins (transitions between clips) ---------------- */

export const KID_JOINS = [
  { id: 'none', name: 'Straight cut', emoji: '✂️', type: null },
  { id: 'fade', name: 'Fade', emoji: '🌫️', type: 'dissolve' },
  { id: 'zoom', name: 'Zoom', emoji: '🔍', type: 'zoomIn' },
  { id: 'spin', name: 'Spin', emoji: '🌀', type: 'spin' },
  { id: 'slide', name: 'Slide', emoji: '🛝', type: 'slide' },
  { id: 'flash', name: 'Flash', emoji: '⚡', type: 'flash' },
  { id: 'circle', name: 'Circle', emoji: '⭕', type: 'iris' },
] as const;

export function setJoins(p: Project, type: string | null): Project {
  return tidyKids({ ...p, kids: { ...p.kids, joins: type } });
}

function applyJoins(p: Project): Project {
  const type = p.kids?.joins;
  const clips = mainClips(p);
  const i = mainTrackIndex(p);
  if (i < 0) return p;
  const next = clips.map((c, k) => {
    const b = clips[k + 1];
    if (!type || !b) return c.transitionOut ? { ...c, transitionOut: undefined } : c;
    const t = createTransition(type, Math.min(0.6, maxTransitionDuration(c, b)));
    return t.duration >= 0.1 ? { ...c, transitionOut: t } : { ...c, transitionOut: undefined };
  });
  const tracks = p.tracks.slice();
  tracks[i] = { ...tracks[i], clips: next };
  return { ...p, tracks };
}

/* ---------------- things on top: stickers, words, sounds, voice ---------------- */

/** Clips on top of the strip that belong to a moment (everything but the strip and the tune). */
export function extras(p: Project): Clip[] {
  const mi = mainTrackIndex(p);
  return p.tracks.filter((t, i) => i !== mi && t.name !== MUSIC_TRACK).flatMap((t) => t.clips).sort((a, b) => a.start - b.start);
}

/** When something added at `at` should start and how long it shows, inside the video. */
export function placeAt(p: Project, at: number, want = 3): { start: number; duration: number } {
  const end = kidsLength(p);
  if (end <= 0) return { start: 0, duration: want };
  const start = Math.max(0, Math.min(at, end - Math.min(want, end)));
  return { start, duration: Math.max(0.3, Math.min(want, end - start)) };
}

/** A big emoji sticker, a little off-centre so several don't sit exactly on top of each other. */
export function addEmoji(p: Project, emoji: string, at: number): { project: Project; id: string } {
  const { width: W } = p.settings;
  const { start, duration } = placeAt(p, at);
  const size = Math.round(Math.min(W, p.settings.height) * 0.38);
  const c = createShapeClip({ ...defaultShape('emoji'), emoji, width: size, height: size }, start, duration);
  c.name = `Sticker ${emoji}`;
  const n = extras(p).length;
  c.transform = { ...c.transform, x: [0, 0.18, -0.18, 0.1, -0.1][n % 5], y: [-0.05, 0.12, -0.18, 0.2, 0.05][n % 5] };
  c.motion = { in: 'pop', out: 'fade', loop: 'bounce', duration: 0.35, speed: 0.6 };
  return { project: addOverlayClip(p, c), id: c.id };
}

/** Add a picture sticker (an imported image) on top. */
export function addPictureSticker(p: Project, media: MediaItem, at: number): { project: Project; id: string } {
  const { start, duration } = placeAt(p, at);
  const c = createClipFromMedia(media, start);
  c.duration = duration;
  c.transform = { ...c.transform, scale: 0.5 };
  c.motion = { in: 'pop', out: 'fade', loop: 'none', duration: 0.35, speed: 1 };
  return { project: addOverlayClip(p, c), id: c.id };
}

export interface KidTextStyle { id: string; name: string; style: Partial<TextStyle> }
export const KID_TEXT: KidTextStyle[] = [
  { id: 'bubbly', name: 'Bubbly', style: { fontFamily: 'Fredoka', fontWeight: 700, color: '#ffd23f', strokeColor: '#7a2cff', strokeWidth: 12, shadowBlur: 0, shadowOffsetY: 8, shadowColor: 'rgba(0,0,0,0.35)' } },
  { id: 'comic', name: 'Comic', style: { fontFamily: 'Bangers', color: '#ffffff', strokeColor: '#111111', strokeWidth: 12, letterSpacing: 2, shadowBlur: 0, shadowOffsetY: 0 } },
  { id: 'rainbow', name: 'Rainbow', style: { fontFamily: 'Archivo Black', fontWeight: 400, gradient: { from: '#ff5f6d', to: '#4fc3ff' }, strokeColor: '#ffffff', strokeWidth: 8, shadowBlur: 0 } },
  { id: 'marker', name: 'Pen', style: { fontFamily: 'Permanent Marker', color: '#ffffff', shadowBlur: 0, shadowOffsetY: 6, shadowColor: '#ff3f7f' } },
  { id: 'box', name: 'Label', style: { fontFamily: 'Figtree', fontWeight: 800, color: '#1b2a57', background: '#ffffff', backgroundRadius: 26, backgroundPadding: 22, shadowBlur: 0, shadowOffsetY: 0 } },
  { id: 'game', name: 'Game', style: { fontFamily: 'Press Start 2P', color: '#7be08a', strokeColor: '#111111', strokeWidth: 8, shadowBlur: 0, lineHeight: 1.4 } },
];

export interface WordsOptions { colour?: string | null; animIn?: TextAnimation }

/** A style's look, with an optional colour of your own (not for two-colour styles). */
function styled(styleId: string, o: WordsOptions = {}): Partial<TextStyle> {
  const st = KID_TEXT.find((s) => s.id === styleId) ?? KID_TEXT[0];
  const colour = o.colour && !st.style.gradient ? { color: o.colour } : {};
  return { ...st.style, ...colour, ...(o.animIn ? { animIn: o.animIn } : {}) };
}

export function addWords(p: Project, words: string, styleId: string, at: number, o: WordsOptions = {}): { project: Project; id: string } {
  const { width: W } = p.settings;
  const { start, duration } = placeAt(p, at);
  const size = Math.round(W * (styleId === 'game' ? 0.06 : 0.1));
  const c = createTextClip(start, { animIn: 'pop', ...styled(styleId, o), content: words.trim() || 'Hello!', fontSize: size, boxWidth: 0.86, animOut: 'fade' }, duration);
  c.transform = { ...c.transform, y: -0.28 };
  return { project: addOverlayClip(p, c), id: c.id };
}

/** Change the words or look of a text clip. */
export function editWords(p: Project, clipId: string, words: string, styleId: string, o: WordsOptions = {}): Project {
  return updateClip(p, clipId, (c) => (c.text ? {
    ...c, name: words.trim().slice(0, 24) || c.name,
    text: {
      ...c.text, gradient: null, background: null, strokeWidth: 0, fontWeight: 400, letterSpacing: 0, lineHeight: 1.15, shadowBlur: 0, shadowOffsetY: 0,
      ...styled(styleId, { animIn: c.text.animIn, ...o }), content: words.trim() || c.text.content, fontSize: Math.round(p.settings.width * (styleId === 'game' ? 0.06 : 0.1)),
    },
  } : c));
}

/** Which kid text style a text clip uses. */
export function textStyleOf(c: Clip): string {
  const t = c.text;
  if (!t) return KID_TEXT[0].id;
  return KID_TEXT.find((s) => s.style.fontFamily === t.fontFamily && (s.id !== 'rainbow' || !!t.gradient) && (s.id !== 'bubbly' || !t.gradient) && (s.id !== 'box' || !!t.background))?.id ?? KID_TEXT[0].id;
}

/** A sound effect or voice recording at a moment. */
export function addSound(p: Project, media: MediaItem, at: number): { project: Project; id: string } {
  const end = kidsLength(p);
  const c = createClipFromMedia(media, Math.max(0, Math.min(at, Math.max(0, end - 0.2))));
  const { project } = insertClipAuto(p, c);
  return { project: tidyKids(project), id: c.id };
}

/** How long something on top shows for: seconds, or 'all' for the whole video. */
export function setShowFor(p: Project, clipId: string, seconds: number | 'all'): Project {
  const loc = findClip(p, clipId);
  if (!loc) return p;
  const end = kidsLength(p);
  if (seconds === 'all') return moveExtra(updateClip(p, clipId, { duration: Math.max(0.3, end) }), clipId, 0);
  const start = Math.min(loc.clip.start, Math.max(0, end - seconds));
  return moveExtra(updateClip(p, clipId, { duration: Math.min(seconds, end - start) }), clipId, start);
}

/** Move something on top to a new start time, onto any overlay track with room. */
function moveExtra(p: Project, clipId: string, start: number): Project {
  const loc = findClip(p, clipId);
  if (!loc) return p;
  const clip = { ...loc.clip, start };
  const tracks = p.tracks.map((t) => (t.id === loc.track.id ? { ...t, clips: t.clips.filter((c) => c.id !== clipId) } : t));
  const without = { ...p, tracks };
  if (clip.kind === 'audio') return tidyKids(insertClipAuto(without, clip).project);
  return tidyKids(addOverlayClip(without, clip));
}

/** Start something on top at a new moment (it keeps its length, and stays inside the video). */
export function moveExtraTo(p: Project, clipId: string, at: number): Project {
  const c = findClip(p, clipId)?.clip;
  if (!c) return p;
  const end = kidsLength(p);
  const start = Math.max(0, Math.min(at, end - Math.min(c.duration, end)));
  return moveExtra(p, clipId, start);
}

export const KID_MOTIONS: { id: MotionLoop; name: string; emoji: string }[] = [
  { id: 'none', name: 'Still', emoji: '🧊' }, { id: 'bounce', name: 'Bounce', emoji: '🏀' }, { id: 'pulse', name: 'Pulse', emoji: '💓' },
  { id: 'wiggle', name: 'Wiggle', emoji: '🐛' }, { id: 'spin', name: 'Spin', emoji: '🌀' }, { id: 'float', name: 'Float', emoji: '🎈' },
  { id: 'shake', name: 'Shake', emoji: '🫨' }, { id: 'swing', name: 'Swing', emoji: '🐒' },
];

/** How a sticker or text keeps moving while it's on screen. */
export function setMotion(p: Project, clipId: string, loop: MotionLoop): Project {
  return updateClip(p, clipId, (c) => ({ ...c, motion: { in: 'pop', out: 'fade', duration: 0.35, speed: loop === 'spin' ? 0.4 : 0.7, ...c.motion, loop } }));
}

export const KID_TEXT_IN: { id: TextAnimation; name: string }[] = [
  { id: 'pop', name: 'Pop' }, { id: 'slideUp', name: 'Slide' }, { id: 'typewriter', name: 'Type' }, { id: 'wordByWord', name: 'Word by word' }, { id: 'fade', name: 'Fade' },
];
export const KID_TEXT_COLOURS = ['#ffffff', '#ffd23f', '#ff6fae', '#4fdda6', '#5bb8ff', '#9d7bff', '#ff8b3d', '#111111'];

export function removeExtra(p: Project, clipId: string): Project {
  const mi = mainTrackIndex(p);
  const tracks = p.tracks
    .map((t) => ({ ...t, clips: t.clips.filter((c) => c.id !== clipId) }))
    // Drop overlay tracks left empty (keeps the grown-up timeline tidy too).
    .filter((t, i) => t.clips.length > 0 || i === mi || !t.name.startsWith('Overlay'));
  return tidyKids({ ...p, tracks });
}

/* ---------------- background tune ---------------- */

export function setMusic(p: Project, mediaId: string | null, volume = 0.45): Project {
  return tidyKids({ ...p, kids: { ...p.kids, music: mediaId ? { mediaId, volume } : null } });
}

/** Lay the tune end to end under the whole video, fading out at the end. */
function fitMusic(p: Project): Project {
  const music = p.kids?.music;
  let tracks = p.tracks;
  let ti = tracks.findIndex((t) => t.kind === 'audio' && t.name === MUSIC_TRACK);
  const media = music ? p.media.find((m) => m.id === music.mediaId) : undefined;
  const end = kidsLength(p);
  if (!media || end <= 0) {
    if (ti >= 0 && tracks[ti].clips.length) { tracks = tracks.slice(); tracks[ti] = { ...tracks[ti], clips: [] }; return { ...p, tracks }; }
    return p;
  }
  if (ti < 0) {
    // Locked so sounds and voices never land on it; Kids Studio manages it.
    tracks = [...tracks, { ...createTrack('audio', MUSIC_TRACK), locked: true }];
    ti = tracks.length - 1;
  }
  const loop = Math.max(0.5, media.duration);
  const clips: Clip[] = [];
  for (let t = 0; t < end - 0.01; t += loop) {
    const c = createClipFromMedia(media, t);
    c.id = uid('clp');
    c.duration = Math.min(loop, end - t);
    c.volume = music!.volume;
    c.name = media.name;
    clips.push(c);
  }
  const last = clips[clips.length - 1];
  last.fadeOut = Math.min(1.5, last.duration);
  clips[0].fadeIn = Math.min(0.3, clips[0].duration);
  tracks = tracks.slice();
  tracks[ti] = { ...tracks[ti], clips };
  return { ...p, tracks };
}

/* ---------------- keeping it all neat ---------------- */

/**
 * After any change: things on top can't hang past the end of the video, the
 * tune covers exactly the whole video, and the joins are applied.
 */
export function tidyKids(p: Project): Project {
  const end = kidsLength(p);
  const mi = mainTrackIndex(p);
  // Anything past the end is pulled back inside the video rather than lost.
  const moved: Clip[] = [];
  const tracks = p.tracks.map((t, i) => {
    if (i === mi || t.name === MUSIC_TRACK || end <= 0) return t;
    const keep = t.clips.filter((c) => {
      if (c.start + c.duration <= end + 1e-6) return true;
      const duration = Math.min(c.duration, end);
      moved.push({ ...c, start: Math.min(c.start, end - duration), duration, fadeOut: Math.min(c.fadeOut, duration) });
      return false;
    });
    return keep.length === t.clips.length ? t : { ...t, clips: keep };
  });
  // Put them back wherever there's room (another layer if two would now overlap).
  let q: Project = { ...p, tracks };
  for (const c of moved) q = c.kind === 'audio' ? insertClipAuto(q, c).project : addOverlayClip(q, c);
  return fitMusic(applyJoins(q));
}

/** A new Kids Studio project: tall or wide, magnetic strip, ready for photos and videos. */
export function kidsProjectDefaults(p: Project): Project {
  return { ...p, magnetic: true, kids: { joins: null, music: null } };
}
