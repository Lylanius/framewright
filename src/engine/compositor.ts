/**
 * Compositor: draws one frame of a project onto a 2D canvas.
 *
 * The same function is used for live preview and for export; only the
 * FrameSources differ (video elements for preview, frame-accurate decoded
 * frames for export). That keeps "what you see" equal to "what you get".
 *
 * Tracks are drawn bottom-up. Where two clips on a track meet with a
 * transition, both are drawn to full-frame layers and blended by the
 * transition renderer.
 */
import { activeWordIndex } from '../core/captions';
import { resolveAt, valueAt } from '../core/keyframes';
import { sourceTimeExtended, transitionAt, transitionProgress } from '../core/transitions';
import type { Clip, FitMode, Project, Track } from '../core/types';
import { applyEffects, hasPixelEffects, layerContextSettings, motionOffsets } from './effectsRender';
import { renderTextLayer, textAnimState } from './textRender';
import { renderTransition } from './transitionRender';
import { applyMasks } from './maskRender';
import { renderPlaceholder, renderShapeLayer } from './shapeRender';
import { motionState } from '../core/motion';

export interface VisualFrame {
  src: CanvasImageSource;
  /** Pixel size of `src`. */
  width: number;
  height: number;
  /** Size to lay out as, when `src` is a low-res stand-in (e.g. a thumbnail). */
  displayWidth?: number;
  displayHeight?: number;
}

export interface FrameSources {
  /** Drawable for a video/image clip at a given source time, or null if not ready yet. */
  getVisual(clip: Clip, sourceTime: number): VisualFrame | null;
  /** Person mask (white = keep) for background removal, if one is ready. */
  getMask?(clip: Clip, sourceTime: number): CanvasImageSource | null;
}

export interface RenderOptions {
  /** Output pixels per project pixel (preview canvases are usually smaller). */
  scale: number;
  /** Draw empty template slots (preview only). */
  placeholders?: boolean;
  /** Clip ids that should get a selection outline (preview only). */
  selectedIds?: string[];
  /** Text clips drawn without in/out animation (so a paused, selected title stays editable on screen). */
  staticIds?: string[];
  /** Live playback: favour speed over the last bit of scaling quality. */
  draft?: boolean;
}

export interface ClipBounds {
  clipId: string;
  /** Centre in output pixels. */
  cx: number;
  cy: number;
  w: number;
  h: number;
  rotation: number;
}

const mk = () => (typeof document !== 'undefined' ? document.createElement('canvas') : null);
const layerCanvas = mk();
const transA = mk();
const transB = mk();

/** Size of a w×h source fitted into a W×H frame. */
export function fitSize(mode: FitMode, w: number, h: number, W: number, H: number): { w: number; h: number } {
  if (mode === 'fill') return { w: W, h: H };
  const s = mode === 'cover' ? Math.max(W / w, H / h) : Math.min(W / w, H / h);
  return { w: w * s, h: h * s };
}

/** Visual opacity multiplier from the clip's fade-in/out. */
export function fadeFactor(clip: Clip, local: number): number {
  const l = Math.min(clip.duration, Math.max(0, local));
  let f = 1;
  if (clip.videoFadeIn > 0 && l < clip.videoFadeIn) f *= l / clip.videoFadeIn;
  if (clip.videoFadeOut > 0 && l > clip.duration - clip.videoFadeOut) f *= Math.max(0, (clip.duration - l) / clip.videoFadeOut);
  return Math.max(0, Math.min(1, f));
}

interface DrawEnv {
  project: Project;
  sources: FrameSources;
  opts: RenderOptions;
  W: number;
  H: number;
  frame: number;
}

/** Draw one visual clip at timeline time t (t may lie just outside the clip during a transition). */
function drawClip(ctx: CanvasRenderingContext2D, rawClip: Clip, t: number, env: DrawEnv): ClipBounds | null {
  const { W, H, opts, project } = env;
  const S = opts.scale;
  const PW = project.settings.width;
  // Animation/keyframe time is clamped to the clip; the picture itself may run on (transitions).
  const local = Math.min(rawClip.duration, Math.max(0, t - rawClip.start));
  // Keyframed effect / crop / text values for this moment.
  const clip = resolveAt(rawClip, local);
  if (clip.kind === 'adjustment') return drawAdjustment(ctx, clip, local, env);

  let src: CanvasImageSource | null = null;
  let srcW = 0, srcH = 0;
  let crop = clip.transform.crop;
  let drawW = 0, drawH = 0;
  let extraOpacity = 1, extraDy = 0, extraScale = 1;

  let mask: CanvasImageSource | null = null;
  const bg = clip.effects.find((e) => e.type === 'bgRemove' && e.enabled);
  if ((clip.kind === 'video' || clip.kind === 'image') && clip.placeholder && !clip.mediaId) {
    // Empty template slot: shown in the preview only; exports leave it out.
    if (!opts.placeholders) return null;
    src = renderPlaceholder(clip.placeholder, W, H);
    srcW = src.width; srcH = src.height; drawW = W; drawH = H;
    crop = { left: 0, top: 0, right: 0, bottom: 0 };
  } else if (clip.kind === 'video' || clip.kind === 'image') {
    const media = project.media.find((m) => m.id === clip.mediaId);
    const st = sourceTimeExtended(clip, t, media);
    const vf = env.sources.getVisual(clip, st);
    if (bg) mask = env.sources.getMask?.(clip, st) ?? null;
    if (!vf || !vf.width || !vf.height) return null;
    src = vf.src; srcW = vf.width; srcH = vf.height;
    const dw = vf.displayWidth ?? srcW, dh = vf.displayHeight ?? srcH;
    const cw = dw * (1 - crop.left - crop.right), ch = dh * (1 - crop.top - crop.bottom);
    if (cw <= 1 || ch <= 1) return null;
    const fit = fitSize(clip.fit, cw, ch, W, H);
    drawW = fit.w; drawH = fit.h;
  } else if (clip.kind === 'solid') {
    drawW = W; drawH = H;
    crop = { left: 0, top: 0, right: 0, bottom: 0 };
  } else if (clip.kind === 'shape' && clip.shape) {
    const layer = renderShapeLayer(clip.shape, S, local, clip.duration);
    src = layer; srcW = layer.width; srcH = layer.height;
    drawW = srcW; drawH = srcH;
    crop = { left: 0, top: 0, right: 0, bottom: 0 };
  } else if (clip.kind === 'text' && clip.text) {
    const isStatic = opts.staticIds?.includes(clip.id);
    const anim = isStatic ? { opacity: 1, dy: 0, scale: 1, reveal: 1 } : textAnimState(clip.text, local, clip.duration);
    const word = clip.text.highlightMode && clip.text.highlightMode !== 'none' ? activeWordIndex(clip, t - clip.start) : -1;
    const layer = renderTextLayer(clip.text, PW, S, anim.reveal, word);
    src = layer.canvas; srcW = layer.width; srcH = layer.height;
    drawW = srcW; drawH = srcH;
    crop = { left: 0, top: 0, right: 0, bottom: 0 };
    extraOpacity = anim.opacity; extraDy = anim.dy * drawH; extraScale = anim.scale;
  } else return null;

  const motion = motionOffsets(clip.effects, local, Math.min(W, H));
  const preset = motionState(opts.staticIds?.includes(clip.id) ? undefined : clip.motion, local, clip.duration);
  const x = valueAt(clip, 'x', local) * W + motion.dx + preset.dx * W;
  const y = valueAt(clip, 'y', local) * H + motion.dy + extraDy + preset.dy * H;
  const scale = valueAt(clip, 'scale', local) * motion.dScale * extraScale * preset.scale;
  const rot = ((valueAt(clip, 'rotation', local) + motion.dRot + preset.rot) * Math.PI) / 180;
  const opacity = Math.max(0, Math.min(1, valueAt(clip, 'opacity', local))) * fadeFactor(clip, local) * extraOpacity * preset.opacity;
  if (opacity <= 0.001 || scale <= 0.0001) return null;

  const w = drawW * scale, h = drawH * scale;
  const cx = W / 2 + x, cy = H / 2 + y;

  const pixelFx = (hasPixelEffects(clip.effects) || !!clip.masks?.length) && layerCanvas;
  let drawable: CanvasImageSource | null = src;
  let sx = 0, sy = 0, sw = srcW, sh = srcH;
  if (src) {
    sx = srcW * crop.left; sy = srcH * crop.top;
    sw = srcW * (1 - crop.left - crop.right); sh = srcH * (1 - crop.top - crop.bottom);
  }
  if (pixelFx) {
    // Render at on-screen size (capped) so effect cost scales with what's visible.
    const cap = 1.5;
    const lw = Math.max(1, Math.round(Math.min(w, W * cap)));
    const lh = Math.max(1, Math.round(Math.min(h, H * cap)));
    layerCanvas.width = lw; layerCanvas.height = lh;
    const lctx = layerCanvas.getContext('2d', layerContextSettings())!;
    lctx.clearRect(0, 0, lw, lh);
    if (src) lctx.drawImage(src, sx, sy, sw, sh, 0, 0, lw, lh);
    else { lctx.fillStyle = clip.color ?? '#000'; lctx.fillRect(0, 0, lw, lh); }
    if (bg && mask) {
      // Cut the clip out with the person mask (same crop as the picture).
      const mw = (mask as HTMLCanvasElement).width, mh = (mask as HTMLCanvasElement).height;
      const kx = mw / srcW, ky = mh / srcH;
      lctx.save();
      lctx.globalCompositeOperation = (bg.params.invert ?? 0) >= 1 ? 'destination-out' : 'destination-in';
      const feather = (bg.params.feather ?? 3) * S;
      if (feather > 0.3) lctx.filter = `blur(${feather}px)`;
      lctx.drawImage(mask, sx * kx, sy * ky, sw * kx, sh * ky, 0, 0, lw, lh);
      lctx.restore();
    }
    applyEffects(layerCanvas, clip.effects, local, env.frame, S * (lw / Math.max(1, w)));
    if (clip.masks?.length) applyMasks(layerCanvas, clip.masks, local, S * scale * (lw / Math.max(1, w)));
    drawable = layerCanvas; sx = 0; sy = 0; sw = lw; sh = lh;
  }

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.translate(cx, cy);
  if (rot) ctx.rotate(rot);
  ctx.scale(clip.transform.flipH ? -1 : 1, clip.transform.flipV ? -1 : 1);
  ctx.imageSmoothingQuality = env.opts.draft ? 'low' : 'high';
  if (drawable) ctx.drawImage(drawable, sx, sy, sw, sh, -w / 2, -h / 2, w, h);
  else { ctx.fillStyle = clip.color ?? '#000'; ctx.fillRect(-w / 2, -h / 2, w, h); }
  ctx.restore();
  return { clipId: clip.id, cx, cy, w, h, rotation: rot };
}

/**
 * Adjustment layer: applies its effects (and masks) to everything drawn
 * beneath it so far. Opacity/fades blend the adjusted picture over the original.
 */
function drawAdjustment(ctx: CanvasRenderingContext2D, clip: Clip, local: number, env: DrawEnv): ClipBounds | null {
  const { W, H } = env;
  const opacity = Math.max(0, Math.min(1, valueAt(clip, 'opacity', local))) * fadeFactor(clip, local);
  if (!layerCanvas || opacity <= 0.001 || (!clip.effects.some((e) => e.enabled) && !clip.masks?.length)) return { clipId: clip.id, cx: W / 2, cy: H / 2, w: W, h: H, rotation: 0 };
  layerCanvas.width = W; layerCanvas.height = H;
  const lctx = layerCanvas.getContext('2d', layerContextSettings())!;
  lctx.clearRect(0, 0, W, H);
  lctx.drawImage(ctx.canvas as CanvasImageSource, 0, 0, W, H, 0, 0, W, H);
  applyEffects(layerCanvas, clip.effects, local, env.frame, env.opts.scale);
  if (clip.masks?.length) applyMasks(layerCanvas, clip.masks, local, env.opts.scale);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = opacity;
  ctx.drawImage(layerCanvas, 0, 0);
  ctx.restore();
  return { clipId: clip.id, cx: W / 2, cy: H / 2, w: W, h: H, rotation: 0 };
}

function prepLayer(c: HTMLCanvasElement, W: number, H: number): CanvasRenderingContext2D {
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  const x = c.getContext('2d')!;
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.globalAlpha = 1;
  x.globalCompositeOperation = 'source-over';
  x.clearRect(0, 0, W, H);
  return x;
}

function drawTrack(ctx: CanvasRenderingContext2D, track: Track, t: number, env: DrawEnv, bounds: ClipBounds[]): void {
  const tw = transitionAt(track, t);
  if (tw && transA && transB) {
    const ca = prepLayer(transA, env.W, env.H);
    const cb = prepLayer(transB, env.W, env.H);
    const ba = drawClip(ca, tw.a, t, env);
    const bb = drawClip(cb, tw.b, t, env);
    const p = transitionProgress(tw, t);
    renderTransition(ctx, transA, transB, env.W, env.H, tw.transition, p, env.frame, env.opts.scale);
    const main = p < 0.5 ? ba : bb;
    if (main) bounds.push(main);
    return;
  }
  for (const clip of track.clips) {
    if (t >= clip.start - 1e-6 && t < clip.start + clip.duration - 1e-6) {
      const b = drawClip(ctx, clip, t, env);
      if (b) bounds.push(b);
    }
  }
}

/**
 * Render the frame at time `t`. Returns the on-screen bounds of each drawn
 * clip (used by the preview for click-to-select and drag handles).
 */
export function renderFrame(
  ctx: CanvasRenderingContext2D,
  project: Project,
  t: number,
  sources: FrameSources,
  opts: RenderOptions,
): ClipBounds[] {
  const { width: PW, height: PH, fps } = project.settings;
  const W = Math.round(PW * opts.scale), H = Math.round(PH * opts.scale);
  const env: DrawEnv = { project, sources, opts, W, H, frame: Math.round(t * fps) };
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = project.settings.background;
  ctx.fillRect(0, 0, W, H);
  const bounds: ClipBounds[] = [];

  for (let i = project.tracks.length - 1; i >= 0; i--) {
    const track = project.tracks[i];
    if (track.kind !== 'visual' || track.hidden) continue;
    drawTrack(ctx, track, t, env, bounds);
  }

  if (opts.selectedIds?.length) {
    for (const b of bounds) {
      if (!opts.selectedIds.includes(b.clipId)) continue;
      ctx.save();
      ctx.translate(b.cx, b.cy);
      ctx.rotate(b.rotation);
      ctx.strokeStyle = '#f2b544';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(-b.w / 2, -b.h / 2, b.w, b.h);
      ctx.restore();
    }
  }
  ctx.restore();
  return bounds;
}
