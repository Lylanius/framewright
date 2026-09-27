/**
 * Picks a good spot to zoom in on for a "zoomed-in" quiz question: an
 * extremity of the character (a hand, tail, ear…) rather than its face, so the
 * close-up is a fair puzzle. Works on the picture's see-through background;
 * photos without transparency fall back to the centre.
 */
export function suggestFocus(img: CanvasImageSource & { width: number; height: number }, zoom: number): { x: number; y: number } {
  const N = 96;
  const iw = (img as HTMLImageElement).naturalWidth || img.width, ih = (img as HTMLImageElement).naturalHeight || img.height;
  if (!iw || !ih) return { x: 0.5, y: 0.5 };
  const k = N / Math.max(iw, ih);
  const w = Math.max(1, Math.round(iw * k)), h = Math.max(1, Math.round(ih * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) return { x: 0.5, y: 0.5 };
  g.drawImage(img, 0, 0, w, h);
  let data: Uint8ClampedArray;
  try { data = g.getImageData(0, 0, w, h).data; } catch { return { x: 0.5, y: 0.5 }; }
  let n = 0, sx = 0, sy = 0, clear = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const a = data[(y * w + x) * 4 + 3];
    if (a > 128) { n++; sx += x; sy += y; } else clear++;
  }
  // No see-through background (a photo): nothing to go on, use the centre.
  if (!n || clear < w * h * 0.05) return { x: 0.5, y: 0.5 };
  const cx = sx / n, cy = sy / n;
  // Farthest solid pixel from the middle of the character = an extremity.
  let best = { x: cx, y: cy, d: -1 };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (data[(y * w + x) * 4 + 3] <= 128) continue;
    const d = (x - cx) ** 2 + (y - cy) ** 2;
    if (d > best.d) best = { x, y, d };
  }
  // Pull back towards the middle so the close-up is mostly character, not background.
  const side = Math.min(w, h) / Math.max(1, zoom);
  const dist = Math.sqrt(best.d) || 1;
  const pull = Math.min(dist, side * 0.45);
  const fx = best.x - ((best.x - cx) / dist) * pull, fy = best.y - ((best.y - cy) / dist) * pull;
  return { x: Math.min(1, Math.max(0, (fx + 0.5) / w)), y: Math.min(1, Math.max(0, (fy + 0.5) / h)) };
}
