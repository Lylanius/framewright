import { describe, expect, it } from 'vitest';
import { createProject } from '../../src/core/defaults';
import {
  addEmoji, addSound, addToStrip, addWords, clipRange, copyInStrip, currentLook, editWords, extras, kidsLength, kidsProjectDefaults, KID_LOOKS, KID_SPEEDS,
  mainClips, moveExtraTo, moveInStrip, MUSIC_TRACK, removeExtra, removeFromStrip, setBackwards, setClipVolume, setJoins, setKidSpeed, setLook, setMotion, setMusic,
  setShowFor, splitInStrip, textStyleOf, trimInStrip,
} from '../../src/core/kids';
import { KID_TUNES, renderTune, tuneSeconds } from '../../src/core/kidsMusic';
import { parseProject, serializeProject } from '../../src/core/projectIO';
import { SFX } from '../../src/core/sfx';
import { projectDuration } from '../../src/core/timeline';
import type { MediaItem, Project } from '../../src/core/types';
import { media } from './helpers';

const photo = (id: string): MediaItem => ({ ...media(id, 0, 'image'), mimeType: 'image/jpeg' });

function start(): { p: Project; a: string; b: string; c: string } {
  let p = kidsProjectDefaults(createProject('Molly', { width: 1080, height: 1920, fps: 30, background: '#000', sampleRate: 48000 }));
  p = { ...p, media: [media('A', 10), photo('P'), media('B', 6), media('T', 16, 'audio'), media('S', 0.7, 'audio')] };
  const r = addToStrip(p, [p.media[0], p.media[1], p.media[2]]);
  return { p: r.project, a: r.ids[0], b: r.ids[1], c: r.ids[2] };
}

describe('Kids Studio', () => {
  it('adds photos and videos end to end; photos show for 3 s', () => {
    const { p, a, b, c } = start();
    expect(mainClips(p).map((x) => x.id)).toEqual([a, b, c]);
    expect(mainClips(p).map((x) => x.start)).toEqual([0, 10, 13]);
    expect(kidsLength(p)).toBe(19);
    expect(p.magnetic).toBe(true);
  });

  it('moves clips earlier/later and closes the gap when one is binned', () => {
    const { p, a, b, c } = start();
    const q = moveInStrip(p, c, -1);
    expect(mainClips(q).map((x) => x.id)).toEqual([a, c, b]);
    expect(mainClips(q).map((x) => x.start)).toEqual([0, 10, 16]);
    expect(moveInStrip(p, a, -1)).toBe(p); // already first
    const r = removeFromStrip(p, b);
    expect(mainClips(r).map((x) => [x.id, x.start])).toEqual([[a, 0], [c, 10]]);
  });

  it('makes a video shorter by keeping a part of it; a photo by how long it shows', () => {
    const { p, a, b, c } = start();
    const q = trimInStrip(p, a, 2, 6);
    const ca = mainClips(q)[0];
    expect(ca.sourceIn).toBe(2);
    expect(ca.duration).toBe(4);
    expect(clipRange(q, ca)).toEqual({ from: 2, to: 6, total: 10 });
    expect(mainClips(q).map((x) => x.start)).toEqual([0, 4, 7]); // the rest slide up
    const r = trimInStrip(q, b, 0, 6);
    expect(mainClips(r)[1].duration).toBe(6);
    // Never past the end of the video.
    const s = trimInStrip(p, c, 3, 99);
    expect(mainClips(s)[2].sourceIn).toBe(3);
    expect(mainClips(s)[2].duration).toBe(3);
  });

  it('speed and backwards', () => {
    const { p, a } = start();
    expect(KID_SPEEDS.map((s) => s.speed)).toEqual([0.5, 1, 2, 4]);
    const q = setKidSpeed(p, a, 2);
    expect(mainClips(q)[0].duration).toBe(5);
    expect(kidsLength(q)).toBe(14);
    const r = setKidSpeed(q, a, 0.5);
    expect(mainClips(r)[0].duration).toBe(20);
    expect(mainClips(r)[1].start).toBe(20);
    expect(mainClips(setBackwards(p, a, true))[0].reverse).toBe(true);
  });

  it('colour looks can be put on one clip or all, swapped, and removed', () => {
    const { p, a, b } = start();
    for (const look of KID_LOOKS) {
      const q = setLook(p, a, look.id);
      expect(currentLook(mainClips(q)[0]), look.id).toBe(look.id);
    }
    const all = setLook(p, null, 'bw');
    expect(mainClips(all).every((c) => currentLook(c) === 'bw')).toBe(true);
    // Rainbow keeps turning: its hue is animated over the clip.
    const rb = setLook(p, a, 'rainbow');
    const keys = Object.entries(mainClips(rb)[0].keyframes).find(([k]) => k.endsWith('.hue'))![1]!;
    expect(keys.map((k) => k.v)).toEqual([-180, 180]);
    // Swapping looks leaves no leftovers.
    const back = setLook(setLook(rb, a, 'old'), a, 'none');
    expect(mainClips(back)[0].effects).toEqual([]);
    expect(mainClips(back)[0].keyframes).toEqual({});
    expect(currentLook(mainClips(back)[1])).toBe('none');
    void b;
  });

  it('joins: a transition between every pair of clips (and none after the last)', () => {
    const { p } = start();
    const q = setJoins(p, 'dissolve');
    const cs = mainClips(q);
    expect(cs.slice(0, -1).every((c) => c.transitionOut?.type === 'dissolve')).toBe(true);
    expect(cs[cs.length - 1].transitionOut).toBeUndefined();
    // Still there after the order changes.
    const r = moveInStrip(q, cs[2].id, -1);
    expect(mainClips(r).slice(0, -1).every((c) => c.transitionOut?.type === 'dissolve')).toBe(true);
    expect(mainClips(setJoins(r, null)).every((c) => !c.transitionOut)).toBe(true);
  });

  it('stickers, words and sounds sit at a moment and never hang past the end', () => {
    const { p } = start();
    let q = addEmoji(p, '🦄', 4).project;
    q = addWords(q, 'My holiday!', 'bubbly', 18.5).project; // near the end: pulled back so it fits
    q = addSound(q, q.media.find((m) => m.id === 'S')!, 8).project;
    const ex = extras(q);
    expect(ex).toHaveLength(3);
    const words = ex.find((c) => c.kind === 'text')!;
    expect(words.start + words.duration).toBeCloseTo(19);
    expect(words.text!.content).toBe('My holiday!');
    expect(projectDuration(q)).toBeCloseTo(19); // nothing makes the video longer
    // Bin the last video: things on top get trimmed to the new end.
    const r = removeFromStrip(q, mainClips(q)[2].id);
    expect(kidsLength(r)).toBe(13);
    expect(projectDuration(r)).toBeCloseTo(13);
    expect(extras(r)).toHaveLength(3); // pulled back inside, not lost
    for (const c of extras(r)) expect(c.start + c.duration).toBeLessThanOrEqual(13 + 1e-6);
    for (const t of r.tracks) { const cs = [...t.clips].sort((x, y) => x.start - y.start); for (let i = 1; i < cs.length; i++) expect(cs[i].start).toBeGreaterThanOrEqual(cs[i - 1].start + cs[i - 1].duration - 1e-6); }
    // Show for the whole video, then remove.
    const emoji = extras(r).find((c) => c.shape?.emoji === '🦄')!;
    const s = setShowFor(r, emoji.id, 'all');
    const e2 = extras(s).find((c) => c.shape?.emoji === '🦄')!;
    expect([e2.start, e2.duration]).toEqual([0, 13]);
    expect(extras(removeExtra(s, e2.id)).some((c) => c.shape?.emoji === '🦄')).toBe(false);
    // Change the words and their look.
    const t = editWords(s, words.id, 'Best day ever', 'comic');
    const tc = extras(t).find((c) => c.id === words.id)!;
    expect(tc.text!.content).toBe('Best day ever');
    expect(textStyleOf(tc)).toBe('comic');
  });

  it('the tune covers the whole video, loops, fades out, and follows changes', () => {
    const { p } = start();
    const q = setMusic(p, 'T', 0.45);
    const music = q.tracks.find((t) => t.name === MUSIC_TRACK)!;
    expect(music.locked).toBe(true);
    expect(music.clips.map((c) => [c.start, c.duration])).toEqual([[0, 16], [16, 3]]);
    expect(music.clips.every((c) => c.volume === 0.45)).toBe(true);
    expect(music.clips[1].fadeOut).toBeGreaterThan(0);
    // Video gets shorter → tune follows.
    const r = removeFromStrip(q, mainClips(q)[0].id);
    expect(r.tracks.find((t) => t.name === MUSIC_TRACK)!.clips.map((c) => c.duration)).toEqual([9]);
    // Sounds never land on the tune's track.
    const s = addSound(r, r.media.find((m) => m.id === 'S')!, 1).project;
    expect(s.tracks.find((t) => t.name === MUSIC_TRACK)!.clips).toHaveLength(1);
    expect(setMusic(s, null).tracks.find((t) => t.name === MUSIC_TRACK)!.clips).toHaveLength(0);
  });

  it('original tunes: 8 bars, loop without a click, clean level', () => {
    for (const t of KID_TUNES) {
      for (const bar of t.melody) expect(bar.reduce((n, [, len]) => n + len, 0), `${t.id} bar`).toBe(8);
      expect(t.chords).toHaveLength(8);
      const s = renderTune(t.id, 8000);
      expect(s.length).toBe(Math.round(tuneSeconds(t.id) * 8000));
      let peak = 0, sum = 0;
      for (const v of s) { peak = Math.max(peak, Math.abs(v)); sum += v * v; }
      expect(peak, t.id).toBeCloseTo(0.8, 2);
      expect(Math.sqrt(sum / s.length), t.id).toBeGreaterThan(0.05); // not silent
      // Loop point: the jump from the last sample to the first is no bigger than ordinary sample-to-sample steps.
      let maxStep = 0;
      for (let i = 1; i < s.length; i++) maxStep = Math.max(maxStep, Math.abs(s[i] - s[i - 1]));
      expect(Math.abs(s[0] - s[s.length - 1]), t.id).toBeLessThanOrEqual(maxStep + 1e-6);
    }
  });

  it('split, copy and volume', () => {
    const { p, a } = start();
    expect(splitInStrip(p, a, 0.1)).toBeNull(); // too near the edge
    const r = splitInStrip(p, a, 4)!;
    expect(mainClips(r.project).map((c) => [c.start, c.duration])).toEqual([[0, 4], [4, 6], [10, 3], [13, 6]]);
    expect(mainClips(r.project)[1]).toMatchObject({ id: r.id, sourceIn: 4 });
    const withLook = setLook(r.project, r.id, 'rainbow');
    const c = copyInStrip(withLook, r.id)!;
    const cs = mainClips(c.project);
    expect(cs.map((x) => x.id).indexOf(c.id)).toBe(2); // straight after
    expect(kidsLength(c.project)).toBe(25);
    // The copy has its own effect, with the rainbow animation following it.
    const [orig, copy] = [cs[1], cs[2]];
    expect(copy.effects[0].id).not.toBe(orig.effects[0].id);
    expect(currentLook(copy)).toBe('rainbow');
    expect(Object.keys(copy.keyframes)[0]).toContain(copy.effects[0].id);
    const v = setClipVolume(c.project, a, 0);
    expect(mainClips(v)[0]).toMatchObject({ volume: 0, muted: true });
    expect(mainClips(setClipVolume(v, a, 1.6))[0]).toMatchObject({ volume: 1.6, muted: false });
  });

  it('things on top: start here, motion, text colour and animation', () => {
    const { p } = start();
    const s0 = addEmoji(p, '⭐', 1);
    const moved = moveExtraTo(s0.project, s0.id, 17.5); // pulled back so all 3 s fit
    expect(extras(moved).find((c) => c.shape?.emoji === '⭐')!.start).toBe(16);
    const m = setMotion(moved, s0.id, 'spin');
    expect(extras(m).find((c) => c.shape?.emoji === '⭐')!.motion!.loop).toBe('spin');
    const w = addWords(p, 'Hi', 'comic', 2, { colour: '#ff6fae', animIn: 'typewriter' });
    const t = extras(w.project).find((c) => c.kind === 'text')!;
    expect(t.text).toMatchObject({ color: '#ff6fae', animIn: 'typewriter', fontFamily: 'Bangers' });
    // Two-colour styles keep their own colours.
    const rb = addWords(p, 'Hi', 'rainbow', 2, { colour: '#ff6fae' });
    expect(extras(rb.project)[0].text!.gradient).toBeTruthy();
    // Editing keeps the animation unless it's changed.
    const e = editWords(w.project, w.id, 'Hello', 'bubbly');
    expect(extras(e).find((c) => c.kind === 'text')!.text).toMatchObject({ content: 'Hello', animIn: 'typewriter', fontFamily: 'Fredoka' });
  });

  it('Kids Studio settings survive saving and reopening', () => {
    const { p } = start();
    const q = setJoins(setMusic(p, 'T', 0.7), 'spin');
    const back = parseProject(serializeProject(q));
    expect(back.kids).toEqual({ joins: 'spin', music: { mediaId: 'T', volume: 0.7 } });
    expect(back.magnetic).toBe(true);
    expect(parseProject(serializeProject({ ...q, kids: undefined })).kids).toBeUndefined();
  });

  it('has the fun sounds', () => {
    for (const id of ['pop', 'boing', 'whee', 'tada', 'whoosh', 'sparkle', 'boom', 'buzzer']) expect(SFX.some((s) => s.id === id), id).toBe(true);
  });
});
