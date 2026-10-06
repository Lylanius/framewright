/**
 * Draws vector shapes and emoji stickers into a (cached) layer canvas.
 * Sizes are project pixels × render scale, so they stay sharp at any export size.
 */
import type { Placeholder, ShapeStyle } from '../core/types';

const cache = new Map<string, HTMLCanvasElement>();

export function shapePath(ctx: CanvasRenderingContext2D, s: ShapeStyle, w: number, h: number, pad: number): void {
  const x0 = pad, y0 = pad, x1 = w - pad, y1 = h - pad, cx = w / 2, cy = h / 2;
  const rw = (x1 - x0) / 2, rh = (y1 - y0) / 2;
  ctx.beginPath();
  switch (s.type) {
    case 'rect': ctx.roundRect(x0, y0, x1 - x0, y1 - y0, Math.min(s.radius, rw, rh)); break;
    case 'ellipse': ctx.ellipse(cx, cy, rw, rh, 0, 0, Math.PI * 2); break;
    case 'triangle': ctx.moveTo(cx, y0); ctx.lineTo(x1, y1); ctx.lineTo(x0, y1); ctx.closePath(); break;
    case 'star':
    case 'burst': {
      const n = Math.max(3, Math.round(s.points ?? (s.type === 'star' ? 5 : 14)));
      const inner = s.type === 'star' ? 0.45 : 0.72;
      for (let i = 0; i < n * 2; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / n;
        const r = i % 2 ? inner : 1;
        const px = cx + Math.cos(a) * rw * r, py = cy + Math.sin(a) * rh * r;
        if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      }
      ctx.closePath();
      break;
    }
    case 'heart': {
      const top = y0 + (y1 - y0) * 0.28;
      ctx.moveTo(cx, y1);
      ctx.bezierCurveTo(cx - rw * 0.2, y1 - (y1 - y0) * 0.18, x0, top + (y1 - y0) * 0.28, x0, top);
      ctx.bezierCurveTo(x0, y0 - (y1 - y0) * 0.05, cx - rw * 0.05, y0, cx, top);
      ctx.bezierCurveTo(cx + rw * 0.05, y0, x1, y0 - (y1 - y0) * 0.05, x1, top);
      ctx.bezierCurveTo(x1, top + (y1 - y0) * 0.28, cx + rw * 0.2, y1 - (y1 - y0) * 0.18, cx, y1);
      ctx.closePath();
      break;
    }
    case 'arrow': {
      const shaft = (y1 - y0) * 0.36, head = (x1 - x0) * 0.38;
      ctx.moveTo(x0, cy - shaft / 2); ctx.lineTo(x1 - head, cy - shaft / 2); ctx.lineTo(x1 - head, y0);
      ctx.lineTo(x1, cy); ctx.lineTo(x1 - head, y1); ctx.lineTo(x1 - head, cy + shaft / 2); ctx.lineTo(x0, cy + shaft / 2);
      ctx.closePath();
      break;
    }
    case 'line': ctx.roundRect(x0, y0, x1 - x0, Math.max(2, y1 - y0), Math.max(1, (y1 - y0) / 2)); break;
    case 'bubble': {
      const tail = (y1 - y0) * 0.22, bh = y1 - y0 - tail, r = Math.min(s.radius, rw, bh / 2);
      ctx.roundRect(x0, y0, x1 - x0, bh, r);
      ctx.moveTo(x0 + (x1 - x0) * 0.22, y0 + bh - 1);
      ctx.lineTo(x0 + (x1 - x0) * 0.16, y1);
      ctx.lineTo(x0 + (x1 - x0) * 0.4, y0 + bh - 1);
      ctx.closePath();
      break;
    }
    default: ctx.rect(x0, y0, x1 - x0, y1 - y0);
  }
}

/** Shape/emoji layer at render scale `S` (cached; shapes rarely change between frames). */
/** Shapes whose picture changes over time. */
export function isAnimatedShape(s: ShapeStyle): boolean {
  return s.type === 'countdown' || s.type === 'sparkles' || (!!s.animate && (isBackgroundShape(s) || s.type === 'starburst'));
}

/** Full-frame backgrounds (drawn edge to edge, no padding). */
export function isBackgroundShape(s: ShapeStyle): boolean {
  return s.type === 'speedlines' || s.type === 'rays' || s.type === 'dots' || s.type === 'gradient' || s.type === 'streaks';
}

/**
 * Comic "explosion" burst: a white core with jagged spikes of uneven length
 * fading to the edge colour. When animated the spikes shimmer gently.
 */
function drawStarburst(ctx: CanvasRenderingContext2D, s: ShapeStyle, w: number, h: number, pad: number, t: number): void {
  const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - pad;
  const n = Math.max(12, Math.round(s.points ?? 72));
  // One jagged ring of spikes: lengths and widths vary so it looks hand-drawn.
  const layer = (seed: number, count: number, inner: number, minLen: number, maxLen: number, width: number, colour: string, phase: number) => {
    const rand = rng(seed);
    ctx.fillStyle = colour;
    ctx.beginPath();
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + (rand() - 0.5) * (Math.PI / count);
      const len = minLen + Math.pow(rand(), 1.6) * (maxLen - minLen);
      const half = (Math.PI / count) * width * (0.6 + rand() * 0.9);
      const ph = rand() * 6.28;
      const wob = s.animate ? 1 + 0.045 * Math.sin(t * 6 + ph + phase) : 1;
      const r = R * len * wob, base = R * inner;
      ctx.moveTo(cx + Math.cos(a - half) * base, cy + Math.sin(a - half) * base);
      ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      ctx.lineTo(cx + Math.cos(a + half) * base, cy + Math.sin(a + half) * base);
      ctx.closePath();
    }
    ctx.fill();
    ctx.beginPath(); ctx.arc(cx, cy, R * inner * 1.02, 0, Math.PI * 2); ctx.fill();
  };
  const core = s.fill2 ?? '#ffffff';
  layer(31, n, 0.42, 0.55, 1, 2.6, s.fill, 0);                       // bold outer spikes
  layer(47, Math.round(n * 0.6), 0.3, 0.55, 0.95, 1.2, s.fill, 2);  // a few long thin ones
  layer(59, n, 0.3, 0.42, 0.72, 2.2, s.color2 ?? '#9fd0ff', 4);      // lighter inner spikes
  layer(71, n, 0.2, 0.3, 0.58, 2.0, core, 1);                         // white core spikes
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.38);
  glow.addColorStop(0, core); glow.addColorStop(0.7, core); glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow;
  ctx.beginPath(); ctx.arc(cx, cy, R * 0.38, 0, Math.PI * 2); ctx.fill();
}

/**
 * "Shiny" sparkles: four-point stars twinkling around the edge of the box (the
 * middle is left clear for whatever they're celebrating). Each one fades in,
 * turns a little and fades out on its own rhythm.
 */
function drawSparkles(ctx: CanvasRenderingContext2D, s: ShapeStyle, w: number, h: number, pad: number, t: number): void {
  const n = Math.max(4, Math.round(s.points ?? 14)), rand = rng(83);
  const iw = w - pad * 2, ih = h - pad * 2, unit = Math.min(iw, ih);
  for (let i = 0; i < n; i++) {
    // Spread round the border: pick a spot on the rectangle's edge, pulled in a little.
    const u = (i + rand() * 0.8) / n, inset = 0.04 + rand() * 0.16;
    const per = u * 4, side = Math.floor(per) % 4, f = per - Math.floor(per);
    const ex = side === 0 ? f : side === 1 ? 1 : side === 2 ? 1 - f : 0, ey = side === 0 ? 0 : side === 1 ? f : side === 2 ? 1 : 1 - f;
    const x = pad + iw * (ex + (0.5 - ex) * inset * 2), y = pad + ih * (ey + (0.5 - ey) * inset * 2);
    const size = unit * (0.045 + rand() * 0.075), speed = 1.1 + rand() * 1.3, phase = rand();
    const cyc = ((s.animate === false ? 0.25 : t * speed) + phase) % 1;
    const a = Math.sin(Math.PI * cyc) ** 1.5; // twinkle: in and out
    if (a < 0.02) continue;
    const r = size * (0.45 + 0.55 * a), rot = cyc * 0.9 + rand() * 0.6;
    ctx.save();
    ctx.translate(x, y); ctx.rotate(rot); ctx.globalAlpha = a;
    ctx.shadowColor = s.fill2 ?? '#fff3a0'; ctx.shadowBlur = r * 0.9;
    ctx.fillStyle = i % 3 === 0 ? (s.fill2 ?? '#fff3a0') : s.fill;
    ctx.beginPath();
    for (let k = 0; k < 8; k++) { const rr = k % 2 ? r * 0.22 : r, an = (k / 8) * Math.PI * 2; ctx[k ? 'lineTo' : 'moveTo'](Math.cos(an) * rr, Math.sin(an) * rr); }
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }
}

/** Deterministic pseudo-random numbers (same picture in preview and export). */
function rng(seed: number): () => number {
  let x = (seed * 2654435761) >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}

function drawBackground(ctx: CanvasRenderingContext2D, s: ShapeStyle, w: number, h: number, t: number): void {
  const cx = w / 2, cy = h / 2, R = Math.hypot(w, h) / 2;
  const base = (): void => {
    if (s.fill2) {
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
      g.addColorStop(0, s.fill2); g.addColorStop(1, s.fill);
      ctx.fillStyle = g;
    } else ctx.fillStyle = s.fill;
    ctx.fillRect(0, 0, w, h);
  };
  switch (s.type) {
    case 'gradient': {
      const a = (((s.angle ?? 160) + (s.animate ? t * 20 : 0)) * Math.PI) / 180;
      const g = s.gradientKind === 'radial'
        ? ctx.createRadialGradient(cx, cy, 0, cx, cy, R)
        : ctx.createLinearGradient(cx - Math.cos(a) * R, cy - Math.sin(a) * R, cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      g.addColorStop(0, s.fill); g.addColorStop(1, s.fill2 ?? s.fill);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      break;
    }
    case 'rays': {
      base();
      const n = Math.max(4, Math.round(s.points ?? 18));
      const rot = s.animate ? t * 0.25 : 0;
      ctx.fillStyle = s.color2 ?? '#ffffff';
      for (let i = 0; i < n; i++) {
        const a0 = rot + (i * Math.PI * 2) / n, a1 = a0 + Math.PI / n;
        ctx.beginPath(); ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(a0) * R * 1.1, cy + Math.sin(a0) * R * 1.1);
        ctx.lineTo(cx + Math.cos(a1) * R * 1.1, cy + Math.sin(a1) * R * 1.1);
        ctx.closePath(); ctx.fill();
      }
      break;
    }
    case 'dots': {
      base();
      const step = Math.max(8, Math.min(w, h) / 22);
      const drift = s.animate ? (t * step * 0.6) % step : 0;
      ctx.fillStyle = s.color2 ?? 'rgba(255,255,255,0.35)';
      for (let y = -step; y < h + step; y += step) for (let x = -step; x < w + step; x += step) {
        const odd = Math.round(y / step) % 2 ? step / 2 : 0;
        const px = x + odd + drift, py = y + drift;
        const d = Math.hypot(px - cx, py - cy) / R;
        const r = step * 0.42 * (1 - d * 0.8);
        if (r > 0.5) { ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill(); }
      }
      break;
    }
    case 'streaks': {
      // Soft diagonal bands drifting across the colour, lighter towards the bottom (a "motion" backdrop).
      const vg = ctx.createLinearGradient(0, 0, 0, h);
      vg.addColorStop(0, s.fill); vg.addColorStop(0.65, s.fill); vg.addColorStop(1, s.fill2 ?? s.fill);
      ctx.fillStyle = vg; ctx.fillRect(0, 0, w, h);
      const ang = ((s.angle ?? -22) * Math.PI) / 180;
      ctx.save();
      ctx.translate(cx, cy); ctx.rotate(ang);
      const span = R * 2.2, rand = rng(13);
      const drift = s.animate ? t * 0.06 : 0;
      for (let i = 0; i < 18; i++) {
        const light = i % 3 !== 0;
        const bh = span * (0.02 + rand() * 0.07);
        let y = ((rand() + drift * (0.5 + rand())) % 1) * span - span / 2;
        if (y > span / 2) y -= span;
        const col = light ? (s.fill2 ?? '#ff5a3c') : (s.color2 ?? '#b30a18');
        // Soft top/bottom edges so the bands read as blurred motion, not stripes.
        const g = ctx.createLinearGradient(0, y, 0, y + bh);
        g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.5, col); g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.globalAlpha = 0.25 + rand() * 0.4;
        ctx.fillStyle = g;
        const x0 = -span / 2 + rand() * span * 0.3;
        ctx.fillRect(x0, y, span * (0.6 + rand() * 0.6), bh);
      }
      ctx.restore();
      ctx.globalAlpha = 1;
      break;
    }
    case 'speedlines': {
      // Manga-style focus lines: a bright centre with spikes flickering outwards.
      base();
      const rand = rng(s.animate ? Math.floor(t * 12) + 1 : 7);
      const inner = Math.min(w, h) * 0.2;
      const n = 150;
      const g = ctx.createRadialGradient(cx, cy, inner * 0.4, cx, cy, R * 0.8);
      g.addColorStop(0, '#ffffff'); g.addColorStop(0.35, s.color2 ?? '#3d7bff'); g.addColorStop(1, 'rgba(61,123,255,0)');
      ctx.fillStyle = g;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rand() * 0.05;
        const len = inner + R * (0.15 + rand() * 0.55);
        const wd = (0.006 + rand() * 0.018) * Math.PI;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a - wd) * inner * 0.6, cy + Math.sin(a - wd) * inner * 0.6);
        ctx.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
        ctx.lineTo(cx + Math.cos(a + wd) * inner * 0.6, cy + Math.sin(a + wd) * inner * 0.6);
        ctx.closePath(); ctx.fill();
      }
      const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, inner * 1.5);
      core.addColorStop(0, 'rgba(255,255,255,1)'); core.addColorStop(0.55, 'rgba(255,255,255,0.85)'); core.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = core;
      ctx.beginPath(); ctx.arc(cx, cy, inner * 1.5, 0, Math.PI * 2); ctx.fill();
      break;
    }
  }
}

function drawCountdown(ctx: CanvasRenderingContext2D, s: ShapeStyle, w: number, h: number, pad: number, S: number, local: number, duration: number): void {
  const left = Math.max(0, duration - local);
  const frac = duration > 0 ? left / duration : 0;
  const num = String(Math.max(0, Math.ceil(left - 1e-3)));
  const style = s.countStyle ?? 'ring';
  const cx = w / 2, cy = h / 2;
  if (style === 'bar') {
    const bh = h - pad * 2, bw = w - pad * 2, r = Math.min(bh / 2, s.radius * S);
    ctx.fillStyle = s.fill; ctx.beginPath(); ctx.roundRect(pad, pad, bw, bh, r); ctx.fill();
    ctx.fillStyle = s.stroke; ctx.beginPath(); ctx.roundRect(pad, pad, Math.max(bh, bw * frac), bh, r); ctx.fill();
    return;
  }
  const rad = Math.min(w, h) / 2 - pad - (s.strokeWidth * S) / 2;
  if (style === 'ring') {
    ctx.fillStyle = s.fill; ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = s.strokeWidth * S; ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = s.stroke; ctx.beginPath(); ctx.arc(cx, cy, rad, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac); ctx.stroke();
  }
  const fs = rad * (style === 'number' ? 1.5 : 1.05);
  ctx.font = `900 ${fs}px "Archivo Black", Figtree, system-ui, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if (style === 'number') { ctx.lineWidth = Math.max(2, fs * 0.08); ctx.strokeStyle = s.stroke; ctx.lineJoin = 'round'; ctx.strokeText(num, cx, cy + fs * 0.04); }
  ctx.fillStyle = s.textColor ?? '#ffffff';
  ctx.fillText(num, cx, cy + fs * 0.04);
}

/**
 * Shape/emoji/background layer at render scale `S`. Static shapes are cached;
 * animated ones (backgrounds, countdowns) are drawn for clip-local time `local`.
 */
export function renderShapeLayer(s: ShapeStyle, S: number, local = 0, duration = 1): HTMLCanvasElement {
  const animated = isAnimatedShape(s);
  const tKey = animated ? Math.round(local * 30) : 0;
  const key = JSON.stringify(s) + '|' + S.toFixed(3) + '|' + tKey + (s.type === 'countdown' ? `|${duration.toFixed(2)}` : '');
  const hit = cache.get(key);
  if (hit) return hit;
  const isBg = isBackgroundShape(s);
  const glow = s.glow ?? 0;
  const pad = isBg ? 0 : Math.ceil((s.strokeWidth / 2 + (s.shadow ?? 0) * 1.5 + glow * 1.6 + 2) * S);
  const w = Math.max(2, Math.round(s.width * S) + pad * 2), h = Math.max(2, Math.round(s.height * S) + pad * 2);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  if (isBg) drawBackground(ctx, s, w, h, local);
  else if (s.type === 'countdown') drawCountdown(ctx, s, w, h, pad, S, local, duration);
  else if (s.type === 'starburst') drawStarburst(ctx, s, w, h, pad, local);
  else if (s.type === 'sparkles') drawSparkles(ctx, s, w, h, pad, local);
  else if (s.type === 'emoji') {
    if (s.shadow) { ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = s.shadow * S; ctx.shadowOffsetY = s.shadow * S * 0.3; }
    const size = Math.min(w, h) - pad * 2;
    ctx.font = `${size * 0.86}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(s.emoji ?? '⭐', w / 2, h / 2 + size * 0.04);
  } else {
    if (s.shadow) { ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = s.shadow * S; ctx.shadowOffsetY = s.shadow * S * 0.3; }
    shapePath(ctx, s, w, h, pad);
    if (s.fill && s.fill !== 'transparent') {
      if (s.fill2) {
        const g = ctx.createLinearGradient(0, pad, 0, h - pad);
        g.addColorStop(0, s.fill); g.addColorStop(1, s.fill2);
        ctx.fillStyle = g;
      } else ctx.fillStyle = s.fill;
      ctx.fill();
    }
    ctx.shadowColor = 'transparent';
    ctx.shadowOffsetY = 0;
    if (s.strokeWidth > 0) {
      ctx.lineWidth = s.strokeWidth * S;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = s.stroke;
      if (glow > 0) {
        // Glow: blurred copies of the outline underneath, then the crisp outline.
        ctx.save();
        ctx.shadowColor = s.glowColor ?? s.stroke;
        ctx.shadowBlur = glow * S;
        ctx.stroke(); ctx.stroke();
        ctx.restore();
      }
      ctx.stroke();
    } else if (glow > 0 && s.fill !== 'transparent') {
      ctx.save(); ctx.globalCompositeOperation = 'destination-over'; ctx.shadowColor = s.glowColor ?? s.fill; ctx.shadowBlur = glow * S; ctx.fill(); ctx.restore();
    }
  }
  // Animated frames churn quickly: keep fewer of them.
  if (cache.size > (animated ? 60 : 200)) cache.delete(cache.keys().next().value!);
  cache.set(key, c);
  return c;
}

/** Striped "drop your clip here" slot shown in the preview for empty template slots. */
export function renderPlaceholder(p: Placeholder, W: number, H: number): HTMLCanvasElement {
  const key = `ph|${p.label}|${p.index}|${W}x${H}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = Math.max(2, Math.round(W)); c.height = Math.max(2, Math.round(H));
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#1b1f2a';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.strokeStyle = 'rgba(242,181,68,0.12)';
  ctx.lineWidth = Math.max(6, W / 60);
  for (let x = -c.height; x < c.width; x += ctx.lineWidth * 3) { ctx.beginPath(); ctx.moveTo(x, c.height); ctx.lineTo(x + c.height, 0); ctx.stroke(); }
  const f = Math.max(12, Math.min(W, H) / 11);
  ctx.fillStyle = '#f2b544';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `800 ${f * 1.6}px Figtree, system-ui, sans-serif`;
  ctx.fillText(`${p.index + 1}`, c.width / 2, c.height / 2 - f * 0.9);
  ctx.font = `700 ${f * 0.62}px Figtree, system-ui, sans-serif`;
  ctx.fillStyle = '#e7e9f0';
  ctx.fillText(p.label || 'Your clip here', c.width / 2, c.height / 2 + f * 0.5);
  ctx.font = `500 ${f * 0.42}px Figtree, system-ui, sans-serif`;
  ctx.fillStyle = 'rgba(231,233,240,0.6)';
  ctx.fillText('Select it, then pick a clip', c.width / 2, c.height / 2 + f * 1.15);
  cache.set(key, c);
  return c;
}
