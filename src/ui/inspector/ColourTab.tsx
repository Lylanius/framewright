import { useEffect, useRef, useState } from 'react';
import { adjustMatrix, applyMatrixToPixel, createEffect, effectMatrix, IDENTITY, multiply } from '../../core/effects';
import {
  applyGrade, bakeLut, curveTable, defaultCurves, gradeUniforms, HSL_BANDS, LutFormatError, lutToAsset, parseCube, sampleLut, toCube,
  type CurvePoint, type Curves, type RGB,
} from '../../core/grade';
import { uid } from '../../core/ids';
import { updateClip } from '../../core/timeline';
import type { Clip, EffectInstance } from '../../core/types';
import { getLut } from '../../engine/gpu';
import { canSaveExtension, saveFile } from '../../platform/download';
import { PropRow, Section, Seg } from '../components/Controls';
import { Icon } from '../components/Icon';
import { keyframeState, patchClip, propValue, setProp, toggleKeyframe } from '../propEdit';
import { useApp } from '../store';

function fxOf(clip: Clip, type: string): EffectInstance | undefined {
  return clip.effects.find((e) => e.type === type);
}

/** A slider bound to one parameter of a clip effect; the effect is created on first use. */
function FxProp({ clip, type, param, label, min, max, step = 1, unit, display }: {
  clip: Clip; type: string; param: string; label: string; min: number; max: number; step?: number; unit?: string; display?: number;
}) {
  const fx = fxOf(clip, type);
  const path = fx ? `fx.${fx.id}.${param}` : '';
  const value = fx ? propValue(clip, path) : 0;
  const onChange = (v: number) => {
    if (fx) setProp(clip.id, path, v, label);
    else useApp.getState().apply(label, (p) => updateClip(p, clip.id, (c) => ({ ...c, effects: [...c.effects, createEffect(type, { [param]: v })] })), `newfx:${clip.id}:${type}`);
  };
  return (
    <PropRow label={label} value={value} min={min} max={max} step={step} unit={unit} display={display} onChange={onChange}
      keyframe={fx ? { ...keyframeState(clip, path), toggle: () => toggleKeyframe(clip.id, path) } : undefined} />
  );
}

/* ---------------- colour wheel ---------------- */

function Wheel({ clip, name, label }: { clip: Clip; name: 'lift' | 'gamma' | 'gain'; label: string }) {
  const fx = fxOf(clip, 'grade');
  const x = fx ? propValue(clip, `fx.${fx.id}.${name}X`) : 0;
  const y = fx ? propValue(clip, `fx.${fx.id}.${name}Y`) : 0;
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef(false);
  const set = (nx: number, ny: number) => {
    const r = Math.hypot(nx, ny);
    if (r > 1) { nx /= r; ny /= r; }
    const vals = { [`${name}X`]: +nx.toFixed(3), [`${name}Y`]: +ny.toFixed(3) };
    useApp.getState().apply(`${label} wheel`, (p) => updateClip(p, clip.id, (c) => {
      const cur = fxOf(c, 'grade');
      if (!cur) return { ...c, effects: [...c.effects, createEffect('grade', vals)] };
      return { ...c, effects: c.effects.map((e) => (e.id === cur.id ? { ...e, params: { ...e.params, ...vals } } : e)) };
    }), `wheel:${clip.id}:${name}`);
  };
  const fromEvent = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    set(((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1));
  };
  return (
    <div className="wheel-box">
      <div ref={ref} className="wheel" role="slider" aria-label={`${label} colour`} aria-valuetext={`${x.toFixed(2)}, ${y.toFixed(2)}`} tabIndex={0}
        onPointerDown={(e) => { drag.current = true; (e.target as HTMLElement).setPointerCapture(e.pointerId); fromEvent(e); }}
        onPointerMove={(e) => { if (drag.current) fromEvent(e); }}
        onPointerUp={() => (drag.current = false)}
        onDoubleClick={() => set(0, 0)}>
        <span className="dot" style={{ left: `${50 + x * 50}%`, top: `${50 - y * 50}%` }} />
      </div>
      <span className="wheel-label">{label}</span>
    </div>
  );
}

/* ---------------- curves ---------------- */

const CH: { id: keyof Curves; label: string; colour: string }[] = [
  { id: 'master', label: 'Master', colour: '#e7e9f0' }, { id: 'r', label: 'Red', colour: '#ef5a5a' },
  { id: 'g', label: 'Green', colour: '#4fc58d' }, { id: 'b', label: 'Blue', colour: '#5b8cff' },
];

function CurvesEditor({ clip }: { clip: Clip }) {
  const fx = fxOf(clip, 'grade');
  const curves: Curves = (fx?.data?.curves as Curves) ?? defaultCurves();
  const [ch, setCh] = useState<keyof Curves>('master');
  const ref = useRef<HTMLCanvasElement>(null);
  const dragIdx = useRef<number | null>(null);
  const pts = curves[ch];

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    const S = c.width;
    ctx.clearRect(0, 0, S, S);
    ctx.fillStyle = '#0b0d12'; ctx.fillRect(0, 0, S, S);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo((i * S) / 4, 0); ctx.lineTo((i * S) / 4, S); ctx.moveTo(0, (i * S) / 4); ctx.lineTo(S, (i * S) / 4); ctx.stroke(); }
    ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.beginPath(); ctx.moveTo(0, S); ctx.lineTo(S, 0); ctx.stroke();
    for (const c2 of CH) {
      if (c2.id !== ch && c2.id !== 'master') { /* draw faintly */ }
      const t = curveTable(curves[c2.id]);
      ctx.strokeStyle = c2.id === ch ? c2.colour : `${c2.colour}40`;
      ctx.lineWidth = c2.id === ch ? 2 : 1;
      ctx.beginPath();
      for (let i = 0; i < 256; i++) { const x = (i / 255) * S, y = S - t[i] * S; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
      ctx.stroke();
    }
    ctx.fillStyle = CH.find((x) => x.id === ch)!.colour;
    for (const [x, y] of pts) { ctx.beginPath(); ctx.arc(x * S, S - y * S, 4, 0, Math.PI * 2); ctx.fill(); }
  }, [curves, ch, pts]);

  const write = (next: CurvePoint[], label = 'Curves') => {
    useApp.getState().apply(label, (p) => updateClip(p, clip.id, (c) => {
      const cur = fxOf(c, 'grade');
      const nc: Curves = { ...((cur?.data?.curves as Curves) ?? defaultCurves()), [ch]: next };
      if (!cur) { const e = createEffect('grade'); e.data = { curves: nc }; return { ...c, effects: [...c.effects, e] }; }
      return { ...c, effects: c.effects.map((e) => (e.id === cur.id ? { ...e, data: { ...(e.data ?? {}), curves: nc } } : e)) };
    }), `curves:${clip.id}:${ch}`);
  };
  const pos = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height))] as CurvePoint;
  };
  return (
    <div className="section" style={{ gap: 6 }}>
      <div className="row">
        <Seg label="Curve channel" value={ch} onChange={setCh} options={CH.map((c) => ({ value: c.id, label: c.label }))} />
        <button className="btn sm ghost" onClick={() => write([[0, 0], [1, 1]], 'Reset curve')}>Reset</button>
      </div>
      <canvas ref={ref} width={240} height={240} className="curves" aria-label="Curves: click to add a point, drag to move, double-click a point to remove it"
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          const [x, y] = pos(e);
          let i = pts.findIndex(([px, py]) => Math.hypot(px - x, py - y) < 0.05);
          if (i < 0) {
            const next = [...pts, [x, y] as CurvePoint].sort((a, b) => a[0] - b[0]);
            i = next.findIndex((p) => p[0] === x && p[1] === y);
            write(next);
          }
          dragIdx.current = i;
        }}
        onPointerMove={(e) => {
          const i = dragIdx.current;
          if (i === null) return;
          const [x, y] = pos(e);
          const next = pts.map((p) => [...p] as CurvePoint);
          const lo = i > 0 ? next[i - 1][0] + 0.01 : 0, hi = i < next.length - 1 ? next[i + 1][0] - 0.01 : 1;
          next[i] = [i === 0 ? 0 : i === next.length - 1 ? 1 : Math.min(hi, Math.max(lo, x)), y];
          write(next);
        }}
        onPointerUp={() => (dragIdx.current = null)}
        onDoubleClick={(e) => {
          const [x, y] = pos(e);
          const i = pts.findIndex(([px, py]) => Math.hypot(px - x, py - y) < 0.05);
          if (i > 0 && i < pts.length - 1) write(pts.filter((_, j) => j !== i), 'Remove curve point');
        }} />
    </div>
  );
}

/* ---------------- LUTs ---------------- */

function LutSection({ clip }: { clip: Clip }) {
  const project = useApp((s) => s.project)!;
  const { apply, toast } = useApp();
  const fileRef = useRef<HTMLInputElement>(null);
  const fx = fxOf(clip, 'lut');
  const luts = project.luts ?? [];
  const importCube = async (f: File) => {
    try {
      const lut = parseCube(await f.text(), f.name.replace(/\.cube$/i, ''));
      const asset = lutToAsset(uid('lut'), lut);
      apply('Import LUT', (p) => {
        const withLut = { ...p, luts: [...(p.luts ?? []), asset] };
        return updateClip(withLut, clip.id, (c) => {
          const cur = fxOf(c, 'lut');
          if (cur) return { ...c, effects: c.effects.map((e) => (e.id === cur.id ? { ...e, data: { lutId: asset.id } } : e)) };
          const e = createEffect('lut'); e.data = { lutId: asset.id };
          return { ...c, effects: [...c.effects, e] };
        });
      });
      toast(`Applied LUT “${lut.name}” (${lut.size}³).`, 'success');
    } catch (e) {
      toast(e instanceof LutFormatError ? e.message : `${f.name} couldn’t be read as a .cube LUT.`, 'error');
    }
  };
  const exportGrade = async () => {
    // Bake this clip's colour effects (adjust, filters, grade, LUT) into a 33³ cube.
    let m = IDENTITY;
    const steps: ((c: RGB) => RGB)[] = [];
    for (const e of clip.effects.filter((x) => x.enabled)) {
      const mm = effectMatrix(e);
      if (mm) { m = multiply(mm, m); continue; }
      const flushM = m; m = IDENTITY;
      steps.push((c) => { const o = applyMatrixToPixel(flushM, c[0] * 255, c[1] * 255, c[2] * 255, 255); return [o[0] / 255, o[1] / 255, o[2] / 255]; });
      if (e.type === 'grade') { const u = gradeUniforms(e); steps.push((c) => applyGrade(c, u)); }
      if (e.type === 'lut') { const l = getLut(e.data?.lutId as string); const k = (e.params.intensity ?? 100) / 100; if (l) steps.push((c) => { const o = sampleLut(l, ...c); return [c[0] + (o[0] - c[0]) * k, c[1] + (o[1] - c[1]) * k, c[2] + (o[2] - c[2]) * k]; }); }
    }
    const last = m;
    steps.push((c) => { const o = applyMatrixToPixel(last, c[0] * 255, c[1] * 255, c[2] * 255, 255); return [o[0] / 255, o[1] / 255, o[2] / 255]; });
    const lut = bakeLut((c) => steps.reduce((acc, f) => f(acc), c), 33, `${clip.name} grade`);
    const name = `${clip.name.replace(/[^\w\- ]+/g, '').trim() || 'grade'}.cube`;
    try {
      const r = await saveFile(canSaveExtension('cube') ? name : `${name}.txt`, toCube(lut));
      if (r === 'saved') toast(canSaveExtension('cube') ? `Saved ${name}` : `Saved ${name}.txt — remove “.txt” to use it as a .cube file.`, 'success');
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  void adjustMatrix;
  return (
    <Section title="LUT" right={<button className="btn sm" onClick={() => void exportGrade()} title="Save this clip's colour as a .cube LUT for other apps"><Icon name="export" size={13} />Export LUT</button>}>
      <div className="row">
        <select className="input" value={(fx?.data?.lutId as string) ?? ''} aria-label="LUT"
          onChange={(e) => {
            const id = e.target.value;
            apply(id ? 'Use LUT' : 'Remove LUT', (p) => updateClip(p, clip.id, (c) => {
              const cur = fxOf(c, 'lut');
              if (!id) return { ...c, effects: c.effects.filter((x) => x.type !== 'lut') };
              if (cur) return { ...c, effects: c.effects.map((x) => (x.id === cur.id ? { ...x, data: { lutId: id } } : x)) };
              const ne = createEffect('lut'); ne.data = { lutId: id };
              return { ...c, effects: [...c.effects, ne] };
            }));
          }}>
          <option value="">No LUT</option>
          {luts.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.size}³)</option>)}
        </select>
        <button className="btn sm" onClick={() => fileRef.current?.click()}><Icon name="upload" size={13} />Import .cube</button>
        <input ref={fileRef} type="file" accept=".cube,.txt" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importCube(f); }} />
      </div>
      {fx && <FxProp clip={clip} type="lut" param="intensity" label="Intensity" min={0} max={100} unit="%" />}
    </Section>
  );
}

/* ---------------- tab ---------------- */

export function ColourTab({ clip }: { clip: Clip }) {
  const [band, setBand] = useState(0);
  const b = HSL_BANDS[band];
  const hasGrade = !!fxOf(clip, 'grade') || !!fxOf(clip, 'adjust');
  return (
    <>
      <Section title="Basic" right={hasGrade ? (
        <button className="btn sm ghost" onClick={() => patchClip(clip.id, (c) => ({ ...c, effects: c.effects.filter((e) => e.type !== 'grade' && e.type !== 'adjust') }), 'Reset colour')}>Reset</button>
      ) : undefined}>
        <FxProp clip={clip} type="adjust" param="exposure" label="Exposure" min={-100} max={100} />
        <FxProp clip={clip} type="adjust" param="contrast" label="Contrast" min={-100} max={100} />
        <FxProp clip={clip} type="adjust" param="saturation" label="Saturation" min={-100} max={100} />
        <FxProp clip={clip} type="grade" param="vibrance" label="Vibrance" min={-100} max={100} />
        <FxProp clip={clip} type="adjust" param="temperature" label="Temperature" min={-100} max={100} />
        <FxProp clip={clip} type="adjust" param="tint" label="Tint" min={-100} max={100} />
      </Section>
      <Section title="Light">
        <FxProp clip={clip} type="grade" param="highlights" label="Highlights" min={-100} max={100} />
        <FxProp clip={clip} type="grade" param="shadows" label="Shadows" min={-100} max={100} />
        <FxProp clip={clip} type="grade" param="whites" label="Whites" min={-100} max={100} />
        <FxProp clip={clip} type="grade" param="blacks" label="Blacks" min={-100} max={100} />
      </Section>
      <Section title="Colour wheels">
        <div className="wheels">
          <Wheel clip={clip} name="lift" label="Shadows" />
          <Wheel clip={clip} name="gamma" label="Midtones" />
          <Wheel clip={clip} name="gain" label="Highlights" />
        </div>
        <FxProp clip={clip} type="grade" param="liftL" label="Shadow level" min={-1} max={1} step={0.01} display={100} />
        <FxProp clip={clip} type="grade" param="gammaL" label="Mid level" min={-1} max={1} step={0.01} display={100} />
        <FxProp clip={clip} type="grade" param="gainL" label="High level" min={-1} max={1} step={0.01} display={100} />
        <small className="faint">Drag a dot towards a colour to tint that range. Double-click a wheel to reset it.</small>
      </Section>
      <Section title="Curves"><CurvesEditor clip={clip} /></Section>
      <Section title="HSL">
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          {HSL_BANDS.map((h, i) => (
            <button key={h.key} className={`hsl-chip${band === i ? ' on' : ''}`} style={{ background: h.swatch }} onClick={() => setBand(i)} aria-label={h.label} title={h.label} aria-pressed={band === i} />
          ))}
        </div>
        <FxProp clip={clip} type="grade" param={`hsl.${b.key}.h`} label={`${b.label} hue`} min={-30} max={30} unit="°" />
        <FxProp clip={clip} type="grade" param={`hsl.${b.key}.s`} label={`${b.label} sat.`} min={-100} max={100} />
        <FxProp clip={clip} type="grade" param={`hsl.${b.key}.l`} label={`${b.label} light`} min={-100} max={100} />
      </Section>
      <LutSection clip={clip} />
      <small className="faint">Every slider can be keyframed with its ◆. Open Scopes under the preview to check levels and skin tones.</small>
    </>
  );
}
