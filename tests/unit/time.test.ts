import { describe, expect, it } from 'vitest';
import { formatShort, formatTimecode, parseTime, snapToFrame } from '../../src/core/time';
import { sanitiseSize } from '../../src/core/presets';
import { classify, normalisePeaks } from '../../src/engine/media';

describe('time helpers', () => {
  it('formats and parses timecode', () => {
    expect(formatTimecode(62.5, 30)).toBe('00:01:02:15');
    expect(parseTime('00:01:02:15', 30)).toBeCloseTo(62.5);
    expect(parseTime('1:02.5')).toBeCloseTo(62.5);
    expect(parseTime('4s')).toBe(4);
    expect(parseTime('abc')).toBeNull();
    expect(formatShort(3.25)).toBe('3.3s');
    expect(snapToFrame(1.01, 30)).toBeCloseTo(1);
  });
  it('keeps export sizes even and bounded', () => {
    expect(sanitiseSize(1081, 1919)).toEqual({ width: 1082, height: 1920 });
    expect(sanitiseSize(0, 99999)).toEqual({ width: 16, height: 7680 });
  });
});

describe('media classification', () => {
  it('recognises every format from the brief', () => {
    const exts = { mp4: 'video', mov: 'video', mkv: 'video', webm: 'video', avi: 'video', mpeg: 'video', m4v: 'video', gif: 'image', webp: 'image', jpg: 'image', jpeg: 'image', png: 'image', heic: 'image', wav: 'audio', mp3: 'audio', aac: 'audio', m4a: 'audio', flac: 'audio' };
    for (const [ext, kind] of Object.entries(exts)) expect(classify({ name: `clip.${ext.toUpperCase()}`, type: '' })).toBe(kind);
    expect(classify({ name: 'notes.txt', type: 'text/plain' })).toBeNull();
  });
  it('normalises waveform peaks', () => {
    expect(normalisePeaks([0, 0.25, 0.5])).toEqual([0, 0.5, 1]);
    expect(normalisePeaks([0, 0])).toEqual([0, 0]);
  });
});
