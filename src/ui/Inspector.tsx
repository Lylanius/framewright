import { useEffect, useRef, useState } from 'react';
import { BUILTIN_FONTS, plainText } from '../core/defaults';
import { getEffectDef, LOOKS } from '../core/effects';
import { formatShort, formatTimecode, parseTime } from '../core/time';
import { clipEnd, findClip, maxClipDuration, moveClip, projectDuration, setSpeed, trimEnd } from '../core/timeline';
import type { AnimatableProp, Clip, EffectInstance, TextAnimation, TextStyle } from '../core/types';
import { deleteBackup, listBackups, type Backup } from '../storage/db';
import { uploadedFonts } from '../styles/fonts';
import { deleteSelected, detachSelectedAudio, duplicateSelected } from './actions';
import { PropRow, Section, Seg } from './components/Controls';
import { Icon } from './components/Icon';
import { keyframeState, patchClip, propValue, setProp, toggleKeyframe } from './propEdit';
import { useApp, useTime } from './store';
import { TransitionInspector } from './panels/TransitionsPanel';
import { ColourTab } from './inspector/ColourTab';
import { CutoutTab } from './inspector/CutoutTab';
import { AudioEffectsSection, LevelTools } from './inspector/AudioTools';
import { EasingEditor } from './inspector/EasingEditor';
import { alignSelected, arrange, distributeSelected } from './arrange';
import { BrandSwatches, MotionSection, ShapeTab, SlotTab } from './inspector/LibraryTabs';
import { freezeFrame, RAMP_PRESETS, speedRamp } from '../core/timeline';

type Tab = 'basic' | 'text' | 'anim' | 'speed' | 'audio' | 'effects' | 'colour' | 'cutout' | 'shape' | 'slot';

function useLiveTime(): number {
  // Re-render at most ~8×/s while the playhead moves (keyframe indicators, animated values).
  const [t, setT] = useState(useTime.getState().time);
  useEffect(() => {
    let last = 0;
    return useTime.subscribe((s) => {
      const now = performance.now();
      // While playing, keep the inspector still (it re-renders on pause) so playback stays smooth.
      if (useApp.getState().player?.playing) return;
      if (now - last > 120) { last = now; setT(s.time); }
    });
  }, []);
  return t;
}

function AnimProp({ clip, prop, label, min, max, step, display, unit }: {
  clip: Clip; prop: AnimatableProp; label: string; min: number; max: number; step?: number; display?: number; unit?: string;
}) {
  const kf = keyframeState(clip, prop);
  return (
    <PropRow id={`p-${prop}`} label={label} value={propValue(clip, prop)} min={min} max={max} step={step} display={display} unit={unit}
      onChange={(v) => setProp(clip.id, prop, v)} keyframe={{ ...kf, toggle: () => toggleKeyframe(clip.id, prop) }} />
  );
}

function TimeField({ label, value, fps, onCommit }: { label: string; value: number; fps: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <label className="field">
      <span>{label}</span>
      <input className="input mono" value={text ?? formatTimecode(value, fps)} onFocus={(e) => { setText(formatTimecode(value, fps)); e.target.select(); }}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => { const v = text !== null ? parseTime(text, fps) : null; setText(null); if (v !== null && isFinite(v)) onCommit(v); }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
    </label>
  );
}

function ArrangeSection({ multi = false }: { multi?: boolean }) {
  const toast = useApp((s) => s.toast);
  const al = (a: Parameters<typeof alignSelected>[0], label: string, glyph: string) => (
    <button className="icon-btn sm arrange" onClick={() => alignSelected(a)} title={multi ? `Align ${label} (to each other)` : `Align ${label} (to the frame)`} aria-label={`Align ${label}`}>{glyph}</button>
  );
  return (
    <Section title={multi ? 'Align & distribute' : 'Position'}>
      <div className="row arrange-row">
        {al('left', 'left', '⇤')}{al('centre', 'centre', '↔')}{al('right', 'right', '⇥')}
        <span className="sep" />
        {al('top', 'top', '⤒')}{al('middle', 'middle', '↕')}{al('bottom', 'bottom', '⤓')}
      </div>
      {multi ? (
        <div className="row">
          <button className="btn sm" onClick={() => { if (!distributeSelected('x')) toast('Select 3 or more layers to space them out.'); }}>Space evenly ↔</button>
          <button className="btn sm" onClick={() => { if (!distributeSelected('y')) toast('Select 3 or more layers to space them out.'); }}>Space evenly ↕</button>
        </div>
      ) : (
        <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
          <button className="btn sm" onClick={() => arrange('up')} aria-label="Bring forward">Forward</button>
          <button className="btn sm" onClick={() => arrange('down')} aria-label="Send backward">Backward</button>
          <button className="btn sm" onClick={() => arrange('front')} aria-label="Bring to front">To front</button>
          <button className="btn sm" onClick={() => arrange('back')} aria-label="Send to back">To back</button>
        </div>
      )}
      {!multi && <small className="faint">Drag on the preview: pink guides snap to the edges, the centre and other layers (hold Alt to move freely). Drag a corner to resize, the round knob to rotate.</small>}
    </Section>
  );
}

function TransformSection({ clip }: { clip: Clip }) {
  const t = clip.transform;
  return (
    <>
      {clip.kind !== 'audio' && clip.kind !== 'adjustment' && <ArrangeSection />}
      <Section title="Transform" right={
        <button className="btn sm ghost" onClick={() => patchClip(clip.id, (c) => ({ ...c, transform: { ...c.transform, x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, keyframes: { volume: c.keyframes.volume } }), 'Reset transform')}>Reset</button>
      }>
        <AnimProp clip={clip} prop="x" label="Position X" min={-1} max={1} step={0.001} display={100} unit="% of width" />
        <AnimProp clip={clip} prop="y" label="Position Y" min={-1} max={1} step={0.001} display={100} unit="% of height" />
        <AnimProp clip={clip} prop="scale" label="Scale" min={0.05} max={5} step={0.01} display={100} unit="%" />
        <AnimProp clip={clip} prop="rotation" label="Rotation" min={-360} max={360} step={0.5} unit="°" />
        <AnimProp clip={clip} prop="opacity" label="Opacity" min={0} max={1} step={0.01} display={100} unit="%" />
        <div className="row">
          <button className={`btn sm${t.flipH ? ' primary' : ''}`} onClick={() => patchClip(clip.id, (c) => ({ ...c, transform: { ...c.transform, flipH: !c.transform.flipH } }), 'Flip')}><Icon name="flipH" size={14} />Flip H</button>
          <button className={`btn sm${t.flipV ? ' primary' : ''}`} onClick={() => patchClip(clip.id, (c) => ({ ...c, transform: { ...c.transform, flipV: !c.transform.flipV } }), 'Flip')}><Icon name="flipV" size={14} />Flip V</button>
          <button className="btn sm" onClick={() => setProp(clip.id, 'rotation', (propValue(clip, 'rotation') + 90) % 360, 'Rotate')}>Rotate 90°</button>
        </div>
      </Section>
      {(clip.kind === 'video' || clip.kind === 'image') && (
        <Section title="Fit & crop">
          <Seg label="Fit" value={clip.fit} onChange={(fit) => patchClip(clip.id, { fit }, 'Fit')}
            options={[{ value: 'contain', label: 'Fit' }, { value: 'cover', label: 'Fill' }, { value: 'fill', label: 'Stretch' }]} />
          {(['left', 'right', 'top', 'bottom'] as const).map((side) => (
            <PropRow key={side} label={`Crop ${side}`} value={t.crop[side]} min={0} max={0.45} step={0.005} display={100} unit="%"
              onChange={(v) => patchClip(clip.id, (c) => ({ ...c, transform: { ...c.transform, crop: { ...c.transform.crop, [side]: v } } }), 'Crop', `crop:${clip.id}:${side}`)} />
          ))}
        </Section>
      )}
      <Section title="Fade (picture)">
        <PropRow label="Fade in" value={clip.videoFadeIn} min={0} max={Math.min(5, clip.duration / 2)} step={0.05} unit="s" onChange={(v) => patchClip(clip.id, { videoFadeIn: v }, 'Fade in', `vfi:${clip.id}`)} />
        <PropRow label="Fade out" value={clip.videoFadeOut} min={0} max={Math.min(5, clip.duration / 2)} step={0.05} unit="s" onChange={(v) => patchClip(clip.id, { videoFadeOut: v }, 'Fade out', `vfo:${clip.id}`)} />
      </Section>
    </>
  );
}

function AdjustmentBlend({ clip }: { clip: Clip }) {
  return (
    <Section title="Blend">
      <AnimProp clip={clip} prop="opacity" label="Amount" min={0} max={1} step={0.01} display={100} unit="%" />
      <PropRow label="Fade in" value={clip.videoFadeIn} min={0} max={Math.min(5, clip.duration / 2)} step={0.05} unit="s" onChange={(v) => patchClip(clip.id, { videoFadeIn: v }, 'Fade in', `vfi:${clip.id}`)} />
      <PropRow label="Fade out" value={clip.videoFadeOut} min={0} max={Math.min(5, clip.duration / 2)} step={0.05} unit="s" onChange={(v) => patchClip(clip.id, { videoFadeOut: v }, 'Fade out', `vfo:${clip.id}`)} />
      <small className="faint">An adjustment layer changes everything on the tracks below it while it’s on the timeline. Stretch it to cover the part you want.</small>
    </Section>
  );
}

function AudioSection({ clip }: { clip: Clip }) {
  const media = useApp((s) => s.project?.media.find((m) => m.id === clip.mediaId));
  if (clip.kind === 'video' && media && !media.hasAudio) return <p className="faint">This clip has no sound.</p>;
  return (
    <>
      <Section title="Volume">
        <AnimProp clip={clip} prop="volume" label="Volume" min={0} max={4} step={0.01} display={100} unit="%" />
        <label className="row"><input type="checkbox" checked={clip.muted} onChange={() => patchClip(clip.id, { muted: !clip.muted }, clip.muted ? 'Unmute' : 'Mute')} /> Mute this clip</label>
      </Section>
      <Section title="Fades">
        <PropRow label="Fade in" value={clip.fadeIn} min={0} max={Math.min(10, clip.duration / 2)} step={0.05} unit="s" onChange={(v) => patchClip(clip.id, { fadeIn: v }, 'Audio fade in', `afi:${clip.id}`)} />
        <PropRow label="Fade out" value={clip.fadeOut} min={0} max={Math.min(10, clip.duration / 2)} step={0.05} unit="s" onChange={(v) => patchClip(clip.id, { fadeOut: v }, 'Audio fade out', `afo:${clip.id}`)} />
      </Section>
      <LevelTools clip={clip} />
      <AudioEffectsSection clip={clip} />
      {clip.kind === 'video' && <button className="btn" onClick={detachSelectedAudio}><Icon name="detach" size={15} />Detach audio to its own track</button>}
    </>
  );
}

function SpeedSection({ clip }: { clip: Clip }) {
  const apply = useApp((s) => s.apply);
  const toast = useApp((s) => s.toast);
  const select = useApp((s) => s.select);
  const [hold, setHold] = useState(2);
  const presets = [0.25, 0.5, 1, 1.5, 2, 4];
  if (clip.freeze) {
    return (
      <Section title="Freeze frame">
        <p className="faint" style={{ margin: 0, fontSize: 12 }}>This clip holds a single frame. Change how long it lasts with Duration above or by trimming it on the timeline.</p>
      </Section>
    );
  }
  return (
    <>
      <Section title="Speed">
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {presets.map((s) => <button key={s} className={`chip${Math.abs(clip.speed - s) < 1e-3 ? ' on' : ''}`} onClick={() => apply('Speed', (p) => setSpeed(p, clip.id, s))}>{s}×</button>)}
        </div>
        <PropRow label="Speed" value={clip.speed} min={0.1} max={8} step={0.05} unit="×" onChange={(v) => apply('Speed', (p) => setSpeed(p, clip.id, v), `speed:${clip.id}`)} />
        <p className="faint" style={{ margin: 0, fontSize: 12 }}>New length: {formatShort(clip.duration)}.</p>
        <label className="row"><input type="checkbox" checked={clip.keepPitch !== false} onChange={() => patchClip(clip.id, { keepPitch: clip.keepPitch === false }, 'Keep pitch')} /> Keep voice pitch natural when sped up or slowed</label>
        <label className="row"><input type="checkbox" checked={clip.reverse} onChange={() => patchClip(clip.id, { reverse: !clip.reverse }, 'Reverse')} /> Reverse (plays backwards; preview may be choppy, export is exact)</label>
      </Section>
      {!clip.reverse && (
        <Section title="Speed ramp">
          <div className="ramp-grid">
            {RAMP_PRESETS.map((r) => (
              <button key={r.id} className="ramp-btn" aria-label={`Ramp: ${r.name}`} onClick={() => {
                if (apply(`Speed ramp: ${r.name}`, (p) => speedRamp(p, clip.id, r.f))) toast(`${r.name} applied — the clip is now a run of short pieces you can still trim.`, 'success');
              }}>
                <RampCurve f={r.f} /><span>{r.name}</span>
              </button>
            ))}
          </div>
          <small className="faint">Ramps split the clip into short pieces at changing speeds, so every other tool still works on them. Undo to go back.</small>
        </Section>
      )}
      {clip.kind === 'video' && (
        <Section title="Freeze frame">
          <PropRow label="Hold for" value={hold} min={0.2} max={10} step={0.1} unit="s" onChange={setHold} />
          <button className="btn" onClick={() => {
            let id: string | null = null;
            const ok = apply('Freeze frame', (p) => { const r = freezeFrame(p, clip.id, useTime.getState().time, hold); id = r?.freezeId ?? null; return r?.project; });
            if (!ok) toast('Put the playhead over this clip first.');
            else if (id) select([id]);
          }}><Icon name="pause" size={14} />Freeze at playhead</button>
        </Section>
      )}
    </>
  );
}

function RampCurve({ f }: { f: (u: number) => number }) {
  const pts = Array.from({ length: 25 }, (_, i) => { const u = i / 24; return `${(u * 60).toFixed(1)},${(22 - Math.min(20, f(u) * 5)).toFixed(1)}`; });
  return <svg viewBox="0 0 60 24" width="60" height="24" aria-hidden="true"><polyline points={pts.join(' ')} fill="none" stroke="currentColor" strokeWidth="1.8" /></svg>;
}

const ANIMS: { value: TextAnimation; label: string }[] = [
  { value: 'none', label: 'None' }, { value: 'fade', label: 'Fade' }, { value: 'pop', label: 'Pop' }, { value: 'slideUp', label: 'Slide up' },
  { value: 'slideDown', label: 'Slide down' }, { value: 'typewriter', label: 'Typewriter' }, { value: 'wordByWord', label: 'Word by word' },
];

function TextSection({ clip }: { clip: Clip }) {
  const st = clip.text!;
  const set = (patch: Partial<TextStyle>, label = 'Edit text', key?: string) =>
    patchClip(clip.id, (c) => ({ ...c, name: plainText(patch.content ?? c.text!.content).replace(/\s+/g, ' ').slice(0, 24) || 'Text', text: { ...c.text!, ...patch } }), label, key ?? `text:${clip.id}:${Object.keys(patch).join()}`);
  const fonts = [...BUILTIN_FONTS, ...uploadedFonts()];
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [partColour, setPartColour] = useState('#ffd23f');
  const colourSelection = () => {
    const ta = taRef.current;
    if (!ta || ta.selectionStart === ta.selectionEnd) { useApp.getState().toast('Select some words in the text box first.'); return; }
    const a = ta.selectionStart, b = ta.selectionEnd, v = st.content;
    set({ content: `${v.slice(0, a)}{${partColour}|${v.slice(a, b).replace(/[{}|]/g, '')}}${v.slice(b)}` }, 'Colour words');
  };
  return (
    <>
      <Section title="Text">
        <textarea ref={taRef} className="input" rows={3} value={st.content} onChange={(e) => set({ content: e.target.value })} aria-label="Text content" />
        <div className="row">
          <input type="color" className="swatch" value={partColour} onChange={(e) => setPartColour(e.target.value)} aria-label="Colour for selected words" />
          <button className="btn sm" onClick={colourSelection} title="Select some words in the box above, then press this to colour just those words">Colour selected words</button>
        </div>
        <div className="grid2">
          <select className="input" value={st.fontFamily} onChange={(e) => set({ fontFamily: e.target.value }, 'Font')} aria-label="Font" style={{ fontFamily: `"${st.fontFamily}"` }}>
            {fonts.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
          <select className="input" value={st.fontWeight} onChange={(e) => set({ fontWeight: +e.target.value }, 'Weight')} aria-label="Weight">
            {[300, 400, 600, 700, 800, 900].map((w) => <option key={w} value={w}>{w}</option>)}
          </select>
        </div>
        <div className="row">
          <Seg label="Alignment" value={st.align} onChange={(align) => set({ align }, 'Align')} options={[{ value: 'left', label: 'Left' }, { value: 'center', label: 'Centre' }, { value: 'right', label: 'Right' }]} />
          <button className={`btn sm${st.italic ? ' primary' : ''}`} onClick={() => set({ italic: !st.italic }, 'Italic')} aria-pressed={st.italic}><i>I</i></button>
          <button className={`btn sm${st.uppercase ? ' primary' : ''}`} onClick={() => set({ uppercase: !st.uppercase }, 'Caps')} aria-pressed={st.uppercase}>AA</button>
        </div>
        <PropRow label="Size" value={st.fontSize} min={8} max={400} step={1} unit="px" onChange={(v) => set({ fontSize: v })} />
        <PropRow label="Letters" value={st.letterSpacing} min={-10} max={60} step={0.5} unit="px" onChange={(v) => set({ letterSpacing: v })} />
        <PropRow label="Line height" value={st.lineHeight} min={0.7} max={3} step={0.05} unit="×" onChange={(v) => set({ lineHeight: v })} />
        <PropRow label="Box width" value={st.boxWidth} min={0.1} max={1} step={0.01} display={100} unit="% of canvas" onChange={(v) => set({ boxWidth: v })} />
      </Section>
      <Section title="Colour">
        <BrandSwatches onPick={(c) => set({ color: c, gradient: null }, 'Colour')} />
        <div className="row">
          <input type="color" className="swatch" value={st.color} onChange={(e) => set({ color: e.target.value, gradient: null }, 'Colour')} aria-label="Text colour" />
          <label className="row grow"><input type="checkbox" checked={!!st.gradient} onChange={() => set({ gradient: st.gradient ? null : { from: st.color, to: '#ff5f6d' } }, 'Gradient')} /> Gradient</label>
          {st.gradient && <>
            <input type="color" className="swatch" value={st.gradient.from} onChange={(e) => set({ gradient: { ...st.gradient!, from: e.target.value } }, 'Gradient')} aria-label="Gradient top" />
            <input type="color" className="swatch" value={st.gradient.to} onChange={(e) => set({ gradient: { ...st.gradient!, to: e.target.value } }, 'Gradient')} aria-label="Gradient bottom" />
          </>}
        </div>
      </Section>
      <Section title="Outline, shadow & glow">
        <div className="row"><input type="color" className="swatch" value={st.strokeColor} onChange={(e) => set({ strokeColor: e.target.value }, 'Outline')} aria-label="Outline colour" /><div className="grow"><PropRow label="Outline" value={st.strokeWidth} min={0} max={30} step={0.5} unit="px" onChange={(v) => set({ strokeWidth: v })} /></div></div>
        <div className="row"><input type="color" className="swatch" value={toHex(st.shadowColor)} onChange={(e) => set({ shadowColor: e.target.value }, 'Shadow')} aria-label="Shadow colour" /><div className="grow"><PropRow label="Shadow" value={st.shadowBlur} min={0} max={60} step={1} unit="px" onChange={(v) => set({ shadowBlur: v })} /></div></div>
        <PropRow label="Shadow Y" value={st.shadowOffsetY} min={-40} max={40} step={1} unit="px" onChange={(v) => set({ shadowOffsetY: v })} />
        <PropRow label="Glow" value={st.glow} min={0} max={80} step={1} unit="px" onChange={(v) => set({ glow: v })} />
      </Section>
      <Section title="Spoken-word highlight">
        <select className="input" value={st.highlightMode ?? 'none'} onChange={(e) => set({ highlightMode: e.target.value as TextStyle['highlightMode'] }, 'Highlight')} aria-label="Highlight style">
          <option value="none">None</option><option value="color">Colour the current word</option><option value="box">Box behind the current word</option>
          <option value="karaoke">Karaoke (fill as spoken)</option><option value="underline">Underline the current word</option>
        </select>
        {st.highlightMode && st.highlightMode !== 'none' && (
          <div className="row">
            <input type="color" className="swatch" value={toHex(st.highlightColor ?? '#ffd23f')} onChange={(e) => set({ highlightColor: e.target.value }, 'Highlight colour')} aria-label="Highlight colour" />
            <span className="muted grow" style={{ fontSize: 12 }}>Highlight</span>
            {st.highlightMode === 'box' && <><input type="color" className="swatch" value={toHex(st.highlightTextColor ?? '#ffffff')} onChange={(e) => set({ highlightTextColor: e.target.value }, 'Highlight text')} aria-label="Highlighted word colour" /><span className="muted" style={{ fontSize: 12 }}>Word</span></>}
          </div>
        )}
        {st.highlightMode && st.highlightMode !== 'none' && !clip.words && (
          <small className="faint">Word timing is estimated from the text length. Exact timing arrives with on-device transcription.</small>
        )}
      </Section>
      <Section title="Background">
        <div className="row">
          <label className="row grow"><input type="checkbox" checked={!!st.background} onChange={() => set({ background: st.background ? null : '#000000' }, 'Background')} /> Label background</label>
          {st.background && <input type="color" className="swatch" value={toHex(st.background)} onChange={(e) => set({ background: e.target.value }, 'Background')} aria-label="Background colour" />}
        </div>
        {st.background && <>
          <PropRow label="Padding" value={st.backgroundPadding} min={0} max={80} step={1} unit="px" onChange={(v) => set({ backgroundPadding: v })} />
          <PropRow label="Rounding" value={st.backgroundRadius} min={0} max={80} step={1} unit="px" onChange={(v) => set({ backgroundRadius: v })} />
          <div className="row">
            <input type="color" className="swatch" value={toHex(st.backgroundBorder ?? '#111111')} onChange={(e) => set({ backgroundBorder: e.target.value, backgroundBorderWidth: st.backgroundBorderWidth || 4 }, 'Box border')} aria-label="Box border colour" />
            <div className="grow"><PropRow label="Border" value={st.backgroundBorderWidth ?? 0} min={0} max={20} step={0.5} unit="px" onChange={(v) => set({ backgroundBorderWidth: v, backgroundBorder: st.backgroundBorder ?? '#111111' })} /></div>
          </div>
          <label className="row"><input type="checkbox" checked={!!st.backgroundFull} onChange={() => set({ backgroundFull: !st.backgroundFull }, 'Button box')} /> Fixed-width box (buttons — set the width with Box width)</label>
        </>}
      </Section>
    </>
  );
}

function AnimationSection({ clip }: { clip: Clip }) {
  const st = clip.text;
  const kfCount = Object.values(clip.keyframes).reduce((a, k) => a + (k?.length ?? 0), 0);
  return (
    <>
      {st && (
        <Section title="Text animation">
          <label className="field"><span>In</span>
            <select className="input" value={st.animIn} onChange={(e) => patchClip(clip.id, (c) => ({ ...c, text: { ...c.text!, animIn: e.target.value as TextAnimation } }), 'Animation in')}>
              {ANIMS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
            </select>
          </label>
          <label className="field"><span>Out</span>
            <select className="input" value={st.animOut} onChange={(e) => patchClip(clip.id, (c) => ({ ...c, text: { ...c.text!, animOut: e.target.value as TextAnimation } }), 'Animation out')}>
              {ANIMS.filter((a) => a.value !== 'typewriter' && a.value !== 'wordByWord').map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
            </select>
          </label>
          <PropRow label="Duration" value={st.animDuration} min={0.05} max={3} step={0.05} unit="s" onChange={(v) => patchClip(clip.id, (c) => ({ ...c, text: { ...c.text!, animDuration: v } }), 'Animation speed', `anim:${clip.id}`)} />
        </Section>
      )}
      {clip.kind !== 'audio' && <MotionSection clip={clip} />}
      <Section title="Keyframes">
        <p className="faint" style={{ margin: 0, fontSize: 12 }}>
          Move the playhead, then press the ◆ next to any slider (position, crop, colour, effects, sound…). Changing a keyframed value adds a key at the playhead.
        </p>
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>{kfCount} keyframe{kfCount === 1 ? '' : 's'} on this clip.</p>
        {kfCount > 0 && <button className="btn sm" onClick={() => patchClip(clip.id, { keyframes: {} }, 'Clear keyframes')}>Clear all keyframes</button>}
      </Section>
      {kfCount > 0 && <EasingEditor clip={clip} />}
    </>
  );
}

function EffectCard({ clip, fx, index }: { clip: Clip; fx: EffectInstance; index: number }) {
  const def = getEffectDef(fx.type);
  if (!def) return null;
  const update = (patch: Partial<EffectInstance>, label: string, key?: string) =>
    patchClip(clip.id, (c) => ({ ...c, effects: c.effects.map((e) => (e.id === fx.id ? { ...e, ...patch } : e)) }), label, key);
  const move = (dir: -1 | 1) => patchClip(clip.id, (c) => {
    const list = c.effects.slice();
    const j = index + dir;
    if (j < 0 || j >= list.length) return c;
    [list[index], list[j]] = [list[j], list[index]];
    return { ...c, effects: list };
  }, 'Reorder effects');
  return (
    <div className={`fx-card${fx.enabled ? '' : ' off'}`}>
      <header>
        <input type="checkbox" checked={fx.enabled} onChange={() => update({ enabled: !fx.enabled }, fx.enabled ? 'Disable effect' : 'Enable effect')} aria-label={`Enable ${def.name}`} />
        <span>{fx.type === 'look' ? `Filter: ${LOOKS[Math.round(fx.params.look)]?.name ?? ''}` : def.name}</span>
        <button className="icon-btn sm" onClick={() => move(-1)} aria-label="Move up" title="Apply earlier"><Icon name="back" size={13} style={{ transform: 'rotate(90deg)' }} /></button>
        <button className="icon-btn sm" onClick={() => move(1)} aria-label="Move down" title="Apply later"><Icon name="back" size={13} style={{ transform: 'rotate(-90deg)' }} /></button>
        <button className="icon-btn sm" onClick={() => patchClip(clip.id, (c) => ({ ...c, effects: c.effects.filter((e) => e.id !== fx.id) }), 'Remove effect')} aria-label="Remove effect"><Icon name="trash" size={13} /></button>
      </header>
      {fx.type === 'grade' || fx.type === 'lut' ? <small className="faint">Edit in the Colour tab.</small> : def.params.filter((p) => !(fx.type === 'look' && p.key === 'look')).map((p) => {
        const path = `fx.${fx.id}.${p.key}`;
        return (
          <PropRow key={p.key} label={p.label} value={propValue(clip, path)} min={p.min} max={p.max} step={p.step} unit={p.unit}
            onChange={(v) => setProp(clip.id, path, v, def.name)} keyframe={{ ...keyframeState(clip, path), toggle: () => toggleKeyframe(clip.id, path) }} />
        );
      })}
    </div>
  );
}

function EffectsSection({ clip }: { clip: Clip }) {
  const setPanel = useApp((s) => s.setPanel);
  const setSheet = useApp((s) => s.setMobileSheet);
  return (
    <Section title="Effect stack" right={<button className="btn sm" onClick={() => { setPanel('effects'); setSheet(window.innerWidth <= 900 ? 'panel' : null); }}><Icon name="plus" size={13} />Add</button>}>
      {clip.effects.length === 0 && <p className="faint" style={{ margin: 0, fontSize: 12 }}>No effects yet. Add them from the Effects, Filters or Adjust panels.</p>}
      {clip.effects.map((fx, i) => <EffectCard key={fx.id} clip={clip} fx={fx} index={i} />)}
    </Section>
  );
}

function ClipHeader({ clip }: { clip: Clip }) {
  const project = useApp((s) => s.project)!;
  const apply = useApp((s) => s.apply);
  const fps = project.settings.fps;
  return (
    <Section title={clip.placeholder && !clip.mediaId ? 'Template slot' : clip.kind === 'solid' ? 'Colour clip' : clip.kind === 'adjustment' ? 'Adjustment layer' : clip.kind === 'shape' ? (clip.shape?.type === 'emoji' ? 'Emoji' : 'Shape') : clip.freeze ? 'Freeze frame' : `${clip.kind} clip`} right={
      <>
        <button className={`icon-btn sm${clip.locked ? ' on' : ''}`} onClick={() => patchClip(clip.id, { locked: !clip.locked }, clip.locked ? 'Unlock clip' : 'Lock clip')} title={clip.locked ? 'Unlock clip' : 'Lock clip'} aria-label="Lock clip"><Icon name={clip.locked ? 'lock' : 'unlock'} size={14} /></button>
        <button className="icon-btn sm" onClick={duplicateSelected} title="Duplicate" aria-label="Duplicate"><Icon name="copy" size={14} /></button>
        <button className="icon-btn sm" onClick={() => deleteSelected(false)} title="Delete" aria-label="Delete"><Icon name="trash" size={14} /></button>
      </>
    }>
      {clip.kind !== 'text' && <input className="input" value={clip.name} onChange={(e) => patchClip(clip.id, { name: e.target.value }, 'Rename clip', `name:${clip.id}`)} aria-label="Clip name" />}
      {clip.kind === 'solid' && (
        <div className="row"><input type="color" className="swatch" value={clip.color ?? '#000000'} onChange={(e) => patchClip(clip.id, { color: e.target.value }, 'Colour', `col:${clip.id}`)} aria-label="Clip colour" /><span className="mono faint">{clip.color}</span></div>
      )}
      <div className="grid2">
        <TimeField label="Start" value={clip.start} fps={fps} onCommit={(v) => apply('Move clip', (p) => moveClip(p, clip.id, v))} />
        <TimeField label="Duration" value={clip.duration} fps={fps} onCommit={(v) => apply('Set duration', (p) => trimEnd(p, clip.id, clip.start + Math.max(1 / fps, v)))} />
      </div>
      {(clip.kind === 'video' || clip.kind === 'audio') && (
        <small className="faint mono">Source {formatShort(clip.sourceIn)} → {formatShort(clip.sourceIn + clip.duration * clip.speed)} · max {formatShort(maxClipDuration(project, clip))}</small>
      )}
    </Section>
  );
}

function tabsFor(clip: Clip): { id: Tab; label: string }[] {
  if (clip.placeholder && !clip.mediaId) return clip.kind === 'audio'
    ? [{ id: 'slot', label: 'Slot' }, { id: 'audio', label: 'Audio' }]
    : [{ id: 'slot', label: 'Slot' }, { id: 'basic', label: 'Transform' }, { id: 'effects', label: 'Effects' }, { id: 'anim', label: 'Animate' }];
  switch (clip.kind) {
    case 'shape': return [{ id: 'shape', label: 'Shape' }, { id: 'basic', label: 'Transform' }, { id: 'anim', label: 'Animate' }, { id: 'cutout', label: 'Mask' }, { id: 'effects', label: 'Effects' }];
    case 'video': return clip.freeze
      ? [{ id: 'basic', label: 'Video' }, { id: 'colour', label: 'Colour' }, { id: 'cutout', label: 'Cutout' }, { id: 'effects', label: 'Effects' }, { id: 'speed', label: 'Freeze' }, { id: 'anim', label: 'Animate' }]
      : [{ id: 'basic', label: 'Video' }, { id: 'colour', label: 'Colour' }, { id: 'cutout', label: 'Cutout' }, { id: 'audio', label: 'Audio' }, { id: 'speed', label: 'Speed' }, { id: 'effects', label: 'Effects' }, { id: 'anim', label: 'Animate' }];
    case 'image': return [{ id: 'basic', label: 'Transform' }, { id: 'colour', label: 'Colour' }, { id: 'cutout', label: 'Cutout' }, { id: 'effects', label: 'Effects' }, { id: 'anim', label: 'Animate' }];
    case 'adjustment': return [{ id: 'colour', label: 'Colour' }, { id: 'effects', label: 'Effects' }, { id: 'cutout', label: 'Mask' }, { id: 'basic', label: 'Blend' }, { id: 'anim', label: 'Keyframes' }];
    case 'audio': return [{ id: 'audio', label: 'Audio' }, { id: 'speed', label: 'Speed' }, { id: 'anim', label: 'Keyframes' }];
    case 'text': return [{ id: 'text', label: 'Text' }, { id: 'anim', label: 'Animate' }, { id: 'basic', label: 'Transform' }, { id: 'cutout', label: 'Mask' }, { id: 'effects', label: 'Effects' }];
    default: return [{ id: 'basic', label: 'Transform' }, { id: 'cutout', label: 'Mask' }, { id: 'effects', label: 'Effects' }, { id: 'anim', label: 'Animate' }];
  }
}

/** Everything visible at the playhead, front to back — click to select (like a layers panel). */
function LayersHere() {
  const project = useApp((s) => s.project)!;
  const select = useApp((s) => s.select);
  const t = useLiveTime();
  const layers = project.tracks.flatMap((tr) => (tr.kind === 'visual' && !tr.hidden ? tr.clips.filter((c) => t >= c.start && t < c.start + c.duration) : []));
  if (!layers.length) return null;
  return (
    <Section title="Layers at the playhead">
      <div className="layers-list">
        {layers.map((c, i) => (
          <button key={c.id} className="layer-row" onClick={() => select([c.id])}>
            <span className="faint mono">{i + 1}</span>
            <span className="grow">{c.placeholder && !c.mediaId ? `Slot ${c.placeholder.index + 1}` : c.text ? c.text.content.replace(/\{[^|]*\|([^}]*)\}/g, '$1').slice(0, 30) : c.name}</span>
            <span className="faint" style={{ fontSize: 11 }}>{c.kind === 'shape' ? (c.shape?.type === 'emoji' ? 'emoji' : 'shape') : c.kind}</span>
          </button>
        ))}
      </div>
      <small className="faint">Top of the list is in front.</small>
    </Section>
  );
}

function ProjectInfo() {
  const project = useApp((s) => s.project)!;
  const apply = useApp((s) => s.apply);
  const [backups, setBackups] = useState<Backup[] | null>(null);
  const [confirm, setConfirm] = useState<number | null>(null);
  const [versionName, setVersionName] = useState('');
  const saveVersion = async () => {
    const name = versionName.trim();
    if (!name) return;
    await useApp.getState().saveNow(name, true);
    setVersionName('');
    setBackups(await listBackups(project.id));
    useApp.getState().toast(`Saved version “${name}”.`, 'success');
  };
  const s = project.settings;
  const clipCount = project.tracks.reduce((a, t) => a + t.clips.length, 0);
  return (
    <div className="insp-body">
      <Section title="Project">
        <div className="mono muted" style={{ fontSize: 12, lineHeight: 1.7 }}>
          {s.width}×{s.height} · {s.fps} fps<br />
          {formatShort(projectDuration(project))} · {clipCount} clip{clipCount === 1 ? '' : 's'} · {project.media.length} media · {project.tracks.length} tracks
        </div>
        <p className="faint" style={{ margin: 0, fontSize: 12 }}>Select a clip to edit it. Tap a layer in the preview to select it there.</p>
      </Section>
      <LayersHere />
      <Section title="Version history" right={<button className="btn sm" onClick={async () => setBackups(await listBackups(project.id))}><Icon name="history" size={13} />{backups ? 'Refresh' : 'Show'}</button>}>
        <div className="row">
          <input className="input" placeholder="Name this version (e.g. “Before music”)" value={versionName} onChange={(e) => setVersionName(e.target.value)} aria-label="Version name"
            onKeyDown={(e) => { if (e.key === 'Enter') void saveVersion(); }} />
          <button className="btn sm" onClick={() => void saveVersion()} disabled={!versionName.trim()}><Icon name="star" size={13} />Save</button>
        </div>
        {backups && backups.length === 0 && <p className="faint" style={{ margin: 0, fontSize: 12 }}>No snapshots yet. Framewright keeps one every 5 minutes and on each manual save (Ctrl/⌘+S). Named versions are kept until you delete them.</p>}
        {backups?.map((b, i) => (
          <div key={b.savedAt} className="row" style={{ fontSize: 12 }}>
            {b.pinned && <Icon name="star" size={12} style={{ color: 'var(--accent)' }} />}
            <span className="grow"><b>{b.label}</b> <span className="faint">{new Date(b.savedAt).toLocaleString()}</span></span>
            {b.pinned && <button className="icon-btn sm" aria-label={`Delete version ${b.label}`} onClick={async () => { await deleteBackup(project.id, b.savedAt); setBackups(await listBackups(project.id)); }}><Icon name="trash" size={12} /></button>}
            {confirm === i
              ? <button className="btn sm primary" onClick={() => { apply('Restore version', () => ({ ...b.project, id: project.id })); setConfirm(null); }}>Restore</button>
              : <button className="btn sm" onClick={() => setConfirm(i)}>Use</button>}
          </div>
        ))}
        {backups && <p className="faint" style={{ margin: 0, fontSize: 11 }}>Restoring is itself undoable.</p>}
      </Section>
    </div>
  );
}

export function Inspector() {
  const project = useApp((s) => s.project)!;
  const selection = useApp((s) => s.selection);
  const selectedTransition = useApp((s) => s.selectedTransition);
  useLiveTime();
  const [tab, setTab] = useState<Tab>('basic');
  const loc = selection.length === 1 ? findClip(project, selection[0]) : null;
  const clip = loc?.clip;
  const tabs = clip ? tabsFor(clip) : [];
  // Open on the clip's primary tab whenever a different clip is selected.
  const [tabFor, setTabFor] = useState<string | undefined>(clip?.id);
  if (clip && tabFor !== clip.id) { setTabFor(clip.id); setTab(tabs[0].id); }
  const active = tabs.find((t) => t.id === tab) ? tab : tabs[0]?.id;
  const playheadInside = clip ? useTime.getState().time >= clip.start && useTime.getState().time <= clipEnd(clip) : false;

  if (selection.length > 1) {
    return (
      <aside className="inspector" aria-label="Inspector">
        <div className="insp-body">
          <ArrangeSection multi />
          <Section title={`${selection.length} clips selected`}>
            <p className="faint" style={{ margin: 0, fontSize: 12 }}>Drag any of them on the timeline to move them together.</p>
            <div className="row">
              <button className="btn" onClick={duplicateSelected}><Icon name="copy" size={14} />Duplicate</button>
              <button className="btn danger" onClick={() => deleteSelected(false)}><Icon name="trash" size={14} />Delete</button>
            </div>
          </Section>
        </div>
      </aside>
    );
  }
  if (selectedTransition && !clip) return <aside className="inspector" aria-label="Transition"><TransitionInspector clipId={selectedTransition} /></aside>;
  if (!clip) return <aside className="inspector" aria-label="Inspector"><ProjectInfo /></aside>;

  return (
    <aside className="inspector" aria-label="Inspector">
      <div className="tabs" role="tablist">
        {tabs.map((t) => <button key={t.id} role="tab" aria-selected={active === t.id} className={active === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>{t.label}</button>)}
      </div>
      <div className="insp-body">
        <ClipHeader clip={clip} />
        {!playheadInside && (active === 'basic' || active === 'anim') && Object.keys(clip.keyframes).length > 0 && (
          <small style={{ color: 'var(--accent)' }}>The playhead is outside this clip, so keyframe edits go to the nearest end.</small>
        )}
        {active === 'basic' && (clip.kind === 'adjustment' ? <AdjustmentBlend clip={clip} /> : <TransformSection clip={clip} />)}
        {active === 'colour' && <ColourTab clip={clip} />}
        {active === 'shape' && clip.shape && <ShapeTab clip={clip} />}
        {active === 'slot' && clip.placeholder && <SlotTab clip={clip} />}
        {active === 'cutout' && <CutoutTab clip={clip} />}
        {active === 'text' && clip.text && <TextSection clip={clip} />}
        {active === 'audio' && <AudioSection clip={clip} />}
        {active === 'speed' && <SpeedSection clip={clip} />}
        {active === 'effects' && <EffectsSection clip={clip} />}
        {active === 'anim' && <AnimationSection clip={clip} />}
      </div>
    </aside>
  );
}

function toHex(c: string): string {
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (m) return '#' + [m[1], m[2], m[3]].map((x) => (+x).toString(16).padStart(2, '0')).join('');
  return '#000000';
}
