/**
 * On-canvas mask editing: drag the shape to move it, the corner to resize,
 * the top handle to rotate, polygon dots to reshape, or trace a freehand mask.
 */
import { useEffect, useRef, useState } from 'react';
import { maskOutline, resolveMask, simplifyStroke } from '../core/masks';
import type { Clip, Mask } from '../core/types';
import type { ClipBounds } from '../engine/compositor';
import { localTime, setMaskProps, updateMask } from './maskEdit';
import { useApp, useTime } from './store';

interface Geo { b: ClipBounds; fx: number; fy: number; left: number; top: number; cssW: number; cssH: number; pxW: number; pxH: number }
type Pt = { x: number; y: number };

export function MaskOverlay({ canvas }: { canvas: HTMLCanvasElement | null }) {
  const maskEdit = useApp((s) => s.maskEdit);
  const project = useApp((s) => s.project)!;
  const player = useApp((s) => s.player);
  useTime((s) => s.time);
  const [geo, setGeo] = useState<Geo | null>(null);
  const drag = useRef<null | { kind: 'move' | 'size' | 'rotate' | 'point' | 'draw'; start: Pt; m: Mask; index?: number; stroke?: Pt[] }>(null);
  const [stroke, setStroke] = useState<Pt[] | null>(null);

  const clip: Clip | undefined = maskEdit ? project.tracks.flatMap((t) => t.clips).find((c) => c.id === maskEdit.clipId) : undefined;
  const raw = clip?.masks?.find((m) => m.id === maskEdit?.maskId);

  // Follow the clip's on-screen box (it changes after each render).
  useEffect(() => {
    if (!maskEdit || !player || !canvas) { setGeo(null); return; }
    let raf = 0, sig = '';
    const loop = () => {
      const b = player.lastBounds.find((x) => x.clipId === maskEdit.clipId);
      const cr = canvas.getBoundingClientRect();
      const pr = canvas.parentElement!.getBoundingClientRect();
      const c = useApp.getState().project?.tracks.flatMap((t) => t.clips).find((x) => x.id === maskEdit.clipId);
      const next = b && c ? { b, fx: c.transform.flipH ? -1 : 1, fy: c.transform.flipV ? -1 : 1, left: cr.left - pr.left, top: cr.top - pr.top, cssW: cr.width, cssH: cr.height, pxW: canvas.width, pxH: canvas.height } : null;
      const s = JSON.stringify(next);
      if (s !== sig) { sig = s; setGeo(next); }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [maskEdit, player, canvas]);

  if (!maskEdit || !clip || !raw || !geo) return null;
  const { b, fx, fy } = geo;
  const m = resolveMask(raw, localTime(clip));
  const cos = Math.cos(b.rotation), sin = Math.sin(b.rotation);
  // Layer pixels (0..b.w, 0..b.h) → canvas pixels.
  const toCanvas = (p: Pt): Pt => {
    const qx = (p.x - b.w / 2) * fx, qy = (p.y - b.h / 2) * fy;
    return { x: b.cx + qx * cos - qy * sin, y: b.cy + qx * sin + qy * cos };
  };
  const toLayer = (p: Pt): Pt => {
    const dx = p.x - b.cx, dy = p.y - b.cy;
    const qx = dx * cos + dy * sin, qy = -dx * sin + dy * cos;
    return { x: qx * fx + b.w / 2, y: qy * fy + b.h / 2 };
  };
  const eventLayer = (e: React.PointerEvent): Pt => {
    const k = geo.pxW / geo.cssW;
    const r = (e.currentTarget as Element).closest('svg')!.getBoundingClientRect();
    return toLayer({ x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k });
  };

  const outline = maskOutline(m, b.w, b.h).map(toCanvas);
  const mcx = b.w / 2 + m.x * b.w, mcy = b.h / 2 + m.y * b.h;
  const rot = (m.rotation * Math.PI) / 180, mc = Math.cos(rot), ms = Math.sin(rot);
  const inMask = (x: number, y: number): Pt => ({ x: mcx + x * mc - y * ms, y: mcy + x * ms + y * mc });
  const hw = (m.w * b.w) / 2, hh = (m.h * b.h) / 2;
  const corner = toCanvas(inMask(hw, hh));
  const rotH = toCanvas(inMask(0, -hh - 24 * (geo.pxW / geo.cssW)));
  const topMid = toCanvas(inMask(0, -hh));
  const polyPts = (m.type === 'polygon' ? m.points : []).map((p) => toCanvas(inMask((p.x - 0.5) * m.w * b.w, (p.y - 0.5) * m.h * b.h)));
  const r = 6 * (geo.pxW / geo.cssW);

  const start = (kind: NonNullable<typeof drag.current>['kind'], e: React.PointerEvent, index?: number) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    useApp.getState().player?.pause();
    const p = eventLayer(e);
    drag.current = { kind, start: p, m: raw, index, stroke: kind === 'draw' ? [p] : undefined };
    if (kind === 'draw') setStroke([p]);
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = eventLayer(e);
    const t = localTime(clip);
    const m0 = resolveMask(d.m, t);
    if (d.kind === 'move') {
      setMaskProps(clip.id, raw.id, { x: m0.x + (p.x - d.start.x) / b.w, y: m0.y + (p.y - d.start.y) / b.h }, 'Move mask', `mask-move:${raw.id}`);
    } else if (d.kind === 'size') {
      const dx = p.x - mcx, dy = p.y - mcy;
      const lx = dx * mc + dy * ms, ly = -dx * ms + dy * mc;
      setMaskProps(clip.id, raw.id, { w: Math.max(0.01, (2 * Math.abs(lx)) / b.w), h: Math.max(0.01, (2 * Math.abs(ly)) / b.h) }, 'Resize mask', `mask-size:${raw.id}`);
    } else if (d.kind === 'rotate') {
      const a = (Math.atan2(p.y - mcy, p.x - mcx) * 180) / Math.PI + 90;
      setMaskProps(clip.id, raw.id, { rotation: Math.round(((a + 540) % 360) - 180) }, 'Rotate mask', `mask-rot:${raw.id}`);
    } else if (d.kind === 'point' && d.index !== undefined) {
      const dx = p.x - mcx, dy = p.y - mcy;
      const lx = dx * mc + dy * ms, ly = -dx * ms + dy * mc;
      const np = { x: lx / Math.max(1e-6, m0.w * b.w) + 0.5, y: ly / Math.max(1e-6, m0.h * b.h) + 0.5 };
      updateMask(clip.id, raw.id, (x) => ({ ...x, points: x.points.map((q, i) => (i === d.index ? np : q)) }), 'Move mask point', `mask-pt:${raw.id}:${d.index}`);
    } else if (d.kind === 'draw' && d.stroke) {
      d.stroke.push(p);
      setStroke([...d.stroke]);
    }
  };
  const end = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.kind === 'draw' && d.stroke) {
      setStroke(null);
      const pts = simplifyStroke(d.stroke.map((q) => ({ x: q.x / b.w, y: q.y / b.h })));
      if (pts.length >= 3) {
        updateMask(clip.id, raw.id, (x) => ({ ...x, x: 0, y: 0, w: 1, h: 1, rotation: 0, points: pts, keyframes: {} }), 'Draw mask');
        useApp.getState().setMaskEdit({ clipId: clip.id, maskId: raw.id });
      } else useApp.getState().toast('Drag to draw around what you want to keep.');
    }
  };
  const addPoint = (e: React.MouseEvent) => {
    if (m.type !== 'polygon') return;
    const k = geo.pxW / geo.cssW;
    const rr = (e.currentTarget as Element).closest('svg')!.getBoundingClientRect();
    const p = toLayer({ x: (e.clientX - rr.left) * k, y: (e.clientY - rr.top) * k });
    const dx = p.x - mcx, dy = p.y - mcy;
    const np = { x: (dx * mc + dy * ms) / (m.w * b.w) + 0.5, y: (-dx * ms + dy * mc) / (m.h * b.h) + 0.5 };
    // Insert after the nearest edge.
    let best = 0, bestD = Infinity;
    for (let i = 0; i < m.points.length; i++) {
      const a = m.points[i], c = m.points[(i + 1) % m.points.length];
      const d = Math.hypot(a.x - np.x, a.y - np.y) + Math.hypot(c.x - np.x, c.y - np.y) - Math.hypot(a.x - c.x, a.y - c.y);
      if (d < bestD) { bestD = d; best = i; }
    }
    updateMask(clip.id, raw.id, (x) => ({ ...x, points: [...x.points.slice(0, best + 1), np, ...x.points.slice(best + 1)] }), 'Add mask point');
  };

  const path = (pts: Pt[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('') + 'Z';
  const drawing = !!maskEdit.draw && m.type === 'freeform';

  return (
    <svg className={`mask-overlay${drawing ? ' drawing' : ''}`} viewBox={`0 0 ${geo.pxW} ${geo.pxH}`}
      style={{ left: geo.left, top: geo.top, width: geo.cssW, height: geo.cssH }}
      onPointerMove={move} onPointerUp={end} onPointerCancel={end} aria-label="Mask editor">
      {drawing && <rect x={0} y={0} width={geo.pxW} height={geo.pxH} fill="transparent" style={{ pointerEvents: 'all', cursor: 'crosshair' }} onPointerDown={(e) => start('draw', e)} />}
      {!drawing && outline.length >= 3 && (
        <path d={path(outline)} className="mask-shape" data-testid="mask-shape" onPointerDown={(e) => start('move', e)} onDoubleClick={addPoint} />
      )}
      {stroke && <path d={stroke.map(toCanvas).map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join('')} className="mask-stroke" />}
      {!drawing && (m.type === 'rect' || m.type === 'ellipse') && (
        <>
          <line x1={topMid.x} y1={topMid.y} x2={rotH.x} y2={rotH.y} className="mask-stem" />
          <circle cx={rotH.x} cy={rotH.y} r={r} className="mask-handle rot" onPointerDown={(e) => start('rotate', e)} aria-label="Rotate mask" />
          <rect x={corner.x - r} y={corner.y - r} width={r * 2} height={r * 2} className="mask-handle" data-testid="mask-size" onPointerDown={(e) => start('size', e)} aria-label="Resize mask" />
        </>
      )}
      {!drawing && polyPts.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={r} className="mask-handle" onPointerDown={(e) => start('point', e, i)}
          onDoubleClick={(e) => { e.stopPropagation(); if (raw.points.length > 3) updateMask(clip.id, raw.id, (x) => ({ ...x, points: x.points.filter((_, j) => j !== i) }), 'Remove mask point'); }} />
      ))}
    </svg>
  );
}
