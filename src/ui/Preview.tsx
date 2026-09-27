import { useEffect, useRef, useState } from 'react';
import { projectDuration } from '../core/timeline';
import { formatTimecode } from '../core/time';
import { Player } from '../engine/player';
import { filesFromDataTransfer } from '../engine/media';
import { seek, stepFrames, togglePlay } from './actions';
import { Icon } from './components/Icon';
import { MaskOverlay } from './MaskOverlay';
import { TransformOverlay } from './TransformOverlay';
import { snapBox } from '../core/snap';
import { useGuides } from './guides';
import { Scopes } from './Scopes';
import { propValue, setProp, setProps } from './propEdit';
import { useApp, useTime } from './store';

function Meter({ player }: { player: Player }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const el = ref.current;
      if (el) {
        const lv = player.playing ? player.levels() : [-Infinity, -Infinity];
        lv.forEach((db, i) => {
          const pct = isFinite(db) ? Math.max(0, Math.min(100, ((db + 48) / 48) * 100)) : 0;
          (el.children[i] as HTMLElement).style.setProperty('--lvl', `${pct}%`);
        });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [player]);
  return <div className="meter" ref={ref} title="Output level" aria-hidden="true"><i /><i /></div>;
}

function useNarrow(): boolean {
  const q = '(max-width: 900px)';
  const [narrow, setNarrow] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(q).matches);
  useEffect(() => {
    const m = matchMedia(q);
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return narrow;
}

/** "1:05.3" */
function shortTime(t: number): string {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
}

function Timecode() {
  const time = useTime((s) => s.time);
  const project = useApp((s) => s.project)!;
  const fps = project.settings.fps;
  const narrow = useNarrow();
  return (
    // Phones: a shorter format so the controls fit on one line.
    narrow
      ? <span className="timecode"><b>{shortTime(time)}</b> / {shortTime(projectDuration(project))}</span>
      : <span className="timecode"><b>{formatTimecode(time, fps)}</b> / {formatTimecode(projectDuration(project), fps)}</span>
  );
}

function ScopesButton() {
  const scopes = useApp((s) => s.scopes);
  const setScopes = useApp((s) => s.setScopes);
  return (
    <button className={`icon-btn${scopes !== 'off' ? ' on' : ''}`} onClick={() => setScopes(scopes === 'off' ? 'histogram' : 'off')} title="Video scopes (levels & colour)" aria-label="Scopes" aria-pressed={scopes !== 'off'}>
      <Icon name="adjust" size={16} />
    </button>
  );
}

export function Preview() {
  const project = useApp((s) => s.project)!;
  const selection = useApp((s) => s.selection);
  const setPlayer = useApp((s) => s.setPlayer);
  const importFiles = useApp((s) => s.importFiles);
  const select = useApp((s) => s.select);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<Player | null>(null);
  const [player, setLocalPlayer] = useState<Player | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [cssSize, setCssSize] = useState({ w: 0, h: 0 });

  // Create the player once.
  useEffect(() => {
    const p = new Player(canvasRef.current!, useApp.getState().project!);
    playerRef.current = p;
    setLocalPlayer(p);
    setPlayer(p);
    const offT = p.onTime((t) => useTime.getState().setTime(t));
    const offS = p.onState(setPlaying);
    p.seek(useTime.getState().time);
    return () => { offT(); offS(); p.dispose(); setPlayer(null); };
  }, [setPlayer]);

  useEffect(() => { playerRef.current?.setProject(project); }, [project]);
  useEffect(() => {
    const p = playerRef.current;
    if (p) { p.selectedIds = selection; p.requestRender(); }
  }, [selection]);
  useEffect(() => { if (playerRef.current) playerRef.current.loop = loop; }, [loop]);

  // Fit canvas to the stage.
  useEffect(() => {
    const stage = stageRef.current!;
    const fit = () => {
      const p = playerRef.current;
      if (!p) return;
      const r = stage.getBoundingClientRect();
      const { cssW, cssH } = p.resize(Math.max(10, r.width - 24), Math.max(10, r.height - 24));
      setCssSize({ w: cssW, h: cssH });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(stage);
    return () => ro.disconnect();
  }, [project.settings.width, project.settings.height, player]);

  /* ----- direct manipulation on the canvas ----- */
  const gesture = useRef<{
    id: string; startX: number; startY: number; ox: number; oy: number; box?: { cx: number; cy: number; w: number; h: number };
    pointers: Map<number, { x: number; y: number }>; pinch?: { d: number; a: number; scale: number; rot: number };
  } | null>(null);

  const hitTest = (clientX: number, clientY: number): string | null => {
    const p = playerRef.current, c = canvasRef.current;
    if (!p || !c) return null;
    const r = c.getBoundingClientRect();
    const k = c.width / r.width;
    const x = (clientX - r.left) * k, y = (clientY - r.top) * k;
    for (let i = p.lastBounds.length - 1; i >= 0; i--) {
      const b = p.lastBounds[i];
      if (clipById(b.clipId)?.kind === 'adjustment') continue;
      const dx = x - b.cx, dy = y - b.cy;
      const cos = Math.cos(-b.rotation), sin = Math.sin(-b.rotation);
      const lx = dx * cos - dy * sin, ly = dx * sin + dy * cos;
      if (Math.abs(lx) <= b.w / 2 && Math.abs(ly) <= b.h / 2) return b.clipId;
    }
    return null;
  };

  const clipById = (id: string) => useApp.getState().project?.tracks.flatMap((t) => t.clips).find((c) => c.id === id);

  const pickMode = useApp((s) => s.pickMode);

  const onPointerDown = (e: React.PointerEvent) => {
    const pm = useApp.getState().pickMode;
    if (pm) {
      const p = playerRef.current, c = canvasRef.current;
      const b = p?.lastBounds.find((x) => x.clipId === pm.clipId);
      const clip = clipById(pm.clipId);
      if (!p || !c || !b || !clip) { useApp.getState().toast('Move the playhead to where that clip is showing, then click again.'); return; }
      const r = c.getBoundingClientRect();
      const k = c.width / r.width;
      const dx = (e.clientX - r.left) * k - b.cx, dy = (e.clientY - r.top) * k - b.cy;
      const cos = Math.cos(-b.rotation), sin = Math.sin(-b.rotation);
      let u = (dx * cos - dy * sin) / b.w + 0.5, v = (dx * sin + dy * cos) / b.h + 0.5;
      if (u < 0 || u > 1 || v < 0 || v > 1) { useApp.getState().toast('Click on the video itself.'); return; }
      if (clip.transform.flipH) u = 1 - u;
      if (clip.transform.flipV) v = 1 - v;
      const cr = clip.transform.crop;
      u = cr.left + u * (1 - cr.left - cr.right);
      v = cr.top + v * (1 - cr.top - cr.bottom);
      useApp.getState().setPickMode(null);
      pm.onPick(u, v);
      return;
    }
    const g = gesture.current;
    if (g && g.pointers.size === 1) {
      // Second finger: start pinch on the same clip.
      g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const [a, b] = [...g.pointers.values()];
      const clip = clipById(g.id);
      if (clip) g.pinch = { d: Math.hypot(b.x - a.x, b.y - a.y), a: Math.atan2(b.y - a.y, b.x - a.x), scale: propValue(clip, 'scale'), rot: propValue(clip, 'rotation') };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }
    const id = hitTest(e.clientX, e.clientY);
    if (!id) { if (!e.shiftKey) select([]); return; }
    const clip = clipById(id);
    if (!clip) return;
    if (!useApp.getState().selection.includes(id)) select([id], e.shiftKey);
    playerRef.current?.pause();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const box = playerRef.current?.lastBounds.find((b) => b.clipId === id);
    gesture.current = { id, startX: e.clientX, startY: e.clientY, ox: propValue(clip, 'x'), oy: propValue(clip, 'y'), box: box ? { cx: box.cx, cy: box.cy, w: box.w, h: box.h } : undefined, pointers: new Map([[e.pointerId, { x: e.clientX, y: e.clientY }]]) };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g || !g.pointers.has(e.pointerId)) return;
    g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const clip = clipById(g.id);
    if (!clip || clip.locked) return;
    if (g.pinch && g.pointers.size >= 2) {
      const [a, b] = [...g.pointers.values()];
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      setProps(g.id, { scale: Math.max(0.02, g.pinch.scale * (d / g.pinch.d)), rotation: g.pinch.rot + ((ang - g.pinch.a) * 180) / Math.PI }, 'Pinch');
      return;
    }
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    let nx = g.ox + (e.clientX - g.startX) / r.width;
    let ny = g.oy + (e.clientY - g.startY) / r.height;
    // Smart guides: snap edges/centre to the frame and to other layers (hold Alt to move freely).
    const p = playerRef.current;
    const b0 = g.box;
    if (p && b0 && !e.altKey) {
      const k = c.width / r.width;
      const box = { cx: b0.cx + (nx - g.ox) * c.width, cy: b0.cy + (ny - g.oy) * c.height, w: b0.w, h: b0.h };
      const others = p.lastBounds.filter((o) => o.clipId !== g.id && clipById(o.clipId)?.kind !== 'adjustment' && !(o.w >= c.width * 0.98 && o.h >= c.height * 0.98));
      const sn = snapBox(box, others, c.width, c.height, 7 * k);
      nx += sn.dx / c.width;
      ny += sn.dy / c.height;
      useGuides.getState().set(sn.guidesX, sn.guidesY);
    } else useGuides.getState().set([], []);
    setProps(g.id, { x: nx, y: ny }, 'Move');
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    g.pointers.delete(e.pointerId);
    useGuides.getState().set([], []);
    if (g.pointers.size === 0) gesture.current = null;
    else g.pinch = undefined;
  };

  const onWheel = (e: React.WheelEvent) => {
    const sel = useApp.getState().selection;
    if (sel.length !== 1) return;
    const clip = clipById(sel[0]);
    if (!clip || clip.kind === 'audio') return;
    const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002));
    setProp(clip.id, 'scale', Math.max(0.02, propValue(clip, 'scale') * f), 'Scale');
  };

  const fullscreen = () => {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else el.requestFullscreen?.().catch(() => useApp.getState().toast('Full screen isn’t available here.'));
  };

  const empty = project.tracks.every((t) => t.clips.length === 0);

  return (
    <div className="preview-area">
      <div
        ref={stageRef}
        className={`stage${dropping ? ' drop-target' : ''}`}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropping(true); } }}
        onDragLeave={() => setDropping(false)}
        onDrop={async (e) => {
          e.preventDefault();
          setDropping(false);
          const files = await filesFromDataTransfer(e.dataTransfer);
          if (files.length) void importFiles(files, useTime.getState().time);
        }}
      >
        <canvas
          ref={canvasRef}
          style={{ width: cssSize.w || undefined, height: cssSize.h || undefined }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
          onDoubleClick={fullscreen}
          aria-label="Video preview. Click a layer to select it, drag to move, scroll or pinch to scale."
        />
        <MaskOverlay canvas={player ? canvasRef.current : null} />
        <TransformOverlay canvas={player ? canvasRef.current : null} playing={playing} />
        {pickMode && (
          <div className="pick-banner" role="status">
            <Icon name="ai" size={16} /> {pickMode.label}
            <button className="btn sm" onClick={() => useApp.getState().setPickMode(null)}>Cancel</button>
          </div>
        )}
        {empty && (
          <div className="empty-stage">
            <div>
              <Icon name="upload" size={30} />
              <p style={{ margin: '8px 0 0', fontWeight: 700 }}>Drop videos, photos or music here</p>
              <p className="faint" style={{ margin: '4px 0 0', fontSize: 12 }}>{project.settings.width}×{project.settings.height} · {project.settings.fps} fps</p>
            </div>
          </div>
        )}
      </div>
      <Scopes />
      <div className="transport">
        <button className="icon-btn" onClick={() => seek(0)} title="Go to start (Home)" aria-label="Go to start"><Icon name="stepBack" size={16} /></button>
        <button className="icon-btn" onClick={() => stepFrames(-1)} title="Previous frame (←)" aria-label="Previous frame"><Icon name="back" size={16} /></button>
        <button className="play-btn" onClick={togglePlay} title="Play / pause (Space)" aria-label={playing ? 'Pause' : 'Play'}>
          <Icon name={playing ? 'pause' : 'play'} size={18} />
        </button>
        <button className="icon-btn" onClick={() => stepFrames(1)} title="Next frame (→)" aria-label="Next frame"><Icon name="back" size={16} style={{ transform: 'scaleX(-1)' }} /></button>
        <Timecode />
        <div style={{ flex: 1 }} />
        {player && <Meter player={player} />}
        <span className="desktop-only"><ScopesButton /></span>
        <button className={`icon-btn${loop ? ' on' : ''}`} onClick={() => setLoop(!loop)} title="Loop playback" aria-label="Loop" aria-pressed={loop}><Icon name="loop" size={16} /></button>
        <button className="icon-btn" onClick={fullscreen} title="Full-screen preview" aria-label="Full screen"><Icon name="fullscreen" size={16} /></button>
      </div>
    </div>
  );
}
