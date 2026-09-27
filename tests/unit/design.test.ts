import { describe, expect, it } from 'vitest';
import { createShapeClip, createTextClip, defaultShape } from '../../src/core/defaults';
import { motionState } from '../../src/core/motion';
import { parseProject, serializeProject } from '../../src/core/projectIO';
import { answerScale, answerSlots, buildQuiz, fitAnswerScale, DEFAULT_QUIZ, introLength, pictureScale, quizLength, roundLength, zoomCrop } from '../../src/core/quiz';
import { valueAt } from '../../src/core/keyframes';
import { maskValue } from '../../src/core/masks';
import { SFX, wavBytes } from '../../src/core/sfx';
import { tidyVoice, toMono } from '../../src/core/voiceTrim';
import { alignBox, distribute, snapBox } from '../../src/core/snap';
import { addOverlayClip, addUnderlayClip, findClip, mainTrackIndex, moveClipLayer, projectDuration } from '../../src/core/timeline';
import type { MediaItem } from '../../src/core/types';
import { parseColourRuns } from '../../src/engine/textRender';
import { media, sampleProject } from './helpers';

describe('text colour runs', () => {
  it('parses {colour|text} markup', () => {
    const r = parseColourRuns('{#ffcc00|A)} Charmander');
    expect(r.plain).toBe('A) Charmander');
    expect(r.colours!.slice(0, 3)).toEqual(['#ffcc00', '#ffcc00', null]);
    expect(parseColourRuns('plain text').colours).toBeNull();
    expect(parseColourRuns('{red|hi} and {#00ff00|bye}').plain).toBe('hi and bye');
  });
});

describe('smart guides', () => {
  it('snaps edges and centres to the frame and other layers', () => {
    const r = snapBox({ cx: 537, cy: 300, w: 100, h: 50 }, [], 1080, 1920, 8);
    expect(r.dx).toBe(3);
    expect(r.guidesX).toEqual([540]);
    const r2 = snapBox({ cx: 245, cy: 903, w: 100, h: 100 }, [{ cx: 400, cy: 900, w: 200, h: 100 }], 1080, 1920, 8);
    expect(r2.dx).toBe(5); // right edge 295 → the other layer's left edge 300
    expect(r2.guidesX).toEqual([300]);
    expect(r2.dy).toBe(-3); // centres line up
    expect(r2.guidesY).toContain(900);
    const far = snapBox({ cx: 100, cy: 100, w: 10, h: 10 }, [], 1080, 1920, 4);
    expect(far).toMatchObject({ dx: 0, dy: 0, guidesX: [], guidesY: [] });
  });
  it('aligns and distributes', () => {
    expect(alignBox({ cx: 500, cy: 500, w: 200, h: 100 }, { left: 0, top: 0, right: 1080, bottom: 1920 }, 'left')).toEqual({ cx: 100, cy: 500 });
    expect(alignBox({ cx: 500, cy: 500, w: 200, h: 100 }, { left: 0, top: 0, right: 1080, bottom: 1920 }, 'bottom')).toEqual({ cx: 500, cy: 1870 });
    const c = distribute([{ cx: 100, cy: 0, w: 100, h: 10 }, { cx: 700, cy: 0, w: 100, h: 10 }, { cx: 200, cy: 0, w: 100, h: 10 }], 'x');
    expect(c).toEqual([100, 700, 400]);
  });
});

describe('layers', () => {
  it('backgrounds go under everything and never become the main track', () => {
    const { p } = sampleProject();
    const mi = mainTrackIndex(p);
    const q = addUnderlayClip(p, createShapeClip(defaultShape('speedlines'), 0, 10));
    expect(mainTrackIndex(q)).toBe(mi);
    const bgIndex = q.tracks.findIndex((t) => t.role === 'background');
    expect(bgIndex).toBeGreaterThan(mi);
    // Survives save/load.
    expect(parseProject(serializeProject(q)).tracks[bgIndex].role).toBe('background');
  });
  it('brings forward and sends back', () => {
    const { p } = sampleProject();
    const a = createShapeClip(defaultShape('star'), 0, 3);
    const b = createShapeClip(defaultShape('heart'), 1, 3);
    let q = addOverlayClip(addOverlayClip(p, a), b); // b lands on a new top track
    const ia = () => findClip(q, a.id)!.trackIndex, ib = () => findClip(q, b.id)!.trackIndex;
    expect(ib()).toBeLessThan(ia());
    q = moveClipLayer(q, a.id, 'front')!;
    expect(ia()).toBeLessThan(ib());
    q = moveClipLayer(q, a.id, 'down')!;
    expect(ia()).toBeGreaterThan(ib());
    expect(moveClipLayer(q, a.id, 'down')).toBeNull(); // already just above the main footage
    expect(mainTrackIndex(q)).toBe(q.tracks.findIndex((t) => t.clips.some((c) => c.mediaId === 'A')));
  });
});

describe('design elements', () => {
  it('slam starts huge and settles', () => {
    const m = { in: 'slam' as const, out: 'none' as const, loop: 'none' as const, duration: 0.6, speed: 1 };
    expect(motionState(m, 0.01, 5).scale).toBeGreaterThan(3);
    expect(motionState(m, 1, 5).scale).toBeCloseTo(1);
  });
  it('the intro sting builds up, then hits as the title lands; a recorded shout comes on the hit', () => {
    const s = SFX.find((d) => d.id === 'sting')!.make(48000);
    const rms = (a: number, b: number) => { let t = 0; for (let i = a * 48000; i < b * 48000; i++) t += s[i] ** 2; return Math.sqrt(t / ((b - a) * 48000)); };
    expect(rms(0.4, 0.6)).toBeGreaterThan(rms(0.1, 0.3) * 1.5); // quieter swell, big hit
    expect(rms(0.4, 0.6)).toBeGreaterThan(rms(1.6, 1.95) * 4); // dies away
  });
  it('a voice recording is trimmed to the words and levelled', () => {
    const rate = 8000, sig = new Float32Array(rate * 3);
    for (let i = 0; i < sig.length; i++) sig[i] = (Math.random() - 0.5) * 0.004; // room hiss
    for (let i = rate; i < rate * 1.5; i++) sig[i] = 0.3 * Math.sin(i / 3); // "who's that…" from 1.0 s to 1.5 s
    const out = tidyVoice(sig, rate);
    expect(out.length / rate).toBeGreaterThan(0.5);
    expect(out.length / rate).toBeLessThan(0.8); // 0.5 s of words + a short breath either side
    let peak = 0; for (const v of out) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeCloseTo(0.9, 1);
    expect(Math.abs(out[0])).toBeLessThan(0.01);
    expect(tidyVoice(new Float32Array(100), rate).length).toBe(0);
    expect(Array.from(toMono([new Float32Array([1, 0]), new Float32Array([0, 1])]))).toEqual([0.5, 0.5]);
  });
  it('sound effects are clean, normalised WAVs', () => {
    for (const d of SFX) {
      const s = d.make(48000);
      expect(s.length).toBe(Math.round(d.seconds * 48000));
      let peak = 0; for (const v of s) peak = Math.max(peak, Math.abs(v));
      expect(peak, d.id).toBeGreaterThan(0.3);
      expect(peak, d.id).toBeLessThanOrEqual(0.81);
      // Starts and ends silent (no clicks).
      expect(Math.abs(s[0]), d.id).toBeLessThan(0.01);
      expect(Math.abs(s[s.length - 1]), d.id).toBeLessThan(0.01);
      expect(Number.isFinite(s.reduce((a, v) => a + v, 0))).toBe(true);
    }
    const w = wavBytes(new Float32Array([0, 0.5, -0.5]), 48000);
    expect(String.fromCharCode(...w.slice(0, 4))).toBe('RIFF');
    expect(w.length).toBe(44 + 6);
  });
});

describe('quiz maker', () => {
  const pic = (id: string): MediaItem => ({ ...media(id, 0, 'image'), width: 800, height: 800 });
  it('builds rounds with a hidden picture, answers, a green right answer and sounds', () => {
    const { p } = sampleProject();
    const before = projectDuration(p);
    const tick = media('tick', 0.12, 'audio'), tock = media('tock', 0.12, 'audio'), ding = media('ding', 1.6, 'audio'), whoosh = media('wh', 0.7, 'audio');
    const q0 = { ...p, media: [...p.media, pic('P1'), pic('P2'), tick, tock, ding, whoosh] };
    const r = buildQuiz(q0, [
      { picture: pic('P1'), answers: ['Aa', 'Bb', 'Cc', 'Dd'], correct: 3 },
      { picture: pic('P2'), answers: ['Yes', 'No'], correct: 0 },
    ], { ...DEFAULT_QUIZ, intro: false, hide: 'silhouette', background: 'speedlines', sounds: { tick, tock, ding, whoosh } });
    const len = roundLength(DEFAULT_QUIZ);
    expect(r.start).toBeCloseTo(before);
    expect(r.end - r.start).toBeCloseTo(len * 2);
    const all = r.project.tracks.flatMap((t) => t.clips);
    // Picture hidden until the reveal, then shown.
    const p1 = all.find((c) => c.mediaId === 'P1')!;
    const fx = p1.effects.find((e) => e.type === 'silhouette')!;
    const keys = p1.keyframes[`fx.${fx.id}.amount`]!;
    expect(keys[0].v).toBe(100);
    expect(keys[keys.length - 1].v).toBe(0);
    expect(p1.start + keys[1].t).toBeCloseTo(before + 1 + DEFAULT_QUIZ.thinkSeconds);
    // Answers: 4 + 2 buttons, plus 2 green ones.
    const answers = all.filter((c) => c.text?.backgroundFull);
    expect(answers).toHaveLength(8);
    const green = answers.filter((c) => c.text!.background === '#3ddc84');
    expect(green).toHaveLength(2);
    expect(green[0].text!.content).toContain('D)');
    expect(green[0].text!.content).toContain('Dd');
    // Sounds: one whoosh + ticks + one ding per round, no overlaps on a track.
    const ticks = all.filter((c) => c.mediaId === 'tick' || c.mediaId === 'tock');
    expect(ticks).toHaveLength(Math.floor(DEFAULT_QUIZ.thinkSeconds) * 2);
    expect(all.filter((c) => c.mediaId === 'tock').length).toBe(Math.floor(Math.floor(DEFAULT_QUIZ.thinkSeconds) / 2) * 2);
    for (const t of r.project.tracks) {
      const cs = t.clips.slice().sort((a, b) => a.start - b.start);
      for (let i = 1; i < cs.length; i++) expect(cs[i].start, t.name).toBeGreaterThanOrEqual(cs[i - 1].start + cs[i - 1].duration - 1e-6);
    }
    // Background under everything; main track unchanged.
    expect(r.project.tracks.some((t) => t.role === 'background' && t.clips.some((c) => c.shape?.type === 'speedlines'))).toBe(true);
    expect(mainTrackIndex(r.project)).toBe(r.project.tracks.findIndex((t) => t.clips.some((c) => c.mediaId === 'A')));
    expect(pictureScale(q0, pic('P1'), 540)).toBeCloseTo(0.5);
    void createTextClip;
  });
  it('with the sting, it starts with the intro and a recorded shout comes on the hit', () => {
    const { p } = sampleProject();
    const before = projectDuration(p);
    const sting = media('sting', 2, 'audio'), voice = media('voice', 2, 'audio');
    const r = buildQuiz({ ...p, media: [...p.media, pic('P1'), sting, voice] }, [{ picture: pic('P1'), answers: ['Aa', 'Bb'], correct: 0 }], { ...DEFAULT_QUIZ, sounds: { sting, introVoice: voice } });
    const all = r.project.tracks.flatMap((t) => t.clips);
    expect(all.find((c) => c.mediaId === 'sting')!.start).toBeCloseTo(before);
    expect(all.find((c) => c.mediaId === 'voice')!.start).toBeCloseTo(before + 0.4);
    expect(DEFAULT_QUIZ.introSound).toBe('sting');
  });
  it('adds an intro that slams the title in, then crossfades into round 1', () => {
    const { p } = sampleProject();
    const before = projectDuration(p);
    const boom = media('boom', 1.2, 'audio'), voice = media('voice', 2, 'audio');
    const r = buildQuiz({ ...p, media: [...p.media, pic('P1'), boom, voice] }, [
      { picture: pic('P1'), answers: ['Aa', 'Bb'], correct: 1 },
    ], { ...DEFAULT_QUIZ, sounds: { boom, introVoice: voice } });
    const intro = introLength(DEFAULT_QUIZ);
    expect(intro).toBe(2.5);
    expect(r.end - r.start).toBeCloseTo(quizLength(DEFAULT_QUIZ, 1));
    expect(quizLength(DEFAULT_QUIZ, 1)).toBeCloseTo(intro + roundLength(DEFAULT_QUIZ));
    const all = r.project.tracks.flatMap((t) => t.clips);
    // Intro title: centred, slams in, fades out over the start of round 1.
    const titles = all.filter((c) => c.text?.content === DEFAULT_QUIZ.title);
    const introTitle = titles.find((c) => c.start === before)!;
    expect(introTitle.transform.y).toBe(0);
    expect(introTitle.motion).toMatchObject({ in: 'slam', out: 'fade' });
    const roundTitle = titles.find((c) => c.start > before)!;
    expect(roundTitle.start).toBeCloseTo(before + intro);
    expect(introTitle.start + introTitle.duration).toBeGreaterThan(roundTitle.start); // overlap = crossfade
    expect(roundTitle.motion?.in).toBe('fade');
    // Starbursts: one for the intro, one behind the picture for the rounds.
    expect(all.filter((c) => c.shape?.type === 'starburst')).toHaveLength(2);
    // Round starts after the intro (picture pops in 0.35 s into the round).
    expect(all.find((c) => c.mediaId === 'P1')!.start).toBeCloseTo(before + intro + 0.35);
    // Boom as the title lands, voice at the start.
    expect(all.find((c) => c.mediaId === 'boom')!.start).toBeCloseTo(before + 0.38);
    expect(all.find((c) => c.mediaId === 'voice')!.start).toBeCloseTo(before + 0.1);
    // Streaks background covers intro + rounds.
    const bg = all.find((c) => c.shape?.type === 'streaks')!;
    expect(bg.start).toBeCloseTo(before);
    expect(bg.duration).toBeCloseTo(r.end - r.start);
    for (const t of r.project.tracks) {
      const cs = t.clips.slice().sort((a, b) => a.start - b.start);
      for (let i = 1; i < cs.length; i++) expect(cs[i].start, t.name).toBeGreaterThanOrEqual(cs[i - 1].start + cs[i - 1].duration - 1e-6);
    }
  });
  it('zoomed-in question: close-up of the chosen spot, then zooms out to the whole picture', () => {
    // Square crop around the focus, clamped inside the picture.
    const c = zoomCrop({ width: 1000, height: 500 }, { x: 0.9, y: 0.1 }, 4);
    expect(1 - c.left - c.right).toBeCloseTo(0.125); // 125 px of 1000
    expect(1 - c.top - c.bottom).toBeCloseTo(0.25);  // 125 px of 500
    expect(c.left + 0.125).toBeLessThanOrEqual(1 + 1e-9);
    expect(c.top).toBe(0);
    const { p } = sampleProject();
    const before = projectDuration(p);
    const r = buildQuiz({ ...p, media: [...p.media, pic('P1')] }, [
      { picture: pic('P1'), answers: ['Aa', 'Bb'], correct: 0, focus: { x: 0.8, y: 0.3 } },
    ], { ...DEFAULT_QUIZ, intro: false, sounds: {} });
    expect(DEFAULT_QUIZ.hide).toBe('zoom');
    const clip = r.project.tracks.flatMap((t) => t.clips).find((x) => x.mediaId === 'P1')!;
    const reveal = before + 1 + DEFAULT_QUIZ.thinkSeconds - clip.start; // clip-local
    const side = 1 / DEFAULT_QUIZ.zoom;
    // While thinking: cropped in on the spot, in a round window, no blur.
    const mid = reveal / 2;
    expect(valueAt(clip, 'crop.left', mid)).toBeCloseTo(0.8 - side / 2);
    expect(valueAt(clip, 'crop.top', mid)).toBeCloseTo(0.3 - side / 2);
    expect(1 - valueAt(clip, 'crop.left', mid) - valueAt(clip, 'crop.right', mid)).toBeCloseTo(side);
    expect(clip.masks?.[0].type).toBe('ellipse');
    expect(maskValue(clip.masks![0], 'w', mid)).toBeCloseTo(1);
    const blur = clip.effects.find((e) => e.type === 'blur')!;
    expect(valueAt(clip, `fx.${blur.id}.radius`, mid)).toBe(0);
    expect(valueAt(clip, `fx.${blur.id}.radius`, reveal + 0.27)).toBeGreaterThan(10); // blur mid zoom-out
    // After the reveal: whole picture at its normal size, window opened past the corners, blur gone.
    const after = reveal + 1;
    for (const e of ['left', 'top', 'right', 'bottom']) expect(valueAt(clip, `crop.${e}`, after)).toBeCloseTo(0);
    expect(valueAt(clip, 'scale', after)).toBeCloseTo(pictureScale(r.project, pic('P1'), 1080 * 0.5));
    expect(maskValue(clip.masks![0], 'w', after)).toBeGreaterThan(2);
    expect(valueAt(clip, `fx.${blur.id}.radius`, after)).toBe(0);
  });
  it('each round can have its own zoom', () => {
    const { p } = sampleProject();
    const r = buildQuiz({ ...p, media: [...p.media, pic('P1'), pic('P2')] }, [
      { picture: pic('P1'), answers: ['Aa', 'Bb'], correct: 0, focus: { x: 0.5, y: 0.5 }, zoom: 6 },
      { picture: pic('P2'), answers: ['Aa', 'Bb'], correct: 0, focus: { x: 0.5, y: 0.5 } },
    ], { ...DEFAULT_QUIZ, intro: false, zoom: 2, sounds: {} });
    const all = r.project.tracks.flatMap((t) => t.clips);
    const w = (id: string) => { const c = all.find((x) => x.mediaId === id)!.transform.crop; return 1 - c.left - c.right; };
    expect(w('P1')).toBeCloseTo(1 / 6);
    expect(w('P2')).toBeCloseTo(1 / 2); // falls back to the quiz-wide zoom
  });
  it('the right answer\'s white button is gone once the green one has popped over it', () => {
    const { p } = sampleProject();
    const before = projectDuration(p);
    const r = buildQuiz({ ...p, media: [...p.media, pic('P1')] }, [{ picture: pic('P1'), answers: ['Aa', 'Bb', 'Cc', 'Dd'], correct: 2 }], { ...DEFAULT_QUIZ, intro: false, sounds: {} });
    const all = r.project.tracks.flatMap((t) => t.clips);
    const reveal = before + 1 + DEFAULT_QUIZ.thinkSeconds;
    const white = all.filter((c) => c.text?.backgroundFull && c.text.background === '#ffffff');
    const green = all.find((c) => c.text?.background === '#3ddc84')!;
    const rightWhite = white.find((c) => c.text!.content.includes('Cc'))!;
    expect(rightWhite.start + rightWhite.duration).toBeCloseTo(reveal + 0.2);
    expect(green.start).toBeCloseTo(reveal);
    // The other answers stay to the end of the round.
    for (const c of white.filter((x) => x !== rightWhite)) expect(c.start + c.duration).toBeCloseTo(r.end);
  });
  it('answer size and layout: bigger buttons stay inside the frame, between the picture and the countdown', () => {
    for (const layout of ['grid', 'list'] as const) {
      for (const size of [0.7, 1, 1.3, 1.6]) {
        const slots = answerSlots(4, size, layout);
        const h = 0.05 * answerScale(4, size, layout);
        for (const sl of slots) {
          const outer = sl.boxWidth + 0.05 * answerScale(4, size, layout);
          expect(Math.abs(sl.x) + outer / 2, `${layout} ${size}`).toBeLessThanOrEqual(0.49);
          expect(sl.y - h / 2, `${layout} ${size} top`).toBeGreaterThan(0.15); // below the picture ring
          expect(sl.y + h / 2, `${layout} ${size} bottom`).toBeLessThan(0.44); // above the countdown bar
        }
        // Buttons don't overlap each other.
        for (let i = 0; i < slots.length; i++) for (let j = i + 1; j < slots.length; j++) {
          const a = slots[i], b = slots[j];
          const apartX = Math.abs(a.x - b.x) >= (a.boxWidth + b.boxWidth) / 2 + 0.05 * answerScale(4, size, layout) + 0.02 - 1e-9;
          const apartY = Math.abs(a.y - b.y) >= h * 0.95;
          expect(apartX || apartY, `${layout} ${size} ${i}/${j}`).toBe(true);
        }
      }
    }
    // Normal size keeps the familiar layout.
    expect(answerSlots(4, 1, 'grid')[0].x).toBeCloseTo(-0.235);
    expect(answerSlots(4, 1, 'grid')[0].boxWidth).toBeCloseTo(0.36);
    // Long answers get a little smaller so they stay on one line; short ones keep the chosen size.
    expect(fitAnswerScale(['A) Sparkit', 'B) Moltor'], 1.5, 'grid')).toBe(1.5);
    expect(fitAnswerScale(['A) Supercalifragilistic', 'B) Moltor'], 1.5, 'grid')).toBeLessThan(1.5);
    // Bigger text really is bigger.
    const { p } = sampleProject();
    const big = buildQuiz({ ...p, media: [...p.media, pic('P1')] }, [{ picture: pic('P1'), answers: ['Aa', 'Bb'], correct: 0 }], { ...DEFAULT_QUIZ, intro: false, answerSize: 1.5, sounds: {} });
    const btn = big.project.tracks.flatMap((t) => t.clips).find((c) => c.text?.backgroundFull)!;
    expect(btn.text!.fontSize).toBe(Math.round(1080 * 0.04 * 1.5));
  });
});
