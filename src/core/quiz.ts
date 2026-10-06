/**
 * Quiz maker: turns a list of questions into finished "guess who / guess what"
 * rounds — background, title, hidden picture that's revealed, four answer
 * buttons, countdown, the right answer turning green, and sound effects.
 * Everything it makes is ordinary clips you can edit afterwards.
 */
import { createClipFromMedia, createShapeClip, createTextClip, createTrack, defaultShape } from './defaults';
import { createEffect } from './effects';
import { createMask } from './masks';
import { addUnderlayClip, createTrackAbove, projectDuration } from './timeline';
import type { Clip, ClipMotion, MediaItem, Project, ShapeStyle, TextStyle, Track } from './types';

export type HideMode = 'zoom' | 'silhouette' | 'blur' | 'pixelate' | 'none';

export interface QuizRound {
  picture: MediaItem;
  answers: string[]; // 2–4
  correct: number;
  /** 'zoom' mode: the point to zoom in on, as fractions of the picture (0..1). Defaults to the centre. */
  focus?: { x: number; y: number };
  /** Spot-the-shiny rounds: the four pictures in the order shown (A, B, C, D); `correct` is the real shiny. */
  variants?: MediaItem[];
  /** 'zoom' mode: this round's own zoom (overrides the quiz-wide setting). */
  zoom?: number;
}

export interface QuizOptions {
  title: string;
  firstRound: number;
  showRound: boolean;
  thinkSeconds: number;
  revealSeconds: number;
  hide: HideMode;
  /** 'zoom' mode: how far in the question shot is zoomed (2 = twice as close). */
  zoom: number;
  background: 'streaks' | 'speedlines' | 'rays' | 'dots' | 'gradient';
  /** Spiky "explosion" behind the picture. */
  burst: boolean;
  /** Opening title card: the title slams in over a starburst, then crossfades into round 1. */
  intro: boolean;
  introSeconds: number;
  /** Sound under the intro title: an original dramatic sting, a plain boom, or none. */
  introSound: 'sting' | 'boom' | 'none';
  /** 'guess' = who's that? (one picture, text answers). 'shiny' = spot the real shiny (four pictures A–D). */
  kind?: 'guess' | 'shiny';
  /** Line under the intro title: the round number, your own words, or nothing. */
  introSub: 'round' | 'custom' | 'none';
  introText: string;
  bgColour: string;
  accent: string; // title / letters colour
  countdown: 'bar' | 'ring' | 'none';
  /** Answer buttons: text and button size (1 = normal, up to 1.6). */
  answerSize: number;
  /** 2×2 grid, or one answer per row (wider buttons for long answers). */
  answerLayout: 'grid' | 'list';
  sounds: { tick?: MediaItem; tock?: MediaItem; ding?: MediaItem; whoosh?: MediaItem; boom?: MediaItem; sting?: MediaItem; sparkle?: MediaItem; introVoice?: MediaItem };
}

export const DEFAULT_QUIZ: Omit<QuizOptions, 'sounds'> = {
  title: "WHO'S THAT\nPOKÉMON?", firstRound: 1, showRound: true, thinkSeconds: 5, revealSeconds: 3,
  hide: 'zoom', zoom: 3.5, background: 'streaks', bgColour: '#e3141f', accent: '#ffd23f', countdown: 'bar', answerSize: 1, answerLayout: 'grid',
  burst: true, intro: true, introSeconds: 2.5, introSound: 'boom', introSub: 'round', introText: '',
};

export const SHINY_TITLE = 'SPOT THE\nREAL SHINY!';
export const SHINY_GREEN = '#00E676';
const LETTERS = ['A)', 'B)', 'C)', 'D)'];

/**
 * Spot-the-shiny layout: where the four picture tiles and the A–D buttons go
 * (x, y from the centre as fractions of the frame; sizes in pixels).
 * Tall and square videos get a 2 × 2 grid, wide ones four in a row.
 */
export function shinyLayout(W: number, H: number): { tile: number; tiles: { x: number; y: number }[]; buttons: { x: number; y: number }[]; btnWidth: number } {
  const cols = W > H * 1.2 ? 4 : 2, rows = 4 / cols;
  const top = -0.265, bottom = 0.215, gap = Math.min(W, H) * 0.035;
  const tile = Math.floor(Math.min((W * 0.92 - gap * (cols - 1)) / cols, (H * (bottom - top) - gap * (rows - 1)) / rows));
  const cy = (top + bottom) / 2;
  const tiles = Array.from({ length: 4 }, (_, i) => ({
    x: ((i % cols) - (cols - 1) / 2) * (tile + gap) / W,
    y: cy + (Math.floor(i / cols) - (rows - 1) / 2) * (tile + gap) / H,
  }));
  const btnWidth = Math.min(0.2, (tile * cols + gap * (cols - 1)) / W / 4 - 0.02);
  const span = cols === 4 ? (tile + gap) / W : 0.23;
  const buttons = Array.from({ length: 4 }, (_, i) => ({ x: (i - 1.5) * span, y: 0.3 }));
  return { tile, tiles, buttons, btnWidth };
}
const INTRO = 1;

const motion = (m: Partial<ClipMotion>): ClipMotion => ({ in: 'pop', out: 'none', loop: 'none', duration: 0.35, speed: 1, ...m });

function text(start: number, dur: number, y: number, x: number, style: Partial<TextStyle>, m?: Partial<ClipMotion>): Clip {
  const c = createTextClip(start, { shadowBlur: 0, shadowOffsetY: 0, animIn: 'none', animOut: 'none', ...style }, dur);
  c.transform = { ...c.transform, x, y };
  if (m) c.motion = motion(m);
  return c;
}

/** Scale that makes a picture (fitted "contain" to the frame) fill a `box`-pixel square. */
export function pictureScale(p: Project, m: MediaItem, box: number): number {
  const { width: W, height: H } = p.settings;
  const mw = m.width ?? 1, mh = m.height ?? 1;
  const fitW = Math.min(W, (H * mw) / mh), fitH = fitW * (mh / mw);
  return box / Math.max(fitW, fitH);
}

/**
 * Where each answer button goes (x, y from the centre as fractions of the
 * frame) and how wide it is (fraction of the width), for a size and layout.
 * Kept between the picture ring above and the countdown below.
 */
/** Padding + border around the answer text, as a fraction of the frame width (at size 1). */
const BTN_EDGE = 0.05;

/** Answer size actually used: one-per-row caps it so every row fits above the countdown. */
export function answerScale(n: number, size: number, layout: 'grid' | 'list'): number {
  const s = Math.min(1.6, Math.max(0.7, size));
  if (layout !== 'list' || n <= 1) return s;
  return Math.min(s, (0.27 - 0.012 * (n - 1)) / (0.05 * n));
}

/**
 * Where each answer button goes (x, y from the centre as fractions of the
 * frame) and the text width inside it (fraction of the width). Buttons stay
 * inside the frame, between the picture ring above and the countdown below.
 */
export function answerSlots(n: number, size: number, layout: 'grid' | 'list'): { x: number; y: number; boxWidth: number }[] {
  const s = answerScale(n, size, layout);
  const btn = 0.05 * s; // button height (fraction of frame height)
  if (layout === 'list') {
    const outer = Math.min(0.9, 0.67 * s);
    const step = Math.max(btn + 0.012, Math.min(0.062 * s, (0.27 - btn) / Math.max(1, n - 1)));
    const top = 0.3 - (step * (n - 1)) / 2;
    return Array.from({ length: n }, (_, i) => ({ x: 0, y: top + i * step, boxWidth: outer - BTN_EDGE * s }));
  }
  const outer = Math.min(0.47, 0.41 * s); // whole button, padding included
  const gap = Math.max(0.012, Math.min(0.03, 0.485 - outer));
  const x = outer / 2 + gap;
  const step = Math.max(btn + 0.012, 0.075 * s);
  const rows = Math.ceil(n / 2);
  const top = 0.32 - (step * (rows - 1)) / 2;
  return Array.from({ length: n }, (_, i) => ({ x: (i % 2 ? 1 : -1) * x, y: top + Math.floor(i / 2) * step, boxWidth: outer - BTN_EDGE * s }));
}

/**
 * Size for a round's answers: the chosen size, made a little smaller if the
 * longest answer wouldn't fit on one line (bold font ≈ 0.64 × its size per letter).
 */
export function fitAnswerScale(labels: string[], size: number, layout: 'grid' | 'list'): number {
  const longest = Math.max(1, ...labels.map((l) => [...l].length));
  let s = answerScale(labels.length, size, layout);
  while (s > 0.7) {
    const box = answerSlots(labels.length, s, layout)[0].boxWidth;
    if (longest * 0.64 * 0.04 * s <= box) break;
    s = Math.round((s - 0.05) * 100) / 100;
  }
  return Math.max(0.7, s);
}

export function roundLength(o: Pick<QuizOptions, 'thinkSeconds' | 'revealSeconds'>): number {
  return INTRO + o.thinkSeconds + o.revealSeconds;
}

/** Length of the opening title card (0 when switched off). */
export function introLength(o: Pick<QuizOptions, 'intro' | 'introSeconds'>): number {
  return o.intro ? Math.max(1, o.introSeconds) : 0;
}

/** Whole quiz: intro + every round. */
export function quizLength(o: Pick<QuizOptions, 'thinkSeconds' | 'revealSeconds' | 'intro' | 'introSeconds'>, rounds: number): number {
  return rounds ? introLength(o) + roundLength(o) * rounds : 0;
}

function burstStyle(p: Project, size: number): ShapeStyle {
  return { ...defaultShape('starburst', p.settings), width: size, height: size };
}

/** The line under the intro title, or '' for none. */
export function introSubtitle(o: Pick<QuizOptions, 'introSub' | 'introText' | 'firstRound'>, rounds: number): string {
  if (o.introSub === 'custom') return o.introText.trim();
  if (o.introSub !== 'round') return '';
  return rounds > 1 ? `Rounds ${o.firstRound}–${o.firstRound + rounds - 1}` : `Round ${o.firstRound}`;
}

/**
 * Add quiz rounds to the end of a project. Returns the new project and the
 * time range the rounds occupy.
 */
export function buildQuiz(p: Project, rounds: QuizRound[], o: QuizOptions): { project: Project; start: number; end: number } {
  const { width: W } = p.settings;
  const start0 = projectDuration(p);
  const len = roundLength(o);
  const intro = introLength(o);
  const total = quizLength(o, rounds.length);
  const roundsStart = start0 + intro;
  let q = p;

  // Background for the whole quiz, underneath everything.
  const bgStyle: ShapeStyle = { ...defaultShape(o.background, p.settings), fill: o.bgColour };
  if (o.background === 'speedlines') bgStyle.fill2 = lighten(o.bgColour, 0.25);
  if (o.background === 'streaks') { bgStyle.fill2 = lighten(o.bgColour, 0.3); bgStyle.color2 = darken(o.bgColour, 0.25); }
  q = addUnderlayClip(q, createShapeClip(bgStyle, start0, total));

  // Tracks, back to front (clips on one track can't overlap, so each layer gets its own).
  const names = ['Quiz burst', 'Quiz picture', 'Quiz ring', 'Answer A', 'Answer B', 'Answer C', 'Answer D', 'Right answer', 'Quiz round', 'Quiz title', 'Quiz countdown', 'Intro burst', 'Intro title', 'Intro subtitle',
    'Card A', 'Card B', 'Card C', 'Card D', 'Picture A', 'Picture B', 'Picture C', 'Picture D', 'Letter A', 'Letter B', 'Letter C', 'Letter D', 'Shiny glow', 'Shiny sparkles'];
  const T = { burst: 0, picture: 1, ring: 2, answer: 3, right: 7, round: 8, title: 9, countdown: 10, introBurst: 11, introTitle: 12, introSub: 13, card: 14, variant: 18, letter: 22, glow: 26, sparkles: 27 };
  const tracks: Track[] = names.map((n) => createTrack('visual', n));
  const put = (i: number, c: Clip) => { tracks[i].clips.push(c); };
  const audio: Clip[] = [], swoosh: Clip[] = [], voice: Clip[] = [];
  const snd = (m: MediaItem | undefined, at: number, list = audio) => { if (m) { const c = createClipFromMedia(m, at); c.name = m.name; list.push(c); } };
  const titleStyle: Partial<TextStyle> = { content: o.title, fontFamily: 'Archivo Black', fontSize: Math.round(W * 0.098), color: o.accent, strokeColor: '#1f4fb8', strokeWidth: 9, uppercase: true, lineHeight: 1.02, shadowColor: 'rgba(0,0,0,0.35)', shadowOffsetY: 8 };
  const FADE = 0.45; // intro → round 1 crossfade

  // Intro: the title slams in over a starburst, holds, then crossfades into round 1.
  if (intro) {
    // Cover: phones and apps use a video's very first frame as its thumbnail, so when the
    // quiz opens the video, that frame shows the finished title card. Then the slam plays.
    const cover = start0 < 1e-6 ? 1 / p.settings.fps : 0;
    const introStyle = { ...titleStyle, fontSize: Math.round(W * 0.085) };
    if (cover) {
      const still = createShapeClip(burstStyle(q, W * 1.15), start0, cover);
      still.name = 'Cover starburst';
      still.motion = motion({ in: 'none' });
      put(T.introBurst, still);
      const t = text(start0, cover, 0, 0, introStyle, { in: 'none' });
      t.name = 'Cover title';
      put(T.introTitle, t);
    }
    // Line under the title ("Round 8", or your own words): pops in just after the title lands.
    const sub = introSubtitle(o, rounds.length);
    if (sub) {
      const subStyle: Partial<TextStyle> = { content: sub, fontFamily: 'Archivo Black', fontSize: Math.round(W * 0.052), color: '#ffffff', strokeColor: '#1f4fb8', strokeWidth: 7, uppercase: true, shadowColor: 'rgba(0,0,0,0.35)', shadowOffsetY: 6 };
      const lines = o.title.split('\n').length, y = 0.03 + lines * 0.027; // sits just below the title, however many lines it has
      if (cover) { const c = text(start0, cover, y, 0, subStyle, { in: 'none' }); c.name = 'Cover subtitle'; put(T.introSub, c); }
      const at = Math.max(cover, Math.min(0.55, intro - 0.6));
      const c = text(start0 + at, intro + FADE - at, y, 0, subStyle, { in: 'pop', out: 'fade', duration: 0.3 });
      c.name = 'Intro subtitle';
      put(T.introSub, c);
    }
    const burst = createShapeClip(burstStyle(q, W * 1.15), start0 + cover, intro + FADE - cover);
    burst.name = 'Intro starburst';
    burst.motion = motion({ in: 'zoom', out: 'fade', duration: FADE });
    put(T.introBurst, burst);
    put(T.introTitle, text(start0 + cover, intro + FADE - cover, 0, 0, introStyle, { in: 'slam', out: 'fade', duration: 0.6 }));
    snd(o.sounds.introVoice, start0 + (o.sounds.sting ? 0.4 : 0.1), voice); // with the sting, the shout comes on the hit
    snd(o.sounds.boom, start0 + 0.38); // as the title lands
    snd(o.sounds.sting, start0); // builds for 0.38 s, then hits as the title lands
  }
  // Starburst behind the picture for every round.
  if (o.burst && rounds.length && o.kind !== 'shiny') {
    const b = createShapeClip(burstStyle(q, W * 0.98), roundsStart, len * rounds.length);
    b.transform = { ...b.transform, y: -0.02 };
    b.motion = motion({ in: intro ? 'fade' : 'zoom', duration: intro ? FADE : 0.35 });
    put(T.burst, b);
  }

  const shiny = o.kind === 'shiny';
  if (shiny) rounds.forEach((r, k) => {
    const s = roundsStart + k * len, thinkEnd = s + INTRO + o.thinkSeconds, H = p.settings.height;
    const L = shinyLayout(W, H), navy = '#1b2a57';
    const firstIn: Partial<ClipMotion> = intro ? { in: 'fade', duration: FADE } : { in: 'slam', duration: 0.7 };
    put(T.title, text(s, len, -0.37, 0, { ...titleStyle, fontSize: Math.round(W * 0.085) }, k === 0 ? firstIn : { in: 'pop', duration: 0.35 }));
    if (o.showRound) put(T.round, text(s + 0.15, len - 0.15, -0.298, 0, { content: `Round ${o.firstRound + k}`, fontFamily: 'Archivo Black', fontSize: Math.round(W * 0.036), color: '#ffffff', strokeColor: '#1f4fb8', strokeWidth: 5 }, { in: 'fade' }));
    // At the reveal the three wrong ones fade back so the real shiny stands out.
    const dim = (c: Clip, wrong: boolean) => { if (wrong) c.keyframes = { ...c.keyframes, opacity: [{ t: 0, v: 1, ease: 'hold' }, { t: thinkEnd - c.start, v: 1, ease: 'easeOut' }, { t: thinkEnd - c.start + 0.4, v: 0.3, ease: 'linear' }] }; return c; };
    (r.variants ?? []).slice(0, 4).forEach((m, i) => {
      const { x, y } = L.tiles[i], wrong = i !== r.correct, at = s + 0.25 + i * 0.1;
      const card = createShapeClip({ ...defaultShape('rect'), width: L.tile, height: L.tile, radius: L.tile * 0.1, fill: '#ffffff', fill2: '#dfeaff', stroke: navy, strokeWidth: 7, shadow: 10 }, at, s + len - at);
      card.name = `Card ${'ABCD'[i]}`;
      card.transform = { ...card.transform, x, y };
      card.motion = motion({ in: 'pop' });
      put(T.card + i, dim(card, wrong));
      const pic = createClipFromMedia(m, at + 0.08);
      pic.duration = s + len - pic.start;
      pic.fit = 'contain';
      pic.transform = { ...pic.transform, x, y, scale: pictureScale(q, m, L.tile * 0.8) };
      pic.motion = motion({ in: 'pop' });
      put(T.variant + i, dim(pic, wrong));
      // Letter badge on the card's top-left corner.
      const badge = text(at + 0.12, s + len - at - 0.12, y - (L.tile * 0.36) / H, x - (L.tile * 0.36) / W,
        { content: 'ABCD'[i], fontFamily: 'Archivo Black', fontSize: Math.round(L.tile * 0.13), color: navy, background: o.accent, backgroundBorder: navy, backgroundBorderWidth: 5, backgroundPadding: Math.round(L.tile * 0.035), backgroundRadius: Math.round(L.tile * 0.05), backgroundFull: true, boxWidth: (L.tile * 0.11) / W, align: 'center' }, { in: 'pop' });
      put(T.letter + i, dim(badge, wrong));
      // Answer buttons: plain A–D; the right one turns solid green with white text.
      const b = L.buttons[i], bs = s + 0.6 + i * 0.08;
      const base: Partial<TextStyle> = { content: 'ABCD'[i], fontFamily: 'Archivo Black', fontSize: Math.round(W * 0.055), color: navy, background: '#ffffff', backgroundBorder: navy, backgroundBorderWidth: 5, backgroundPadding: 20, backgroundRadius: 28, backgroundFull: true, boxWidth: L.btnWidth - BTN_EDGE, align: 'center' };
      const end = wrong ? s + len : thinkEnd + 0.2;
      put(T.answer + i, dim(text(bs, end - bs, b.y, b.x, base, { in: 'pop' }), wrong));
      if (!wrong) {
        put(T.right, text(thinkEnd, s + len - thinkEnd, b.y, b.x, { ...base, background: SHINY_GREEN, backgroundBorder: '#ffffff', color: '#ffffff' }, { in: 'pop', loop: 'pulse', speed: 0.8 }));
        const glow = createShapeClip({ ...defaultShape('rect'), width: L.tile, height: L.tile, radius: L.tile * 0.1, fill: 'transparent', stroke: SHINY_GREEN, strokeWidth: 16, glow: 34, glowColor: SHINY_GREEN }, thinkEnd, s + len - thinkEnd);
        glow.name = 'Shiny glow';
        glow.transform = { ...glow.transform, x, y };
        glow.motion = motion({ in: 'pop', loop: 'pulse', speed: 0.8 });
        put(T.glow, glow);
        const sp = createShapeClip({ ...defaultShape('sparkles'), width: L.tile * 1.3, height: L.tile * 1.3 }, thinkEnd, s + len - thinkEnd);
        sp.name = 'Shiny sparkles';
        sp.transform = { ...sp.transform, x, y };
        sp.motion = motion({ in: 'fade', duration: 0.2 });
        put(T.sparkles, sp);
      }
    });
    if (o.countdown !== 'none') {
      const cd = createShapeClip(o.countdown === 'bar'
        ? { ...defaultShape('countdown'), countStyle: 'bar', width: W * 0.74, height: 36, radius: 18, fill: 'rgba(0,0,0,0.35)', stroke: o.accent }
        : { ...defaultShape('countdown'), width: W * 0.16, height: W * 0.16, stroke: o.accent }, s + INTRO, o.thinkSeconds);
      cd.transform = { ...cd.transform, y: o.countdown === 'bar' ? 0.385 : 0.4 };
      cd.motion = motion({ in: 'fade', out: 'fade', duration: 0.2 });
      put(T.countdown, cd);
    }
    snd(o.sounds.whoosh, s, swoosh);
    for (let i = 0; i < Math.floor(o.thinkSeconds); i++) snd(i % 2 && o.sounds.tock ? o.sounds.tock : o.sounds.tick, s + INTRO + i);
    snd(o.sounds.sparkle ?? o.sounds.ding, thinkEnd);
  });

  if (!shiny) rounds.forEach((r, k) => {
    const s = roundsStart + k * len;
    const thinkEnd = s + INTRO + o.thinkSeconds;
    // Titles
    const firstIn: Partial<ClipMotion> = intro ? { in: 'fade', duration: FADE } : { in: 'slam', duration: 0.7 };
    put(T.title, text(s, len, -0.345, 0, titleStyle, k === 0 ? firstIn : { in: 'pop', duration: 0.35 }));
    if (o.showRound) put(T.round, text(s + 0.15, len - 0.15, -0.255, 0, { content: `Round ${o.firstRound + k}`, fontFamily: 'Archivo Black', fontSize: Math.round(W * 0.04), color: o.accent, strokeColor: '#1f4fb8', strokeWidth: 5 }, { in: 'fade' }));
    // Ring + picture
    const ring = createShapeClip({ ...defaultShape('ellipse'), width: W * 0.6, height: W * 0.6, fill: 'rgba(255,255,255,0.08)', stroke: '#ffffff', strokeWidth: 10, glow: 36, glowColor: '#9fdcff' }, s + 0.2, len - 0.2);
    ring.transform = { ...ring.transform, y: -0.02 };
    ring.motion = motion({ in: 'zoom', loop: 'pulse', speed: 0.5 });
    if (o.burst) ring.shape = { ...ring.shape!, fill: 'rgba(255,255,255,0.12)' };
    put(T.ring, ring);
    const pic = createClipFromMedia(r.picture, s + 0.35);
    pic.duration = len - 0.35;
    pic.fit = 'contain';
    pic.transform = { ...pic.transform, y: -0.02, scale: pictureScale(q, r.picture, W * 0.5) };
    pic.motion = motion({ in: 'pop' });
    const revealAt = thinkEnd - pic.start; // clip-local
    if (o.hide === 'zoom') zoomReveal(pic, q, r, r.zoom ?? o.zoom, revealAt);
    const hide = o.hide === 'zoom' ? null : hideEffect(o.hide);
    if (hide) {
      pic.effects = [hide.fx];
      pic.keyframes = { [`fx.${hide.fx.id}.${hide.param}`]: [
        { t: 0, v: hide.from, ease: 'hold' }, { t: revealAt, v: hide.from, ease: 'easeOut' }, { t: revealAt + 0.45, v: hide.to, ease: 'linear' },
      ] };
    }
    put(T.picture, pic);
    // Answers + the right one turning green at the reveal
    const n = Math.min(4, r.answers.length);
    const sz = fitAnswerScale(r.answers.slice(0, n).map((a, i) => `${LETTERS[i]} ${a}`), o.answerSize ?? 1, o.answerLayout ?? 'grid');
    const slots = answerSlots(n, sz, o.answerLayout ?? 'grid');
    for (let i = 0; i < n; i++) {
      const { x, y, boxWidth } = slots[i];
      const label = `{${o.accent}|${LETTERS[i]}} ${r.answers[i]}`;
      const base: Partial<TextStyle> = { content: label, fontFamily: 'Archivo Black', fontSize: Math.round(W * 0.04 * sz), color: '#1b2a57', background: '#ffffff', backgroundBorder: '#1b2a57', backgroundBorderWidth: Math.round(5 * sz), backgroundPadding: Math.round(22 * sz), backgroundRadius: Math.round(28 * sz), backgroundFull: true, boxWidth, align: 'center' };
      const start = s + 0.45 + i * 0.08;
      // The right answer's white button hides once the green one has popped over it,
      // so it never peeks out while the green one pulses.
      const end = i === r.correct ? thinkEnd + 0.2 : s + len;
      put(T.answer + i, text(start, end - start, y, x, base, { in: 'pop' }));
      if (i === r.correct) put(T.right, text(thinkEnd, s + len - thinkEnd, y, x, { ...base, background: '#3ddc84', content: `{#0b5d2e|${LETTERS[i]}} ${r.answers[i]}`, color: '#0b3d20' }, { in: 'pop', loop: 'pulse', speed: 0.8 }));
    }
    // Countdown while you think
    if (o.countdown !== 'none') {
      const cd = createShapeClip(o.countdown === 'bar'
        ? { ...defaultShape('countdown'), countStyle: 'bar', width: W * 0.74, height: 36, radius: 18, fill: 'rgba(0,0,0,0.35)', stroke: o.accent }
        : { ...defaultShape('countdown'), width: W * 0.2, height: W * 0.2, stroke: o.accent }, s + INTRO, o.thinkSeconds);
      cd.transform = { ...cd.transform, y: o.countdown === 'bar' ? 0.445 : 0.435 };
      cd.motion = motion({ in: 'fade', out: 'fade', duration: 0.2 });
      put(T.countdown, cd);
    }
    // Sounds
    snd(o.sounds.whoosh, s, swoosh);
    // Tick-tock (alternating) once a second while you think.
    for (let i = 0; i < Math.floor(o.thinkSeconds); i++) snd(i % 2 && o.sounds.tock ? o.sounds.tock : o.sounds.tick, s + INTRO + i);
    snd(o.sounds.ding, thinkEnd);
  });

  // Stack the quiz tracks above the main track (front-most last in the list → top).
  for (const t of tracks) if (t.clips.length) q = createTrackAbove(q, t);
  // Sound effects on their own audio track.
  for (const [name, list] of [['Quiz sounds', audio], ['Quiz whooshes', swoosh], ['Intro voice', voice]] as const) {
    if (!list.length) continue;
    const at = createTrack('audio', name);
    at.clips = list.slice().sort((a, b) => a.start - b.start);
    q = { ...q, tracks: [...q.tracks, at] };
  }
  return { project: q, start: start0, end: start0 + total };
}

/** Square crop (fractions of the picture) around `focus`, `zoom` times closer than the whole picture. */
export function zoomCrop(m: Pick<MediaItem, 'width' | 'height'>, focus: { x: number; y: number }, zoom: number): { left: number; top: number; right: number; bottom: number } {
  const mw = m.width ?? 1, mh = m.height ?? 1;
  const side = Math.min(mw, mh) / Math.max(1, zoom);
  const fw = side / mw, fh = side / mh;
  const left = Math.min(1 - fw, Math.max(0, focus.x - fw / 2));
  const top = Math.min(1 - fh, Math.max(0, focus.y - fh / 2));
  return { left, top, right: 1 - left - fw, bottom: 1 - top - fh };
}

const ZOOM_OUT = 0.6; // seconds for the reveal zoom-out

/**
 * "Zoom" hide: the question shows a close-up of one part of the picture in a
 * circle; at the reveal it zooms out to the whole picture with a quick blur.
 */
function zoomReveal(pic: Clip, p: Project, r: QuizRound, zoom: number, revealAt: number): void {
  const { width: W, height: H } = p.settings;
  const crop = zoomCrop(r.picture, r.focus ?? { x: 0.5, y: 0.5 }, zoom);
  const full = pic.transform.scale;
  const close = (W * 0.56) / Math.min(W, H); // a square crop fits the frame's short side; fill the ring
  const a = revealAt, b = revealAt + ZOOM_OUT;
  const ramp = (from: number, to: number) => [{ t: 0, v: from, ease: 'hold' as const }, { t: a, v: from, ease: 'easeInOut' as const }, { t: b, v: to, ease: 'linear' as const }];
  pic.transform = { ...pic.transform, scale: close, crop };
  pic.keyframes = {
    ...pic.keyframes,
    scale: ramp(close, full),
    'crop.left': ramp(crop.left, 0), 'crop.top': ramp(crop.top, 0), 'crop.right': ramp(crop.right, 0), 'crop.bottom': ramp(crop.bottom, 0),
  };
  // Round window while zoomed in; it grows past the corners as it zooms out.
  const mask = { ...createMask('ellipse'), name: 'Zoom window', w: 1, h: 1, feather: 3 };
  mask.keyframes = { w: ramp(1, 2.2), h: ramp(1, 2.2) };
  pic.masks = [mask];
  // A quick blur as it zooms out, like a camera pulling back.
  const blur = createEffect('blur', { radius: 0 });
  pic.effects = [...pic.effects, blur];
  pic.keyframes[`fx.${blur.id}.radius`] = [{ t: 0, v: 0, ease: 'hold' }, { t: a, v: 0, ease: 'easeOut' }, { t: a + ZOOM_OUT * 0.45, v: 16, ease: 'easeIn' }, { t: b, v: 0, ease: 'linear' }];
}

function hideEffect(h: HideMode): { fx: ReturnType<typeof createEffect>; param: string; from: number; to: number } | null {
  switch (h) {
    case 'silhouette': return { fx: createEffect('silhouette', { amount: 100, r: 16, g: 18, b: 40 }), param: 'amount', from: 100, to: 0 };
    case 'blur': return { fx: createEffect('blur', { radius: 40 }), param: 'radius', from: 40, to: 0 };
    case 'pixelate': return { fx: createEffect('pixelate', { size: 60 }), param: 'size', from: 60, to: 2 };
    default: return null;
  }
}

function darken(hex: string, k: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return '#' + [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(v * (1 - k)).toString(16).padStart(2, '0')).join('');
}

function lighten(hex: string, k: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (255 - v) * k));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}
