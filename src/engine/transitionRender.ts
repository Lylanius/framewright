/**
 * Transition renderer. Given the outgoing (A) and incoming (B) clips already
 * drawn onto full-frame transparent layers, blend them for progress p (0..1).
 * Deterministic per frame so preview and export match.
 */
import type { TransitionInstance } from '../core/types';
import { blur, getNoise, rgbSplit } from './effectsRender';

type Ctx = CanvasRenderingContext2D;

const pool: HTMLCanvasElement[] = [];
function tmp(i: number, w: number, h: number): { c: HTMLCanvasElement; ctx: Ctx } {
  let c = pool[i];
  if (!c) { c = document.createElement('canvas'); pool[i] = c; }
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const ctx = c.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.clearRect(0, 0, w, h);
  return { c, ctx };
}

interface Place { dx?: number; dy?: number; scale?: number; rot?: number; alpha?: number; op?: GlobalCompositeOperation }

function put(ctx: Ctx, layer: CanvasImageSource, W: number, H: number, pl: Place = {}): void {
  ctx.save();
  ctx.globalAlpha = pl.alpha ?? 1;
  ctx.globalCompositeOperation = pl.op ?? 'source-over';
  ctx.translate(W / 2 + (pl.dx ?? 0), H / 2 + (pl.dy ?? 0));
  if (pl.rot) ctx.rotate(pl.rot);
  const s = pl.scale ?? 1;
  ctx.scale(s, s);
  ctx.drawImage(layer, -W / 2, -H / 2, W, H);
  ctx.restore();
}

/** Linear mix of two layers (correct for both opaque and transparent layers). */
function mix(ctx: Ctx, a: CanvasImageSource, b: CanvasImageSource, W: number, H: number, p: number, placeA: Place = {}, placeB: Place = {}): void {
  const t = tmp(0, W, H);
  put(t.ctx, a, W, H, { ...placeA, alpha: (placeA.alpha ?? 1) * (1 - p) });
  put(t.ctx, b, W, H, { ...placeB, alpha: (placeB.alpha ?? 1) * p, op: 'lighter' });
  ctx.drawImage(t.c, 0, 0);
}

function dirVec(dir: number): [number, number] {
  return [[-1, 0], [1, 0], [0, -1], [0, 1]][Math.round(dir) % 4] as [number, number];
}

function hash(n: number): number {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
}

/** Draw `b` through a mask built by `shape` (a path filled in white). */
function masked(ctx: Ctx, b: CanvasImageSource, W: number, H: number, shape: (m: Ctx) => void, softPx = 0): void {
  const t = tmp(1, W, H);
  t.ctx.drawImage(b, 0, 0, W, H);
  const m = tmp(2, W, H);
  if (softPx > 0) m.ctx.filter = `blur(${softPx}px)`;
  m.ctx.fillStyle = '#fff';
  shape(m.ctx);
  m.ctx.filter = 'none';
  t.ctx.globalCompositeOperation = 'destination-in';
  t.ctx.drawImage(m.c, 0, 0);
  ctx.drawImage(t.c, 0, 0);
}

export function renderTransition(
  ctx: Ctx, a: HTMLCanvasElement, b: HTMLCanvasElement, W: number, H: number,
  tr: TransitionInstance, p: number, frame: number, pxScale: number,
): void {
  const prm = tr.params;
  const bump = 1 - Math.abs(2 * p - 1); // 0 → 1 → 0
  switch (tr.type) {
    case 'dissolve':
    default:
      mix(ctx, a, b, W, H, p);
      return;
    case 'dip': {
      put(ctx, p < 0.5 ? a : b, W, H);
      ctx.save();
      ctx.globalAlpha = Math.min(1, bump * 1.05);
      ctx.fillStyle = tr.color ?? '#000';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
      return;
    }
    case 'fadeThrough': {
      put(ctx, p < 0.5 ? a : b, W, H);
      ctx.save();
      ctx.globalAlpha = Math.min(1, bump * 1.05);
      ctx.fillStyle = '#050505';
      ctx.fillRect(0, 0, W, H);
      const g = (prm.grain ?? 40) / 100;
      if (g > 0) {
        const pat = ctx.createPattern(getNoise(), 'repeat')!;
        pat.setTransform(new DOMMatrix().translate(hash(frame) * 256, hash(frame + 1) * 256).scale(Math.max(1, pxScale * 2)));
        ctx.globalAlpha = bump * g * 0.5;
        ctx.globalCompositeOperation = 'screen';
        ctx.fillStyle = pat;
        ctx.fillRect(0, 0, W, H);
      }
      ctx.restore();
      return;
    }
    case 'slide': {
      const [vx, vy] = dirVec(prm.dir ?? 0);
      put(ctx, a, W, H);
      put(ctx, b, W, H, { dx: -vx * (1 - p) * W, dy: -vy * (1 - p) * H });
      return;
    }
    case 'push': {
      const [vx, vy] = dirVec(prm.dir ?? 0);
      put(ctx, a, W, H, { dx: vx * p * W, dy: vy * p * H });
      put(ctx, b, W, H, { dx: -vx * (1 - p) * W, dy: -vy * (1 - p) * H });
      return;
    }
    case 'wipe': {
      const [vx, vy] = dirVec(prm.dir ?? 0);
      put(ctx, a, W, H);
      const soft = ((prm.soft ?? 20) / 100) * Math.max(W, H) * 0.25;
      const edge = p * ((vx ? W : H) + soft); // distance travelled from the leading side
      const t = tmp(1, W, H);
      t.ctx.drawImage(b, 0, 0);
      // Leading side: the incoming picture enters from the side opposite the direction of travel.
      const [x0, y0, x1, y1] = vx < 0 ? [W, 0, 0, 0] : vx > 0 ? [0, 0, W, 0] : vy < 0 ? [0, H, 0, 0] : [0, 0, 0, H];
      const len = vx ? W : H;
      const g = t.ctx.createLinearGradient(x0, y0, x1, y1);
      const e1 = Math.max(0, Math.min(1, (edge - soft) / len)), e2 = Math.max(0, Math.min(1, edge / len));
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(e1, 'rgba(0,0,0,1)');
      g.addColorStop(Math.max(e1, e2), 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      t.ctx.globalCompositeOperation = 'destination-in';
      t.ctx.fillStyle = g;
      t.ctx.fillRect(0, 0, W, H);
      ctx.drawImage(t.c, 0, 0);
      return;
    }
    case 'zoomIn': {
      const amt = (prm.amount ?? 120) / 100;
      mix(ctx, a, b, W, H, p, { scale: 1 + amt * p }, { scale: 1 / (1 + amt * 0.35 * (1 - p)) });
      return;
    }
    case 'zoomOut': {
      const amt = (prm.amount ?? 120) / 100;
      mix(ctx, a, b, W, H, p, { scale: 1 / (1 + amt * p) }, { scale: 1 + amt * 0.5 * (1 - p) });
      return;
    }
    case 'spin': {
      const dir = (prm.clockwise ?? 1) >= 1 ? 1 : -1;
      const turns = (prm.turns ?? 1) * Math.PI * 2 * dir;
      mix(ctx, a, b, W, H, p, { rot: turns * p, scale: 1 - 0.5 * p }, { rot: -turns * (1 - p), scale: 1 - 0.5 * (1 - p) });
      return;
    }
    case 'blur': {
      const amt = (prm.amount ?? 30) * pxScale;
      const ta = tmp(3, W, H); ta.ctx.drawImage(a, 0, 0); blur(ta.c, ta.ctx, amt * p);
      const tb = tmp(4, W, H); tb.ctx.drawImage(b, 0, 0); blur(tb.c, tb.ctx, amt * (1 - p));
      mix(ctx, ta.c, tb.c, W, H, p);
      return;
    }
    case 'ripple': {
      const amp = ((prm.amount ?? 40) / 100) * W * 0.08 * bump;
      const t = tmp(3, W, H);
      mix(t.ctx, a, b, W, H, p);
      const band = Math.max(2, Math.round(4 * pxScale));
      for (let y = 0; y < H; y += band) {
        const off = Math.sin(y / H * Math.PI * 8 + p * Math.PI * 4) * amp;
        ctx.drawImage(t.c, 0, y, W, band, off, y, W, band);
      }
      return;
    }
    case 'glitch': {
      const k = (prm.amount ?? 60) / 100;
      const src = p < 0.5 ? a : b;
      const t = tmp(3, W, H);
      t.ctx.drawImage(src, 0, 0);
      if (bump > 0.15) rgbSplit(t.c, t.ctx, bump * k * 24 * pxScale, hash(frame) * 360);
      const slices = Math.round(2 + 10 * k * bump);
      ctx.drawImage(t.c, 0, 0);
      for (let i = 0; i < slices; i++) {
        const sy = Math.floor(hash(frame * 13 + i) * H);
        const sh = Math.max(2, Math.floor(hash(frame * 17 + i) * H * 0.1));
        const off = (hash(frame * 19 + i) - 0.5) * W * 0.2 * k * bump;
        ctx.drawImage(t.c, 0, sy, W, sh, off, sy, W, sh);
      }
      return;
    }
    case 'flash': {
      mix(ctx, a, b, W, H, p < 0.4 ? 0 : p > 0.6 ? 1 : (p - 0.4) / 0.2);
      ctx.save();
      ctx.globalAlpha = Math.pow(bump, 1.5) * ((prm.amount ?? 90) / 100);
      ctx.fillStyle = tr.color ?? '#fff';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
      return;
    }
    case 'burn': {
      mix(ctx, a, b, W, H, p);
      ctx.save();
      const g = ctx.createRadialGradient(W * (0.2 + 0.6 * p), H * 0.3, 0, W * (0.2 + 0.6 * p), H * 0.3, Math.max(W, H) * 0.9);
      g.addColorStop(0, tr.color ?? '#ffb347');
      g.addColorStop(0.5, 'rgba(255,90,40,0.6)');
      g.addColorStop(1, 'rgba(255,40,0,0)');
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = bump * ((prm.amount ?? 70) / 100);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
      return;
    }
    case 'iris': {
      put(ctx, a, W, H);
      const r = p * Math.hypot(W, H) / 2 * 1.05;
      masked(ctx, b, W, H, (m) => { m.beginPath(); m.arc(W / 2, H / 2, r, 0, Math.PI * 2); m.fill(); }, ((prm.soft ?? 10) / 100) * 40 * pxScale);
      return;
    }
    case 'diamond': {
      put(ctx, a, W, H);
      const r = p * (W + H) / 2 * 1.05;
      masked(ctx, b, W, H, (m) => { m.beginPath(); m.moveTo(W / 2, H / 2 - r); m.lineTo(W / 2 + r, H / 2); m.lineTo(W / 2, H / 2 + r); m.lineTo(W / 2 - r, H / 2); m.closePath(); m.fill(); }, ((prm.soft ?? 10) / 100) * 40 * pxScale);
      return;
    }
    case 'clock': {
      put(ctx, a, W, H);
      const cw = (prm.clockwise ?? 1) >= 1;
      const R = Math.hypot(W, H);
      masked(ctx, b, W, H, (m) => {
        m.beginPath();
        m.moveTo(W / 2, H / 2);
        const s = -Math.PI / 2;
        m.arc(W / 2, H / 2, R, s, s + (cw ? 1 : -1) * p * Math.PI * 2, !cw);
        m.closePath();
        m.fill();
      });
      return;
    }
    case 'whip': {
      const [vx, vy] = dirVec(prm.dir ?? 0);
      const streak = (prm.streak ?? 60) / 100;
      const e = p; // already eased
      const steps = 5;
      for (const [layer, base] of [[a, e], [b, e - 1]] as [HTMLCanvasElement, number][]) {
        for (let i = 0; i < steps; i++) {
          const o = base + (i / steps) * 0.12 * streak * bump;
          put(ctx, layer, W, H, { dx: vx * o * W, dy: vy * o * H, alpha: i === 0 ? 1 : 0.35 * streak * bump });
        }
      }
      return;
    }
    case 'bars': {
      put(ctx, p < 0.5 ? a : b, W, H);
      const h = bump * H / 2 * 1.02;
      ctx.save();
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, h);
      ctx.fillRect(0, H - h, W, h);
      ctx.restore();
      return;
    }
  }
}

