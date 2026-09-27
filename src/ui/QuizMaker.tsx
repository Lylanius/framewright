/** Quiz maker dialog: questions in → finished quiz rounds on the timeline. */
import { useEffect, useRef, useState } from 'react';
import { buildQuiz, DEFAULT_QUIZ, quizLength, type HideMode, type QuizOptions, type QuizRound } from '../core/quiz';
import { SFX, sfxFile } from '../core/sfx';
import { formatShort } from '../core/time';
import type { MediaItem } from '../core/types';
import { Dialog, PropRow, Seg } from './components/Controls';
import { Icon } from './components/Icon';
import { QuizPreview } from './QuizPreview';
import { suggestFocus } from './quizFocus';
import { VoiceRecorder } from './VoiceRecorder';
import { ZoomEditor } from './ZoomEditor';
import { useApp, useTime } from './store';

interface Draft {
  id: number; file: File | null; url: string | null; answers: string[]; correct: number;
  /** Zoomed-in question: point to zoom on (0..1), whether the app chose it, and the picture's size. */
  focus?: { x: number; y: number }; autoFocus?: boolean; size?: { w: number; h: number };
  /** This round's own zoom, once you've set it in the close-up editor. */
  zoom?: number;
}
let seq = 1;
const blank = (): Draft => ({ id: seq++, file: null, url: null, answers: ['', '', '', ''], correct: 0 });

const PIC_BOX = 110;

/** Picture thumbnail showing the chosen close-up; tap it to open the close-up editor. */
function ZoomThumb({ r, zoom, index, onEdit, onChange }: { r: Draft; zoom: number; index: number; onEdit: () => void; onChange: () => void }) {
  const w = r.size?.w ?? 1, h = r.size?.h ?? 1;
  const k = Math.min(PIC_BOX / w, PIC_BOX / h), dw = w * k, dh = h * k, ox = (PIC_BOX - dw) / 2, oy = (PIC_BOX - dh) / 2;
  const f = r.focus ?? { x: 0.5, y: 0.5 };
  const z = r.zoom ?? zoom;
  const side = (Math.min(w, h) / z) * k;
  const cx = Math.min(ox + dw - side / 2, Math.max(ox + side / 2, ox + f.x * dw)), cy = Math.min(oy + dh - side / 2, Math.max(oy + side / 2, oy + f.y * dh));
  return (
    <div className="quiz-pic-col">
      <button className="quiz-pic zoom-pick" onClick={onEdit} aria-label={`Choose close-up for round ${index + 1}`} title="Choose the part to zoom in on">
        <img src={r.url!} alt="" draggable={false} />
        <span className="zoom-dim" style={{ background: `radial-gradient(circle at ${cx}px ${cy}px, transparent ${side / 2}px, rgba(0,0,0,0.55) ${side / 2 + 1}px)` }} />
        <span className="zoom-spot" style={{ left: cx - side / 2, top: cy - side / 2, width: side, height: side }} />
        <span className="zoom-badge">{z.toFixed(1)}×</span>
      </button>
      <button className="btn sm primary" onClick={onEdit}><Icon name="zoomIn" size={13} />Close-up</button>
      <button className="btn sm ghost" onClick={onChange}>Change picture</button>
    </div>
  );
}

let playing: HTMLAudioElement | null = null;
function playFile(f: Blob) {
  playing?.pause();
  const url = URL.createObjectURL(f);
  playing = new Audio(url);
  playing.onended = () => URL.revokeObjectURL(url);
  void playing.play().catch(() => URL.revokeObjectURL(url));
}
const playSfx = (id: string) => { const d = SFX.find((x) => x.id === id); if (d) playFile(sfxFile(d)); };

export function QuizMaker({ onClose }: { onClose: () => void }) {
  const { importFiles, apply, toast } = useApp();
  const [opts, setOpts] = useState({ ...DEFAULT_QUIZ, sounds: true });
  const [rounds, setRounds] = useState<Draft[]>([blank()]);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState<number | null>(null); // round shown in the preview
  const [editing, setEditing] = useState<number | null>(null); // round whose close-up is open
  const [voice, setVoice] = useState<File | null>(null); // optional intro voice / sound
  const voiceRef = useRef<HTMLInputElement>(null);
  const settings = useApp((s) => s.project?.settings);
  const { sounds: _s, ...look } = opts; void _s;
  const fileRefs = useRef(new Map<number, HTMLInputElement>());
  useEffect(() => () => rounds.forEach((r) => r.url && URL.revokeObjectURL(r.url)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch: Partial<typeof opts>) => setOpts({ ...opts, ...patch });
  // Spots the app chose itself are re-picked for the new zoom; ones you chose stay put.
  const refocus = (zoom: number) => rounds.forEach((r) => {
    if (!r.autoFocus || !r.url || r.zoom) return;
    const img = new Image();
    img.onload = () => setRounds((rs) => rs.map((x) => (x.id === r.id && x.autoFocus ? { ...x, focus: suggestFocus(img, zoom) } : x)));
    img.src = r.url;
  });
  const upd = (id: number, patch: Partial<Draft>) => { setActive(id); setRounds((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r))); };
  const shownIndex = Math.max(0, rounds.findIndex((r) => r.id === active));
  const shown = rounds[shownIndex] ?? rounds[0];
  const ready = rounds.filter((r) => r.file && r.answers.filter((a) => a.trim()).length >= 2);

  const make = async () => {
    if (!ready.length) { toast('Each round needs a picture and at least two answers.'); return; }
    setBusy(true);
    try {
      // One at a time so each round keeps its own picture even if one file fails.
      const picIds: (string | undefined)[] = [];
      for (const r of ready) picIds.push((await importFiles([r.file!]))[0]);
      const sfxIds: (string | undefined)[] = [];
      const introId = opts.intro && opts.introSound !== 'none' ? opts.introSound : null;
      if (opts.sounds) for (const id of ['tick', 'tock', 'ding', 'whoosh', ...(introId ? [introId] : [])]) sfxIds.push((await importFiles([sfxFile(SFX.find((x) => x.id === id)!)]))[0]);
      const voiceId = opts.intro && voice ? (await importFiles([voice]))[0] : undefined;
      const media = useApp.getState().project!.media;
      const byId = (id?: string) => media.find((m) => m.id === id) as MediaItem | undefined;
      const qr: QuizRound[] = ready.map((r, i) => {
        const answers = r.answers.map((a) => a.trim()).filter(Boolean);
        const correctText = r.answers[r.correct]?.trim();
        return { picture: byId(picIds[i])!, answers, correct: Math.max(0, answers.indexOf(correctText ?? '')), focus: r.focus, zoom: r.zoom };
      }).filter((r) => r.picture);
      const o: QuizOptions = { ...opts, sounds: { tick: byId(sfxIds[0]), tock: byId(sfxIds[1]), ding: byId(sfxIds[2]), whoosh: byId(sfxIds[3]), boom: introId === 'boom' ? byId(sfxIds[4]) : undefined, sting: introId === 'sting' ? byId(sfxIds[4]) : undefined, introVoice: byId(voiceId) } };
      let start = 0;
      apply(`Quiz: ${qr.length} round${qr.length === 1 ? '' : 's'}`, (p) => { const r = buildQuiz(p, qr, o); start = r.start; return r.project; });
      useTime.getState().setTime(start);
      useApp.getState().player?.seek(start);
      toast(`Made ${qr.length} quiz round${qr.length === 1 ? '' : 's'}${opts.intro ? ' with an intro' : ''} (${formatShort(quizLength(opts, qr.length))}). Every part is editable on the timeline.`, 'success');
      useApp.getState().setMobileSheet(null); // phones: show the finished quiz, not the Templates sheet
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally { setBusy(false); }
  };

  return (
    <Dialog title="Quiz maker" onClose={onClose} width={1000} footer={<>
      <span className="faint" style={{ marginRight: 'auto', fontSize: 12, alignSelf: 'center' }}>{ready.length} round{ready.length === 1 ? '' : 's'} ready · {formatShort(quizLength(opts, ready.length))}</span>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={busy || !ready.length} onClick={() => void make()}><Icon name="plus" size={15} />{busy ? 'Making…' : `Add ${ready.length || ''} round${ready.length === 1 ? '' : 's'} to the video`}</button>
    </>}>
      <div className="quiz-grid">
        <div className="quiz-preview-col">
          {settings && <QuizPreview settings={settings} opts={look} round={shown} roundNumber={opts.firstRound + shownIndex} />}
        </div>
        <div className="quiz-opts">
          <label className="field"><span>Title (shown every round)</span>
            <textarea className="input" rows={2} value={opts.title} onChange={(e) => set({ title: e.target.value })} aria-label="Quiz title" />
          </label>
          <div className="row">
            <label className="row grow"><input type="checkbox" checked={opts.showRound} onChange={() => set({ showRound: !opts.showRound })} /> Show “Round N”</label>
            {opts.showRound && <label className="row" style={{ gap: 6 }}>from <input className="input sm" type="number" min={1} value={opts.firstRound} onChange={(e) => set({ firstRound: Math.max(1, +e.target.value || 1) })} style={{ width: 64 }} aria-label="First round number" /></label>}
          </div>
          <label className="row"><input type="checkbox" checked={opts.intro} onChange={() => set({ intro: !opts.intro })} aria-label="Start with an intro" /> Start with an intro (title slams in)</label>
          {opts.intro && (
            <div className="quiz-intro">
              <PropRow label="Intro length" value={opts.introSeconds} min={1.5} max={6} step={0.5} unit="s" onChange={(v) => set({ introSeconds: v })} />
              {opts.sounds && (
                <div className="field"><span>Intro sound</span>
                  <div className="row" style={{ gap: 6 }}>
                    <Seg label="Intro sound" value={opts.introSound} onChange={(v: QuizOptions['introSound']) => set({ introSound: v })} options={[{ value: 'sting', label: 'Sting' }, { value: 'boom', label: 'Boom' }, { value: 'none', label: 'None' }]} />
                    {opts.introSound !== 'none' && <button className="icon-btn sm" onClick={() => playSfx(opts.introSound)} aria-label="Hear the intro sound"><Icon name="play" size={13} /></button>}
                  </div>
                </div>
              )}
              <small className="muted" style={{ marginTop: 2 }}>Your voice (optional)</small>
              <div className="row wrap" style={{ gap: 6 }}>
                <VoiceRecorder onDone={(f) => { setVoice(f); toast('Got it — tap ▶ to hear it back.', 'success'); }} onError={(m) => toast(m, 'error')} />
                <button className="btn sm" onClick={() => voiceRef.current?.click()}><Icon name="upload" size={13} />{voice ? 'Use a file instead' : 'Add a sound file'}</button>
              </div>
              {voice && <div className="row" style={{ gap: 6 }}>
                <button className="icon-btn sm" onClick={() => playFile(voice)} aria-label="Hear your intro voice"><Icon name="play" size={13} /></button>
                <small className="grow faint" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{voice.name}</small>
                <button className="icon-btn sm" onClick={() => setVoice(null)} aria-label="Remove intro sound"><Icon name="trash" size={13} /></button>
              </div>}
              <small className="faint">Tap Record and shout the title (“Who’s that…?!”) — silence at the start and end is trimmed for you. It plays as the title lands. Your recording stays on this device.</small>
            </div>
          )}
          <PropRow label="Thinking time" value={opts.thinkSeconds} min={2} max={15} step={1} unit="s" onChange={(v) => set({ thinkSeconds: v })} />
          <PropRow label="Reveal time" value={opts.revealSeconds} min={1} max={8} step={0.5} unit="s" onChange={(v) => set({ revealSeconds: v })} />
          <label className="field"><span>Hide the picture with</span>
            <Seg label="Hide the picture with" value={opts.hide} onChange={(v: HideMode) => set({ hide: v })} options={[{ value: 'zoom', label: 'Zoom' }, { value: 'silhouette', label: 'Silhouette' }, { value: 'blur', label: 'Blur' }, { value: 'pixelate', label: 'Pixels' }, { value: 'none', label: 'Nothing' }]} />
          </label>
          {opts.hide === 'zoom' && <>
            <PropRow label="Starting zoom" value={opts.zoom} min={1.5} max={8} step={0.5} unit="×" onChange={(v) => { set({ zoom: v }); refocus(v); }} />
            <small className="faint">The question shows a close-up, then zooms out to reveal. Tap <b>Close-up</b> on each picture to choose exactly which part to show and how close.</small>
          </>}
          {opts.hide === 'silhouette' && <small className="faint">Silhouettes need pictures with a see-through background (PNG). For photos, pick Blur or Pixels.</small>}
          <label className="field"><span>Background</span>
            <Seg label="Background" value={opts.background} onChange={(v: QuizOptions['background']) => set({ background: v })} options={[{ value: 'streaks', label: 'Streaks' }, { value: 'speedlines', label: 'Speed lines' }, { value: 'rays', label: 'Sunburst' }, { value: 'dots', label: 'Dots' }, { value: 'gradient', label: 'Gradient' }]} />
          </label>
          <label className="row"><input type="checkbox" checked={opts.burst} onChange={() => set({ burst: !opts.burst })} /> Starburst behind the picture</label>
          <div className="row" style={{ gap: 14 }}>
            <label className="row" style={{ fontSize: 13 }}><input type="color" className="swatch" value={opts.bgColour} onChange={(e) => set({ bgColour: e.target.value })} aria-label="Background colour" />Background</label>
            <label className="row" style={{ fontSize: 13 }}><input type="color" className="swatch" value={opts.accent} onChange={(e) => set({ accent: e.target.value })} aria-label="Title colour" />Title & letters</label>
          </div>
          <label className="field"><span>Answers</span>
            <Seg label="Answer layout" value={opts.answerLayout} onChange={(v: QuizOptions['answerLayout']) => set({ answerLayout: v })} options={[{ value: 'grid', label: '2 × 2 grid' }, { value: 'list', label: 'One per row' }]} />
          </label>
          <PropRow label="Answer size" value={Math.round(opts.answerSize * 100)} min={70} max={160} step={5} unit="%" onChange={(v) => set({ answerSize: v / 100 })} />
          <label className="field"><span>Countdown</span>
            <Seg label="Countdown" value={opts.countdown} onChange={(v: QuizOptions['countdown']) => set({ countdown: v })} options={[{ value: 'bar', label: 'Bar' }, { value: 'ring', label: 'Ring' }, { value: 'none', label: 'None' }]} />
          </label>
          <label className="row"><input type="checkbox" checked={opts.sounds} onChange={() => set({ sounds: !opts.sounds })} /> Sound effects (whoosh, tick-tock, chime{opts.intro ? ', boom' : ''})</label>
        </div>
        <div className="quiz-rounds">
          {rounds.map((r, i) => (
            <div key={r.id} className={`quiz-round${r.id === shown.id && rounds.length > 1 ? ' previewing' : ''}`} onFocus={() => setActive(r.id)}>
              {opts.hide === 'zoom' && r.url && r.size
                ? <ZoomThumb r={r} zoom={opts.zoom} index={i} onEdit={() => { setActive(r.id); setEditing(r.id); }} onChange={() => fileRefs.current.get(r.id)?.click()} />
                : <button className="quiz-pic" onClick={() => fileRefs.current.get(r.id)?.click()} aria-label={`Picture for round ${i + 1}`}>
                  {r.url ? <img src={r.url} alt="" /> : <><Icon name="image" size={22} /><small>Picture</small></>}
                </button>}
              <input ref={(el) => { if (el) fileRefs.current.set(r.id, el); }} type="file" accept="image/*" hidden onChange={(e) => {
                const f = e.target.files?.[0]; e.target.value = '';
                if (!f) return;
                if (r.url) URL.revokeObjectURL(r.url);
                const url = URL.createObjectURL(f);
                upd(r.id, { file: f, url, focus: undefined, autoFocus: true, size: undefined });
                const img = new Image();
                img.onload = () => upd(r.id, { size: { w: img.naturalWidth, h: img.naturalHeight }, focus: suggestFocus(img, opts.zoom), autoFocus: true });
                img.src = url;
              }} />
              <div className="quiz-answers">
                <div className="row"><b className="grow">Round {opts.firstRound + i}</b>
                  {rounds.length > 1 && <button className="icon-btn sm" onClick={() => setRounds(rounds.filter((x) => x.id !== r.id))} aria-label={`Remove round ${i + 1}`}><Icon name="trash" size={13} /></button>}
                </div>
                {r.answers.map((a, j) => (
                  <label key={j} className="row quiz-answer">
                    <input type="radio" name={`correct-${r.id}`} checked={r.correct === j} onChange={() => upd(r.id, { correct: j })} aria-label={`Answer ${'ABCD'[j]} is correct`} title="Right answer" />
                    <span className="mono">{'ABCD'[j]})</span>
                    <input className="input sm grow" value={a} placeholder={j < 2 ? 'Answer' : 'Answer (optional)'} onChange={(e) => upd(r.id, { answers: r.answers.map((x, k) => (k === j ? e.target.value : x)) })} aria-label={`Round ${i + 1} answer ${'ABCD'[j]}`} />
                  </label>
                ))}
                <small className="faint">Tick the right answer.</small>
              </div>
            </div>
          ))}
          <button className="btn" onClick={() => setRounds([...rounds, blank()])}><Icon name="plus" size={14} />Add a round</button>
        </div>
      </div>
      {editing !== null && (() => {
        const i = rounds.findIndex((x) => x.id === editing);
        const r = rounds[i];
        if (!r?.url || !r.size) return null;
        return (
          <ZoomEditor url={r.url} size={r.size} round={opts.firstRound + i}
            value={{ focus: r.focus ?? { x: 0.5, y: 0.5 }, zoom: r.zoom ?? opts.zoom }}
            onSave={(c) => upd(r.id, { focus: c.focus, zoom: c.zoom, autoFocus: false })}
            onClose={() => setEditing(null)}
            suggest={(zoom) => new Promise((res) => { const img = new Image(); img.onload = () => res(suggestFocus(img, zoom)); img.src = r.url!; })} />
        );
      })()}
    </Dialog>
  );
}
