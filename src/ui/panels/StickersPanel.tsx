import { useMemo, useRef, useState } from 'react';
import { defaultShape } from '../../core/defaults';
import { EMOJI, STICKERS } from '../../core/stickers';
import type { ShapeStyle } from '../../core/types';
import { renderShapeLayer } from '../../engine/shapeRender';
import { Icon } from '../components/Icon';
import { addBackground, addDesignText, addShape, addSticker, addStickerFiles, DESIGN_TEXT } from '../library';
import { useApp } from '../store';

const SHAPES: { type: ShapeStyle['type']; label: string }[] = [
  { type: 'rect', label: 'Box' }, { type: 'ellipse', label: 'Ring' }, { type: 'triangle', label: 'Triangle' }, { type: 'star', label: 'Star' },
  { type: 'heart', label: 'Heart' }, { type: 'arrow', label: 'Arrow' }, { type: 'bubble', label: 'Speech' }, { type: 'burst', label: 'Burst' }, { type: 'line', label: 'Line' },
];

function shapePreview(type: ShapeStyle['type']): string {
  const s = defaultShape(type);
  return renderShapeLayer(s, 120 / Math.max(s.width, s.height)).toDataURL();
}

const BACKGROUNDS: { type: ShapeStyle['type']; label: string; extra?: Partial<ShapeStyle> }[] = [
  { type: 'streaks', label: 'Streaks' }, { type: 'speedlines', label: 'Speed lines' }, { type: 'rays', label: 'Sunburst' }, { type: 'dots', label: 'Comic dots' },
  { type: 'gradient', label: 'Gradient' }, { type: 'gradient', label: 'Glow', extra: { gradientKind: 'radial', fill: '#ffe066', fill2: '#ff4d6d' } },
];

function bgPreview(style: ShapeStyle): string {
  const k = 150 / Math.max(style.width, style.height);
  return renderShapeLayer(style, k, 0.2, 1).toDataURL('image/jpeg', 0.8);
}

function DesignSection() {
  const project = useApp((s) => s.project);
  const frame = { width: project?.settings.width ?? 1080, height: project?.settings.height ?? 1920 };
  const bgs = useMemo(() => BACKGROUNDS.map((b) => ({ ...b, style: { ...defaultShape(b.type, frame), ...b.extra } as ShapeStyle })), [frame.width, frame.height]); // eslint-disable-line react-hooks/exhaustive-deps
  const bgUrls = useMemo(() => bgs.map((b) => bgPreview(b.style)), [bgs]);
  const ring: ShapeStyle = { ...defaultShape('ellipse'), width: 640, height: 640, fill: 'rgba(255,255,255,0.08)', stroke: '#ffffff', strokeWidth: 10, glow: 36, glowColor: '#9fdcff' };
  const designs: { label: string; style: ShapeStyle }[] = [
    { label: 'Starburst', style: defaultShape('starburst') },
    { label: 'Glow ring', style: ring },
    { label: 'Countdown ring', style: defaultShape('countdown') },
    { label: 'Countdown bar', style: { ...defaultShape('countdown'), countStyle: 'bar', width: 800, height: 40, radius: 20, fill: 'rgba(0,0,0,0.35)' } },
    { label: 'Big number', style: { ...defaultShape('countdown'), countStyle: 'number', fill: 'transparent', stroke: '#1f4fb8', textColor: '#ffd23f', strokeWidth: 10 } },
  ];
  const designUrls = useMemo(() => designs.map((d) => renderShapeLayer(d.style, 110 / Math.max(d.style.width, d.style.height), 1, 3).toDataURL()), []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <div className="section">
        <div className="label">Backgrounds</div>
        <div className="sticker-grid shapes">
          {bgs.map((b, i) => (
            <button key={b.label} className="sticker bg" onClick={() => addBackground(b.style)} aria-label={`Add ${b.label} background`} title={`${b.label} — goes behind everything`}>
              <img src={bgUrls[i]} alt="" draggable={false} /><span>{b.label}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="section">
        <div className="label">Design</div>
        <div className="sticker-grid shapes">
          {designs.map((d, i) => (
            <button key={d.label} className="sticker" onClick={() => addShape(d.style)} aria-label={`Add ${d.label}`} title={d.label}>
              <img src={designUrls[i]} alt="" draggable={false} /><span>{d.label}</span>
            </button>
          ))}
        </div>
        <div className="design-text">
          {DESIGN_TEXT.map((t) => (
            <button key={t.id} className="btn sm" onClick={() => addDesignText(t.style, t.y)} aria-label={`Add ${t.name}`}>{t.name}</button>
          ))}
        </div>
        <small className="faint">Tip: in any text, select words and use “Colour selected words” — like the yellow “A)” on answer buttons.</small>
      </div>
    </>
  );
}

export function StickersPanel() {
  const [q, setQ] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const previews = useMemo(() => Object.fromEntries(SHAPES.map((s) => [s.type, shapePreview(s.type)])), []);
  const stickerUrls = useMemo(() => Object.fromEntries(STICKERS.map((s) => [s.id, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(s.svg)}`])), []);
  const shown = STICKERS.filter((s) => !q || `${s.name} ${s.tags}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <p className="faint" style={{ margin: 0, fontSize: 12 }}>Backgrounds, design pieces, stickers, shapes and emoji. Tap to add at the playhead. They pop in by default — change the motion in the inspector’s Animate tab.</p>
      <DesignSection />
      <input className="input" placeholder="Search stickers" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search stickers" />
      <div className="section">
        <div className="label">Stickers</div>
        <div className="sticker-grid">
          {shown.map((s) => (
            <button key={s.id} className="sticker" onClick={() => void addSticker(s)} title={s.name} aria-label={`Add sticker ${s.name}`}>
              <img src={stickerUrls[s.id]} alt="" draggable={false} />
            </button>
          ))}
          {!shown.length && <small className="faint">No stickers match.</small>}
        </div>
      </div>
      <div className="section">
        <div className="label">Shapes</div>
        <div className="sticker-grid shapes">
          {SHAPES.map((s) => (
            <button key={s.type} className="sticker" onClick={() => addShape(defaultShape(s.type))} aria-label={`Add ${s.label} shape`} title={s.label}>
              <img src={previews[s.type]} alt="" draggable={false} /><span>{s.label}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="section">
        <div className="label">Emoji</div>
        <div className="emoji-grid">
          {EMOJI.map((e) => (
            <button key={e} onClick={() => addShape({ ...defaultShape('emoji'), emoji: e })} aria-label={`Add emoji ${e}`}>{e}</button>
          ))}
        </div>
        <small className="faint">Emoji look like your device’s own set.</small>
      </div>
      <div className="section">
        <div className="label">Your own</div>
        <button className="btn" onClick={() => fileRef.current?.click()}><Icon name="upload" size={15} />Import PNG, SVG, GIF or WebP</button>
        <input ref={fileRef} type="file" multiple accept="image/png,image/svg+xml,image/gif,image/webp,.svg,.gif,.webp,.png,.apng" hidden
          onChange={(e) => { const f = Array.from(e.target.files ?? []); e.target.value = ''; if (f.length) void addStickerFiles(f); }} />
        <small className="faint">Transparent PNGs work as cut-out stickers. Animated GIFs and WebPs play and loop (Chrome, Edge, Firefox and the desktop/Android apps; Safari shows the first frame).</small>
      </div>
    </>
  );
}
