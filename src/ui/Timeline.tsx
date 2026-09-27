import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  addTrack, clipEnd, findClip, moveClip, moveClipsBy, moveTrack, projectDuration, removeTrack, snapPoints, snapTime,
  trimEnd, trimStart, updateTrack, addMediaClip, addClipToTrack,
} from '../core/timeline';
import { formatShort } from '../core/time';
import { createClipFromMedia } from '../core/defaults';
import { getTransitionDef, nextAdjacent, trackTransitions } from '../core/transitions';
import type { Clip, MediaItem, Project, Track } from '../core/types';
import { filesFromDataTransfer } from '../engine/media';
import {
  addMarker, deleteSelected, detachSelectedAudio, duplicateSelected, seek, splitAtPlayhead, zoomBy, zoomToFit,
} from './actions';
import { Waveform } from './components/Controls';
import { renderCache, type ChunkState } from '../engine/renderCache';
import { CHUNK_SECONDS } from '../core/renderPlan';
import { Icon } from './components/Icon';
import { useApp, useTime } from './store';

const RULER_H = 26;
export const MEDIA_DRAG_TYPE = 'application/x-framewright-media';

const CLIP_COLOR: Record<Clip['kind'], string> = {
  video: 'var(--clip-video)', image: 'var(--clip-image)', audio: 'var(--clip-audio)', text: 'var(--clip-text)', solid: 'var(--clip-solid)', adjustment: 'var(--clip-adjust)', shape: 'var(--clip-shape)',
};

type DragMode = 'move' | 'trimL' | 'trimR';
interface DragState {
  mode: DragMode;
  clipId: string;
  ids: string[];
  pointerId: number;
  x0: number;
  y0: number;
  origin: Clip;
  moved: boolean;
}

function useRowHeight(): number {
  const [h, setH] = useState(() => (window.innerWidth <= 900 ? 50 : 56));
  useEffect(() => {
    const f = () => setH(window.innerWidth <= 900 ? 50 : 56);
    window.addEventListener('resize', f);
    return () => window.removeEventListener('resize', f);
  }, []);
  return h;
}

/* --------------------------------- ruler --------------------------------- */

function Ruler({ zoom, fps, scrollLeft, viewW, duration, markers, onScrubStart }: {
  zoom: number; fps: number; scrollLeft: number; viewW: number; duration: number;
  markers: Project['markers']; onScrubStart: (e: React.PointerEvent) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = devicePixelRatio || 1;
    c.width = Math.max(1, Math.round(viewW * dpr));
    c.height = RULER_H * dpr;
    c.style.width = `${viewW}px`;
    c.style.left = `${scrollLeft}px`;
    const ctx = c.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, viewW, RULER_H);
    // Choose a label step that keeps ~90px between labels.
    const steps = [1 / fps, 2 / fps, 5 / fps, 10 / fps, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const major = steps.find((s) => s * zoom >= 90) ?? 600;
    const minor = steps.slice().reverse().find((s) => s < major && s * zoom >= 12 && (major / s) % 1 < 1e-6) ?? major / 2;
    const t0 = scrollLeft / zoom, t1 = (scrollLeft + viewW) / zoom;
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    ctx.fillRect(Math.max(0, duration * zoom - scrollLeft), 0, viewW, RULER_H);
    ctx.strokeStyle = '#3a4152';
    ctx.fillStyle = '#8d94a8';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textBaseline = 'top';
    ctx.beginPath();
    for (let t = Math.floor(t0 / minor) * minor; t <= t1; t += minor) {
      const x = Math.round(t * zoom - scrollLeft) + 0.5;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      ctx.moveTo(x, isMajor ? 12 : 19);
      ctx.lineTo(x, RULER_H);
      if (isMajor) {
        const label = major < 1 ? `${Math.floor(t)}s ${Math.round((t % 1) * fps)}f` : formatShort(Math.round(t * 100) / 100).replace('.0s', 's');
        ctx.fillText(label, x + 3, 3);
      }
    }
    ctx.stroke();
  }, [zoom, fps, scrollLeft, viewW, duration]);
  return (
    <div className="ruler" onPointerDown={onScrubStart}>
      <canvas ref={ref} />
      {markers.map((m) => (
        <span key={m.id} className="mk" style={{ left: m.time * zoom, background: m.color }} title={`${m.label} — double-click to remove`}
          onPointerDown={(e) => { e.stopPropagation(); seek(m.time); }}
          onDoubleClick={() => useApp.getState().apply('Remove marker', (p) => ({ ...p, markers: p.markers.filter((x) => x.id !== m.id) }))} />
      ))}
    </div>
  );
}

/* --------------------------------- clip --------------------------------- */

const ClipView = memo(function ClipView({ clip, media, zoom, selected, rowH, invalid, dragging, keyTimes }: {
  clip: Clip; media?: MediaItem; zoom: number; selected: boolean; rowH: number; invalid: boolean; dragging: boolean; keyTimes: number[];
}) {
  const w = Math.max(2, clip.duration * zoom);
  const tileW = Math.round((rowH - 8) * 16 / 9);
  // Slivers (a zoomed-out, heavily cut timeline) skip thumbnails and waveforms: nothing would be visible anyway.
  const tiny = w < 16;
  let strip: React.ReactNode = null;
  if (!tiny && (clip.kind === 'video' || clip.kind === 'image') && media?.thumbnails?.length) {
    const thumbs = media.thumbnails;
    const count = Math.min(80, Math.ceil(w / tileW));
    strip = (
      <div className="strip" style={{ display: 'flex' }}>
        {Array.from({ length: count }, (_, i) => {
          let idx = 0;
          if (clip.kind === 'video' && media.duration > 0) {
            const src = clip.sourceIn + ((i + 0.5) * tileW / zoom) * clip.speed;
            idx = Math.min(thumbs.length - 1, Math.max(0, Math.floor((src / media.duration) * thumbs.length)));
          }
          return <div key={i} style={{ width: tileW, flex: 'none', height: '100%', backgroundImage: `url(${thumbs[idx]})`, backgroundSize: 'cover', backgroundPosition: 'center' }} />;
        })}
      </div>
    );
  }
  const showWave = !tiny && (clip.kind === 'audio' || (clip.kind === 'video' && !clip.muted)) && media?.peaks;
  const label = clip.kind === 'text' ? clip.text?.content || 'Text' : clip.name;
  return (
    <div
      className={`clip${selected ? ' sel' : ''}${clip.locked ? ' locked' : ''}${dragging ? ' dragging' : ''}${invalid ? ' invalid' : ''}${clip.placeholder && !clip.mediaId ? ' slot' : ''}`}
      data-clip={clip.id}
      style={{ left: clip.start * zoom, width: w, ['--c' as string]: clip.placeholder && !clip.mediaId ? 'var(--clip-slot)' : clip.kind === 'solid' ? clip.color : CLIP_COLOR[clip.kind] }}
      role="button"
      aria-label={`${clip.kind} clip ${label}, ${formatShort(clip.duration)}`}
      aria-pressed={selected}
    >
      {strip}
      {showWave && (
        <div className="wave" style={clip.kind === 'video' ? { height: '32%', opacity: 0.8 } : undefined}>
          <Waveform peaks={media!.peaks} perSecond={media!.peaksPerSecond} from={clip.sourceIn} to={clip.sourceIn + clip.duration * clip.speed} />
        </div>
      )}
      {clip.fadeIn + clip.videoFadeIn > 0 && <div className="fade in" style={{ width: Math.max(clip.fadeIn, clip.videoFadeIn) * zoom }} />}
      {clip.fadeOut + clip.videoFadeOut > 0 && <div className="fade out" style={{ width: Math.max(clip.fadeOut, clip.videoFadeOut) * zoom }} />}
      <div className="lbl">
        {clip.locked && <Icon name="lock" size={11} />}
        {clip.muted && clip.kind !== 'text' && <Icon name="mute" size={11} />}
        {clip.speed !== 1 && <span className="badge">{clip.speed.toFixed(2).replace(/\.?0+$/, '')}×</span>}
        {clip.reverse && <span className="badge">REV</span>}
        {clip.effects.length > 0 && <span className="badge">FX {clip.effects.length}</span>}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      </div>
      {selected && keyTimes.map((t) => <span key={t} className="kf" style={{ left: t * zoom }} />)}
      {!clip.locked && <><div className="handle l" data-handle="l" /><div className="handle r" data-handle="r" /></>}
    </div>
  );
});

/* --------------------------------- cuts / transitions --------------------------------- */

function Junctions({ track, zoom, selected, inView }: { track: Track; zoom: number; selected: string | null; inView: (c: Clip) => boolean }) {
  const windows = new Map(trackTransitions(track).map((w) => [w.a.id, w]));
  return (
    <>
      {track.clips.map((c) => {
        if (!inView(c)) return null;
        const b = nextAdjacent(track, c);
        if (!b) return null;
        const cut = c.start + c.duration;
        const w = windows.get(c.id);
        return (
          <div key={`j${c.id}`}>
            {w && <div className="tr-band" style={{ left: w.start * zoom, width: w.duration * zoom }} />}
            <button className={`junction${w ? ' has' : ''}${selected === c.id ? ' sel' : ''}`} data-junction={c.id} style={{ left: cut * zoom }}
              title={w ? `${getTransitionDef(w.transition.type)?.name ?? 'Transition'} — tap to edit` : 'Add a transition'}
              aria-label={w ? `Edit transition between ${c.name} and ${b.name}` : `Add transition between ${c.name} and ${b.name}`}>
              <Icon name={w ? 'transitions' : 'plus'} size={11} />
            </button>
          </div>
        );
      })}
    </>
  );
}

/* --------------------------------- track head --------------------------------- */

function TrackHead({ track, rowH, index, count }: { track: Track; rowH: number; index: number; count: number }) {
  const apply = useApp((s) => s.apply);
  const t = track;
  return (
    <div className="tl-head" style={{ height: rowH }}>
      <span className="nm" title={t.name}>{t.name}</span>
      {t.kind === 'visual' ? (
        <button className={`icon-btn keep${t.hidden ? ' on' : ''}`} onClick={() => apply(t.hidden ? 'Show track' : 'Hide track', (p) => updateTrack(p, t.id, { hidden: !t.hidden }))} title={t.hidden ? 'Show track' : 'Hide track'} aria-label={t.hidden ? 'Show track' : 'Hide track'}>
          <Icon name={t.hidden ? 'eyeOff' : 'eye'} size={14} />
        </button>
      ) : null}
      <button className={`icon-btn${t.muted ? ' on' : ''}`} onClick={() => apply(t.muted ? 'Unmute track' : 'Mute track', (p) => updateTrack(p, t.id, { muted: !t.muted }))} title={t.muted ? 'Unmute track' : 'Mute track'} aria-label={t.muted ? 'Unmute track' : 'Mute track'}>
        <Icon name={t.muted ? 'mute' : 'volume'} size={14} />
      </button>
      <button className={`icon-btn${t.locked ? ' on' : ''}`} onClick={() => apply(t.locked ? 'Unlock track' : 'Lock track', (p) => updateTrack(p, t.id, { locked: !t.locked }))} title={t.locked ? 'Unlock track' : 'Lock track'} aria-label={t.locked ? 'Unlock track' : 'Lock track'}>
        <Icon name={t.locked ? 'lock' : 'unlock'} size={14} />
      </button>
      {t.clips.length === 0 && count > 2 ? (
        <button className="icon-btn" onClick={() => apply('Remove track', (p) => removeTrack(p, t.id))} title="Remove empty track" aria-label="Remove empty track"><Icon name="close" size={13} /></button>
      ) : (
        <button className="icon-btn" onClick={() => apply('Move track', (p) => moveTrack(p, t.id, index === 0 ? 1 : -1))} title="Move track up/down" aria-label="Reorder track"><Icon name="grip" size={13} /></button>
      )}
    </div>
  );
}

/* --------------------------------- timeline --------------------------------- */

const NO_KEYS: number[] = [];

/** Thin bar under the ruler: amber = heavy section not rendered yet, green = plays from a background render. */
function RenderBar({ zoom }: { zoom: number }) {
  const [states, setStates] = useState<ChunkState[]>(() => renderCache.states());
  useEffect(() => {
    let raf = 0;
    const update = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => setStates(renderCache.states())); };
    update();
    const off = renderCache.subscribe(update);
    return () => { off(); cancelAnimationFrame(raf); };
  }, []);
  if (!states.some((s) => s !== 'light')) return null;
  return (
    <div className="render-bar" aria-hidden="true">
      {states.map((s, i) => (s === 'light' ? null : (
        <i key={i} className={s} style={{ left: i * CHUNK_SECONDS * zoom, width: CHUNK_SECONDS * zoom }} title={s === 'ready' ? 'Rendered — plays smoothly' : s === 'rendering' ? 'Rendering…' : 'Heavy section — will render in the background'} />
      )))}
    </div>
  );
}

export function Timeline() {
  const project = useApp((s) => s.project)!;
  const selection = useApp((s) => s.selection);
  const selectedTransition = useApp((s) => s.selectedTransition);
  const zoom = useApp((s) => s.zoom);
  const snapping = useApp((s) => s.snapping);
  const { apply, select, setZoom, importFiles, setSnapping, undo, redo, history } = useApp();
  const rowH = useRowHeight();
  const scrollRef = useRef<HTMLDivElement>(null);
  const headsRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ left: 0, top: 0, w: 800 });
  const [ghost, setGhost] = useState<Project | null>(null);
  const [snapAt, setSnapAt] = useState<number | null>(null);
  const [dropLane, setDropLane] = useState<string | null>(null);
  const drag = useRef<DragState | null>(null);
  const tap = useRef<{ id: string; x: number; y: number; pointerId: number } | null>(null);

  const view = ghost ?? project;
  const duration = projectDuration(view);
  // Only clips near the visible part of the timeline are put on the page (plus selected/dragged ones),
  // so a heavily-cut hour-long edit stays as quick as a short one.
  const vx0 = scroll.left - 800, vx1 = scroll.left + scroll.w + 800;
  const inView = (c: Clip) => ((c.start + c.duration) * zoom >= vx0 && c.start * zoom <= vx1) || selection.includes(c.id) || (drag.current?.moved ? drag.current.ids.includes(c.id) : false);
  const contentW = Math.max(scroll.w, (duration + 20) * zoom);
  const mediaById = useMemo(() => new Map(project.media.map((m) => [m.id, m])), [project.media]);

  // Playhead follows time without re-rendering React.
  useEffect(() => {
    const place = (t: number) => {
      if (playheadRef.current) playheadRef.current.style.left = `${t * useApp.getState().zoom}px`;
      const sc = scrollRef.current;
      const player = useApp.getState().player;
      if (sc && player?.playing) {
        const x = t * useApp.getState().zoom;
        if (x > sc.scrollLeft + sc.clientWidth - 40) sc.scrollLeft = x - 60;
        if (x < sc.scrollLeft) sc.scrollLeft = Math.max(0, x - 60);
      }
    };
    place(useTime.getState().time);
    return useTime.subscribe((s) => place(s.time));
  }, [zoom]);

  useLayoutEffect(() => {
    const sc = scrollRef.current!;
    const upd = () => setScroll({ left: sc.scrollLeft, top: sc.scrollTop, w: sc.clientWidth });
    upd();
    const ro = new ResizeObserver(upd);
    ro.observe(sc);
    return () => ro.disconnect();
  }, []);

  const onScroll = () => {
    const sc = scrollRef.current!;
    setScroll({ left: sc.scrollLeft, top: sc.scrollTop, w: sc.clientWidth });
    if (headsRef.current) headsRef.current.style.transform = `translateY(${-sc.scrollTop}px)`;
  };

  /* ----- zoom: ctrl/⌘+wheel and two-finger pinch, anchored under the pointer ----- */
  const zoomAround = useCallback((factor: number, clientX: number) => {
    const sc = scrollRef.current!;
    const r = sc.getBoundingClientRect();
    const z = useApp.getState().zoom;
    const t = (clientX - r.left + sc.scrollLeft) / z;
    const nz = Math.min(800, Math.max(2, z * factor));
    setZoom(nz);
    requestAnimationFrame(() => { sc.scrollLeft = t * nz - (clientX - r.left); });
  }, [setZoom]);

  useEffect(() => {
    const sc = scrollRef.current!;
    const wheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomAround(Math.exp(-e.deltaY * 0.01), e.clientX);
      } else if (!e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX) && sc.scrollHeight <= sc.clientHeight + 2) {
        // Plain wheel scrolls time when there's nothing to scroll vertically.
        sc.scrollLeft += e.deltaY;
      }
    };
    let pinch: { d: number; x: number } | null = null;
    const ts = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        const [a, b] = [e.touches[0], e.touches[1]];
        pinch = { d: Math.abs(a.clientX - b.clientX) + 1, x: (a.clientX + b.clientX) / 2 };
      }
    };
    const tm = (e: TouchEvent) => {
      if (pinch && e.touches.length === 2) {
        e.preventDefault();
        const [a, b] = [e.touches[0], e.touches[1]];
        const d = Math.abs(a.clientX - b.clientX) + 1;
        zoomAround(d / pinch.d, pinch.x);
        pinch.d = d;
      }
    };
    const te = () => { pinch = null; };
    sc.addEventListener('wheel', wheel, { passive: false });
    sc.addEventListener('touchstart', ts, { passive: true });
    sc.addEventListener('touchmove', tm, { passive: false });
    sc.addEventListener('touchend', te);
    return () => {
      sc.removeEventListener('wheel', wheel);
      sc.removeEventListener('touchstart', ts);
      sc.removeEventListener('touchmove', tm);
      sc.removeEventListener('touchend', te);
    };
  }, [zoomAround]);

  /* ----- coordinates ----- */
  const timeAt = (clientX: number) => {
    const sc = scrollRef.current!;
    return Math.max(0, (clientX - sc.getBoundingClientRect().left + sc.scrollLeft) / useApp.getState().zoom);
  };
  const laneAt = (clientY: number): Track | null => {
    const sc = scrollRef.current!;
    const y = clientY - sc.getBoundingClientRect().top + sc.scrollTop - RULER_H;
    const i = Math.floor(y / rowH);
    return useApp.getState().project!.tracks[i] ?? null;
  };

  /* ----- scrubbing ----- */
  const scrub = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    useApp.getState().player?.pause();
    seek(timeAt(e.clientX));
    const move = (ev: PointerEvent) => seek(timeAt(ev.clientX));
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  /* ----- clip dragging ----- */
  const snapThreshold = () => 8 / useApp.getState().zoom;

  const beginDrag = (e: React.PointerEvent, clipId: string, mode: DragMode) => {
    const p = useApp.getState().project!;
    const loc = findClip(p, clipId);
    if (!loc) return;
    if (loc.track.locked || loc.clip.locked) { useApp.getState().toast(loc.track.locked ? 'This track is locked.' : 'This clip is locked.'); return; }
    const sel = useApp.getState().selection;
    const ids = mode === 'move' && sel.includes(clipId) && sel.length > 1 ? sel : [clipId];
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { mode, clipId, ids, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, origin: loc.clip, moved: false };
    useApp.getState().player?.pause();
  };

  const onLanePointerDown = (e: React.PointerEvent) => {
    const target = e.target as HTMLElement;
    const junction = (target.closest('[data-junction]') as HTMLElement | null)?.dataset.junction;
    if (junction) {
      e.stopPropagation();
      const st = useApp.getState();
      st.selectTransition(junction);
      const has = !!findClip(st.project!, junction)?.clip.transitionOut;
      if (!has) st.setPanel('transitions');
      if (window.innerWidth <= 900) st.setMobileSheet(has ? 'inspector' : 'panel');
      return;
    }
    const clipEl = target.closest('[data-clip]') as HTMLElement | null;
    if (!clipEl) {
      // Empty lane: deselect and move the playhead.
      if (e.button === 0) { select([]); scrub(e); }
      return;
    }
    const id = clipEl.dataset.clip!;
    const handle = target.dataset.handle as 'l' | 'r' | undefined;
    const selected = useApp.getState().selection.includes(id);
    if (e.pointerType === 'touch' && !selected) {
      // Touch on an unselected clip: let the timeline scroll; select on tap.
      tap.current = { id, x: e.clientX, y: e.clientY, pointerId: e.pointerId };
      return;
    }
    if (!selected || e.shiftKey || e.metaKey || e.ctrlKey) select([id], e.shiftKey || e.metaKey || e.ctrlKey);
    beginDrag(e, id, handle === 'l' ? 'trimL' : handle === 'r' ? 'trimR' : 'move');
  };

  const onLanePointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.x0;
    if (!d.moved && Math.abs(dx) < 3 && Math.abs(e.clientY - d.y0) < 3) return;
    d.moved = true;
    const z = useApp.getState().zoom;
    const p = useApp.getState().project!;
    const pts = useApp.getState().snapping ? snapPoints(p, d.ids, [useTime.getState().time]) : [];
    const thr = snapThreshold();
    let snapped: number | null = null;
    let next: Project | null = null;
    if (d.mode === 'move') {
      let start = Math.max(0, d.origin.start + dx / z);
      if (pts.length) {
        const s1 = snapTime(start, pts, thr);
        const s2 = snapTime(start + d.origin.duration, pts, thr);
        if (s1.snapped && (!s2.snapped || Math.abs(s1.time - start) <= Math.abs(s2.time - start - d.origin.duration))) { start = s1.time; snapped = s1.time; }
        else if (s2.snapped) { start = s2.time - d.origin.duration; snapped = s2.time; }
      }
      if (d.ids.length > 1) next = moveClipsBy(p, d.ids, start - d.origin.start);
      else {
        const lane = laneAt(e.clientY);
        const loc = findClip(p, d.clipId)!;
        const targetTrack = lane && lane.kind === loc.track.kind && !lane.locked ? lane.id : loc.track.id;
        next = moveClip(p, d.clipId, start, targetTrack) ?? moveClip(p, d.clipId, start);
      }
    } else if (d.mode === 'trimL') {
      let t = d.origin.start + dx / z;
      if (pts.length) { const s = snapTime(t, pts, thr); if (s.snapped) { t = s.time; snapped = t; } }
      next = trimStart(p, d.clipId, t);
    } else {
      let t = clipEnd(d.origin) + dx / z;
      if (pts.length) { const s = snapTime(t, pts, thr); if (s.snapped) { t = s.time; snapped = t; } }
      next = trimEnd(p, d.clipId, t);
      const c = findClip(next, d.clipId)?.clip;
      if (c) seek(Math.max(c.start, clipEnd(c) - 1 / p.settings.fps));
    }
    if (d.mode === 'trimL') {
      const c = next && findClip(next, d.clipId)?.clip;
      if (c) seek(c.start);
    }
    setSnapAt(snapped);
    if (next) setGhost(next); // invalid positions keep the last valid ghost
  };

  const onLanePointerUp = (e: React.PointerEvent) => {
    const t = tap.current;
    if (t && t.pointerId === e.pointerId) {
      tap.current = null;
      if (Math.hypot(e.clientX - t.x, e.clientY - t.y) < 10) select([t.id]);
      return;
    }
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    setSnapAt(null);
    if (ghost && d.moved) {
      const label = d.mode === 'move' ? 'Move clip' : 'Trim clip';
      const g = ghost;
      apply(label, () => g);
    }
    setGhost(null);
  };

  const onLanePointerCancel = () => {
    tap.current = null;
    drag.current = null;
    setGhost(null);
    setSnapAt(null);
  };

  /* ----- drops from the media library / OS ----- */
  const onDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes(MEDIA_DRAG_TYPE) || e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      setDropLane(laneAt(e.clientY)?.id ?? null);
    }
  };
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDropLane(null);
    const t = timeAt(e.clientX);
    const lane = laneAt(e.clientY);
    const mediaId = e.dataTransfer.getData(MEDIA_DRAG_TYPE);
    if (mediaId) {
      let newId = '';
      apply('Add clip', (p) => {
        const m = p.media.find((x) => x.id === mediaId);
        if (!m) return null;
        if (lane) {
          const clip = createClipFromMedia(m, t);
          const direct = addClipToTrack(p, lane.id, clip);
          if (direct) { newId = clip.id; return direct; }
        }
        const r = addMediaClip(p, mediaId, t);
        newId = r?.clipId ?? '';
        return r?.project ?? null;
      });
      if (newId) select([newId]);
      return;
    }
    const files = await filesFromDataTransfer(e.dataTransfer);
    if (files.length) void importFiles(files, t);
  };

  const keyTimesFor = (c: Clip) => {
    const s = new Set<number>();
    Object.values(c.keyframes).forEach((ks) => ks?.forEach((k) => s.add(k.t)));
    return [...s];
  };
  const draggingIds = drag.current?.moved ? drag.current.ids : [];

  return (
    <div className="timeline" style={{ ['--row-h' as string]: `${rowH}px` }}>
      <div className="tl-toolbar" role="toolbar" aria-label="Timeline tools">
        <button className="icon-btn mobile-only" onClick={undo} disabled={!history.past.length} title="Undo" aria-label="Undo"><Icon name="undo" /></button>
        <button className="icon-btn mobile-only" onClick={redo} disabled={!history.future.length} title="Redo" aria-label="Redo"><Icon name="redo" /></button>
        <button className="icon-btn" onClick={splitAtPlayhead} title="Split at playhead (S)" aria-label="Split"><Icon name="split" /></button>
        <button className="icon-btn" onClick={() => deleteSelected(false)} disabled={!selection.length} title="Delete (Del)" aria-label="Delete"><Icon name="trash" /></button>
        <button className="icon-btn" onClick={() => deleteSelected(true)} disabled={!selection.length} title="Ripple delete — close the gap (Shift+Del)" aria-label="Ripple delete"><Icon name="ripple" /></button>
        <button className="icon-btn" onClick={duplicateSelected} disabled={!selection.length} title="Duplicate (Ctrl+D)" aria-label="Duplicate"><Icon name="copy" /></button>
        <button className="icon-btn" onClick={detachSelectedAudio} disabled={!selection.length} title="Detach audio to its own track" aria-label="Detach audio"><Icon name="detach" /></button>
        <span className="sep" />
        <button className={`icon-btn${project.magnetic ? ' on' : ''}`} onClick={() => apply(project.magnetic ? 'Magnetic off' : 'Magnetic on', (p) => ({ ...p, magnetic: !p.magnetic }))}
          title="Magnetic main track — clips on the bottom video track always butt together" aria-label="Magnetic timeline" aria-pressed={project.magnetic}><Icon name="magnet" /></button>
        <button className={`icon-btn${snapping ? ' on' : ''}`} onClick={() => setSnapping(!snapping)} title="Snapping" aria-label="Snapping" aria-pressed={snapping}><Icon name="snap" /></button>
        <button className="icon-btn" onClick={addMarker} title="Add marker (M)" aria-label="Add marker"><Icon name="marker" /></button>
        <span className="sep" />
        <button className="icon-btn desktop-only" onClick={() => apply('Add track', (p) => addTrack(p, 'visual'))} title="Add video/overlay track" aria-label="Add video track"><Icon name="media" /></button>
        <button className="icon-btn desktop-only" onClick={() => apply('Add track', (p) => addTrack(p, 'audio'))} title="Add audio track" aria-label="Add audio track"><Icon name="audio" /></button>
        <div style={{ flex: 1 }} />
        <button className="icon-btn" onClick={() => zoomBy(1 / 1.4)} title="Zoom out (-)" aria-label="Zoom out"><Icon name="zoomOut" /></button>
        <input className="zoom" type="range" min={Math.log(2)} max={Math.log(800)} step={0.01} value={Math.log(zoom)} onChange={(e) => setZoom(Math.exp(+e.target.value))} aria-label="Timeline zoom" />
        <button className="icon-btn" onClick={() => zoomBy(1.4)} title="Zoom in (+)" aria-label="Zoom in"><Icon name="zoomIn" /></button>
        <button className="icon-btn" onClick={() => zoomToFit(scrollRef.current?.clientWidth ?? 800)} title="Fit timeline" aria-label="Fit timeline"><Icon name="fit" /></button>
      </div>
      <div className="tl-main">
        <div className="tl-heads">
          <div ref={headsRef}>
            <div className="heads-spacer" />
            {view.tracks.map((t, i) => <TrackHead key={t.id} track={t} rowH={rowH} index={i} count={view.tracks.length} />)}
          </div>
        </div>
        <div className="tl-scroll" ref={scrollRef} onScroll={onScroll} onDragOver={onDragOver} onDragLeave={() => setDropLane(null)} onDrop={onDrop}>
          <div className="tl-content" style={{ width: contentW, height: RULER_H + view.tracks.length * rowH + 40 }}>
            <Ruler zoom={zoom} fps={project.settings.fps} scrollLeft={scroll.left} viewW={scroll.w} duration={duration} markers={project.markers} onScrubStart={scrub} />
            <RenderBar zoom={zoom} />
            <div
              onPointerDown={onLanePointerDown}
              onPointerMove={onLanePointerMove}
              onPointerUp={onLanePointerUp}
              onPointerCancel={onLanePointerCancel}
              onDoubleClick={(e) => { if ((e.target as HTMLElement).closest('[data-clip]') && window.innerWidth <= 900) useApp.getState().setMobileSheet('inspector'); }}
            >
              {view.tracks.map((t) => (
                <div key={t.id} className={`lane${t.kind === 'audio' ? ' audio' : ''}${t.locked ? ' locked' : ''}${dropLane === t.id ? ' drop-ok' : ''}`} style={{ height: rowH }}>
                  {t.clips.filter(inView).map((c) => (
                    <ClipView key={c.id} clip={c} media={c.mediaId ? mediaById.get(c.mediaId) : undefined} zoom={zoom}
                      selected={selection.includes(c.id)} rowH={rowH} invalid={false} dragging={draggingIds.includes(c.id)}
                      keyTimes={selection.includes(c.id) ? keyTimesFor(c) : NO_KEYS} />
                  ))}
                  {t.kind === 'visual' && t.role !== 'captions' && !ghost && <Junctions track={t} zoom={zoom} selected={selectedTransition} inView={inView} />}
                </div>
              ))}
            </div>
            {project.markers.map((m) => <div key={m.id} className="marker-line" style={{ left: m.time * zoom }} />)}
            {snapAt !== null && <div className="snap-line" style={{ left: snapAt * zoom }} />}
            <div className="playhead" ref={playheadRef} onPointerDown={scrub} />
            {duration === 0 && <div className="tl-empty">Add clips from the Media panel, or drop files here.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
