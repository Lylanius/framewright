import { describe, expect, it } from 'vitest';
import {
  checkTarget, DEFAULT_QUEUE, dueTargets, finalText, hashtagsInText, newPost, nextQueueSlot, parseHashtags, postState, uploadEarly, youtubeTitle, type Post,
} from '../../src/core/publish';

const video = (o: Partial<Post['video']> = {}): Post['video'] => ({ key: 'v1', name: 'Quiz.mp4', size: 20e6, mime: 'video/mp4', duration: 30, width: 1080, height: 1920, ...o });

function post(o: Partial<Post> = {}): Post {
  const p = newPost(video());
  for (const k of ['youtube', 'instagram', 'tiktok'] as const) p.targets[k].enabled = true;
  return { ...p, ...o };
}

describe('hashtags', () => {
  it('parses messy input into clean, unique tags', () => {
    expect(parseHashtags('#Pokemon, quiz  #who\'s_that #pokemon ##gaming;#ポケモン')).toEqual(['Pokemon', 'quiz', 'whos_that', 'gaming', 'ポケモン']);
    expect(hashtagsInText('Guess! #quiz and #Fun_1 not#this?')).toEqual(['quiz', 'Fun_1', 'this']);
  });
  it('adds shared hashtags to the caption without doubling ones already typed', () => {
    const p = post({ caption: 'Who is it? #quiz', hashtags: ['Quiz', 'pokemon', 'fyp'] });
    expect(finalText(p, 'instagram')).toBe('Who is it? #quiz\n\n#pokemon #fyp');
    // Per-platform override
    p.targets.tiktok.hashtags = ['fyp', 'foryou'];
    p.targets.tiktok.caption = 'Comment your answer!';
    expect(finalText(p, 'tiktok')).toBe('Comment your answer!\n\n#fyp #foryou');
  });
  it('YouTube: #Shorts for vertical short videos, title from the caption if none typed', () => {
    const p = post({ caption: 'Who\'s that creature? #quiz\nMore text', hashtags: ['quiz'] });
    expect(finalText(p, 'youtube')).toContain('#Shorts');
    expect(youtubeTitle(p)).toBe('Who\'s that creature?');
    p.targets.youtube.title = 'Round 8 — can you guess?';
    expect(youtubeTitle(p)).toBe('Round 8 — can you guess?');
    const wide = post({ video: video({ width: 1920, height: 1080 }) });
    expect(finalText(wide, 'youtube')).not.toContain('#Shorts');
  });
});

describe('checks', () => {
  it('flags platform limits', () => {
    const p = post({ caption: 'x'.repeat(2300), hashtags: Array.from({ length: 31 }, (_, i) => `t${i}`) });
    const ig = checkTarget(p, 'instagram').map((i) => i.text).join(' | ');
    expect(ig).toMatch(/Caption is \d+ characters/);
    expect(ig).toMatch(/31 hashtags/);
    expect(checkTarget(p, 'tiktok').some((i) => i.level === 'error')).toBe(true);
    const long = post({ video: video({ duration: 1000, width: 1920, height: 1080, mime: 'video/webm', name: 'x.webm' }) });
    const txt = checkTarget(long, 'instagram').map((i) => i.text).join(' | ');
    expect(txt).toMatch(/15 minutes/);
    expect(txt).toMatch(/MP4/);
    long.targets.youtube.title = 'bad <title>';
    expect(checkTarget(long, 'youtube').some((i) => /< or >/.test(i.text))).toBe(true);
    // Disabled platforms aren't checked
    p.targets.instagram.enabled = false;
    expect(checkTarget(p, 'instagram')).toEqual([]);
  });
});

describe('queue and scheduling', () => {
  it('picks the next free queue slot', () => {
    // Monday 2026-09-28 10:00 local
    const mon10 = new Date(2026, 8, 28, 10, 0).getTime();
    const first = nextQueueSlot(DEFAULT_QUEUE, [], mon10)!;
    expect(new Date(first).getHours()).toBe(12);
    expect(new Date(first).getMinutes()).toBe(30);
    const second = nextQueueSlot(DEFAULT_QUEUE, [first], mon10)!;
    expect(new Date(second).getHours()).toBe(18);
    const third = nextQueueSlot(DEFAULT_QUEUE, [first, second], mon10)!;
    expect(new Date(third).getDate()).toBe(29); // Tuesday
    // Saturday: weekend slot
    const sat = nextQueueSlot(DEFAULT_QUEUE, [], new Date(2026, 9, 3, 9, 0).getTime())!;
    expect(new Date(sat).getHours()).toBe(11);
    expect(nextQueueSlot([], [], mon10)).toBeNull();
  });
  it('finds what is due, and uploads scheduled YouTube posts early', () => {
    const now = Date.now();
    const p = post({ when: 'at', publishAt: now + 3600_000 });
    expect(dueTargets([p], now)).toEqual([]);
    p.targets.youtube.delivery = 'direct';
    expect(uploadEarly(p, 'youtube', now)).toBe(true);
    expect(uploadEarly(p, 'tiktok', now)).toBe(false);
    expect(dueTargets([p], now + 3600_001).map((d) => d.platform)).toEqual(['youtube', 'instagram', 'tiktok']);
    p.targets.youtube.status = 'scheduled';
    p.targets.instagram.status = 'posted';
    expect(dueTargets([p], now + 3600_001).map((d) => d.platform)).toEqual(['tiktok']);
    expect(dueTargets([{ ...p, when: 'draft' }], now + 3600_001)).toEqual([]);
  });
  it('summarises a post', () => {
    const p = post({ when: 'at', publishAt: Date.now() });
    expect(postState(p)).toBe('scheduled');
    p.targets.youtube.status = 'posted';
    p.targets.instagram.status = 'reminded';
    expect(postState(p)).toBe('needs-you');
    p.targets.instagram.status = 'shared';
    p.targets.tiktok.status = 'failed';
    expect(postState(p)).toBe('partly');
    p.targets.tiktok.status = 'drafted';
    expect(postState(p)).toBe('done');
    expect(postState({ ...p, when: 'draft' })).toBe('draft');
  });
});
