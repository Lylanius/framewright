import { useRef } from 'react';
import { MOTION_IN, MOTION_LOOP, defaultMotion } from '../../core/motion';
import { EMOJI } from '../../core/stickers';
import { slotsOf } from '../../core/templates';
import type { Clip, ClipMotion, ShapeStyle } from '../../core/types';
import { PropRow, Section, Seg } from '../components/Controls';
import { Icon } from '../components/Icon';
import { fillSlotWith } from '../library';
import { useBrandColors } from '../panels/BrandPanel';
import { patchClip } from '../propEdit';
import { useApp } from '../store';

/** Brand kit colours as one-tap chips (hidden when there's no kit). */
export function BrandSwatches({ onPick, label = 'Brand' }: { onPick: (c: string) => void; label?: string }) {
  const cols = useBrandColors();
  if (!cols.length) return null;
  return (
    <div className="row brand-row" style={{ gap: 4, flexWrap: 'wrap' }}>
      <small className="faint">{label}</small>
      {cols.map((c) => <button key={c} className="chip-swatch" style={{ background: c }} onClick={() => onPick(c)} aria-label={`Use brand colour ${c}`} title={c} />)}
    </div>
  );
}

const SHAPE_TYPES: { v: ShapeStyle['type']; label: string }[] = [
  { v: 'rect', label: 'Box' }, { v: 'ellipse', label: 'Circle' }, { v: 'triangle', label: 'Triangle' }, { v: 'star', label: 'Star' }, { v: 'heart', label: 'Heart' },
  { v: 'arrow', label: 'Arrow' }, { v: 'bubble', label: 'Speech bubble' }, { v: 'burst', label: 'Burst' }, { v: 'line', label: 'Line' }, { v: 'emoji', label: 'Emoji' },
];

const BG_TYPES: ShapeStyle['type'][] = ['speedlines', 'rays', 'dots', 'gradient', 'streaks'];

function Colour({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return <label className="row" style={{ fontSize: 13 }}><input type="color" className="swatch" value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'} onChange={(e) => onChange(e.target.value)} aria-label={label} />{label}</label>;
}

function BackgroundControls({ s, set }: { s: ShapeStyle; set: (p: Partial<ShapeStyle>, label?: string) => void }) {
  return (
    <Section title="Background">
      <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
        <Colour label={s.type === 'gradient' ? 'From' : 'Base'} value={s.fill} onChange={(v) => set({ fill: v }, 'Background colour')} />
        {s.type !== 'streaks' ? null : <Colour label="Light streaks" value={s.fill2 ?? '#ff5a3c'} onChange={(v) => set({ fill2: v }, 'Background colour')} />}
        {(s.type === 'gradient' || s.type === 'speedlines' || s.type === 'rays' || s.type === 'dots') && <Colour label={s.type === 'gradient' ? 'To' : 'Centre'} value={s.fill2 ?? s.fill} onChange={(v) => set({ fill2: v }, 'Background colour')} />}
        {s.type !== 'gradient' && <Colour label={s.type === 'speedlines' ? 'Lines' : s.type === 'rays' ? 'Rays' : s.type === 'streaks' ? 'Dark streaks' : 'Dots'} value={s.color2 ?? '#ffffff'} onChange={(v) => set({ color2: v }, 'Background colour')} />}
      </div>
      <BrandSwatches onPick={(c) => set({ fill: c }, 'Background colour')} label="Base" />
      {s.type === 'rays' && <PropRow label="Rays" value={s.points ?? 18} min={4} max={48} step={1} onChange={(v) => set({ points: Math.round(v) })} />}
      {s.type === 'gradient' && <>
        <Seg label="Gradient" value={s.gradientKind ?? 'linear'} onChange={(v) => set({ gradientKind: v }, 'Gradient')} options={[{ value: 'linear', label: 'Linear' }, { value: 'radial', label: 'Radial' }]} />
        {s.gradientKind !== 'radial' && <PropRow label="Angle" value={s.angle ?? 160} min={0} max={360} step={1} unit="°" onChange={(v) => set({ angle: v })} />}
      </>}
      <label className="row"><input type="checkbox" checked={!!s.animate} onChange={() => set({ animate: !s.animate }, 'Animate background')} /> Animate ({s.type === 'speedlines' ? 'flicker' : s.type === 'rays' ? 'rotate' : s.type === 'dots' || s.type === 'streaks' ? 'drift' : 'shift'})</label>
    </Section>
  );
}

function CountdownControls({ s, set, clip }: { s: ShapeStyle; set: (p: Partial<ShapeStyle>, label?: string) => void; clip: Clip }) {
  return (
    <Section title="Countdown">
      <Seg label="Countdown style" value={s.countStyle ?? 'ring'} onChange={(v) => set({ countStyle: v, ...(v === 'bar' ? { width: 800, height: 40, radius: 20 } : v === 'ring' || v === 'number' ? { width: 260, height: 260 } : {}) }, 'Countdown style')}
        options={[{ value: 'ring', label: 'Ring' }, { value: 'bar', label: 'Bar' }, { value: 'number', label: 'Number' }]} />
      <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
        <Colour label="Progress" value={s.stroke} onChange={(v) => set({ stroke: v }, 'Countdown colour')} />
        {s.countStyle !== 'number' && <Colour label="Track" value={s.fill.startsWith('#') ? s.fill : '#000000'} onChange={(v) => set({ fill: v }, 'Countdown colour')} />}
        {s.countStyle !== 'bar' && <Colour label="Number" value={s.textColor ?? '#ffffff'} onChange={(v) => set({ textColor: v }, 'Countdown colour')} />}
      </div>
      {s.countStyle !== 'bar' && <PropRow label="Thickness" value={s.strokeWidth} min={2} max={80} step={1} unit="px" onChange={(v) => set({ strokeWidth: v })} />}
      <small className="faint">Counts down over the clip’s length ({clip.duration.toFixed(1)} s) — trim the clip to change it.</small>
    </Section>
  );
}

export function ShapeTab({ clip }: { clip: Clip }) {
  const s = clip.shape!;
  const set = (patch: Partial<ShapeStyle>, label = 'Edit shape', key?: string) =>
    patchClip(clip.id, (c) => ({ ...c, shape: { ...c.shape!, ...patch } }), label, key ?? `shape:${clip.id}:${Object.keys(patch).join()}`);
  if (BG_TYPES.includes(s.type)) return <BackgroundControls s={s} set={set} />;
  if (s.type === 'countdown') return <CountdownControls s={s} set={set} clip={clip} />;
  if (s.type === 'starburst') return (
    <Section title="Starburst">
      <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
        <Colour label="Spikes" value={s.fill} onChange={(v) => set({ fill: v }, 'Starburst colour')} />
        <Colour label="Inner" value={s.color2 ?? '#9fd0ff'} onChange={(v) => set({ color2: v }, 'Starburst colour')} />
        <Colour label="Centre" value={s.fill2 ?? '#ffffff'} onChange={(v) => set({ fill2: v }, 'Starburst colour')} />
      </div>
      <PropRow label="Size" value={s.width} min={100} max={3000} step={1} unit="px" onChange={(v) => set({ width: v, height: v })} />
      <PropRow label="Spikes" value={s.points ?? 72} min={12} max={160} step={1} onChange={(v) => set({ points: Math.round(v) })} />
      <label className="row"><input type="checkbox" checked={!!s.animate} onChange={() => set({ animate: !s.animate }, 'Shimmer')} /> Shimmer</label>
    </Section>
  );
  return (
    <>
      <Section title="Shape">
        <select className="input" value={s.type} onChange={(e) => set({ type: e.target.value as ShapeStyle['type'] }, 'Change shape')} aria-label="Shape type">
          {SHAPE_TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
        </select>
        {s.type === 'emoji' && (
          <div className="emoji-grid small">{EMOJI.map((e) => <button key={e} className={s.emoji === e ? 'on' : ''} onClick={() => set({ emoji: e }, 'Emoji')} aria-label={`Emoji ${e}`}>{e}</button>)}</div>
        )}
        <PropRow label="Width" value={s.width} min={8} max={3000} step={1} unit="px" onChange={(v) => set({ width: v, ...(s.type === 'emoji' ? { height: v } : {}) })} />
        {s.type !== 'emoji' && <PropRow label="Height" value={s.height} min={4} max={3000} step={1} unit="px" onChange={(v) => set({ height: v })} />}
        {(s.type === 'rect' || s.type === 'bubble') && <PropRow label="Rounding" value={s.radius} min={0} max={400} step={1} unit="px" onChange={(v) => set({ radius: v })} />}
        {(s.type === 'star' || s.type === 'burst') && <PropRow label="Points" value={s.points ?? 5} min={3} max={32} step={1} onChange={(v) => set({ points: Math.round(v) })} />}
        <PropRow label="Shadow" value={s.shadow ?? 0} min={0} max={60} step={1} unit="px" onChange={(v) => set({ shadow: v })} />
        {s.type !== 'emoji' && <div className="row">
          <input type="color" className="swatch" value={s.glowColor ?? '#7fd4ff'} onChange={(e) => set({ glowColor: e.target.value, glow: s.glow || 24 }, 'Glow colour')} aria-label="Glow colour" />
          <div className="grow"><PropRow label="Glow" value={s.glow ?? 0} min={0} max={120} step={1} unit="px" onChange={(v) => set({ glow: v })} /></div>
        </div>}
      </Section>
      {s.type !== 'emoji' && (
        <Section title="Colour">
          <div className="row">
            <label className="row grow"><input type="checkbox" checked={s.fill !== 'transparent'} onChange={() => set({ fill: s.fill === 'transparent' ? '#f2b544' : 'transparent' }, 'Fill')} /> Fill</label>
            {s.fill !== 'transparent' && <input type="color" className="swatch" value={s.fill} onChange={(e) => set({ fill: e.target.value }, 'Fill colour')} aria-label="Fill colour" />}
            {s.fill !== 'transparent' && <label className="row"><input type="checkbox" checked={!!s.fill2} onChange={() => set({ fill2: s.fill2 ? null : '#ff5f6d' }, 'Gradient')} /> Gradient</label>}
            {s.fill2 && <input type="color" className="swatch" value={s.fill2} onChange={(e) => set({ fill2: e.target.value }, 'Gradient colour')} aria-label="Gradient colour" />}
          </div>
          <BrandSwatches onPick={(c) => set({ fill: c }, 'Fill colour')} label="Fill" />
          <div className="row">
            <input type="color" className="swatch" value={s.stroke} onChange={(e) => set({ stroke: e.target.value }, 'Outline colour')} aria-label="Outline colour" />
            <div className="grow"><PropRow label="Outline" value={s.strokeWidth} min={0} max={60} step={1} unit="px" onChange={(v) => set({ strokeWidth: v })} /></div>
          </div>
          <BrandSwatches onPick={(c) => set({ stroke: c }, 'Outline colour')} label="Outline" />
        </Section>
      )}
    </>
  );
}

/** Preset in/out/loop animation for stickers, images, video overlays (text gets the loop only). */
export function MotionSection({ clip }: { clip: Clip }) {
  const m = clip.motion;
  const isText = clip.kind === 'text';
  const set = (patch: Partial<ClipMotion>, label = 'Animation') =>
    patchClip(clip.id, (c) => ({ ...c, motion: { ...(c.motion ?? { ...defaultMotion(), in: 'none', out: 'none' }), ...patch } }), label, `motion:${clip.id}:${Object.keys(patch).join()}`);
  return (
    <Section title={isText ? 'Loop animation' : 'Motion presets'} right={m ? <button className="btn sm ghost" onClick={() => patchClip(clip.id, (c) => { const x = { ...c }; delete x.motion; return x; }, 'Remove animation')}>Clear</button> : undefined}>
      {!isText && (
        <div className="grid2">
          <label className="field"><span>In</span>
            <select className="input" value={m?.in ?? 'none'} onChange={(e) => set({ in: e.target.value as ClipMotion['in'] })} aria-label="Animation in">
              {MOTION_IN.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </label>
          <label className="field"><span>Out</span>
            <select className="input" value={m?.out ?? 'none'} onChange={(e) => set({ out: e.target.value as ClipMotion['out'] })} aria-label="Animation out">
              {MOTION_IN.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </label>
        </div>
      )}
      <label className="field"><span>Loop</span>
        <select className="input" value={m?.loop ?? 'none'} onChange={(e) => set({ loop: e.target.value as ClipMotion['loop'] })} aria-label="Loop animation">
          {MOTION_LOOP.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </label>
      {m && !isText && <PropRow label="In/out time" value={m.duration} min={0.1} max={2} step={0.05} unit="s" onChange={(v) => set({ duration: v })} />}
      {m && m.loop !== 'none' && <PropRow label="Loop speed" value={m.speed} min={0.2} max={4} step={0.1} unit="×" onChange={(v) => set({ speed: v })} />}
      <small className="faint">Deselect the clip (or press play) to see it move.</small>
    </Section>
  );
}

export function SlotTab({ clip }: { clip: Clip }) {
  const project = useApp((s) => s.project)!;
  const importFiles = useApp((s) => s.importFiles);
  const ref = useRef<HTMLInputElement>(null);
  const ph = clip.placeholder!;
  const slot = slotsOf(project).find((s) => s.index === ph.index);
  const options = project.media.filter((m) => (ph.accepts === 'audio' ? m.kind === 'audio' : m.kind !== 'audio'));
  return (
    <Section title={`Empty slot ${ph.index + 1}`}>
      <p style={{ margin: 0 }}><b>{ph.label}</b> <span className="faint mono">{slot ? `${slot.duration.toFixed(1)} s` : ''}{slot && slot.clips > 1 ? ` · used ${slot.clips}×` : ''}</span></p>
      <button className="btn primary" onClick={() => ref.current?.click()}><Icon name="upload" size={15} />Choose a {ph.accepts === 'audio' ? 'sound' : 'clip or photo'}</button>
      <input ref={ref} type="file" accept={ph.accepts === 'audio' ? 'audio/*' : 'video/*,image/*'} hidden onChange={async (e) => {
        const f = e.target.files?.[0]; e.target.value = '';
        if (!f) return;
        const [id] = await importFiles([f]);
        if (id) fillSlotWith(ph.index, id);
      }} />
      {options.length > 0 && (
        <select className="input" value="" onChange={(e) => e.target.value && fillSlotWith(ph.index, e.target.value)} aria-label="Use media already in the project">
          <option value="">…or use something already imported</option>
          {options.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      )}
      <small className="faint">Effects, zooms and transitions on this slot stay when you fill it.</small>
    </Section>
  );
}
