/**
 * Close-up editor for a "zoomed-in" quiz question: a big view of the picture
 * where you drag the circle onto the exact part to show, resize it (handle,
 * slider, scroll wheel or pinch), and see exactly what viewers will see.
 */
import { useEffect, useRef, useState } from 'react';
import { zoomCrop } from '../core/quiz';
import { Dialog, PropRow } from './components/Controls';
import { Icon } from './components/Icon';

export const MIN_ZOOM = 1.2;
export const MAX_ZOOM = 12;
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export interface CloseUp { focus: { x: number; y: number }; zoom: number }

/** Keeps the focus where the close-up square still fits inside the picture (matches zoomCrop). */
export function fitFocus(size: { w: number; h: number }, c: CloseUp): CloseUp {
  const crop = zoomCrop({ width: size.w, height: size.h }, c.focus, c.zoom);
  const fw = 1 - crop.left - crop.right, fh = 1 - crop.top - crop.bottom;
  return { zoom: c.zoom, focus: { x: crop.left + fw / 2, y: crop.top + fh / 2 } };
}

export function ZoomEditor({ url, size, value, round, onSave, onClose, suggest }: {
  url: string;
  size: { w: number; h: number };
  value: CloseUp;
  round: number;
  onSave: (c: CloseUp) => void;
  onClose: () => void;
  suggest: (zoom: number) => Promise<{ x: number; y: number }>;
}) {
  const [c, setC] = useState<CloseUp>(() => fitFocus(size, value));
  const stageRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [stage, setStage] = useState(420);
  const drag = useRef<{ mode: 'move' | 'size'; dx: number; dy: number } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; zoom: number } | null>(null);

  const set = (next: CloseUp) => setC(fitFocus(size, { zoom: clampZoom(next.zoom), focus: { x: clamp01(next.focus.x), y: clamp01(next.focus.y) } }));

  // Big stage: as large as the dialog allows (phones get the full width).
  useEffect(() => {
    const fit = () => setStage(Math.max(220, Math.min(520, window.innerWidth - 60, window.innerHeight - 330)));
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  // Picture laid out "contain" inside the square stage.
  const k = Math.min(stage / size.w, stage / size.h);
  const dw = size.w * k, dh = size.h * k, ox = (stage - dw) / 2, oy = (stage - dh) / 2;
  const sidePx = (Math.min(size.w, size.h) / c.zoom) * k;
  const cx = ox + c.focus.x * dw, cy = oy + c.focus.y * dh;
  const toFocus = (px: number, py: number) => ({ x: (px - ox) / dw, y: (py - oy) / dh });
  const local = (e: { clientX: number; clientY: number }) => {
    const b = stageRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - b.left) / b.width) * stage, y: ((e.clientY - b.top) / b.height) * stage };
  };

  // Live close-up: exactly the crop the quiz will use, in a circle.
  useEffect(() => {
    const draw = () => {
      const cv = previewRef.current, img = imgRef.current;
      if (!cv || !img || !img.complete) return;
      const g = cv.getContext('2d')!;
      const S = cv.width;
      const crop = zoomCrop({ width: size.w, height: size.h }, c.focus, c.zoom);
      g.clearRect(0, 0, S, S);
      g.save();
      g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 3, 0, Math.PI * 2); g.clip();
      g.fillStyle = '#20242e'; g.fillRect(0, 0, S, S);
      g.drawImage(img, crop.left * img.naturalWidth, crop.top * img.naturalHeight, (1 - crop.left - crop.right) * img.naturalWidth, (1 - crop.top - crop.bottom) * img.naturalHeight, 0, 0, S, S);
      g.restore();
      g.lineWidth = 4; g.strokeStyle = '#ffffff';
      g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 3, 0, Math.PI * 2); g.stroke();
    };
    if (!imgRef.current) {
      const img = new Image();
      img.onload = draw;
      img.src = url;
      imgRef.current = img;
    }
    draw();
  }, [c, url, size]);

  const onDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: c.zoom };
      drag.current = null;
      return;
    }
    const onHandle = (e.target as HTMLElement).dataset.handle === 'size';
    if (onHandle) { drag.current = { mode: 'size', dx: 0, dy: 0 }; return; }
    const inside = Math.hypot(p.x - cx, p.y - cy) <= sidePx / 2;
    if (inside) drag.current = { mode: 'move', dx: cx - p.x, dy: cy - p.y };
    else { set({ ...c, focus: toFocus(p.x, p.y) }); drag.current = { mode: 'move', dx: 0, dy: 0 }; }
  };
  const onMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d > 4) set({ ...c, zoom: pinch.current.zoom * (pinch.current.dist / d) }); // fingers apart = bigger circle = less zoom
      return;
    }
    const dr = drag.current;
    if (!dr) return;
    if (dr.mode === 'move') set({ ...c, focus: toFocus(p.x + dr.dx, p.y + dr.dy) });
    else {
      // Handle: distance from the centre sets the circle's size.
      const half = Math.max(8, Math.max(Math.abs(p.x - cx), Math.abs(p.y - cy)));
      set({ ...c, zoom: (Math.min(size.w, size.h) * k) / (half * 2) });
    }
  };
  const onUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (!pointers.current.size) drag.current = null;
  };

  const handleX = cx + (sidePx / 2) * Math.SQRT1_2, handleY = cy + (sidePx / 2) * Math.SQRT1_2;
  return (
    <Dialog title={`Close-up for round ${round}`} onClose={onClose} width={860} footer={<>
      <button className="btn ghost" style={{ marginRight: 'auto' }} onClick={async () => set({ ...c, focus: await suggest(c.zoom) })}><Icon name="ai" size={14} />Suggest a spot</button>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" onClick={() => { onSave(c); onClose(); }}><Icon name="check" size={15} />Use this close-up</button>
    </>}>
      <div className="zoom-editor">
        <div ref={stageRef} className="zoom-stage" style={{ width: stage, height: stage }}
          role="slider" tabIndex={0} aria-label="Close-up position" aria-valuetext={`${Math.round(c.focus.x * 100)}% across, ${Math.round(c.focus.y * 100)}% down, ${c.zoom.toFixed(1)} times zoom`}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
          onWheel={(e) => set({ ...c, zoom: c.zoom * (e.deltaY > 0 ? 0.92 : 1.08) })}
          onKeyDown={(e) => {
            const st = 0.01 * (e.shiftKey ? 5 : 1);
            const mv: Record<string, [number, number]> = { ArrowLeft: [-st, 0], ArrowRight: [st, 0], ArrowUp: [0, -st], ArrowDown: [0, st] };
            if (mv[e.key]) { e.preventDefault(); set({ ...c, focus: { x: c.focus.x + mv[e.key][0], y: c.focus.y + mv[e.key][1] } }); }
            if (e.key === '+' || e.key === '=') set({ ...c, zoom: c.zoom * 1.1 });
            if (e.key === '-') set({ ...c, zoom: c.zoom / 1.1 });
          }}>
          <img src={url} alt="" draggable={false} style={{ left: ox, top: oy, width: dw, height: dh }} />
          <span className="zoom-dim" style={{ background: `radial-gradient(circle at ${cx}px ${cy}px, transparent ${sidePx / 2}px, rgba(0,0,0,0.6) ${sidePx / 2 + 1}px)` }} />
          <span className="zoom-window" style={{ left: cx - sidePx / 2, top: cy - sidePx / 2, width: sidePx, height: sidePx }} />
          <span className="zoom-handle" data-handle="size" style={{ left: handleX - 11, top: handleY - 11 }} aria-hidden />
        </div>
        <div className="zoom-side">
          <div className="label">What viewers see</div>
          <canvas ref={previewRef} width={220} height={220} className="zoom-closeup" aria-label="Close-up preview" role="img" />
          <PropRow label="Zoom" value={Number(c.zoom.toFixed(1))} min={MIN_ZOOM} max={MAX_ZOOM} step={0.1} unit="×" onChange={(v) => set({ ...c, zoom: v })} />
          <small className="faint">Drag the circle onto the part to show. Drag the round handle, scroll, or pinch to make it bigger or smaller. It zooms out to the whole picture at the reveal.</small>
        </div>
      </div>
    </Dialog>
  );
}
