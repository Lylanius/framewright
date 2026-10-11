/**
 * Kids Studio picture: the real player (so it looks exactly like the saved
 * video), plus finger controls for the stickers and words on top — drag to
 * move, pinch to resize and turn. The photos/videos underneath don't move, so
 * a stray finger can't knock the picture out of place.
 */
import { useEffect, useRef, useState } from 'react';
import { extras } from '../../core/kids';
import { Player } from '../../engine/player';
import { propValue, setProps } from '../propEdit';
import { useApp, useTime } from '../store';

interface Box { left: number; top: number; width: number; height: number; rotation: number }

export function KidsStage({ onPlaying }: { onPlaying: (p: boolean) => void }) {
  const project = useApp((s) => s.project)!;
  const selection = useApp((s) => s.selection);
  const setPlayer = useApp((s) => s.setPlayer);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<Player | null>(null);
  const [css, setCss] = useState({ w: 0, h: 0 });
  const [box, setBox] = useState<Box | null>(null);
  const time = useTime((s) => s.time);

  useEffect(() => {
    const p = new Player(canvasRef.current!, useApp.getState().project!);
    playerRef.current = p;
    setPlayer(p);
    const offT = p.onTime((t) => useTime.getState().setTime(t));
    const offS = p.onState(onPlaying);
    p.seek(useTime.getState().time);
    return () => { offT(); offS(); p.dispose(); setPlayer(null); };
  }, [setPlayer]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { playerRef.current?.setProject(project); }, [project]);

  useEffect(() => {
    const stage = stageRef.current!;
    const fit = () => {
      const p = playerRef.current;
      if (!p) return;
      const r = stage.getBoundingClientRect();
      const { cssW, cssH } = p.resize(Math.max(10, r.width), Math.max(10, r.height));
      setCss({ w: cssW, h: cssH });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(stage);
    return () => ro.disconnect();
  }, [project.settings.width, project.settings.height]);

  // Chunky outline round the selected sticker/words (follows it as it moves).
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const p = playerRef.current, c = canvasRef.current, id = useApp.getState().selection[0];
      const b = id && p && !p.playing ? p.lastBounds.find((x) => x.clipId === id) : null;
      if (b && c && c.width) {
        const k = c.getBoundingClientRect().width / c.width;
        setBox((old) => {
          const next = { left: (b.cx - b.w / 2) * k, top: (b.cy - b.h / 2) * k, width: b.w * k, height: b.h * k, rotation: b.rotation };
          return old && Math.abs(old.left - next.left) < 0.5 && Math.abs(old.top - next.top) < 0.5 && Math.abs(old.width - next.width) < 0.5 && old.rotation === next.rotation ? old : next;
        });
      } else setBox(null);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const clipById = (id: string) => useApp.getState().project?.tracks.flatMap((t) => t.clips).find((c) => c.id === id);
  const gesture = useRef<{ id: string; sx: number; sy: number; ox: number; oy: number; pts: Map<number, { x: number; y: number }>; pinch?: { d: number; a: number; scale: number; rot: number } } | null>(null);

  /** Topmost sticker or words under the finger (not the photos/videos). */
  const hit = (cx: number, cy: number): string | null => {
    const p = playerRef.current, c = canvasRef.current;
    if (!p || !c) return null;
    const r = c.getBoundingClientRect(), k = c.width / r.width;
    const x = (cx - r.left) * k, y = (cy - r.top) * k;
    const mine = new Set(extras(useApp.getState().project!).filter((e) => e.kind !== 'audio').map((e) => e.id));
    for (let i = p.lastBounds.length - 1; i >= 0; i--) {
      const b = p.lastBounds[i];
      if (!mine.has(b.clipId)) continue;
      const dx = x - b.cx, dy = y - b.cy, cos = Math.cos(-b.rotation), sin = Math.sin(-b.rotation);
      const lx = dx * cos - dy * sin, ly = dx * sin + dy * cos;
      // A little extra room round small things so they're easy to grab.
      if (Math.abs(lx) <= b.w / 2 + 14 * k && Math.abs(ly) <= b.h / 2 + 14 * k) return b.clipId;
    }
    return null;
  };

  const down = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (g && g.pts.size === 1) {
      g.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const [a, b] = [...g.pts.values()];
      const clip = clipById(g.id);
      if (clip) g.pinch = { d: Math.hypot(b.x - a.x, b.y - a.y), a: Math.atan2(b.y - a.y, b.x - a.x), scale: propValue(clip, 'scale'), rot: propValue(clip, 'rotation') };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }
    const id = hit(e.clientX, e.clientY);
    if (!id) { useApp.getState().select([]); return; }
    const clip = clipById(id);
    if (!clip) return;
    useApp.getState().select([id]);
    playerRef.current?.pause();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    gesture.current = { id, sx: e.clientX, sy: e.clientY, ox: propValue(clip, 'x'), oy: propValue(clip, 'y'), pts: new Map([[e.pointerId, { x: e.clientX, y: e.clientY }]]) };
  };
  const move = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g || !g.pts.has(e.pointerId)) return;
    g.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g.pinch && g.pts.size >= 2) {
      const [a, b] = [...g.pts.values()];
      const d = Math.hypot(b.x - a.x, b.y - a.y), ang = Math.atan2(b.y - a.y, b.x - a.x);
      setProps(g.id, { scale: Math.min(6, Math.max(0.1, g.pinch.scale * (d / g.pinch.d))), rotation: g.pinch.rot + ((ang - g.pinch.a) * 180) / Math.PI }, 'Resize');
      return;
    }
    const r = canvasRef.current!.getBoundingClientRect();
    setProps(g.id, { x: Math.max(-0.55, Math.min(0.55, g.ox + (e.clientX - g.sx) / r.width)), y: Math.max(-0.55, Math.min(0.55, g.oy + (e.clientY - g.sy) / r.height)) }, 'Move');
  };
  const up = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    g.pts.delete(e.pointerId);
    if (!g.pts.size) gesture.current = null;
    else g.pinch = undefined;
  };

  const empty = project.tracks.every((t) => !t.clips.length);
  void time;
  void selection;
  return (
    <div className="k-stage" ref={stageRef}>
      <div className="k-canvas-wrap" style={{ width: css.w || undefined, height: css.h || undefined }}>
        <canvas ref={canvasRef} style={{ width: css.w || undefined, height: css.h || undefined }}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
          aria-label="Your video. Drag stickers and words to move them; pinch to make them bigger." />
        {box && <div className="k-sel" style={{ left: box.left, top: box.top, width: box.width, height: box.height, transform: `rotate(${box.rotation}rad)` }} aria-hidden />}
        {empty && <div className="k-empty" aria-hidden><span>🎬</span>Add photos and videos to start</div>}
      </div>
    </div>
  );
}
