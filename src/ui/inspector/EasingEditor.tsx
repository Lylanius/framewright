import { ease } from '../../core/keyframes';
import { formatShort } from '../../core/time';
import type { Clip, Easing } from '../../core/types';
import { seek } from '../actions';
import { PropRow, Section } from '../components/Controls';
import { Icon } from '../components/Icon';
import { setKeyEasing } from '../propEdit';
import { useTime } from '../store';

const EASINGS: { id: Easing; label: string }[] = [
  { id: 'linear', label: 'Linear' }, { id: 'easeIn', label: 'Ease in' }, { id: 'easeOut', label: 'Ease out' },
  { id: 'easeInOut', label: 'Smooth' }, { id: 'hold', label: 'Hold' }, { id: 'bezier', label: 'Custom' },
];

const BEZ_PRESETS: { label: string; bez: [number, number, number, number] }[] = [
  { label: 'Snappy', bez: [0.2, 0.9, 0.1, 1] }, { label: 'Overshoot', bez: [0.34, 1.56, 0.64, 1] },
  { label: 'Anticipate', bez: [0.36, -0.4, 0.6, 1] }, { label: 'Slow middle', bez: [0.1, 0.8, 0.9, 0.2] },
];

function Curve({ e, bez }: { e: Easing; bez?: [number, number, number, number] }) {
  const pts = Array.from({ length: 41 }, (_, i) => { const x = i / 40; const y = ease(e, x, bez); return `${(6 + x * 108).toFixed(1)},${(66 - y * 54).toFixed(1)}`; });
  return (
    <svg viewBox="0 0 120 78" className="ease-curve" aria-hidden="true">
      <rect x="6" y="12" width="108" height="54" className="frame" />
      <polyline points={pts.join(' ')} fill="none" stroke="var(--accent)" strokeWidth="2" />
    </svg>
  );
}

/** Easing for the keyframe under the playhead, plus next/previous key navigation. */
export function EasingEditor({ clip }: { clip: Clip }) {
  const time = useTime((s) => s.time);
  const local = time - clip.start;
  const times = [...new Set(Object.values(clip.keyframes).flatMap((k) => (k ?? []).map((x) => +x.t.toFixed(4))))].sort((a, b) => a - b);
  const here = Object.values(clip.keyframes).flatMap((k) => k ?? []).find((k) => Math.abs(k.t - local) < 1e-3);
  const prev = [...times].reverse().find((t) => t < local - 1e-3);
  const next = times.find((t) => t > local + 1e-3);
  const bez = here?.bez ?? [0.25, 0.1, 0.25, 1];
  const setBez = (i: number, v: number) => { const b = [...bez] as [number, number, number, number]; b[i] = v; setKeyEasing(clip.id, 'bezier', b); };
  return (
    <Section title="Keyframe easing">
      <div className="row">
        <button className="btn sm" disabled={prev === undefined} onClick={() => prev !== undefined && seek(clip.start + prev)} aria-label="Previous keyframe"><Icon name="back" size={12} />Prev</button>
        <span className="grow mono faint" style={{ textAlign: 'center', fontSize: 12 }}>{here ? `Key at ${formatShort(here.t)}` : 'No key at playhead'}</span>
        <button className="btn sm" disabled={next === undefined} onClick={() => next !== undefined && seek(clip.start + next)} aria-label="Next keyframe">Next<Icon name="back" size={12} style={{ transform: 'scaleX(-1)' }} /></button>
      </div>
      {here ? (
        <>
          <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
            {EASINGS.map((e) => (
              <button key={e.id} className={`chip${here.ease === e.id ? ' on' : ''}`} onClick={() => setKeyEasing(clip.id, e.id, e.id === 'bezier' ? bez : undefined)}>{e.label}</button>
            ))}
          </div>
          <Curve e={here.ease} bez={here.bez} />
          {here.ease === 'bezier' && (
            <>
              <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
                {BEZ_PRESETS.map((b) => <button key={b.label} className="chip" onClick={() => setKeyEasing(clip.id, 'bezier', b.bez)}>{b.label}</button>)}
              </div>
              <PropRow label="Out X" value={bez[0]} min={0} max={1} step={0.01} onChange={(v) => setBez(0, v)} />
              <PropRow label="Out Y" value={bez[1]} min={-1} max={2} step={0.01} onChange={(v) => setBez(1, v)} />
              <PropRow label="In X" value={bez[2]} min={0} max={1} step={0.01} onChange={(v) => setBez(2, v)} />
              <PropRow label="In Y" value={bez[3]} min={-1} max={2} step={0.01} onChange={(v) => setBez(3, v)} />
            </>
          )}
          <small className="faint">Easing shapes the move from this key to the next one.</small>
        </>
      ) : <small className="faint">Jump to a key to change how it eases.</small>}
    </Section>
  );
}
