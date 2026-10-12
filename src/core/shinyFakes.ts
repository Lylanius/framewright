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
 * Colour family of a hue, as people name colours. The colour wheel isn't even
 * to the eye — greens cover a wide stretch — so two hues 80° apart can both
 * just look "green". Decoys must each be a different family.
 */
export function hueFamily(h: number): string {
  const x = ((h % 360) + 360) % 360;
  if (x < 15 || x >= 345) return 'red';
  if (x < 40) return 'orange';
  if (x < 65) return 'yellow';
  if (x < 160) return 'green';
  if (x < 195) return 'cyan';
  if (x < 250) return 'blue';
  if (x < 290) return 'purple';
  return 'pink';
}

/**
 * Two colour shifts (degrees) for the decoys: well away from "no change" (the
 * normal one), from the real shiny's shift, and from each other — and, given
 * the picture's main hue, each a different colour family from the normal, the
 * real shiny and each other. Picked at random from every pair that qualifies,
 * so the decoys aren't the same two colours every time.
 */
export function pickFakeShifts(shinyShift: number, rand: () => number = Math.random, minGap = 50, baseHue: number | null = null): [number, number] {
  const spaced: [number, number][] = [], distinct: [number, number][] = [];
  let best: [number, number] = [120, 240], score = -1;
  const taken = baseHue === null ? [] : [hueFamily(baseHue), hueFamily(baseHue + shinyShift)];
  for (let a = 30; a < 360; a += 15) for (let b = a + 15; b < 360; b += 15) {
    const sc = Math.min(apart(a, 0), apart(b, 0), apart(a, shinyShift), apart(b, shinyShift), apart(a, b));
    if (sc > score) { score = sc; best = [a, b]; }
    if (sc < minGap) continue;
    spaced.push([a, b]);
    if (baseHue !== null) {
      const fa = hueFamily(baseHue + a), fb = hueFamily(baseHue + b);
      if (fa !== fb && !taken.includes(fa) && !taken.includes(fb)) distinct.push([a, b]);
    }
  }
  const pool = distinct.length ? distinct : spaced;
  if (!pool.length) return best;
  const pair = pool[Math.floor(rand() * pool.length) % pool.length];
  return rand() < 0.5 ? pair : [pair[1], pair[0]];
}

/** A little random variety on top of the colour change: a touch brighter/darker, a touch more/less vivid. */
export function pickTweak(rand: () => number = Math.random): { sat: number; light: number } {
  return { sat: 0.85 + rand() * 0.35, light: (rand() - 0.5) * 0.12 };
}

/**
 * Recolour pixels by turning every colour `shift` degrees round the colour
 * wheel (in place). Grey/white/black characters have no colour to turn, so
 * with `tint` they're given the target colour instead.
 */
export function recolour(data: Uint8ClampedArray, shift: number, tint = false, tweak: { sat?: number; light?: number } = {}): void {
  const ks = tweak.sat ?? 1, dl = tweak.light ?? 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    const s1 = tint ? Math.max(s, 0.55 * (1 - Math.abs(2 * l - 1) ** 2)) : s;
    // Outlines (very dark) and highlights (very light) keep their brightness.
    const l2 = l < 0.12 || l > 0.92 ? l : Math.min(0.95, Math.max(0.05, l + dl));
    const [r, g, b] = hslToRgb(tint && s < 0.12 ? shift : h + shift, Math.min(1, s1 * ks), l2);
    data[i] = r; data[i + 1] = g; data[i + 2] = b;
  }
}
