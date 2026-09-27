import { useRef } from 'react';
import { BUILTIN_FONTS, TEXT_PRESETS } from '../../core/defaults';
import { EFFECTS, LOOKS, lookMatrix } from '../../core/effects';
import { FORMAT_PRESETS, FPS_OPTIONS, sanitiseSize } from '../../core/presets';
import { registerFontFile } from '../../styles/fonts';
import { addAdjustmentLayer, addEffectToSelection, addSolid, addText, applyLook } from '../actions';
import { Icon, type IconName } from '../components/Icon';
import { useApp, type PanelId } from '../store';
import { MediaPanel } from './MediaPanel';
import { CaptionsPanel } from './CaptionsPanel';
import { TransitionsPanel } from './TransitionsPanel';
import { AiPanel } from './AiPanel';
import { StickersPanel } from './StickersPanel';
import { TemplatesPanel } from './TemplatesPanel';
import { BrandPanel } from './BrandPanel';

export interface PanelDef { id: PanelId; label: string; icon: IconName; todo?: { phase: number; items: string[] } }

export const PANELS: PanelDef[] = [
  { id: 'media', label: 'Media', icon: 'media' },
  { id: 'audio', label: 'Audio', icon: 'audio' },
  { id: 'text', label: 'Text', icon: 'text' },
  { id: 'captions', label: 'Captions', icon: 'captions' },
  { id: 'ai', label: 'AI tools', icon: 'ai' },
  { id: 'effects', label: 'Effects', icon: 'effects' },
  { id: 'transitions', label: 'Transitions', icon: 'transitions' },
  { id: 'filters', label: 'Filters', icon: 'filters' },
  { id: 'adjust', label: 'Adjust', icon: 'adjust' },
  { id: 'canvas', label: 'Canvas', icon: 'canvas' },
  { id: 'stickers', label: 'Elements', icon: 'sticker' },
  { id: 'templates', label: 'Templates', icon: 'templates' },
  { id: 'brand', label: 'Brand', icon: 'brand' },
];

function TodoPanel({ def }: { def: PanelDef }) {
  return (
    <div className="todo-panel">
      <span className="badge">Planned · Phase {def.todo!.phase}</span>
      <p style={{ margin: 0 }}>{def.label} isn’t built yet. Nothing here is faked — this is what’s coming:</p>
      <ul>{def.todo!.items.map((i) => <li key={i}>{i}</li>)}</ul>
    </div>
  );
}

function TextPanel() {
  const fontRef = useRef<HTMLInputElement>(null);
  const toast = useApp((s) => s.toast);
  return (
    <>
      <button className="btn primary" onClick={() => addText()}><Icon name="plus" size={16} />Add text</button>
      <div className="label">Styles</div>
      <div className="text-presets">
        {TEXT_PRESETS.map((p) => {
          const st = p.style;
          return (
            <button key={p.id} className="text-preset" onClick={() => addText(p)} title={p.name}
              style={{
                fontFamily: `"${st.fontFamily ?? 'Figtree'}"`, fontWeight: st.fontWeight ?? 400, fontStyle: st.italic ? 'italic' : undefined,
                color: st.gradient ? st.gradient.from : st.color ?? '#fff', textTransform: st.uppercase ? 'uppercase' : undefined,
                WebkitTextStroke: st.strokeWidth ? `${Math.min(1.5, st.strokeWidth / 5)}px ${st.strokeColor}` : undefined, paintOrder: 'stroke fill',
                textShadow: st.glow ? `0 0 10px ${st.shadowColor}` : undefined, letterSpacing: st.letterSpacing ? st.letterSpacing / 3 : undefined,
              }}>
              <span style={{ background: st.background ?? undefined, padding: st.background ? '2px 6px' : undefined, borderRadius: 4, fontSize: 17 }}>{st.content}</span>
            </button>
          );
        })}
      </div>
      <div className="label">Fonts</div>
      <p className="faint" style={{ margin: 0, fontSize: 12 }}>{BUILTIN_FONTS.length} fonts are built in and work offline. Add your own TTF, OTF or WOFF:</p>
      <button className="btn" onClick={() => fontRef.current?.click()}><Icon name="upload" size={15} />Upload font</button>
      <input ref={fontRef} type="file" accept=".ttf,.otf,.woff,.woff2" hidden onChange={async (e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (!f) return;
        try {
          const fam = await registerFontFile(f);
          toast(`Added font “${fam}”. Pick it in the Text inspector. (Uploaded fonts last for this session.)`, 'success');
        } catch { toast('That font file could not be read.', 'error'); }
      }} />
    </>
  );
}

function EffectsPanel() {
  const cats: { id: string; label: string }[] = [
    { id: 'stylise', label: 'Stylise' }, { id: 'distort', label: 'Distort & glitch' }, { id: 'motion', label: 'Motion' }, { id: 'blur', label: 'Blur & sharpen' },
  ];
  const selection = useApp((s) => s.selection);
  return (
    <>
      <p className="faint" style={{ margin: 0, fontSize: 12 }}>{selection.length ? 'Tap an effect to add it to the selected clip. Effects stack in order.' : 'Select a clip on the timeline, then tap an effect.'}</p>
      {cats.map((c) => (
        <div key={c.id} className="section">
          <div className="label">{c.label}</div>
          <div className="fx-list">
            {EFFECTS.filter((e) => e.category === c.id).map((e) => (
              <button key={e.type} className="fx-item" onClick={() => addEffectToSelection(e.type)}>
                <span className="sw" style={{ background: fxSwatch(e.type) }} />
                <span><strong>{e.name}</strong><small>{e.description}</small></span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

function fxSwatch(type: string): string {
  const map: Record<string, string> = {
    blur: 'radial-gradient(circle, #8fb3ff 10%, #2a3350 80%)', sharpen: 'repeating-linear-gradient(90deg,#ddd 0 2px,#333 2px 4px)',
    vignette: 'radial-gradient(circle, #d9c7a0 30%, #000 90%)', grain: 'repeating-conic-gradient(#777 0 25%, #555 0 50%) 0 0/4px 4px',
    glow: 'radial-gradient(circle, #fff 5%, #ffc76a 30%, #2b1b05 75%)', pixelate: 'conic-gradient(#e0a13a 25%, #3f6fd8 0 50%, #e0a13a 0 75%, #3f6fd8 0) 0 0/12px 12px',
    rgbSplit: 'linear-gradient(90deg, #f00 0 33%, #0f0 0 66%, #00f 0)', glitch: 'repeating-linear-gradient(0deg, #ff3fd1 0 3px, #111 3px 7px, #3cf0ff 7px 9px)',
    shake: 'linear-gradient(135deg, #555, #aaa)', pulse: 'radial-gradient(circle, #f2b544 20%, transparent 22%, transparent 40%, #f2b544 42%, transparent 44%) , #222',
  };
  return map[type] ?? '#444';
}

function FiltersPanel() {
  const project = useApp((s) => s.project)!;
  const selection = useApp((s) => s.selection);
  const current = project.tracks.flatMap((t) => t.clips).find((c) => c.id === selection[0])?.effects.find((e) => e.type === 'look')?.params.look;
  return (
    <>
      <p className="faint" style={{ margin: 0, fontSize: 12 }}>One-tap colour grades. Fine-tune strength in the inspector’s Effects tab.</p>
      <div className="look-grid">
        <button className={`look${current === undefined ? ' on' : ''}`} onClick={() => applyLook(null)}>
          <i style={{ background: 'linear-gradient(135deg,#9aa3b8,#3b4150)' }} />None
        </button>
        {LOOKS.map((l, i) => {
          const m = lookMatrix(i);
          const tint = `rgb(${Math.round(128 * (m[0] + m[1] + m[2]) + m[4])},${Math.round(128 * (m[5] + m[6] + m[7]) + m[9])},${Math.round(128 * (m[10] + m[11] + m[12]) + m[14])})`;
          return (
            <button key={l.id} className={`look${current === i ? ' on' : ''}`} onClick={() => applyLook(i)}>
              <i style={{ background: `linear-gradient(135deg, ${l.swatch[0]}, ${tint} 55%, ${l.swatch[1]})` }} />{l.name}
            </button>
          );
        })}
      </div>
    </>
  );
}

function AdjustPanel() {
  const setMobileSheet = useApp((s) => s.setMobileSheet);
  return (
    <>
      <div className="ai-card">
        <h4><Icon name="adjust" size={16} /><span>Adjustment layer</span></h4>
        <p>A clip that colour-grades or adds effects to everything beneath it — grade a whole scene in one go. Stretch it on the timeline to cover what you want.</p>
        <button className="btn primary" onClick={() => { addAdjustmentLayer(); if (window.innerWidth <= 900) setMobileSheet('inspector'); }}><Icon name="plus" size={15} />Add adjustment layer</button>
      </div>
      <p className="faint" style={{ margin: 0, fontSize: 12 }}>Or grade one clip: select it and open the inspector’s <b>Colour</b> tab for curves, colour wheels, HSL, LUTs and more. Turn on scopes with the button under the preview.</p>
      <button className="btn" onClick={() => addEffectToSelection('adjust')}><Icon name="adjust" size={16} />Add colour adjust to selected clip</button>
      <div className="fx-list">
        {EFFECTS.filter((e) => e.category === 'adjust' && !['adjust', 'grade', 'lut'].includes(e.type)).map((e) => (
          <button key={e.type} className="fx-item" onClick={() => addEffectToSelection(e.type)}>
            <span className="sw" style={{ background: e.type === 'invert' ? 'linear-gradient(90deg,#fff 50%,#000 50%)' : e.type === 'mono' ? 'linear-gradient(135deg,#eee,#222)' : e.type === 'chroma' ? 'linear-gradient(135deg,#1fd15a,#0b3d1c)' : 'linear-gradient(135deg,#e9d3a7,#6b4e2e)' }} />
            <span><strong>{e.name}</strong><small>{e.description}</small></span>
          </button>
        ))}
      </div>
    </>
  );
}

function CanvasPanel() {
  const project = useApp((s) => s.project)!;
  const apply = useApp((s) => s.apply);
  const st = project.settings;
  const setSettings = (patch: Partial<typeof st>, label: string) => apply(label, (p) => ({ ...p, settings: { ...p.settings, ...patch } }), 'canvas');
  return (
    <>
      <div className="label">Format</div>
      <div className="fx-list">
        {FORMAT_PRESETS.map((p) => {
          const on = p.width === st.width && p.height === st.height;
          return (
            <button key={p.id} className="fx-item" style={on ? { borderColor: 'var(--accent)' } : undefined}
              onClick={() => apply('Resize canvas', (proj) => ({ ...proj, settings: { ...proj.settings, width: p.width, height: p.height } }))}>
              <span className="sw" style={{ display: 'grid', placeItems: 'center', background: 'var(--bg)' }}>
                <span style={{ border: '2px solid var(--muted)', borderRadius: 3, width: p.width > p.height ? 24 : 24 * p.width / p.height, height: p.height >= p.width ? 24 : 24 * p.height / p.width }} />
              </span>
              <span><strong>{p.label}</strong><small className="mono">{p.width}×{p.height} · {p.ratio}</small></span>
            </button>
          );
        })}
      </div>
      <div className="label">Custom</div>
      <div className="grid2">
        <label className="field"><span>Width</span><input className="input mono" type="number" defaultValue={st.width} key={`w${st.width}`}
          onBlur={(e) => setSettings(sanitiseSize(+e.target.value, st.height), 'Canvas width')} /></label>
        <label className="field"><span>Height</span><input className="input mono" type="number" defaultValue={st.height} key={`h${st.height}`}
          onBlur={(e) => setSettings(sanitiseSize(st.width, +e.target.value), 'Canvas height')} /></label>
        <label className="field"><span>Frame rate</span>
          <select className="input" value={st.fps} onChange={(e) => setSettings({ fps: +e.target.value }, 'Frame rate')}>
            {FPS_OPTIONS.map((f) => <option key={f} value={f}>{f} fps</option>)}
          </select>
        </label>
        <label className="field"><span>Background</span>
          <div className="row"><input type="color" className="swatch" value={st.background} onChange={(e) => setSettings({ background: e.target.value }, 'Background')} aria-label="Background colour" /><span className="mono faint">{st.background}</span></div>
        </label>
      </div>
      <div className="label">Colour clips</div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        {['#000000', '#ffffff', '#f2b544', '#ef6363', '#3f6fd8', '#2f9d6c', '#b061d6', '#12141c'].map((c) => (
          <button key={c} onClick={() => addSolid(c)} title={`Add ${c} colour clip`} aria-label={`Add colour clip ${c}`}
            style={{ width: 30, height: 30, borderRadius: 6, background: c, border: '1px solid var(--line)' }} />
        ))}
      </div>
    </>
  );
}

export function PanelContent({ id }: { id: PanelId }) {
  const def = PANELS.find((p) => p.id === id)!;
  if (def.todo) return <TodoPanel def={def} />;
  switch (id) {
    case 'media': return <MediaPanel />;
    case 'audio': return <MediaPanel audioOnly />;
    case 'text': return <TextPanel />;
    case 'effects': return <EffectsPanel />;
    case 'filters': return <FiltersPanel />;
    case 'adjust': return <AdjustPanel />;
    case 'canvas': return <CanvasPanel />;
    case 'captions': return <CaptionsPanel />;
    case 'transitions': return <TransitionsPanel />;
    case 'ai': return <AiPanel />;
    case 'stickers': return <StickersPanel />;
    case 'templates': return <TemplatesPanel />;
    case 'brand': return <BrandPanel />;
    default: return null;
  }
}

export function SidePanel() {
  const panel = useApp((s) => s.panel);
  const def = PANELS.find((p) => p.id === panel)!;
  return (
    <aside className="panel" aria-label={`${def.label} panel`}>
      <div className="panel-head"><h3>{def.label}</h3></div>
      <div className="panel-body"><PanelContent id={panel} /></div>
    </aside>
  );
}

export function Rail() {
  const panel = useApp((s) => s.panel);
  const setPanel = useApp((s) => s.setPanel);
  return (
    <nav className="rail" aria-label="Tools">
      {PANELS.map((p) => (
        <button key={p.id} className={panel === p.id ? 'on' : ''} onClick={() => setPanel(p.id)} aria-current={panel === p.id} title={p.todo ? `${p.label} (planned)` : p.label}>
          <Icon name={p.icon} size={19} />
          <span>{p.label}</span>
          {p.todo && <span className="todo-dot" />}
        </button>
      ))}
    </nav>
  );
}
