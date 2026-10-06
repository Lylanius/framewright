/** Browser side of the shiny decoys: read the two pictures, write two recoloured PNGs. */
import { mainHue, pickFakeShifts, recolour } from '../core/shinyFakes';

const MAX = 900; // plenty for a tile in a 1080-wide video

function load(file: Blob): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('That picture couldn’t be opened. Try a PNG or JPEG.')); };
    img.src = url;
  });
}

function pixels(img: HTMLImageElement): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; data: ImageData } {
  const k = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * k)); canvas.height = Math.max(1, Math.round(img.naturalHeight * k));
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return { canvas, ctx, data: ctx.getImageData(0, 0, canvas.width, canvas.height) };
}

/** Two decoy colourings of the normal picture, chosen to differ from it and from the real shiny. */
export async function makeFakes(normal: File, shiny: File): Promise<[File, File]> {
  const [a, b] = await Promise.all([load(normal), load(shiny)]);
  const n = pixels(a), s = pixels(b);
  const hn = mainHue(n.data.data), hs = mainHue(s.data.data);
  const grey = hn.saturation < 0.08; // white/grey/black character: tint it rather than turn its colours
  const shifts = grey ? pickFakeShifts(hs.saturation < 0.08 ? 0 : hs.hue).map((d) => d) as [number, number] : pickFakeShifts((hs.hue - hn.hue + 360) % 360);
  const out: File[] = [];
  for (const [i, shift] of shifts.entries()) {
    const copy = new ImageData(new Uint8ClampedArray(n.data.data), n.data.width, n.data.height);
    recolour(copy.data, shift, grey);
    n.ctx.putImageData(copy, 0, 0);
    const blob = await new Promise<Blob>((res, rej) => n.canvas.toBlob((x) => (x ? res(x) : rej(new Error('Couldn’t make the decoy picture.'))), 'image/png'));
    out.push(new File([blob], `${normal.name.replace(/\.\w+$/, '')} decoy ${i + 1}.png`, { type: 'image/png' }));
  }
  return out as [File, File];
}
