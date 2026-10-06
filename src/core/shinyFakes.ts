/**
 * "Spot the real shiny": making the two decoy colourings.
 * Given the normal picture and the real shiny, pick two colour shifts that look
 * clearly different from both, and recolour the normal picture with them.
 * Pure maths on pixel data, so it's unit-tested and runs entirely on-device.
 */

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (d < 1e-6) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, Math.min(1, s), l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s, hp = (((h % 360) + 360) % 360) / 60, x = c * (1 - Math.abs((hp % 2) - 1)), m = l - c / 2;
  const [r, g, b] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** The picture's main colour (0–360°) and how colourful it is (0–1), ignoring see-through, white, black and grey areas. */
export function mainHue(data: Uint8ClampedArray | number[]): { hue: number; saturation: number } {
  let sx = 0, sy = 0, sat = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    n++;
    const w = s * (1 - Math.abs(2 * l - 1)); // vivid mid-tones count most
    sat += w;
    sx += Math.cos((h * Math.PI) / 180) * w; sy += Math.sin((h * Math.PI) / 180) * w;
  }
  return { hue: ((Math.atan2(sy, sx) * 180) / Math.PI + 360) % 360, saturation: n ? sat / n : 0 };
}

const apart = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/**
 * Two colour shifts (degrees) for the decoys: as far as possible from "no
 * change" (the normal one), from the real shiny's shift, and from each other.
 */
export function pickFakeShifts(shinyShift: number): [number, number] {
  let best: [number, number] = [120, 240], score = -1;
  for (let a = 30; a < 360; a += 15) for (let b = a + 15; b < 360; b += 15) {
    const sc = Math.min(apart(a, 0), apart(b, 0), apart(a, shinyShift), apart(b, shinyShift), apart(a, b));
    if (sc > score) { score = sc; best = [a, b]; }
  }
  return best;
}

/**
 * Recolour pixels by turning every colour `shift` degrees round the colour
 * wheel (in place). Grey/white/black characters have no colour to turn, so
 * with `tint` they're given the target colour instead.
 */
export function recolour(data: Uint8ClampedArray, shift: number, tint = false): void {
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    const s2 = tint ? Math.max(s, 0.55 * (1 - Math.abs(2 * l - 1) ** 2)) : s;
    const [r, g, b] = hslToRgb(tint && s < 0.12 ? shift : h + shift, s2, l);
    data[i] = r; data[i + 1] = g; data[i + 2] = b;
  }
}
