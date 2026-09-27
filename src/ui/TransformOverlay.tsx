/**
 * Canva-style handles on the selected layer: drag a corner to resize, the
 * round knob to rotate (snaps to 0/90/180/270°; hold Shift for free rotation),
 * plus the smart-guide lines shown while moving.
 */
import { useEffect, useRef, useState } from 'react';
import type { ClipBounds } from '../engine/compositor';
import { useGuides } from './guides';
import { propValue, setProps } from './propEdit';
import { useApp, useTime } from './store';

interface Geo { b: ClipBounds; left: number; top: number; cssW: number; cssH: number; pxW: number; pxH: number }

export function TransformOverlay({ canvas, playing }: { canvas: HTMLCanvasElement | null; playing: boolean }) {
  const selection = useApp((s) => s.selection);
  const maskEdit = useApp((s) => s.maskEdit);
  const pickMode = useApp((s) => s.pickMode);
  const player = useApp((s) => s.player);
  const guides = useGuides();
  useTime((s) => s.time);
  const [geo, setGeo] = useState<Geo | null>(null);
  const drag = useRef<null | { kind: 'scale' | 'rotate'; id: string; cx: number; cy: number; d0: number; a0: number; scale0: number; rot0: number }>(null);
  const id = selection.length === 1 ? selection[0] : null;
  const active = !!id && !maskEdit && !pickMode && !playing;

  useEffect(() => {
    if (!player || !canvas) { setGeo(null); return; }
    let raf = 0, sig = '';
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const b = id ? player.lastBounds.find((x) => x.clipId === id) : undefined;
      const cr = canvas.getBoundingClientRect(), pr = canvas.parentElement!.getBoundingClientRect();
      const next = { b: b ?? { clipId: '', cx: 0, cy: 0, w: 0, h: 0, rotation: 0 }, left: cr.left - pr.left, top: cr.top - pr.top, cssW: cr.width, cssH: cr.height, pxW: canvas.width, pxH: canvas.height };
      const s = JSON.stringify(next);
      if (s !== sig) { sig = s; setGeo(next); }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [player, canvas, id]);

  if (!geo) return null;
  const k = geo.pxW / geo.cssW;
  const svgStyle = { left: geo.left, top: geo.top, width: geo.cssW, height: geo.cssH };
  const guideLines = (
    <>
      {guides.x.map((x) => <line key={`gx${x}`} x1={x} y1={0} x2={x} y2={geo.pxH} className="snap-guide" />)}
      {guides.y.map((y) => <line key={`gy${y}`} x1={0} y1={y} x2={geo.pxW} y2={y} className="snap-guide" />)}
    </>
  );
  const clip = id ? useApp.getState().project?.tracks.flatMap((t) => t.clips).find((c) => c.id === id) : undefined;
  const show = active && geo.b.clipId && clip && clip.kind !== 'audio' && clip.kind !== 'adjustment' && !clip.locked;
  if (!show) return guides.x.length || guides.y.length ? <svg className="xf-overlay" viewBox={`0 0 ${geo.pxW} ${geo.pxH}`} style={svgStyle}>{guideLines}</svg> : null;

  const { b } = geo;
  const cos = Math.cos(b.rotation), sin = Math.sin(b.rotation);
  const pt = (lx: number, ly: number) => ({ x: b.cx + lx * cos - ly * sin, y: b.cy + lx * sin + ly * cos });
  const corners = [pt(-b.w / 2, -b.h / 2), pt(b.w / 2, -b.h / 2), pt(b.w / 2, b.h / 2), pt(-b.w / 2, b.h / 2)];
  const knob = pt(0, -b.h / 2 - 34 * k);
  const top = pt(0, -b.h / 2);
  const r = 7 * k;

  const toCanvas = (e: React.PointerEvent) => {
    const rr = (e.currentTarget as Element).closest('svg')!.getBoundingClientRect();
    return { x: (e.clientX - rr.left) * k, y: (e.clientY - rr.top) * k };
  };
  const start = (kind: 'scale' | 'rotate', e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    const p = toCanvas(e);
    drag.current = {
      kind, id: clip.id, cx: b.cx, cy: b.cy,
      d0: Math.max(1, Math.hypot(p.x - b.cx, p.y - b.cy)), a0: Math.atan2(p.y - b.cy, p.x - b.cx),
      scale0: propValue(clip, 'scale'), rot0: propValue(clip, 'rotation'),
    };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = toCanvas(e);
    if (d.kind === 'scale') {
      const f = Math.hypot(p.x - d.cx, p.y - d.cy) / d.d0;
      setProps(d.id, { scale: Math.max(0.02, d.scale0 * f) }, 'Resize');
    } else {
      let rot = d.rot0 + ((Math.atan2(p.y - d.cy, p.x - d.cx) - d.a0) * 180) / Math.PI;
      rot = ((rot % 360) + 540) % 360 - 180;
      if (!e.shiftKey) for (const s of [-180, -90, 0, 90, 180]) if (Math.abs(rot - s) < 4) rot = s;
      setProps(d.id, { rotation: Math.round(rot * 10) / 10 }, 'Rotate');
    }
  };
  const end = () => { drag.current = null; };

  return (
    <svg className="xf-overlay" viewBox={`0 0 ${geo.pxW} ${geo.pxH}`} style={svgStyle} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
      {guideLines}
      <line x1={top.x} y1={top.y} x2={knob.x} y2={knob.y} className="xf-stem" />
      <circle cx={knob.x} cy={knob.y} r={r * 1.1} className="xf-handle rot" onPointerDown={(e) => start('rotate', e)} aria-label="Rotate" data-testid="xf-rotate" />
      {corners.map((c, i) => (
        <rect key={i} x={c.x - r} y={c.y - r} width={r * 2} height={r * 2} rx={r * 0.3} className="xf-handle" onPointerDown={(e) => start('scale', e)} aria-label="Resize" data-testid={`xf-corner-${i}`} />
      ))}
    </svg>
  );
}
