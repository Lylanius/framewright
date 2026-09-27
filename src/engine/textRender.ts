/**
 * Text layer renderer. Draws a TextStyle into an offscreen canvas (cached),
 * and works out the in/out animation state for a given clip-local time.
 */
import type { TextAnimation, TextStyle } from '../core/types';

export interface TextAnimState {
  opacity: number;
  /** Vertical offset as a fraction of the text block height. */
  dy: number;
  scale: number;
  /** Fraction of characters/words revealed (typewriter / word-by-word). */
  reveal: number;
}

function easeOutBack(x: number): number {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}
const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);

function applyAnim(kind: TextAnimation, x: number, state: TextAnimState, entering: boolean): void {
  // x: 0 = fully hidden side, 1 = fully visible
  switch (kind) {
    case 'none': return;
    case 'fade': state.opacity *= easeOut(x); return;
    case 'pop': state.opacity *= Math.min(1, x * 2); state.scale *= entering ? 0.4 + 0.6 * easeOutBack(x) : 0.7 + 0.3 * x; return;
    case 'slideUp': state.opacity *= easeOut(x); state.dy += (1 - easeOut(x)) * (entering ? 0.8 : -0.8); return;
    case 'slideDown': state.opacity *= easeOut(x); state.dy += (1 - easeOut(x)) * (entering ? -0.8 : 0.8); return;
    case 'typewriter':
    case 'wordByWord': state.reveal = Math.min(state.reveal, x); return;
  }
}

export function textAnimState(style: TextStyle, local: number, duration: number): TextAnimState {
  const s: TextAnimState = { opacity: 1, dy: 0, scale: 1, reveal: 1 };
  const d = Math.max(0.01, Math.min(style.animDuration, duration / 2));
  const revealAnim = style.animIn === 'typewriter' || style.animIn === 'wordByWord';
  // Typewriter/word reveals take longer so they read naturally.
  const inDur = revealAnim ? Math.min(duration * 0.6, Math.max(d, style.content.length * 0.045)) : d;
  if (style.animIn !== 'none' && local < inDur) applyAnim(style.animIn, Math.max(0, local / inDur), s, true);
  if (style.animOut !== 'none' && local > duration - d) applyAnim(style.animOut, Math.max(0, (duration - local) / d), s, false);
  return s;
}

export interface TextLayer {
  canvas: HTMLCanvasElement;
  /** Size in output pixels. */
  width: number;
  height: number;
}

const cache = new Map<string, TextLayer>();
const CACHE_MAX = 40;

function fontString(st: TextStyle, px: number): string {
  return `${st.italic ? 'italic ' : ''}${st.fontWeight} ${px}px "${st.fontFamily}", "Figtree", system-ui, sans-serif`;
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(/(\s+)/).filter((w) => w.length);
    let line = '';
    for (const w of words) {
      const test = line + w;
      if (line && ctx.measureText(test.trimEnd()).width > maxWidth && w.trim()) {
        out.push(line.trimEnd());
        line = w.trimStart();
      } else line = test;
    }
    out.push(line.trimEnd());
  }
  return out;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Truncate the revealed portion for typewriter / word-by-word animations. */
function revealText(lines: string[], reveal: number, mode: TextAnimation): string[] {
  if (reveal >= 1) return lines;
  if (mode === 'wordByWord') {
    const words = lines.map((l) => l.split(' '));
    const total = words.reduce((a, w) => a + w.length, 0);
    let left = Math.ceil(reveal * total);
    return words.map((ws) => {
      const take = Math.max(0, Math.min(ws.length, left));
      left -= take;
      return ws.slice(0, take).join(' ');
    });
  }
  const total = lines.reduce((a, l) => a + l.length, 0);
  let left = Math.floor(reveal * total);
  return lines.map((l) => {
    const take = Math.max(0, Math.min(l.length, left));
    left -= take;
    return l.slice(0, take);
  });
}

/**
 * Inline colour markup: `{#ffcc00|A)} Charmander` colours "A)" yellow.
 * Returns the plain text and a colour per character (null = the text colour).
 */
export function parseColourRuns(text: string): { plain: string; colours: (string | null)[] | null } {
  if (!text.includes('{')) return { plain: text, colours: null };
  const re = /\{(#[0-9a-fA-F]{3,8}|[a-zA-Z]+)\|([^{}]*)\}/g;
  let plain = '', last = 0, any = false;
  const colours: (string | null)[] = [];
  for (const m of text.matchAll(re)) {
    const before = text.slice(last, m.index);
    plain += before; colours.push(...Array(before.length).fill(null));
    plain += m[2]; colours.push(...Array(m[2].length).fill(m[1]));
    last = (m.index ?? 0) + m[0].length;
    any = true;
  }
  const rest = text.slice(last);
  plain += rest; colours.push(...Array(rest.length).fill(null));
  return any ? { plain, colours } : { plain: text, colours: null };
}

/**
 * Render text at `scale` output pixels per project pixel. `canvasWidth` is the
 * project width (for box wrapping).
 */
export function renderTextLayer(style: TextStyle, canvasWidth: number, scale: number, reveal = 1, activeWord = -1): TextLayer {
  const revealMode = style.animIn === 'wordByWord' ? 'wordByWord' : 'typewriter';
  const revealKey = reveal >= 1 ? 1 : Math.round(reveal * 200) / 200;
  const hl = style.highlightMode && style.highlightMode !== 'none' ? style.highlightMode : null;
  const key = JSON.stringify([style, canvasWidth, Math.round(scale * 1000), revealKey, hl ? activeWord : -1]);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const px = style.fontSize * scale;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  ctx.font = fontString(style, px);
  const ls = style.letterSpacing * scale;
  const supportsLS = 'letterSpacing' in ctx;
  if (supportsLS) (ctx as unknown as { letterSpacing: string }).letterSpacing = `${ls}px`;
  const runs = parseColourRuns(style.content);
  const upper = style.uppercase ? runs.plain.toUpperCase() : runs.plain;
  const content = upper;
  // Colour runs only survive if upper-casing didn't change the length (e.g. ß → SS).
  const charColours = runs.colours && upper.length === runs.plain.length ? runs.colours : null;
  const maxW = Math.max(px, style.boxWidth * canvasWidth * scale);
  const allLines = wrapLines(ctx, content, maxW);
  // Where each wrapped line starts in the plain text (for colour runs).
  const lineStart: number[] = [];
  { let pos = 0; for (const l of allLines) { const i = l ? content.indexOf(l, pos) : pos; lineStart.push(i < 0 ? pos : i); pos = (i < 0 ? pos : i) + l.length; } }
  const lines = revealText(allLines, reveal, revealMode);
  const lineH = px * style.lineHeight;
  const widths = allLines.map((l) => ctx.measureText(l).width);
  const blockW = style.backgroundFull && style.background ? Math.max(maxW, ...widths) : Math.max(1, ...widths);
  const bgPad = style.background ? style.backgroundPadding * scale + (style.backgroundBorderWidth ?? 0) * scale : 0;
  const fx = (style.strokeWidth + Math.max(style.shadowBlur, style.glow) * 1.5) * scale +
    Math.max(Math.abs(style.shadowOffsetX), Math.abs(style.shadowOffsetY)) * scale;
  const margin = Math.ceil(bgPad + fx + 4);
  const w = Math.ceil(blockW + margin * 2);
  const h = Math.ceil(lineH * allLines.length + margin * 2);
  canvas.width = Math.min(8192, w);
  canvas.height = Math.min(8192, h);
  // resizing resets state
  ctx.font = fontString(style, px);
  if (supportsLS) (ctx as unknown as { letterSpacing: string }).letterSpacing = `${ls}px`;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';

  const xFor = (i: number) => {
    if (style.align === 'left') return margin;
    if (style.align === 'right') return margin + blockW - widths[i];
    return margin + (blockW - widths[i]) / 2;
  };
  const yFor = (i: number) => margin + lineH * i + lineH / 2;

  // Per-line rounded backgrounds (sized to the full line so reveals don't jump).
  if (style.background) {
    const bw = (style.backgroundBorderWidth ?? 0) * scale;
    const paint = () => {
      ctx.fillStyle = style.background!;
      ctx.fill();
      if (bw > 0 && style.backgroundBorder) { ctx.lineWidth = bw; ctx.strokeStyle = style.backgroundBorder; ctx.stroke(); }
    };
    if (style.backgroundFull) {
      // Buttons: a little taller than per-line labels.
      roundRect(ctx, margin - bgPad + bw / 2, margin - bgPad * 0.7 + bw / 2, blockW + bgPad * 2 - bw, lineH * allLines.length + bgPad * 1.4 - bw, style.backgroundRadius * scale);
      paint();
    } else {
      allLines.forEach((l, i) => {
        if (!l.trim()) return;
        roundRect(ctx, xFor(i) - bgPad + bw / 2, yFor(i) - lineH / 2 - bgPad * 0.35 + bw / 2, widths[i] + bgPad * 2 - bw, lineH + bgPad * 0.7 - bw, style.backgroundRadius * scale);
        paint();
      });
    }
  }

  let fill: string | CanvasGradient = style.color;
  if (style.gradient) {
    const g = ctx.createLinearGradient(0, margin, 0, h - margin);
    g.addColorStop(0, style.gradient.from);
    g.addColorStop(1, style.gradient.to);
    fill = g;
  }

  // Word geometry for spoken-word highlighting.
  const boxes: { i: number; x: number; y: number; w: number; text: string; shown: boolean }[] = [];
  if (hl && activeWord >= 0) {
    allLines.forEach((line, i) => {
      for (const m of line.matchAll(/\S+/g)) {
        const idx = m.index ?? 0;
        boxes.push({ i, x: xFor(i) + ctx.measureText(line.slice(0, idx)).width, y: yFor(i), w: ctx.measureText(m[0]).width, text: m[0], shown: idx + m[0].length <= (lines[i]?.length ?? 0) });
      }
    });
    const b = boxes[activeWord];
    if (hl === 'box' && b?.shown) {
      ctx.save();
      ctx.fillStyle = style.highlightColor ?? '#7c4dff';
      const padX = px * 0.16, padY = px * 0.1;
      roundRect(ctx, b.x - padX, b.y - px * 0.5 - padY, b.w + padX * 2, px + padY * 2, px * 0.22);
      ctx.fill();
      ctx.restore();
    }
  }
  const drawWord = (b: (typeof boxes)[number], color: string) => {
    if (style.strokeWidth > 0) {
      ctx.strokeStyle = style.strokeColor;
      ctx.lineWidth = style.strokeWidth * 2 * scale;
      ctx.strokeText(b.text, b.x, b.y);
    }
    ctx.fillStyle = color;
    ctx.fillText(b.text, b.x, b.y);
  };

  /** Fill a line, switching colour where the colour markup says so. */
  const fillLine = (l: string, i: number, x: number, y: number) => {
    if (!charColours) { ctx.fillStyle = fill; ctx.fillText(l, x, y); return; }
    const start = lineStart[i];
    let k = 0, cx = x;
    while (k < l.length) {
      const col = charColours[start + k] ?? null;
      let e = k + 1;
      while (e < l.length && (charColours[start + e] ?? null) === col) e++;
      const part = l.slice(k, e);
      ctx.fillStyle = col ?? fill;
      ctx.fillText(part, cx, y);
      cx += ctx.measureText(part).width;
      k = e;
    }
  };

  lines.forEach((l, i) => {
    if (!l) return;
    const x = xFor(i), y = yFor(i);
    ctx.textAlign = 'left';
    if (style.glow > 0) {
      ctx.save();
      ctx.shadowColor = style.shadowColor || style.color;
      ctx.shadowBlur = style.glow * scale;
      ctx.fillStyle = fill;
      for (let k = 0; k < 2; k++) ctx.fillText(l, x, y);
      ctx.restore();
    }
    if (style.strokeWidth > 0) {
      ctx.save();
      if (style.shadowBlur > 0 || style.shadowOffsetX || style.shadowOffsetY) {
        ctx.shadowColor = style.shadowColor;
        ctx.shadowBlur = style.shadowBlur * scale;
        ctx.shadowOffsetX = style.shadowOffsetX * scale;
        ctx.shadowOffsetY = style.shadowOffsetY * scale;
      }
      ctx.strokeStyle = style.strokeColor;
      ctx.lineWidth = style.strokeWidth * 2 * scale;
      ctx.strokeText(l, x, y);
      ctx.restore();
      fillLine(l, i, x, y);
    } else {
      ctx.save();
      if (style.glow <= 0 && (style.shadowBlur > 0 || style.shadowOffsetX || style.shadowOffsetY)) {
        ctx.shadowColor = style.shadowColor;
        ctx.shadowBlur = style.shadowBlur * scale;
        ctx.shadowOffsetX = style.shadowOffsetX * scale;
        ctx.shadowOffsetY = style.shadowOffsetY * scale;
      }
      fillLine(l, i, x, y);
      ctx.restore();
    }
  });

  if (hl && activeWord >= 0 && boxes.length) {
    ctx.save();
    ctx.textAlign = 'left';
    const col = style.highlightColor ?? '#ffd23f';
    if (hl === 'color') { const b = boxes[activeWord]; if (b?.shown) drawWord(b, col); }
    if (hl === 'box') { const b = boxes[activeWord]; if (b?.shown && style.highlightTextColor) drawWord(b, style.highlightTextColor); }
    if (hl === 'karaoke') boxes.slice(0, activeWord + 1).forEach((b) => b.shown && drawWord(b, col));
    if (hl === 'underline') {
      const b = boxes[activeWord];
      if (b?.shown) { ctx.fillStyle = col; roundRect(ctx, b.x, b.y + px * 0.52, b.w, Math.max(2, px * 0.1), px * 0.05); ctx.fill(); }
    }
    ctx.restore();
  }

  const layer = { canvas, width: canvas.width, height: canvas.height };
  cache.set(key, layer);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return layer;
}

export function clearTextCache(): void {
  cache.clear();
}
