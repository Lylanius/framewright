/**
 * Brand kits: your colours, fonts, logo and intro/outro clips, applied to any
 * project in one tap. The kit's files (logo, fonts, intro/outro) are stored
 * on this device; this module is the pure "apply" logic.
 */
import { createClipFromMedia } from './defaults';
import { addOverlayClip, addClipToTrack, mainTrackIndex, projectDuration, rippleInsert } from './timeline';
import type { Clip, MediaItem, Project } from './types';

export type Corner = 'tl' | 'tr' | 'bl' | 'br';

export interface BrandAsset { name: string; type: string; blob: Blob }

export interface BrandKit {
  id: string;
  name: string;
  colors: string[];
  headingFont: string;
  bodyFont: string;
  /** Font files uploaded for this kit (registered at start-up). */
  fonts: BrandAsset[];
  logo?: BrandAsset;
  logoCorner: Corner;
  /** Logo width as a fraction of the frame width. */
  logoSize: number;
  logoOpacity: number;
  intro?: BrandAsset;
  outro?: BrandAsset;
  updatedAt: number;
}

export function newBrandKit(name = 'My brand'): BrandKit {
  return {
    id: `brand_${Date.now().toString(36)}`, name, colors: ['#f2b544', '#111318', '#ffffff'],
    headingFont: 'Archivo Black', bodyFont: 'Figtree', fonts: [], logoCorner: 'tr', logoSize: 0.18, logoOpacity: 0.9, updatedAt: Date.now(),
  };
}

export interface ApplyOptions { fonts: boolean; titleColour: string | null; captions: boolean; shapes: boolean }

/** Restyle every title, caption and shape in the project with the kit. */
export function applyBrand(p: Project, kit: BrandKit, o: ApplyOptions): { project: Project; changed: number } {
  let changed = 0;
  const [c1, c2] = kit.colors;
  const tracks = p.tracks.map((t) => ({
    ...t,
    clips: t.clips.map((c): Clip => {
      if (c.text && c.caption) {
        if (!o.captions) return c;
        changed++;
        return { ...c, text: { ...c.text, fontFamily: o.fonts ? kit.bodyFont : c.text.fontFamily, highlightColor: c1 ?? c.text.highlightColor } };
      }
      if (c.text) {
        changed++;
        const text = { ...c.text };
        if (o.fonts) text.fontFamily = kit.headingFont;
        if (o.titleColour) { text.color = o.titleColour; text.gradient = null; }
        return { ...c, text };
      }
      if (c.shape && o.shapes && c.shape.type !== 'emoji') {
        changed++;
        return { ...c, shape: { ...c.shape, fill: c.shape.fill === 'transparent' ? 'transparent' : (c1 ?? c.shape.fill), fill2: null, stroke: c2 ?? c.shape.stroke } };
      }
      return c;
    }),
  }));
  return { project: { ...p, tracks }, changed };
}

/** Logo overlay for the whole project, tucked into a corner. */
export function logoClip(p: Project, media: MediaItem, kit: Pick<BrandKit, 'logoCorner' | 'logoSize' | 'logoOpacity'>): Clip {
  const { width: W, height: H } = p.settings;
  const duration = Math.max(1, projectDuration(p));
  const c = createClipFromMedia(media, 0);
  c.duration = duration;
  c.name = 'Logo';
  c.fit = 'contain';
  // Natural "contain" size of the logo, then scaled to the requested width.
  const mw = media.width ?? 1, mh = media.height ?? 1;
  const fitW = Math.min(W, (H * mw) / mh);
  const scale = (kit.logoSize * W) / fitW;
  const wFrac = kit.logoSize, hFrac = (kit.logoSize * W * (mh / mw)) / H;
  const margin = 0.045;
  const right = kit.logoCorner.endsWith('r'), bottom = kit.logoCorner.startsWith('b');
  c.transform = {
    ...c.transform, scale, opacity: kit.logoOpacity,
    x: (right ? 1 : -1) * (0.5 - margin - wFrac / 2),
    y: (bottom ? 1 : -1) * (0.5 - margin * (W / H) - hFrac / 2),
  };
  return c;
}

export function addLogo(p: Project, media: MediaItem, kit: BrandKit): Project {
  return addOverlayClip(p, logoClip(p, media, kit));
}

/** Put an intro at the very start (everything else moves along) or an outro at the end. */
export function addBookend(p: Project, media: MediaItem, where: 'intro' | 'outro'): Project {
  const mi = mainTrackIndex(p);
  if (mi < 0) return p;
  const clip = createClipFromMedia(media, 0);
  clip.name = where === 'intro' ? `Intro · ${media.name}` : `Outro · ${media.name}`;
  if (where === 'intro') {
    const shifted = rippleInsert(p, 0, clip.duration);
    return addClipToTrack(shifted, shifted.tracks[mi].id, clip) ?? shifted;
  }
  const end = p.tracks[mi].clips.reduce((a, c) => Math.max(a, c.start + c.duration), 0);
  clip.start = end;
  return addClipToTrack(p, p.tracks[mi].id, clip) ?? p;
}
