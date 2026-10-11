/**
 * Kids Studio: a simple, big-button video maker inside Framewright.
 * Once a grown-up switches it on it stays on — even after the app is closed —
 * until a grown-up answers a sum to leave. Kids only see their own videos.
 */
import { useEffect, useRef, useState } from 'react';
import { kidsProjectDefaults } from '../../core/kids';
import { prefs } from '../../storage/db';
import { Dialog } from '../components/Controls';
import { useApp } from '../store';
import { KidsEditor } from './KidsEditor';
import '../../styles/kids.css';

export const kidName = () => prefs.get<string>('kidName', '').trim();

function ago(ts: number): string {
  const d = Math.floor((Date.now() - ts) / 86400000);
  return d <= 0 ? 'Today' : d === 1 ? 'Yesterday' : `${d} days ago`;
}

/** Backup if the PIN is forgotten: a long multiplication (e.g. 37 × 24). */
export function makeSum(rand = Math.random): { a: number; b: number } {
  return { a: 23 + Math.floor(rand() * 26), b: 13 + Math.floor(rand() * 17) };
}
const pinOf = () => prefs.get<string>('kidsPin', '');

/** Leaving Kids Studio needs the grown-up PIN (or, if it's forgotten, a long multiplication). */
function GrownUpGate({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<'pin' | 'sum'>(pinOf() ? 'pin' : 'sum');
  const [sum, setSum] = useState(makeSum);
  const [answer, setAnswer] = useState('');
  const [wrong, setWrong] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const check = () => {
    const ok = mode === 'pin' ? answer === pinOf() : +answer === sum.a * sum.b;
    if (ok) { void useApp.getState().setKidsMode(false); return; }
    setWrong(true); setAnswer('');
    if (mode === 'sum') setSum(makeSum());
    input.current?.focus();
  };
  const switchTo = (m: 'pin' | 'sum') => { setMode(m); setAnswer(''); setWrong(false); input.current?.focus(); };
  return (
    <>
      <div className="k-sheet-back" onClick={onClose} />
      <section className="k-sheet k-gate" role="dialog" aria-label="Grown-ups only">
        <header><h2>Grown-ups only</h2><button className="k-x" onClick={onClose} aria-label="Close">✕</button></header>
        <div className="k-sheet-body">
          {mode === 'pin' ? <p>Enter the grown-up PIN to leave Kids Studio.</p> : <>
            <p>To leave Kids Studio, answer this:</p>
            <p className={`k-sum${wrong ? ' wrong' : ''}`}>{sum.a} × {sum.b} =</p>
          </>}
          <input ref={input} className={`k-input k-answer${wrong && mode === 'pin' ? ' wrong' : ''}`} inputMode="numeric" pattern="[0-9]*" autoFocus value={answer}
            type={mode === 'pin' ? 'password' : 'text'} autoComplete="off" aria-label={mode === 'pin' ? 'PIN' : 'Answer'}
            onChange={(e) => { setAnswer(e.target.value.replace(/\D/g, '').slice(0, mode === 'pin' ? 4 : 5)); setWrong(false); }}
            onKeyDown={(e) => { if (e.key === 'Enter') check(); }} />
          {wrong && <p className="k-hint">{mode === 'pin' ? 'That’s not the PIN.' : 'Not quite — here’s a new one.'}</p>}
          <button className="k-btn grape wide" onClick={check} disabled={!answer}>Leave Kids Studio</button>
          {mode === 'pin' ? <button className="k-link" onClick={() => switchTo('sum')}>Forgot the PIN?</button>
            : pinOf() && <button className="k-link" onClick={() => switchTo('pin')}>Use the PIN</button>}
        </div>
      </section>
    </>
  );
}

function KidsHome() {
  const summaries = useApp((s) => s.summaries).filter((s) => s.kids);
  const { refreshSummaries, newProject, openProject, removeProject } = useApp.getState();
  const [gate, setGate] = useState(false);
  const [binning, setBinning] = useState<string | null>(null);
  useEffect(() => { void refreshSummaries(); }, [refreshSummaries]);

  const make = (tall: boolean) => {
    const n = summaries.length + 1;
    const name = kidName() ? `${kidName()}’s video ${n}` : `My video ${n}`;
    void newProject(name, { width: tall ? 1080 : 1920, height: tall ? 1920 : 1080, fps: 30, background: '#000000', sampleRate: 48000 }, (p) => kidsProjectDefaults(p));
  };

  return (
    <main className="k-home">
      <header className="k-home-top">
        <div>
          <h1>{kidName() ? `Hi ${kidName()}!` : 'Hi!'} <span aria-hidden>👋</span></h1>
          <p>What shall we make today?</p>
        </div>
        <button className="k-btn white small" onClick={() => setGate(true)}><span className="k-ico">🔒</span>Grown-ups</button>
      </header>
      <div className="k-new">
        <button className="k-new-btn pink" onClick={() => make(true)}><span className="k-shape tall" aria-hidden>📱</span><b>New tall video</b><small>For phones, TikTok and Shorts</small></button>
        <button className="k-new-btn sky" onClick={() => make(false)}><span className="k-shape wide" aria-hidden>📺</span><b>New wide video</b><small>For TV and YouTube</small></button>
      </div>
      <h2 className="k-h2">My videos</h2>
      {!summaries.length ? <p className="k-empty-note">Nothing here yet — start a new video above.</p> : (
        <div className="k-videos">
          {summaries.map((s) => (
            <article key={s.id} className="k-video">
              <button className="k-video-thumb" style={{ backgroundImage: s.thumbnail ? `url(${s.thumbnail})` : undefined, aspectRatio: `${s.width} / ${s.height}` }} onClick={() => void openProject(s.id)} aria-label={`Open ${s.name}`}>
                {!s.thumbnail && <span>🎬</span>}
              </button>
              <div className="k-video-meta">
                <b>{s.name}</b><small>{ago(s.updatedAt)}</small>
                {binning === s.id ? (
                  <span className="k-confirm">Bin it? <button className="k-chip pinkish" onClick={() => { void removeProject(s.id); setBinning(null); }}>Yes</button><button className="k-chip" onClick={() => setBinning(null)}>No</button></span>
                ) : <button className="k-round small white" onClick={() => setBinning(s.id)} aria-label={`Bin ${s.name}`}>🗑️</button>}
              </div>
            </article>
          ))}
        </div>
      )}
      {gate && <GrownUpGate onClose={() => setGate(false)} />}
    </main>
  );
}

export function KidsStudio() {
  const project = useApp((s) => s.project);
  const screen = useApp((s) => s.screen);
  // A grown-up project can't be opened from here: Kids Studio only shows kids' videos.
  useEffect(() => { if (project && !project.kids) void useApp.getState().closeProject(); }, [project]);
  return <div className="kids">{project?.kids && screen === 'editor' ? <KidsEditor key={project.id} /> : <KidsHome />}</div>;
}

/** Grown-up side: switch Kids Studio on (child's name, and a PIN that's needed to leave it). */
export function KidsStudioStart({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState(kidName() || 'Molly');
  const had = !!pinOf();
  const [pin, setPin] = useState('');
  const ready = pin.length === 4 || (had && !pin);
  const start = () => {
    if (!ready) return;
    prefs.set('kidName', name.trim());
    if (pin) prefs.set('kidsPin', pin);
    onClose();
    void useApp.getState().setKidsMode(true);
  };
  return (
    <Dialog title="Kids Studio" onClose={onClose} width={440} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" onClick={start} disabled={!ready}>Start Kids Studio</button>
    </>}>
      <p style={{ margin: 0 }}>A simpler editor with big buttons — trim, split, speed, filters, text, stickers, music, sounds, voiceovers and transitions. It only shows the videos made in it, and stays on even if the app is closed.</p>
      <label className="field"><span>Who’s making videos?</span>
        <input className="input" value={name} maxLength={20} onChange={(e) => setName(e.target.value)} aria-label="Child’s name" />
      </label>
      <label className="field"><span>{had ? 'Grown-up PIN (leave blank to keep the current one)' : 'Choose a 4-number grown-up PIN — you’ll need it to leave'}</span>
        <input className="input" type="password" inputMode="numeric" pattern="[0-9]*" autoComplete="new-password" value={pin} maxLength={4}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))} onKeyDown={(e) => { if (e.key === 'Enter') start(); }} aria-label="Grown-up PIN" />
      </label>
      <small className="faint">Videos made in Kids Studio also show in your projects here (marked 🧸).</small>
    </Dialog>
  );
}
