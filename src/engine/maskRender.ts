/**
 * Draws a clip's masks into an alpha mask and applies it to the clip layer.
 */
import { maskOutline, resolveMask } from '../core/masks';
import type { Mask } from '../core/types';

const maskCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
const shapeCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;

function sized(c: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D {
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const x = c.getContext('2d')!;
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.globalCompositeOperation = 'source-over';
  x.globalAlpha = 1;
  x.filter = 'none';
  x.clearRect(0, 0, w, h);
  return x;
}

/**
 * `pxScale` converts project pixels to layer pixels (for feather).
 * Masks combine in order: add (union), subtract, intersect.
 */
export function applyMasks(layer: HTMLCanvasElement, masks: Mask[], local: number, pxScale: number): void {
  if (!maskCanvas || !shapeCanvas || !masks.length) return;
  const w = layer.width, h = layer.height;
  const resolved = masks.map((m) => resolveMask(m, local));
  // Soft (feathered) masks are drawn at reduced resolution: the blur hides it and it's far cheaper.
  const minFeather = Math.min(...resolved.map((m) => m.feather * pxScale));
  const k = minFeather > 6 ? Math.max(0.25, Math.min(1, 3 / minFeather * 2)) : 1;
  const mw = Math.max(1, Math.round(w * k)), mh = Math.max(1, Math.round(h * k));
  const mctx = sized(maskCanvas, mw, mh);
  resolved.forEach((m, i) => {
    const sctx = sized(shapeCanvas, mw, mh);
    const pts = maskOutline(m, mw, mh);
    if (pts.length < 3) return;
    const feather = Math.max(0, m.feather * pxScale * k);
    if (feather > 0.3) sctx.filter = `blur(${feather / 2}px)`;
    sctx.fillStyle = '#fff';
    sctx.globalAlpha = Math.max(0, Math.min(1, m.opacity));
    if (m.invert) {
      sctx.fillRect(-feather * 2, -feather * 2, mw + feather * 4, mh + feather * 4);
      sctx.globalCompositeOperation = 'destination-out';
      sctx.globalAlpha = 1;
    }
    sctx.beginPath();
    pts.forEach((p, j) => (j ? sctx.lineTo(p.x, p.y) : sctx.moveTo(p.x, p.y)));
    sctx.closePath();
    sctx.fill();
    const op: GlobalCompositeOperation = i === 0 || m.mode === 'add' ? 'source-over' : m.mode === 'subtract' ? 'destination-out' : 'destination-in';
    mctx.globalCompositeOperation = op;
    mctx.drawImage(shapeCanvas, 0, 0);
  });
  const lctx = layer.getContext('2d')!;
  lctx.save();
  lctx.setTransform(1, 0, 0, 1, 0, 0);
  lctx.globalCompositeOperation = 'destination-in';
  lctx.imageSmoothingEnabled = true;
  lctx.drawImage(maskCanvas, 0, 0, mw, mh, 0, 0, w, h);
  lctx.restore();
}
