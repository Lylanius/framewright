import { describe, expect, it } from 'vitest';
import {
  activeWordIndex, addCaptions, captionClips, chunkCues, estimateWords, mergeCaptionWithNext, parseSubtitles, projectCues,
  rechunkCaptions, restyleCaptions, splitCaption, toSRT, toVTT,
} from '../../src/core/captions';
import { parseProject, serializeProject } from '../../src/core/projectIO';
import { sampleProject } from './helpers';

const SRT = `1
00:00:01,000 --> 00:00:03,500
Welcome back to the channel

2
00:00:04,000 --> 00:00:06,000
<i>Today</i> we open a booster pack!

bad block without timing

3
00:00:07,000 --> 00:00:06,000
end before start is skipped
`;

const VTT = `WEBVTT
Kind: captions

intro
00:00.500 --> 00:02.000 align:center
Hello &amp; welcome

00:00:02.000 --> 00:00:04.000
<00:00:02.000>one <00:00:02.500>two <00:00:03.500>three
`;

describe('subtitle parsing', () => {
  it('parses SRT, strips tags and skips broken blocks', () => {
    const cues = parseSubtitles(SRT);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ start: 1, end: 3.5, text: 'Welcome back to the channel' });
    expect(cues[1].text).toBe('Today we open a booster pack!');
  });
  it('parses WebVTT with short timestamps, settings, entities and karaoke timings', () => {
    const cues = parseSubtitles(VTT);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ start: 0.5, end: 2, text: 'Hello & welcome' });
    expect(cues[1].text).toBe('one two three');
    expect(cues[1].words!.map((w) => w.start)).toEqual([0, 0.5, 1.5]);
    expect(cues[1].words![2].end).toBe(2);
  });
  it('handles Windows line endings and a BOM', () => {
    expect(parseSubtitles('﻿' + SRT.replace(/\n/g, '\r\n'))).toHaveLength(2);
  });
  it('round-trips through SRT and VTT', () => {
    const cues = parseSubtitles(SRT);
    expect(parseSubtitles(toSRT(cues)).map((c) => [c.start, c.end, c.text])).toEqual(cues.map((c) => [c.start, c.end, c.text]));
    expect(parseSubtitles(toVTT(cues)).map((c) => c.text)).toEqual(cues.map((c) => c.text));
    expect(toSRT(cues)).toContain('00:00:01,000 --> 00:00:03,500');
    expect(toVTT(cues).startsWith('WEBVTT')).toBe(true);
  });
});

describe('word timing and chunking', () => {
  it('estimates word times that fill the duration, longer words longer', () => {
    const w = estimateWords('I absolutely love it', 2);
    expect(w).toHaveLength(4);
    expect(w[0].start).toBe(0);
    expect(w[3].end).toBeCloseTo(2);
    expect(w[1].end - w[1].start).toBeGreaterThan(w[0].end - w[0].start);
  });
  it('chunks cues into short captions covering the same time', () => {
    const [cue] = parseSubtitles(SRT);
    const parts = chunkCues([cue], 2);
    expect(parts.map((p) => p.text)).toEqual(['Welcome back', 'to the', 'channel']);
    expect(parts[0].start).toBe(1);
    expect(parts[2].end).toBe(3.5);
    for (let i = 1; i < parts.length; i++) expect(parts[i].start).toBeCloseTo(parts[i - 1].end);
  });
});

describe('caption clips', () => {
  const setup = () => addCaptions(sampleProject().p, parseSubtitles(SRT), 'punch');
  it('creates a caption track on top with styled caption clips', () => {
    const p = setup();
    expect(p.tracks[0].role).toBe('captions');
    const caps = captionClips(p);
    expect(caps).toHaveLength(2);
    expect(caps[0].caption).toBe(true);
    expect(caps[0].text!.highlightMode).toBe('color');
    expect(projectCues(p).map((c) => c.text)).toEqual(['Welcome back to the channel', 'Today we open a booster pack!']);
  });
  it('replaces captions on re-import and never overlaps', () => {
    let p = setup();
    p = addCaptions(p, parseSubtitles(SRT), 'boxed');
    expect(captionClips(p)).toHaveLength(2);
    p = addCaptions(p, [{ start: 2, end: 3, text: 'overlap' }], 'boxed', false);
    expect(captionClips(p)).toHaveLength(2);
  });
  it('tracks the spoken word', () => {
    const c = captionClips(setup())[0];
    expect(activeWordIndex(c, 0)).toBe(0);
    expect(activeWordIndex(c, c.duration - 0.01)).toBe(4);
  });
  it('splits at a word boundary and merges back', () => {
    const p = setup();
    const c = captionClips(p)[0];
    const r = splitCaption(p, c.id, c.start + c.duration / 2)!;
    const [a, b] = captionClips(r.project);
    expect(`${a.text!.content} ${b.text!.content}`).toBe('Welcome back to the channel');
    expect(a.start + a.duration).toBeCloseTo(b.start);
    const merged = mergeCaptionWithNext(r.project, a.id)!;
    const m = captionClips(merged)[0];
    expect(m.text!.content).toBe('Welcome back to the channel');
    expect(m.start + m.duration).toBeCloseTo(3.5);
  });
  it('restyles and re-chunks all captions, keeping the text', () => {
    let p = setup();
    p = restyleCaptions(p, 'karaoke');
    expect(captionClips(p).every((c) => c.text!.highlightMode === 'karaoke')).toBe(true);
    p = rechunkCaptions(p, 1);
    expect(captionClips(p).map((c) => c.text!.content).join(' ')).toBe('Welcome back to the channel Today we open a booster pack!');
    expect(captionClips(p).every((c) => c.text!.highlightMode === 'karaoke')).toBe(true);
  });
  it('survives save and reopen', () => {
    const p = setup();
    const back = parseProject(serializeProject(p));
    expect(back.tracks[0].role).toBe('captions');
    expect(captionClips(back)).toHaveLength(2);
  });
});

import { cuesFromWords, phrasesToWords } from '../../src/core/captions';
describe('captions from transcription', () => {
  const words = ['Welcome', 'back', 'everyone.', 'Today', 'we', 'open', 'packs'].map((text, i) => ({ text, start: i * 0.4 + (i >= 3 ? 1 : 0), end: i * 0.4 + 0.35 + (i >= 3 ? 1 : 0) }));
  it('groups words by count, sentence and pauses', () => {
    const c2 = cuesFromWords(words, 2);
    expect(c2.map((c) => c.text)).toEqual(['Welcome back', 'everyone.', 'Today we', 'open packs']);
    const sentences = cuesFromWords(words, 0);
    expect(sentences.map((c) => c.text)).toEqual(['Welcome back everyone.', 'Today we open packs']);
    expect(sentences[0].words![0].start).toBe(0);
  });
  it('estimates words inside phrases', () => {
    const w = phrasesToWords([{ text: 'hello there friend', start: 2, end: 3.5 }]);
    expect(w.map((x) => x.text)).toEqual(['hello', 'there', 'friend']);
    expect(w[0].start).toBe(2);
    expect(w[2].end).toBeCloseTo(3.5);
  });
});
