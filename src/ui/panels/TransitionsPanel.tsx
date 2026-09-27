import { useEffect, useRef, useState } from 'react';
import {
  createTransition, DIRECTION_LABELS, getTransitionDef, maxTransitionDuration, nextAdjacent, TRANSITION_CATEGORIES, TRANSITIONS,
} from '../../core/transitions';
import { findClip, setTransition } from '../../core/timeline';
import type { Project } from '../../core/types';
import { renderTransition } from '../../engine/transitionRender';
import { PropRow, Section, Seg } from '../components/Controls';
import { Icon } from '../components/Icon';
import { useApp, useTime } from '../store';

/* ----------------------------- thumbnails ----------------------------- */

const TW = 112, TH = 70;
let cards: [HTMLCanvasElement, HTMLCanvasElement] | null = null;
function sampleCards(): [HTMLCanvasElement, HTMLCanvasElement] {
  if (cards) return cards;
  const make = (bg1: string, bg2: string, label: string) => {
    const c = document.createElement('canvas');
    c.width = TW; c.height = TH;
    const x = c.getContext('2d')!;
    const g = x.createLinearGradient(0, 0, TW, TH);
    g.addColorStop(0, bg1); g.addColorStop(1, bg2);
    x.fillStyle = g; x.fillRect(0, 0, TW, TH);
    x.fillStyle = 'rgba(255,255,255,0.9)';
    x.font = '800 28px Figtree, sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(label, TW / 2, TH / 2 + 1);
    return c;
  };
  cards = [make('#f2b544', '#c8643b', 'A'), make('#3f6fd8', '#2a2f7a', 'B')];
  return cards;
}

function TransitionThumb({ type, active }: { type: string; active: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState(false);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    const [a, b] = sampleCards();
    const tr = createTransition(type);
    const draw = (p: number, frame: number) => {
      ctx.clearRect(0, 0, TW, TH);
      ctx.fillStyle = '#0b0d12';
      ctx.fillRect(0, 0, TW, TH);
      renderTransition(ctx, a, b, TW, TH, tr, p, frame, TW / 1080);
    };
    if (!hover && !active) { draw(0.42, 3); return; }
    let raf = 0;
    const t0 = performance.now();
    const loop = () => {
      const el = (performance.now() - t0) / 1000;
      const cyc = el % 1.6;
      const p = cyc < 0.2 ? 0 : cyc > 1.2 ? 1 : (cyc - 0.2);
      const x = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      draw(x, Math.floor(el * 30));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [type, hover, active]);
  return <canvas ref={ref} width={TW} height={TH} onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)} style={{ width: '100%', aspectRatio: `${TW} / ${TH}`, borderRadius: 6, display: 'block' }} />;
}

/* ----------------------------- targeting ----------------------------- */

/** Which cut a transition should go on: the selected cut, the selected clip's end, or the cut nearest the playhead. */
export function resolveCut(p: Project): string | null {
  const st = useApp.getState();
  if (st.selectedTransition && findClip(p, st.selectedTransition)) return st.selectedTransition;
  const cuts: { id: string; time: number }[] = [];
  for (const track of p.tracks) {
    if (track.kind !== 'visual') continue;
    for (const c of track.clips) if (nextAdjacent(track, c)) cuts.push({ id: c.id, time: c.start + c.duration });
  }
  const sel = st.selection.find((id) => cuts.some((c) => c.id === id));
  if (sel) return sel;
  if (!cuts.length) return null;
  const t = useTime.getState().time;
  cuts.sort((a, b) => Math.abs(a.time - t) - Math.abs(b.time - t));
  return cuts[0].id;
}

export function applyTransitionType(type: string): void {
  const st = useApp.getState();
  const p = st.project;
  if (!p) return;
  const id = resolveCut(p);
  if (!id) { st.toast('Transitions go on a cut. Put two clips end to end on the same track first.'); return; }
  const loc = findClip(p, id)!;
  const next = nextAdjacent(loc.track, loc.clip)!;
  const prev = loc.clip.transitionOut;
  const dur = Math.min(prev?.duration ?? 0.5, maxTransitionDuration(loc.clip, next));
  st.apply(`Transition: ${getTransitionDef(type)?.name}`, (proj) => setTransition(proj, id, createTransition(type, dur)));
  st.selectTransition(id);
}

export function applyToAllCuts(): void {
  const st = useApp.getState();
  const p = st.project;
  const src = st.selectedTransition ? findClip(p!, st.selectedTransition)?.clip.transitionOut : undefined;
  if (!p || !src) return;
  let n = 0;
  st.apply('Transition on every cut', (proj) => {
    let next = proj;
    for (const track of proj.tracks) {
      if (track.kind !== 'visual' || track.role === 'captions') continue;
      for (const c of track.clips) {
        const b = nextAdjacent(track, c);
        if (!b) continue;
        next = setTransition(next, c.id, { ...src, params: { ...src.params }, duration: Math.min(src.duration, maxTransitionDuration(c, b)) });
        n++;
      }
    }
    return n ? next : null;
  });
  st.toast(`Applied to ${n} cut${n === 1 ? '' : 's'}.`, 'success');
}

/* ----------------------------- panel ----------------------------- */

export function TransitionsPanel() {
  const project = useApp((s) => s.project)!;
  const selectedTransition = useApp((s) => s.selectedTransition);
  const current = selectedTransition ? findClip(project, selectedTransition)?.clip.transitionOut?.type : undefined;
  return (
    <>
      <p className="faint" style={{ margin: 0, fontSize: 12 }}>
        Tap a ◇ between two clips on the timeline, then pick a transition. Hover a tile to preview it. With nothing picked, it goes on the cut nearest the playhead.
      </p>
      {TRANSITION_CATEGORIES.map((cat) => {
        const list = TRANSITIONS.filter((t) => t.category === cat.id);
        if (!list.length) return null;
        return (
          <div key={cat.id} className="section">
            <div className="label">{cat.label}</div>
            <div className="tr-grid">
              {list.map((t) => (
                <button key={t.type} className={`tr-tile${current === t.type ? ' on' : ''}`} onClick={() => applyTransitionType(t.type)} aria-label={`Add ${t.name} transition`}>
                  <TransitionThumb type={t.type} active={current === t.type} />
                  <span>{t.name}</span>
                </button>
              ))}
            </div>
          </div>
        );
      })}
      <p className="faint" style={{ margin: 0, fontSize: 11 }}>Sound cuts straight across for now; automatic audio crossfades are planned.</p>
    </>
  );
}

/* ----------------------------- inspector ----------------------------- */

export function TransitionInspector({ clipId }: { clipId: string }) {
  const project = useApp((s) => s.project)!;
  const { apply, selectTransition, setPanel, setMobileSheet } = useApp();
  const loc = findClip(project, clipId);
  const next = loc ? nextAdjacent(loc.track, loc.clip) : null;
  if (!loc || !next) {
    return (
      <div className="insp-body">
        <p className="faint">These clips no longer touch, so there’s no cut here.</p>
        <button className="btn" onClick={() => selectTransition(null)}>Done</button>
      </div>
    );
  }
  const tr = loc.clip.transitionOut;
  const def = tr ? getTransitionDef(tr.type) : undefined;
  const max = maxTransitionDuration(loc.clip, next);
  const update = (patch: Partial<NonNullable<typeof tr>>, label: string, key?: string) =>
    apply(label, (p) => setTransition(p, clipId, { ...tr!, ...patch }), key);
  return (
    <div className="insp-body">
      <Section title="Cut" right={<button className="icon-btn sm" onClick={() => selectTransition(null)} aria-label="Close"><Icon name="close" size={14} /></button>}>
        <div className="muted" style={{ fontSize: 12 }}><b>{loc.clip.name}</b> → <b>{next.name}</b></div>
      </Section>
      {!tr || !def ? (
        <Section title="Transition">
          <p className="faint" style={{ margin: 0, fontSize: 12 }}>No transition on this cut yet.</p>
          <button className="btn primary" onClick={() => { setPanel('transitions'); setMobileSheet(window.innerWidth <= 900 ? 'panel' : null); }}><Icon name="transitions" size={15} />Choose a transition</button>
        </Section>
      ) : (
        <>
          <Section title={def.name} right={
            <button className="btn sm" onClick={() => { setPanel('transitions'); setMobileSheet(window.innerWidth <= 900 ? 'panel' : null); }}>Change</button>
          }>
            <PropRow label="Duration" value={Math.min(tr.duration, max)} min={0.1} max={max} step={0.05} unit="s" onChange={(v) => update({ duration: v }, 'Transition length', `trd:${clipId}`)} />
            {def.params.filter((p) => p.key !== 'dir' && p.key !== 'ease' && p.key !== 'clockwise').map((p) => (
              <PropRow key={p.key} label={p.label} value={tr.params[p.key] ?? p.default} min={p.min} max={p.max} step={p.step} unit={p.unit}
                onChange={(v) => update({ params: { ...tr.params, [p.key]: v } }, def.name, `trp:${clipId}:${p.key}`)} />
            ))}
            {def.params.some((p) => p.key === 'dir') && (
              <div className="field"><span>Direction</span>
                <Seg label="Direction" value={String(tr.params.dir ?? 0)} onChange={(v) => update({ params: { ...tr.params, dir: +v } }, 'Direction')}
                  options={DIRECTION_LABELS.map((l, i) => ({ value: String(i), label: l }))} />
              </div>
            )}
            {def.params.some((p) => p.key === 'clockwise') && (
              <label className="row"><input type="checkbox" checked={(tr.params.clockwise ?? 1) >= 1} onChange={() => update({ params: { ...tr.params, clockwise: (tr.params.clockwise ?? 1) >= 1 ? 0 : 1 } }, 'Direction')} /> Clockwise</label>
            )}
            {def.params.some((p) => p.key === 'ease') && (
              <label className="row"><input type="checkbox" checked={(tr.params.ease ?? 1) >= 1} onChange={() => update({ params: { ...tr.params, ease: (tr.params.ease ?? 1) >= 1 ? 0 : 1 } }, 'Easing')} /> Smooth start and end</label>
            )}
            {def.color && (
              <div className="row"><input type="color" className="swatch" value={tr.color ?? def.color} onChange={(e) => update({ color: e.target.value }, 'Transition colour', `trc:${clipId}`)} aria-label="Transition colour" /><span className="muted" style={{ fontSize: 12 }}>Colour</span></div>
            )}
          </Section>
          <Section title="More">
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <button className="btn sm" onClick={applyToAllCuts}><Icon name="copy" size={13} />Use on every cut</button>
              <button className="btn sm danger" onClick={() => { apply('Remove transition', (p) => setTransition(p, clipId, null)); }}><Icon name="trash" size={13} />Remove</button>
            </div>
            {tr.duration > max + 1e-6 && <small className="faint">Shortened to {max.toFixed(2)}s to fit these clips.</small>}
          </Section>
        </>
      )}
    </div>
  );
}
