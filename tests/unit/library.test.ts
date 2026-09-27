import { describe, expect, it } from 'vitest';
import { addBookend, addLogo, applyBrand, logoClip, newBrandKit } from '../../src/core/brand';
import { builtinTemplates } from '../../src/core/builtinTemplates';
import { createClipFromMedia, createShapeClip, createTextClip, defaultShape } from '../../src/core/defaults';
import { defaultMotion, motionState } from '../../src/core/motion';
import { EMOJI, STICKERS, stickerFile } from '../../src/core/stickers';
import { fillSlot, fillSlots, projectToTemplate, slotsOf, templateDuration, templateToProject } from '../../src/core/templates';
import { addOverlayClip, findClip, mainTrackIndex, projectDuration } from '../../src/core/timeline';
import type { MediaItem } from '../../src/core/types';
import { media, sampleProject } from './helpers';

describe('motion presets', () => {
  it('pops in, settles, and fades out', () => {
    const m = { ...defaultMotion(), in: 'pop' as const, out: 'fade' as const, duration: 0.4 };
    expect(motionState(m, 0, 4).scale).toBeLessThan(0.2);
    const mid = motionState(m, 2, 4);
    expect(mid.scale).toBeCloseTo(1);
    expect(mid.opacity).toBeCloseTo(1);
    expect(motionState(m, 3.95, 4).opacity).toBeLessThan(0.4);
    // Pop overshoots a little on the way in.
    const peak = Math.max(...Array.from({ length: 40 }, (_, i) => motionState(m, (i / 40) * 0.4, 4).scale));
    expect(peak).toBeGreaterThan(1.02);
  });
  it('loops keep going for the whole clip', () => {
    const m = { ...defaultMotion(), in: 'none' as const, out: 'none' as const, loop: 'wiggle' as const };
    const rots = Array.from({ length: 20 }, (_, i) => motionState(m, 1 + i * 0.05, 10).rot);
    expect(Math.max(...rots) - Math.min(...rots)).toBeGreaterThan(5);
    expect(motionState(undefined, 1, 2)).toEqual({ opacity: 1, dx: 0, dy: 0, scale: 1, rot: 0 });
  });
  it('slides start off to the side', () => {
    const m = { ...defaultMotion(), in: 'slideLeft' as const, out: 'none' as const };
    expect(motionState(m, 0, 4).dx).toBeGreaterThan(0.2);
    expect(motionState(m, 1, 4).dx).toBeCloseTo(0);
  });
});

describe('stickers', () => {
  it('are valid, self-contained SVG', () => {
    expect(STICKERS.length).toBeGreaterThanOrEqual(16);
    for (const s of STICKERS) {
      const doc = new DOMParser().parseFromString(s.svg, 'image/svg+xml');
      expect(doc.querySelector('parsererror'), s.id).toBeNull();
      expect(doc.documentElement.getAttribute('width')).toBeTruthy();
      expect(s.svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/); // no external references
      expect(stickerFile(s).type).toBe('image/svg+xml');
    }
    expect(new Set(STICKERS.map((s) => s.id)).size).toBe(STICKERS.length);
    expect(EMOJI.length).toBeGreaterThan(20);
  });
});

describe('overlays', () => {
  it('puts stickers above the main track, reusing a free overlay track', () => {
    const { p } = sampleProject();
    const a = addOverlayClip(p, createShapeClip(defaultShape('star'), 0, 2));
    const mi = mainTrackIndex(a);
    const star = a.tracks.findIndex((t) => t.clips.some((c) => c.kind === 'shape'));
    expect(star).toBeLessThan(mi);
    const b = addOverlayClip(a, createShapeClip(defaultShape('heart'), 3, 2));
    expect(b.tracks.length).toBe(a.tracks.length);
    const c = addOverlayClip(b, createShapeClip(defaultShape('heart'), 1, 2)); // overlaps → new track
    expect(c.tracks.length).toBe(b.tracks.length + 1);
  });
});

describe('templates', () => {
  it('built-ins are well formed', () => {
    const list = builtinTemplates();
    expect(list.length).toBeGreaterThanOrEqual(8);
    for (const d of list) {
      const p = templateToProject(d);
      const slots = slotsOf(p);
      expect(slots.length, d.id).toBeGreaterThan(0);
      expect(slots.map((s) => s.index)).toEqual(slots.map((_, i) => i));
      expect(templateDuration(d)).toBeGreaterThan(5);
      // The last visual track is the main one and holds slots.
      const mi = mainTrackIndex(p);
      expect(p.tracks.slice(0, mi + 1).some((t) => t.clips.some((c) => c.placeholder)), d.id).toBe(true);
      // Fresh ids each time.
      expect(templateToProject(d).tracks[0].id).not.toBe(p.tracks[0].id);
    }
  });

  it('fills slots in order, and shared slots together', () => {
    const d = builtinTemplates().find((t) => t.id === 'builtin-gaming')!;
    let p = templateToProject(d);
    expect(slotsOf(p)).toHaveLength(1);
    expect(slotsOf(p)[0].clips).toBe(2); // front + blurred background copy
    const clip: MediaItem = { ...media('G', 30), name: 'clutch.mp4' };
    p = { ...p, media: [clip] };
    p = fillSlot(p, 0, clip);
    expect(slotsOf(p)).toHaveLength(0);
    const filled = p.tracks.flatMap((t) => t.clips).filter((c) => c.mediaId === 'G');
    expect(filled).toHaveLength(2);
    expect(filled.every((c) => c.duration === 10 && !c.placeholder)).toBe(true);
  });

  it('slows short footage down to fill a slot (not below 0.25×)', () => {
    const d = builtinTemplates().find((t) => t.id === 'builtin-beforeafter')!;
    const short: MediaItem = media('S', 2);
    const r = fillSlots({ ...templateToProject(d), media: [short, media('T', 20)] }, [short, media('T', 20)]);
    expect(r.filled).toBe(2);
    const first = r.project.tracks.flatMap((t) => t.clips).find((c) => c.mediaId === 'S')!;
    expect(first.speed).toBeLessThan(1);
    expect(first.duration * first.speed).toBeLessThanOrEqual(2);
  });

  it('saves a project as a template: footage → slots, stickers kept', () => {
    const { p, a, b } = sampleProject();
    const sticker: MediaItem = { ...media('K', 0, 'image'), name: 'Sticker - WOW.svg', size: 2000 };
    let q = { ...p, media: [...p.media, sticker] };
    q = addOverlayClip(q, { ...createClipFromMedia(sticker, 1) });
    q = addOverlayClip(q, createTextClip(0, { content: 'Hello' }));
    const doc = projectToTemplate(q, { name: 'Mine', keep: (m) => m.kind === 'image' && m.size < 100_000 });
    const back = templateToProject(doc);
    const slots = slotsOf(back);
    expect(slots.map((s) => s.label)).toEqual(['Clip 1', 'Clip 2']);
    expect(back.tracks.flatMap((t) => t.clips).some((c) => c.mediaId === 'K')).toBe(true);
    expect(back.media.map((m) => m.id)).toEqual(['K']);
    expect(back.tracks.flatMap((t) => t.clips).some((c) => c.text?.content === 'Hello')).toBe(true);
    expect(findClip(back, a)).toBeNull(); // new ids
    void b;
  });
});

describe('brand kits', () => {
  it('restyles titles, captions and shapes', () => {
    const { p } = sampleProject();
    let q = addOverlayClip(p, createTextClip(0, { content: 'Title', fontFamily: 'Bangers', color: '#fff' }));
    q = addOverlayClip(q, { ...createTextClip(4, { content: 'cap' }), caption: true });
    q = addOverlayClip(q, createShapeClip(defaultShape('star'), 0, 2));
    const kit = { ...newBrandKit(), colors: ['#123456', '#abcdef'], headingFont: 'Oswald', bodyFont: 'Poppins' };
    const r = applyBrand(q, kit, { fonts: true, titleColour: '#123456', captions: true, shapes: true });
    const all = r.project.tracks.flatMap((t) => t.clips);
    expect(r.changed).toBe(3);
    expect(all.find((c) => c.text?.content === 'Title')!.text!).toMatchObject({ fontFamily: 'Oswald', color: '#123456' });
    expect(all.find((c) => c.caption)!.text!.fontFamily).toBe('Poppins');
    expect(all.find((c) => c.shape)!.shape!.fill).toBe('#123456');
  });

  it('tucks the logo into the chosen corner for the whole video', () => {
    const { p } = sampleProject(); // 1080×1920, 16 s
    const logo: MediaItem = { ...media('L', 0, 'image'), width: 400, height: 200 };
    const c = logoClip(p, logo, { logoCorner: 'tr', logoSize: 0.2, logoOpacity: 0.8 });
    expect(c.duration).toBeCloseTo(projectDuration(p));
    expect(c.transform.x).toBeGreaterThan(0.3);
    expect(c.transform.y).toBeLessThan(-0.4);
    const withLogo = addLogo({ ...p, media: [...p.media, logo] }, logo, { ...newBrandKit(), logoCorner: 'bl' });
    const placed = withLogo.tracks.flatMap((t) => t.clips).find((x) => x.name === 'Logo')!;
    expect(placed.transform.x).toBeLessThan(0);
    expect(placed.transform.y).toBeGreaterThan(0);
  });

  it('adds an intro before everything and an outro after', () => {
    const { p, a } = sampleProject();
    const intro: MediaItem = media('I', 2);
    const q = addBookend({ ...p, media: [...p.media, intro] }, intro, 'intro');
    expect(findClip(q, a)!.clip.start).toBeCloseTo(2);
    expect(projectDuration(q)).toBeCloseTo(projectDuration(p) + 2);
    const out = addBookend(q, media('O', 3), 'outro');
    expect(projectDuration(out)).toBeCloseTo(projectDuration(q) + 3);
  });
});
