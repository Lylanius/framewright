/**
 * Framewright's own starter templates (original designs). Each builds a
 * TemplateDoc in code: slots for your footage plus text, shapes, motion,
 * effects and transitions.
 */
import { createShapeClip, createSolidClip, createTextClip, defaultShape } from './defaults';
import { createEffect } from './effects';
import { createSlotClip, track, type TemplateDoc } from './templates';
import { createTransition } from './transitions';
import type { Clip, ClipMotion, ProjectSettings, TextStyle } from './types';

const V: ProjectSettings = { width: 1080, height: 1920, fps: 30, background: '#000000', sampleRate: 48000 };
const H: ProjectSettings = { width: 1920, height: 1080, fps: 30, background: '#000000', sampleRate: 48000 };
const SQ: ProjectSettings = { width: 1080, height: 1080, fps: 30, background: '#000000', sampleRate: 48000 };

function text(start: number, dur: number, content: string, y: number, style: Partial<TextStyle> = {}): Clip {
  const c = createTextClip(start, { content, ...style }, dur);
  c.transform = { ...c.transform, y };
  return c;
}
const motion = (m: Partial<ClipMotion>): ClipMotion => ({ in: 'pop', out: 'fade', loop: 'none', duration: 0.35, speed: 1, ...m });

/** Slots laid end to end, with a transition on each cut. */
function run(labels: string[], durs: number[], transition?: string, tDur = 0.4, from = 0): Clip[] {
  let t = from;
  return labels.map((label, i) => {
    const c = createSlotClip(i, label, t, durs[i]);
    t += durs[i];
    if (transition && i < labels.length - 1) c.transitionOut = createTransition(transition, tDur);
    return c;
  });
}
const kenBurns = (c: Clip, from = 1, to = 1.12): Clip => ({ ...c, keyframes: { ...c.keyframes, scale: [{ t: 0, v: from, ease: 'linear' }, { t: c.duration, v: to, ease: 'linear' }] } });

const HOOK: Partial<TextStyle> = { fontFamily: 'Archivo Black', fontSize: 104, uppercase: true, strokeColor: '#111111', strokeWidth: 8, shadowBlur: 0, animIn: 'pop' };
const LABEL: Partial<TextStyle> = { fontFamily: 'Figtree', fontWeight: 800, fontSize: 60, color: '#111111', background: '#ffffff', backgroundRadius: 14, shadowBlur: 0, shadowOffsetY: 0, animIn: 'slideUp', animOut: 'fade' };

function doc(id: string, name: string, category: string, description: string, settings: ProjectSettings, tracks: TemplateDoc['tracks']): TemplateDoc {
  return { id: `builtin-${id}`, name, category, description, builtIn: true, createdAt: 0, settings, tracks, media: [] };
}

export function builtinTemplates(): TemplateDoc[] {
  // 1. Pack opening reveal
  const pack = run(['Sealed pack', 'Opening it', 'The big pull'], [3, 4, 5], 'whip', 0.35);
  pack[2] = { ...kenBurns(pack[2], 1, 1.25), effects: [createEffect('pulse', { amount: 5, bpm: 100 })] };
  const burst = createShapeClip({ ...defaultShape('burst'), width: 380, height: 380 }, 7.2, 4.8);
  burst.transform = { ...burst.transform, x: 0.26, y: -0.3 };
  burst.motion = motion({ in: 'spin', loop: 'pulse' });
  const packT = track('visual', 'Titles', [
    text(0, 3, 'WHAT WILL I PULL?', -0.3, HOOK),
    text(7.2, 4.8, 'NO WAY!!', -0.3, { ...HOOK, color: '#ffd23f', fontSize: 130 }),
    text(10, 2, 'Follow for part 2 ➜', 0.34, LABEL),
  ]);

  // 2. Gaming highlight (blurred-background vertical layout)
  const gFront = { ...createSlotClip(0, 'Gameplay clip', 0, 10), fit: 'contain' as const };
  const gBack = { ...createSlotClip(0, 'Gameplay clip', 0, 10), fit: 'cover' as const, effects: [createEffect('blur', { radius: 28 }), createEffect('adjust', { exposure: -25 })], muted: true };
  const gTitle = track('visual', 'Titles', [
    text(0, 10, 'INSANE CLUTCH', -0.33, { ...HOOK, fontFamily: 'Bangers', fontSize: 140, color: '#ffd23f', letterSpacing: 3 }),
    text(0.5, 9.5, 'wait for the end…', 0.33, { ...LABEL, background: 'rgba(0,0,0,0.6)', color: '#ffffff' }),
  ]);

  // 3. Before & after
  const ba = run(['Before', 'After'], [3.5, 4.5], 'wipe', 0.8);
  const baT = track('visual', 'Labels', [
    text(0.2, 3.1, 'BEFORE', -0.36, { ...LABEL, background: '#6b7280', color: '#ffffff' }),
    text(3.9, 4.1, 'AFTER', -0.36, { ...LABEL, background: '#22a06b', color: '#ffffff' }),
    text(5.2, 2.8, 'Swipe for the details', 0.36, LABEL),
  ]);

  // 4. Room / kitchen reveal
  const room = run(['Wide shot', 'Detail 1', 'Detail 2', 'Detail 3', 'Final wide'], [3, 2, 2, 2, 3.5], 'push', 0.4);
  room[0] = kenBurns(room[0]); room[4] = kenBurns(room[4], 1.15, 1);
  const cta = createSolidClip('#0f1115', 12.5, 3);
  const roomT = track('visual', 'Titles', [
    text(0, 3, 'The reveal', -0.3, { fontFamily: 'DM Serif Display', italic: true, fontSize: 130, animIn: 'fade', shadowBlur: 20 }),
    text(3, 2, 'The finish', 0.33, LABEL), text(5, 2, 'The details', 0.33, LABEL), text(7, 2, 'The storage', 0.33, LABEL),
    text(12.7, 2.8, 'Book your free\ndesign appointment', 0, { fontFamily: 'Figtree', fontWeight: 800, fontSize: 84, animIn: 'slideUp' }),
  ]);
  const roomMain = [...room, cta];

  // 5. Top 3 countdown
  const top = run(['Number 3', 'Number 2', 'Number 1'], [3, 3, 4], 'dip', 0.5, 1.5);
  const topIntro = createSolidClip('#111318', 0, 1.5);
  const topT = track('visual', 'Numbers', [
    text(0, 1.5, 'TOP 3', 0, { ...HOOK, fontSize: 170, gradient: { from: '#ffe066', to: '#ff5f6d' } }),
    text(1.5, 3, '#3', -0.34, { ...HOOK, fontSize: 150 }),
    text(4.5, 3, '#2', -0.34, { ...HOOK, fontSize: 150 }),
    text(7.5, 4, '#1', -0.34, { ...HOOK, fontSize: 170, color: '#ffd23f' }),
  ]);

  // 6. Fast montage
  const montage = run(Array.from({ length: 8 }, (_, i) => `Shot ${i + 1}`), Array(8).fill(0.8), 'flash', 0.2);
  montage.forEach((c, i) => { if (i % 2) montage[i] = { ...c, effects: [createEffect('pulse', { amount: 6, bpm: 150 })] }; });
  const montT = track('visual', 'Title', [text(0, 1.6, 'THIS WEEKEND', 0, { ...HOOK, fontSize: 130, animIn: 'pop' })]);

  // 7. YouTube-style intro (16:9)
  const yt = run(['Hook moment', 'Main video'], [5, 8], 'zoomIn', 0.5);
  yt.splice(1, 0, { ...createSolidClip('#0f1115', 5, 2.5) });
  yt[2] = { ...yt[2], start: 7.5 };
  const ytT = track('visual', 'Titles', [
    text(5, 2.5, 'YOUR CHANNEL', 0, { ...HOOK, fontSize: 150, fontFamily: 'Anton', letterSpacing: 6, uppercase: true }),
    text(0.3, 4.5, 'You won’t believe this…', 0.36, { ...LABEL, fontSize: 56 }),
  ]);
  const star = createShapeClip({ ...defaultShape('star'), width: 160, height: 160 }, 5, 2.5);
  star.transform = { ...star.transform, x: 0.3, y: -0.25 };
  star.motion = motion({ in: 'spin', loop: 'float' });

  // 8. Photo slideshow (square)
  const slides = run(Array.from({ length: 6 }, (_, i) => `Photo ${i + 1}`), Array(6).fill(2.5), 'dissolve', 0.6).map((c, i) => kenBurns(c, i % 2 ? 1.12 : 1, i % 2 ? 1 : 1.12));
  const slideT = track('visual', 'Title', [text(0, 2.5, 'Memories', 0.35, { fontFamily: 'Lobster', fontSize: 110, animIn: 'fade' })]);

  return [
    doc('pack', 'Pack opening reveal', 'Gaming & cards', 'Three shots building up to your best pull, with a spinning burst and hype titles.', V,
      [track('visual', 'Stickers', [burst]), packT, track('visual', 'Main', pack), track('audio', 'Music', [])]),
    doc('gaming', 'Gaming highlight', 'Gaming & cards', 'Landscape gameplay in a vertical frame over a blurred copy of itself, with a title and hook.', V,
      [gTitle, track('visual', 'Gameplay', [gFront]), track('visual', 'Background', [gBack]), track('audio', 'Music', [])]),
    doc('beforeafter', 'Before & after', 'Reveal', 'Two shots with a wipe between them and BEFORE / AFTER labels — makeovers, rooms, builds.', V,
      [baT, track('visual', 'Main', ba), track('audio', 'Music', [])]),
    doc('room', 'Room reveal', 'Reveal', 'A wide shot, three details and a final wide with gentle zooms, then a call-to-action card.', V,
      [roomT, track('visual', 'Main', roomMain), track('audio', 'Music', [])]),
    doc('top3', 'Top 3 countdown', 'Lists', 'A title card then #3, #2, #1 with big numbers and dip transitions.', V,
      [topT, track('visual', 'Main', [topIntro, ...top]), track('audio', 'Music', [])]),
    doc('montage', 'Fast montage', 'Lists', 'Eight quick shots with flash cuts and zoom pulses — great on a beat.', V,
      [montT, track('visual', 'Main', montage), track('audio', 'Music', [])]),
    doc('ytintro', 'YouTube intro', 'Long-form', 'A hook, a channel title card and your main video (16:9).', H,
      [track('visual', 'Stickers', [star]), ytT, track('visual', 'Main', yt), track('audio', 'Music', [])]),
    doc('slideshow', 'Photo slideshow', 'Photos', 'Six photos with slow zooms and soft dissolves (square).', SQ,
      [slideT, track('visual', 'Main', slides), track('audio', 'Music', [])]),
  ];
}
