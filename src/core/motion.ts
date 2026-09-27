/**
 * Preset motion for any visual clip: an entrance, an exit and an optional
 * loop (stickers bobbing, logos pulsing…). Pure maths, shared by preview and
 * export. Offsets are fractions of the frame; rotation in degrees.
 */
import type { ClipMotion, MotionIn, MotionLoop } from './types';

export interface MotionState { opacity: number; dx: number; dy: number; scale: number; rot: number }

export const MOTION_IN: { id: MotionIn; label: string }[] = [
  { id: 'none', label: 'None' }, { id: 'fade', label: 'Fade' }, { id: 'pop', label: 'Pop' }, { id: 'zoom', label: 'Zoom' }, { id: 'slam', label: 'Slam in' },
  { id: 'slideUp', label: 'Slide up' }, { id: 'slideDown', label: 'Slide down' }, { id: 'slideLeft', label: 'Slide left' },
  { id: 'slideRight', label: 'Slide right' }, { id: 'spin', label: 'Spin' }, { id: 'drop', label: 'Drop & bounce' },
];
export const MOTION_LOOP: { id: MotionLoop; label: string }[] = [
  { id: 'none', label: 'None' }, { id: 'pulse', label: 'Pulse' }, { id: 'wiggle', label: 'Wiggle' }, { id: 'bounce', label: 'Bounce' },
  { id: 'float', label: 'Float' }, { id: 'spin', label: 'Spin' }, { id: 'shake', label: 'Shake' }, { id: 'swing', label: 'Swing' },
];

export function defaultMotion(): ClipMotion {
  return { in: 'pop', out: 'fade', loop: 'none', duration: 0.4, speed: 1 };
}

const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);
const backOut = (x: number) => { const c = 1.9; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };
function bounceOut(x: number): number {
  const n = 7.5625, d = 2.75;
  if (x < 1 / d) return n * x * x;
  if (x < 2 / d) return n * (x -= 1.5 / d) * x + 0.75;
  if (x < 2.5 / d) return n * (x -= 2.25 / d) * x + 0.9375;
  return n * (x -= 2.625 / d) * x + 0.984375;
}

/** Contribution of an entrance (p: 0 = start → 1 = settled). Exits use the same shapes in reverse. */
function entrance(kind: MotionIn, p: number, exit: boolean): MotionState {
  const s: MotionState = { opacity: 1, dx: 0, dy: 0, scale: 1, rot: 0 };
  if (kind === 'none' || p >= 1) return s;
  const e = easeOut(p);
  switch (kind) {
    case 'fade': s.opacity = e; break;
    case 'pop': s.scale = exit ? e : backOut(p); s.opacity = Math.min(1, p * 3); break;
    case 'zoom': s.scale = 0.3 + 0.7 * e; s.opacity = e; break;
    case 'slam':
      s.scale = exit ? 1 + (1 - e) * 2 : 1 + 2.5 * Math.pow(1 - p, 3) - (p > 0.7 ? 0.06 * Math.sin(((p - 0.7) / 0.3) * Math.PI) : 0);
      s.opacity = exit ? e : Math.min(1, p * 5);
      break;
    case 'slideUp': s.dy = (1 - e) * 0.25 * (exit ? -1 : 1); s.opacity = e; break;
    case 'slideDown': s.dy = -(1 - e) * 0.25 * (exit ? -1 : 1); s.opacity = e; break;
    case 'slideLeft': s.dx = (1 - e) * 0.3 * (exit ? -1 : 1); s.opacity = e; break;
    case 'slideRight': s.dx = -(1 - e) * 0.3 * (exit ? -1 : 1); s.opacity = e; break;
    case 'spin': s.rot = (1 - e) * (exit ? 360 : -360); s.scale = e; break;
    case 'drop': s.dy = exit ? (1 - e) * 0.4 : -(1 - bounceOut(p)) * 0.4; s.opacity = Math.min(1, p * 4); break;
  }
  return s;
}

function loopState(kind: MotionLoop, t: number, speed: number): MotionState {
  const s: MotionState = { opacity: 1, dx: 0, dy: 0, scale: 1, rot: 0 };
  const w = t * speed;
  switch (kind) {
    case 'pulse': s.scale = 1 + 0.08 * Math.sin(w * Math.PI * 2 * 1.2); break;
    case 'wiggle': s.rot = 7 * Math.sin(w * Math.PI * 2 * 2.5); break;
    case 'bounce': s.dy = -0.03 * Math.abs(Math.sin(w * Math.PI * 1.6)); break;
    case 'float': s.dy = 0.012 * Math.sin(w * Math.PI * 2 * 0.5); s.rot = 2 * Math.sin(w * Math.PI * 2 * 0.35); break;
    case 'spin': s.rot = (w * 120) % 360; break;
    case 'shake': s.dx = 0.006 * Math.sin(w * 97); s.dy = 0.006 * Math.sin(w * 71 + 1); break;
    case 'swing': s.rot = 12 * Math.sin(w * Math.PI * 2 * 0.8); break;
  }
  return s;
}

export function motionState(m: ClipMotion | undefined, local: number, duration: number): MotionState {
  const out: MotionState = { opacity: 1, dx: 0, dy: 0, scale: 1, rot: 0 };
  if (!m) return out;
  const d = Math.max(0.05, Math.min(m.duration, duration / 2));
  const parts = [
    entrance(m.in, local / d, false),
    entrance(m.out, (duration - local) / d, true),
    loopState(m.loop, local, m.speed || 1),
  ];
  for (const p of parts) { out.opacity *= p.opacity; out.dx += p.dx; out.dy += p.dy; out.scale *= p.scale; out.rot += p.rot; }
  out.opacity = Math.max(0, Math.min(1, out.opacity));
  return out;
}
