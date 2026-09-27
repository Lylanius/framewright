/**
 * Video scopes computed from the preview picture: histogram, luma waveform and
 * vectorscope. Works on a small copy of the frame so it's cheap to run live.
 */
const sample = typeof document !== 'undefined' ? document.createElement('canvas') : null;

export interface ScopeData { w: number; h: number; px: Uint8ClampedArray }

export function grabFrame(src: HTMLCanvasElement, maxW = 256): ScopeData | null {
  if (!sample || !src.width) return null;
  const w = Math.min(maxW, src.width), h = Math.max(1, Math.round((src.height / src.width) * w));
  sample.width = w; sample.height = h;
  const ctx = sample.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, w, h);
  return { w, h, px: ctx.getImageData(0, 0, w, h).data };
}

function prep(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#07080c';
  ctx.fillRect(0, 0, c.width, c.height);
  return ctx;
}

export function drawHistogram(c: HTMLCanvasElement, d: ScopeData): void {
  const ctx = prep(c);
  const bins = [new Float32Array(256), new Float32Array(256), new Float32Array(256), new Float32Array(256)];
  for (let i = 0; i < d.px.length; i += 4) {
    const r = d.px[i], g = d.px[i + 1], b = d.px[i + 2];
    bins[0][r]++; bins[1][g]++; bins[2][b]++;
    bins[3][Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)]++;
  }
  let max = 1;
  for (const b of bins) for (let i = 1; i < 255; i++) max = Math.max(max, b[i]);
  const W = c.width, H = c.height;
  const colours = ['rgba(239,80,80,0.55)', 'rgba(80,210,110,0.55)', 'rgba(80,140,255,0.55)', 'rgba(230,230,230,0.35)'];
  ctx.globalCompositeOperation = 'lighter';
  bins.forEach((b, k) => {
    ctx.fillStyle = colours[k];
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let i = 0; i < 256; i++) ctx.lineTo((i / 255) * W, H - Math.min(1, Math.sqrt(b[i] / max)) * (H - 4));
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();
  });
}

export function drawWaveform(c: HTMLCanvasElement, d: ScopeData): void {
  const ctx = prep(c);
  const W = c.width, H = c.height;
  const img = ctx.createImageData(W, H);
  const acc = new Float32Array(W * H);
  for (let y = 0; y < d.h; y++) for (let x = 0; x < d.w; x++) {
    const i = (y * d.w + x) * 4;
    const l = 0.2126 * d.px[i] + 0.7152 * d.px[i + 1] + 0.0722 * d.px[i + 2];
    const cx = Math.floor((x / d.w) * W), cy = Math.round(H - 1 - (l / 255) * (H - 1));
    acc[cy * W + cx]++;
  }
  const k = 255 / Math.max(1, d.h * 0.12);
  for (let i = 0; i < acc.length; i++) {
    const v = Math.min(255, acc[i] * k);
    img.data[i * 4] = v * 0.55; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v * 0.6; img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.font = '9px monospace';
  for (const p of [0, 25, 50, 75, 100]) {
    const y = H - 1 - (p / 100) * (H - 1);
    ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); ctx.stroke();
    ctx.fillText(String(p), 2, Math.max(9, y - 2));
  }
}

export function drawVectorscope(c: HTMLCanvasElement, d: ScopeData): void {
  const ctx = prep(c);
  const S = Math.min(c.width, c.height), R = S / 2 - 6, cx = c.width / 2, cy = c.height / 2;
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const acc = new Float32Array(c.width * c.height);
  for (let i = 0; i < d.px.length; i += 4) {
    const r = d.px[i] / 255, g = d.px[i + 1] / 255, b = d.px[i + 2] / 255;
    const cb = -0.1146 * r - 0.3854 * g + 0.5 * b, cr = 0.5 * r - 0.4542 * g - 0.0458 * b;
    const x = Math.round(cx + cb * 2 * R), y = Math.round(cy - cr * 2 * R);
    if (x >= 0 && y >= 0 && x < c.width && y < c.height) acc[y * c.width + x]++;
  }
  for (let i = 0; i < acc.length; i++) if (acc[i]) {
    const v = Math.min(255, 60 + acc[i] * 40);
    img.data[i * 4] = v * 0.6; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v * 0.7;
  }
  ctx.putImageData(img, 0, 0);
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
  // Colour targets (75% primaries) and the skin-tone line.
  const targets: [string, number, number, number][] = [['R', 0.75, 0, 0], ['G', 0, 0.75, 0], ['B', 0, 0, 0.75], ['Cy', 0, 0.75, 0.75], ['Mg', 0.75, 0, 0.75], ['Yl', 0.75, 0.75, 0]];
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '9px monospace';
  for (const [n, r, g, b] of targets) {
    const cb = -0.1146 * r - 0.3854 * g + 0.5 * b, cr = 0.5 * r - 0.4542 * g - 0.0458 * b;
    const x = cx + cb * 2 * R, y = cy - cr * 2 * R;
    ctx.strokeRect(x - 4, y - 4, 8, 8);
    ctx.fillText(n, x + 6, y + 3);
  }
  ctx.strokeStyle = 'rgba(242,181,68,0.5)';
  const skin = (123 * Math.PI) / 180;
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(skin) * R, cy - Math.sin(skin) * R); ctx.stroke();
}
