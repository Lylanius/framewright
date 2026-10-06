/**
 * Stickers, templates and brand kits: the actions behind their panels.
 * Templates and kits are stored on this device (see storage/kv.ts).
 */
import { addBookend, addLogo, applyBrand, type ApplyOptions, type BrandAsset, type BrandKit } from '../core/brand';
import { builtinTemplates } from '../core/builtinTemplates';
import { createClipFromMedia, createShapeClip, createTextClip } from '../core/defaults';
import { defaultMotion } from '../core/motion';
import { parseProject } from '../core/projectIO';
import { stickerFile, type StickerDef } from '../core/stickers';
import { fillSlot, fillSlots, projectToTemplate, templateToProject, type TemplateDoc } from '../core/templates';
import { addOverlayClip, addUnderlayClip, projectDuration } from '../core/timeline';
import type { MediaItem, ShapeStyle, TextStyle } from '../core/types';
import { getBlob, registerBlob } from '../engine/media';
import { saveFile } from '../platform/download';
import { kv } from '../storage/kv';
import * as db from '../storage/db';
import { registerFontFile } from '../styles/fonts';
import { useApp, useTime } from './store';

const app = () => useApp.getState();
const now = () => useTime.getState().time;

/* ---------------- stickers & shapes ---------------- */

async function importOne(file: File): Promise<MediaItem | null> {
  const [id] = await app().importFiles([file]);
  return app().project?.media.find((m) => m.id === id) ?? null;
}

/** Add an image (sticker, GIF, logo…) as an overlay at the playhead with a pop-in. */
export function addImageOverlay(media: MediaItem, opts: { scale?: number; duration?: number } = {}): void {
  const clip = createClipFromMedia(media, now());
  clip.duration = opts.duration ?? (media.meta?.animated ? Math.max(3, media.duration) : 3);
  clip.fit = 'contain';
  clip.transform = { ...clip.transform, scale: opts.scale ?? 0.45 };
  clip.motion = defaultMotion();
  app().apply('Add sticker', (p) => addOverlayClip(p, clip));
  app().select([clip.id]);
}

export async function addSticker(def: StickerDef): Promise<void> {
  const m = await importOne(stickerFile(def));
  if (m) addImageOverlay(m);
}

export async function addStickerFiles(files: File[]): Promise<void> {
  const ids = await app().importFiles(files);
  for (const id of ids) {
    const m = app().project?.media.find((x) => x.id === id);
    if (m && m.kind === 'image') addImageOverlay(m);
  }
}

export function addShape(style: ShapeStyle): void {
  const clip = createShapeClip(style, now(), 3);
  clip.motion = defaultMotion();
  app().apply('Add shape', (p) => addOverlayClip(p, clip));
  app().select([clip.id]);
}

/** Full-frame background (speed lines, rays…) underneath everything, from the playhead to the end. */
export function addBackground(style: ShapeStyle): void {
  const p = app().project;
  if (!p) return;
  const start = now();
  const dur = Math.max(3, projectDuration(p) - start);
  const clip = createShapeClip(style, start, dur);
  app().apply('Add background', (q) => addUnderlayClip(q, clip));
  app().select([clip.id]);
}

/** Ready-made design text (titles, answer buttons…) as an overlay at the playhead. */
export function addDesignText(style: Partial<TextStyle>, y = 0, x = 0, duration = 3): void {
  const clip = createTextClip(now(), style, duration);
  clip.transform = { ...clip.transform, x, y };
  app().apply('Add text', (p) => addOverlayClip(p, clip));
  app().select([clip.id]);
}

export const DESIGN_TEXT: { id: string; name: string; style: Partial<TextStyle>; y: number }[] = [
  { id: 'quiz-title', name: 'Quiz title', y: -0.34, style: { content: "WHO'S THAT\nPOKÉMON?", fontFamily: 'Archivo Black', fontSize: 104, color: '#ffd23f', strokeColor: '#1f4fb8', strokeWidth: 9, shadowBlur: 0, shadowOffsetY: 8, shadowColor: 'rgba(0,0,0,0.35)', uppercase: true, lineHeight: 1.05, animIn: 'pop' } },
  { id: 'round', name: 'Round label', y: -0.24, style: { content: 'Round 1', fontFamily: 'Archivo Black', fontSize: 44, color: '#ffd23f', strokeColor: '#1f4fb8', strokeWidth: 5, shadowBlur: 0, animIn: 'fade' } },
  { id: 'answer', name: 'Answer button', y: 0.3, style: { content: '{#e8a200|A)} Answer', fontFamily: 'Archivo Black', fontSize: 44, color: '#1b2a57', background: '#ffffff', backgroundBorder: '#1b2a57', backgroundBorderWidth: 4, backgroundPadding: 18, backgroundRadius: 26, backgroundFull: true, boxWidth: 0.36, align: 'center', shadowBlur: 0, shadowOffsetY: 0, animIn: 'pop' } },
  { id: 'banner', name: 'Banner', y: 0.38, style: { content: 'COMMENT YOUR ANSWER!', fontFamily: 'Archivo Black', fontSize: 52, color: '#ffffff', background: '#e5242b', backgroundPadding: 22, backgroundRadius: 12, backgroundFull: true, boxWidth: 0.82, shadowBlur: 0, shadowOffsetY: 0, animIn: 'slideUp' } },
];

/* ---------------- templates ---------------- */

const TPL = 'template/';

export async function savedTemplates(): Promise<TemplateDoc[]> {
  return (await kv.list<TemplateDoc>(TPL)).sort((a, b) => b.createdAt - a.createdAt);
}

export function allBuiltins(): TemplateDoc[] {
  return builtinTemplates();
}

function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(r.error); r.readAsDataURL(b); });
}
async function dataUrlToBlob(u: string): Promise<Blob> {
  return (await fetch(u)).blob();
}

/** Save the open project as a template: footage becomes slots; small images (stickers, logos) and optionally music are kept. */
export async function saveProjectAsTemplate(name: string, description: string, keepMusic: boolean): Promise<TemplateDoc | null> {
  const p = app().project;
  if (!p) return null;
  const keep = (m: MediaItem) => (m.kind === 'image' && m.size < 3_000_000) || (keepMusic && m.kind === 'audio' && m.size < 25_000_000);
  const doc = projectToTemplate(p, { name, description, keep });
  doc.assets = {};
  for (const m of doc.media) {
    const b = getBlob(m.id) ?? (await db.getBlob(m.fingerprint));
    if (b) doc.assets[m.fingerprint] = await blobToDataUrl(b);
  }
  doc.media = doc.media.filter((m) => doc.assets![m.fingerprint]);
  const snap = await app().player?.snapshot('image/jpeg');
  if (snap) doc.thumbnail = await blobToDataUrl(await shrink(snap, 240));
  await kv.set(TPL + doc.id, doc);
  return doc;
}

async function shrink(b: Blob, maxH: number): Promise<Blob> {
  const bmp = await createImageBitmap(b);
  const k = Math.min(1, maxH / bmp.height);
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((r) => c.toBlob((x) => r(x ?? b), 'image/jpeg', 0.8));
}

export async function deleteTemplate(id: string): Promise<void> { await kv.del(TPL + id); }

export async function exportTemplate(doc: TemplateDoc): Promise<void> {
  const name = `${doc.name.replace(/[^\w\- ]+/g, '').trim() || 'template'}.framewright-template.json`;
  await saveFile(name, JSON.stringify({ framewrightTemplate: 1, ...doc }));
}

export async function importTemplate(file: File): Promise<TemplateDoc> {
  const raw = JSON.parse(await file.text());
  if (!raw || raw.framewrightTemplate !== 1 || !Array.isArray(raw.tracks)) throw new Error(`${file.name} isn’t a Framewright template.`);
  // Validate the tracks by round-tripping through the project parser.
  const check = parseProject(JSON.stringify({ ...templateToProject(raw as TemplateDoc), media: [] }));
  const doc: TemplateDoc = { ...(raw as TemplateDoc), id: `tpl_${Date.now().toString(36)}`, builtIn: false, createdAt: Date.now(), tracks: check.tracks.length ? (raw as TemplateDoc).tracks : [] };
  delete (doc as unknown as { framewrightTemplate?: number }).framewrightTemplate;
  await kv.set(TPL + doc.id, doc);
  return doc;
}

/** Start a new project from a template. */
export async function useTemplate(doc: TemplateDoc): Promise<void> {
  const p = templateToProject(doc, doc.name);
  for (const m of p.media) {
    const url = doc.assets?.[m.fingerprint];
    if (!url) continue;
    const blob = await dataUrlToBlob(url);
    registerBlob(m.id, blob);
    await db.putBlob(m.fingerprint, blob);
  }
  await app().openProjectData(p);
  app().toast(`Started “${doc.name}”. Tap a numbered slot to put your clip in — or use “Fill slots”.`, 'success');
}

/** Import files and drop them into the empty slots in order. */
export async function fillSlotsWithFiles(files: File[]): Promise<number> {
  const ids = await app().importFiles(files);
  const media = ids.map((id) => app().project?.media.find((m) => m.id === id)).filter(Boolean) as MediaItem[];
  let filled = 0;
  app().apply('Fill slots', (p) => { const r = fillSlots(p, media); filled = r.filled; return r.project; });
  return filled;
}

export function fillSlotWith(index: number, mediaId: string): void {
  const m = app().project?.media.find((x) => x.id === mediaId);
  if (m) app().apply('Fill slot', (p) => fillSlot(p, index, m));
}

/* ---------------- brand kits ---------------- */

const BRAND = 'brand/';

export async function brandKits(): Promise<BrandKit[]> {
  return (await kv.list<BrandKit>(BRAND)).sort((a, b) => b.updatedAt - a.updatedAt);
}
export async function saveBrandKit(k: BrandKit): Promise<void> { await kv.set(BRAND + k.id, { ...k, updatedAt: Date.now() }); }
export async function deleteBrandKit(id: string): Promise<void> { await kv.del(BRAND + id); }

export function assetFromFile(f: File): BrandAsset {
  return { name: f.name, type: f.type, blob: f };
}

/** Register a kit's own fonts so they're available everywhere (and after reloads). */
export async function registerKitFonts(k: BrandKit): Promise<void> {
  for (const f of k.fonts) { try { await registerFontFile(new File([f.blob], f.name), false); } catch { /* bad font */ } }
}

async function assetMedia(a: BrandAsset): Promise<MediaItem | null> {
  return importOne(new File([a.blob], a.name, { type: a.type }));
}

export async function applyKit(k: BrandKit, o: ApplyOptions): Promise<number> {
  await registerKitFonts(k);
  let n = 0;
  app().apply(`Apply brand “${k.name}”`, (p) => { const r = applyBrand(p, k, o); n = r.changed; return r.project; });
  return n;
}

export async function addKitLogo(k: BrandKit): Promise<boolean> {
  if (!k.logo) return false;
  const m = await assetMedia(k.logo);
  if (!m) return false;
  app().apply('Add logo', (p) => addLogo(p, m, k));
  return true;
}

export async function addKitBookend(k: BrandKit, where: 'intro' | 'outro'): Promise<boolean> {
  const a = where === 'intro' ? k.intro : k.outro;
  if (!a) return false;
  const m = await assetMedia(a);
  if (!m) return false;
  app().apply(where === 'intro' ? 'Add intro' : 'Add outro', (p) => addBookend(p, m, where));
  return true;
}
