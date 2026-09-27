import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';

interface PropRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Multiplier for display (e.g. 100 for percentages stored as 0..1). */
  display?: number;
  unit?: string;
  onChange: (v: number) => void;
  keyframe?: { has: boolean; on: boolean; toggle: () => void };
  id?: string;
}

/** Numeric property: drag the label to scrub, slide, or type an exact value. */
export function PropRow({ label, value, min, max, step = 0.01, display = 1, unit, onChange, keyframe, id }: PropRowProps) {
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  const dragRef = useRef<{ x: number; v: number } | null>(null);
  const shown = value * display;
  const decimals = step * display >= 1 ? 0 : step * display >= 0.1 ? 1 : 2;
  const clamp = (v: number) => Math.min(max, Math.max(min, v));

  const commitText = () => {
    setEditing(false);
    const n = parseFloat(text);
    if (!isNaN(n)) onChange(clamp(n / display));
  };

  return (
    <div className={`prop${keyframe ? '' : ' nokf'}`}>
      <label
        htmlFor={id}
        title="Drag to adjust"
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          dragRef.current = { x: e.clientX, v: value };
        }}
        onPointerMove={(e) => {
          if (!dragRef.current) return;
          const dx = e.clientX - dragRef.current.x;
          const range = max - min;
          const sens = e.shiftKey ? 0.1 : 1;
          onChange(clamp(Math.round((dragRef.current.v + (dx / 300) * range * sens) / step) * step));
        }}
        onPointerUp={() => (dragRef.current = null)}
        onPointerCancel={() => (dragRef.current = null)}
      >
        {label}
      </label>
      <input type="range" min={min} max={max} step={step} value={clamp(value)} aria-label={label}
        onChange={(e) => onChange(parseFloat(e.target.value))} />
      <input
        id={id}
        type="number"
        step={step * display}
        value={editing ? text : Number(shown.toFixed(decimals))}
        onFocus={() => { setEditing(true); setText(shown.toFixed(decimals)); }}
        onChange={(e) => setText(e.target.value)}
        onBlur={commitText}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        title={unit}
        aria-label={`${label} value`}
      />
      {keyframe && (
        <button className={`kf-btn${keyframe.on ? ' on' : keyframe.has ? ' has' : ''}`} onClick={keyframe.toggle}
          title={keyframe.on ? 'Remove keyframe here' : 'Add keyframe at playhead'} aria-label={`Keyframe ${label}`}>
          <Icon name="keyframe" size={12} />
        </button>
      )}
    </div>
  );
}

export function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="section">
      <div className="section-title"><span className="grow">{title}</span>{right}</div>
      {children}
    </section>
  );
}

/** Open dialogs, newest last — Escape only closes the one on top (dialogs can open over dialogs). */
const dialogStack: object[] = [];

export function Dialog({ title, onClose, children, footer, wide, width }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; width?: number }) {
  const [me] = useState(() => ({}));
  useEffect(() => {
    dialogStack.push(me);
    return () => { const i = dialogStack.indexOf(me); if (i >= 0) dialogStack.splice(i, 1); };
  }, [me]);
  // Registered once (latest onClose via a ref): re-adding it mid-keypress would miss that keypress.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && dialogStack[dialogStack.length - 1] === me) closeRef.current(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [me]);
  // Rendered at the top of the page: inside a phone bottom-sheet (which is transformed)
  // a fixed dialog would otherwise be clipped to the sheet and couldn't scroll to its end.
  return createPortal(
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} style={width || wide ? { width: `min(${width ?? 760}px, 100%)` } : undefined}>
        <header>
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
        </header>
        <div className="body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label?: string }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={value === o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Mini waveform drawn from normalised peaks. */
export function Waveform({ peaks, color = 'rgba(255,255,255,0.75)', from = 0, to, perSecond = 40, className }: {
  peaks?: number[]; color?: string; from?: number; to?: number; perSecond?: number; className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !peaks?.length) return;
    const draw = () => {
      const w = Math.min(8000, Math.max(1, Math.round(c.clientWidth * devicePixelRatio)));
      const h = Math.max(1, Math.round(c.clientHeight * devicePixelRatio));
      c.width = w; c.height = h;
      const ctx = c.getContext('2d')!;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = color;
      const a = Math.floor(from * perSecond);
      const b = Math.min(peaks.length, Math.ceil((to ?? peaks.length / perSecond) * perSecond));
      const n = Math.max(1, b - a);
      for (let x = 0; x < w; x++) {
        const i0 = a + Math.floor((x / w) * n), i1 = Math.max(i0 + 1, a + Math.floor(((x + 1) / w) * n));
        let v = 0;
        for (let i = i0; i < i1 && i < peaks.length; i++) v = Math.max(v, peaks[i]);
        const bh = Math.max(1, v * h);
        ctx.fillRect(x, h - bh, 1, bh);
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
  }, [peaks, color, from, to, perSecond]);
  return <canvas ref={ref} className={className} style={{ width: '100%', height: '100%', display: 'block' }} />;
}
