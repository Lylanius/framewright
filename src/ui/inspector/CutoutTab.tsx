import { useEffect } from 'react';
import { createEffect } from '../../core/effects';
import { maskValue, MASK_ANIMATABLE, type MaskProp } from '../../core/masks';
import { updateClip } from '../../core/timeline';
import type { Clip, Mask, MaskType } from '../../core/types';
import { bundledModelsAvailable } from '../../engine/ai';
import { PropRow, Section, Seg } from '../components/Controls';
import { Icon } from '../components/Icon';
import { addMask, keyWholeMask, localTime, maskKeyState, removeMask, setMaskProps, toggleMaskKey, updateMask } from '../maskEdit';
import { keyframeState, propValue, setProp, toggleKeyframe } from '../propEdit';
import { useApp } from '../store';

const SHAPES: { type: MaskType; label: string }[] = [
  { type: 'rect', label: 'Rectangle' }, { type: 'ellipse', label: 'Ellipse' }, { type: 'polygon', label: 'Polygon' }, { type: 'freeform', label: 'Draw' },
];

const PROP_UI: Record<MaskProp, { label: string; min: number; max: number; step: number; display?: number; unit?: string }> = {
  x: { label: 'Centre X', min: -1, max: 1, step: 0.001, display: 100, unit: '%' },
  y: { label: 'Centre Y', min: -1, max: 1, step: 0.001, display: 100, unit: '%' },
  w: { label: 'Width', min: 0.01, max: 2, step: 0.001, display: 100, unit: '%' },
  h: { label: 'Height', min: 0.01, max: 2, step: 0.001, display: 100, unit: '%' },
  rotation: { label: 'Rotation', min: -180, max: 180, step: 0.5, unit: '°' },
  feather: { label: 'Feather', min: 0, max: 200, step: 1, unit: 'px' },
  opacity: { label: 'Strength', min: 0, max: 1, step: 0.01, display: 100, unit: '%' },
  roundness: { label: 'Rounding', min: 0, max: 1, step: 0.01, display: 100, unit: '%' },
};

function MaskProps({ clip, m }: { clip: Clip; m: Mask }) {
  const t = localTime(clip);
  const props = MASK_ANIMATABLE.filter((p) => p !== 'roundness' || m.type === 'rect');
  return (
    <>
      {props.map((p) => {
        const ui = PROP_UI[p];
        const kf = maskKeyState(clip, m, p);
        return (
          <PropRow key={p} label={ui.label} value={maskValue(m, p, t)} min={ui.min} max={ui.max} step={ui.step} display={ui.display} unit={ui.unit}
            onChange={(v) => setMaskProps(clip.id, m.id, { [p]: v }, `Mask ${ui.label.toLowerCase()}`)}
            keyframe={{ ...kf, toggle: () => toggleMaskKey(clip.id, m.id, p) }} />
        );
      })}
    </>
  );
}

function MaskSection({ clip }: { clip: Clip }) {
  const maskEdit = useApp((s) => s.maskEdit);
  const setMaskEdit = useApp((s) => s.setMaskEdit);
  const masks = clip.masks ?? [];
  const active = masks.find((m) => m.id === maskEdit?.maskId && maskEdit.clipId === clip.id) ?? null;

  // Keep the preview overlay pointed at this clip while the tab is open.
  useEffect(() => {
    const cur = useApp.getState().maskEdit;
    if (masks.length && (!cur || cur.clipId !== clip.id || !masks.some((m) => m.id === cur.maskId))) setMaskEdit({ clipId: clip.id, maskId: masks[masks.length - 1].id });
    if (!masks.length && cur?.clipId === clip.id && !cur.draw) setMaskEdit(null);
  }, [clip.id, masks, setMaskEdit]);
  useEffect(() => () => useApp.getState().setMaskEdit(null), []);

  const add = (type: MaskType) => {
    const id = addMask(clip.id, type);
    if (id) setMaskEdit({ clipId: clip.id, maskId: id, draw: type === 'freeform' });
  };

  return (
    <Section title="Masks">
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        {SHAPES.map((s) => (
          <button key={s.type} className="btn sm" onClick={() => add(s.type)} aria-label={`Add ${s.label.toLowerCase()} mask`}>
            <Icon name="plus" size={12} />{s.label}
          </button>
        ))}
      </div>
      {masks.length === 0 && <small className="faint">A mask shows only part of this clip. Drag its outline on the preview; use ◆ to animate it. Draw lets you trace any shape by hand.</small>}
      {masks.map((m, i) => (
        <div key={m.id} className={`mask-row${active?.id === m.id ? ' on' : ''}`}>
          <button className="grow mask-name" onClick={() => setMaskEdit({ clipId: clip.id, maskId: m.id })} aria-pressed={active?.id === m.id}>{m.name}</button>
          {i > 0 && (
            <select className="input sm" value={m.mode} aria-label={`${m.name} combine mode`}
              onChange={(e) => updateMask(clip.id, m.id, (x) => ({ ...x, mode: e.target.value as Mask['mode'] }), 'Mask mode')}>
              <option value="add">Add</option><option value="subtract">Subtract</option><option value="intersect">Intersect</option>
            </select>
          )}
          <button className={`icon-btn sm${m.invert ? ' on' : ''}`} title="Invert (show outside instead)" aria-label={`Invert ${m.name}`} aria-pressed={m.invert}
            onClick={() => updateMask(clip.id, m.id, (x) => ({ ...x, invert: !x.invert }), 'Invert mask')}>⊘</button>
          <button className="icon-btn sm" aria-label={`Delete ${m.name}`} onClick={() => removeMask(clip.id, m.id)}><Icon name="trash" size={13} /></button>
        </div>
      ))}
      {active && (
        <>
          {active.type === 'freeform' && (
            <div className="row">
              <button className={`btn sm${maskEdit?.draw ? ' primary' : ''}`} onClick={() => setMaskEdit({ clipId: clip.id, maskId: active.id, draw: !maskEdit?.draw })}>
                {maskEdit?.draw ? 'Drawing… (drag on the preview)' : active.points.length ? 'Redraw' : 'Draw on preview'}
              </button>
            </div>
          )}
          {active.type === 'polygon' && <small className="faint">Drag the corner dots on the preview. Double-click an edge to add a point; double-click a dot to remove it.</small>}
          <div className="row">
            <button className="btn sm" onClick={() => keyWholeMask(clip.id, active.id)} title="Add position, size and rotation keys at the playhead"><Icon name="keyframe" size={12} />Key shape here</button>
          </div>
          <MaskProps clip={clip} m={active} />
        </>
      )}
    </Section>
  );
}

function rgbHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');
}

function ChromaSection({ clip }: { clip: Clip }) {
  const { apply, setPickMode, toast } = useApp();
  const player = useApp((s) => s.player);
  const fx = clip.effects.find((e) => e.type === 'chroma');
  const setKey = (rgb: [number, number, number]) => apply('Key colour', (p) => updateClip(p, clip.id, (c) => {
    const cur = c.effects.find((e) => e.type === 'chroma');
    const params = { keyR: rgb[0], keyG: rgb[1], keyB: rgb[2] };
    if (!cur) return { ...c, effects: [...c.effects, createEffect('chroma', params)] };
    return { ...c, effects: c.effects.map((e) => (e.id === cur.id ? { ...e, params: { ...e.params, ...params } } : e)) };
  }));
  const pick = () => setPickMode({
    clipId: clip.id, label: 'Click the background colour to remove',
    onPick: (u, v) => {
      const c = useApp.getState().project?.tracks.flatMap((t) => t.clips).find((x) => x.id === clip.id);
      const rgb = c && player?.sampleSource(c, u, v);
      if (!rgb) { toast('Couldn’t read that frame yet — try again in a moment.'); return; }
      setKey(rgb);
      toast(`Keying out ${rgbHex(...rgb)}`, 'success');
    },
  });
  const p = (param: string, label: string, min: number, max: number) => {
    const path = `fx.${fx!.id}.${param}`;
    return <PropRow key={param} label={label} value={propValue(clip, path)} min={min} max={max} step={1}
      onChange={(v) => setProp(clip.id, path, v, label)} keyframe={{ ...keyframeState(clip, path), toggle: () => toggleKeyframe(clip.id, path) }} />;
  };
  return (
    <Section title="Green screen" right={fx ? <button className="btn sm ghost" onClick={() => apply('Remove green screen', (pp) => updateClip(pp, clip.id, (c) => ({ ...c, effects: c.effects.filter((e) => e.type !== 'chroma') })))}>Turn off</button> : undefined}>
      {!fx && (
        <div className="row">
          <button className="btn primary" onClick={() => setKey([0, 200, 60])}>Remove green</button>
          <button className="btn" onClick={() => setKey([20, 60, 230])}>Remove blue</button>
          <button className="btn" onClick={pick} aria-label="Pick key colour">Pick colour…</button>
        </div>
      )}
      {fx && (
        <>
          <div className="row">
            <span className="swatch" style={{ background: rgbHex(fx.params.keyR ?? 0, fx.params.keyG ?? 0, fx.params.keyB ?? 0) }} aria-label="Key colour" />
            <span className="mono faint grow">{rgbHex(fx.params.keyR ?? 0, fx.params.keyG ?? 0, fx.params.keyB ?? 0)}</span>
            <button className="btn sm" onClick={pick} aria-label="Pick key colour">Eyedropper</button>
          </div>
          {p('tolerance', 'Strength', 0, 100)}
          {p('softness', 'Edge softness', 0, 100)}
          {p('spill', 'Spill removal', 0, 100)}
          {p('shrink', 'Shrink edges', 0, 100)}
          <small className="faint">Put a background on the track below this one to see it through the keyed area.</small>
        </>
      )}
    </Section>
  );
}

function BgRemoveSection({ clip }: { clip: Clip }) {
  const apply = useApp((s) => s.apply);
  const models = bundledModelsAvailable();
  const fx = clip.effects.find((e) => e.type === 'bgRemove');
  return (
    <Section title="Remove background (AI)">
      {!models.ok ? <small className="faint">{models.reason}</small> : fx ? (
        <>
          <div className="row"><span className="grow">On — runs on this device.</span>
            <button className="btn sm ghost" onClick={() => apply('Keep background', (p) => updateClip(p, clip.id, (c) => ({ ...c, effects: c.effects.filter((e) => e.type !== 'bgRemove') })))}>Turn off</button></div>
          <PropRow label="Edge softness" value={fx.params.feather ?? 3} min={0} max={20} step={0.5} unit="px"
            onChange={(v) => apply('Edge softness', (p) => updateClip(p, clip.id, (c) => ({ ...c, effects: c.effects.map((e) => (e.id === fx.id ? { ...e, params: { ...e.params, feather: v } } : e)) })), `bgf:${clip.id}`)} />
          <Seg label="Keep" value={fx.params.invert ? 'bg' : 'person'} onChange={(v) => apply('Keep', (p) => updateClip(p, clip.id, (c) => ({ ...c, effects: c.effects.map((e) => (e.id === fx.id ? { ...e, params: { ...e.params, invert: v === 'bg' ? 1 : 0 } } : e)) })))}
            options={[{ value: 'person', label: 'Person' }, { value: 'bg', label: 'Background' }]} />
        </>
      ) : (
        <button className="btn" onClick={() => apply('Remove background', (p) => updateClip(p, clip.id, (c) => ({ ...c, effects: [createEffect('bgRemove'), ...c.effects] })))}><Icon name="image" size={15} />Cut out the person</button>
      )}
    </Section>
  );
}

export function CutoutTab({ clip }: { clip: Clip }) {
  return (
    <>
      <MaskSection clip={clip} />
      {(clip.kind === 'video' || clip.kind === 'image') && <ChromaSection clip={clip} />}
      {(clip.kind === 'video' || clip.kind === 'image') && <BgRemoveSection clip={clip} />}
    </>
  );
}
