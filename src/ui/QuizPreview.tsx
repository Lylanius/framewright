/**
 * Live, looping preview of one quiz round inside the quiz maker, drawn with the
 * real renderer — so what you see here is what lands on the timeline.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createProject } from '../core/defaults';
import { buildQuiz, introLength, quizLength, type QuizOptions } from '../core/quiz';
import type { MediaItem, ProjectSettings } from '../core/types';
import { renderFrame } from '../engine/compositor';
import { Icon } from './components/Icon';

const PIC_ID = '__quiz_preview_pic';
const PREVIEW_W = 190;

/** A friendly stand-in creature (transparent background, so silhouettes work) until a picture is picked. */
function standIn(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 400;
  const g = c.getContext('2d')!;
  g.fillStyle = '#7ec8ff';
  g.beginPath(); g.ellipse(200, 235, 130, 125, 0, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.ellipse(110, 110, 38, 70, -0.4, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.ellipse(290, 110, 38, 70, 0.4, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#fff';
  for (const x of [155, 245]) { g.beginPath(); g.arc(x, 215, 28, 0, Math.PI * 2); g.fill(); }
  g.fillStyle = '#1b2a57';
  for (const x of [160, 250]) { g.beginPath(); g.arc(x, 220, 13, 0, Math.PI * 2); g.fill(); }
  g.strokeStyle = '#1b2a57'; g.lineWidth = 8; g.lineCap = 'round';
  g.beginPath(); g.arc(200, 270, 40, 0.2 * Math.PI, 0.8 * Math.PI); g.stroke();
  return c;
}

export interface PreviewRound { url: string | null; answers: string[]; correct: number; focus?: { x: number; y: number }; zoom?: number }

export function QuizPreview({ settings, opts, round, roundNumber }: {
  settings: ProjectSettings;
  opts: Omit<QuizOptions, 'sounds'>;
  round: PreviewRound;
  roundNumber: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pic, setPic] = useState<CanvasImageSource & { width: number; height: number }>(() => standIn());
  const [playing, setPlaying] = useState(true);
  const [progress, setProgress] = useState(0);
  const timeRef = useRef(0);

  useEffect(() => {
    if (!round.url) { setPic(standIn()); return; }
    const img = new Image();
    img.onload = () => setPic(img);
    img.src = round.url;
  }, [round.url]);

  const len = quizLength(opts, 1);
  const intro = introLength(opts);
  const project = useMemo(() => {
    const picture: MediaItem = {
      id: PIC_ID, name: 'Preview', kind: 'image', mimeType: 'image/png', size: 0, duration: 0,
      width: (pic as HTMLImageElement).naturalWidth || pic.width, height: (pic as HTMLImageElement).naturalHeight || pic.height,
      hasAudio: false, fingerprint: PIC_ID, importedAt: 0,
    };
    const base = createProject('Quiz preview', settings);
    const filled = round.answers.map((a, i) => a.trim() || (i < 2 ? `Answer ${'ABCD'[i]}` : '')).filter(Boolean);
    const correctText = round.answers[round.correct]?.trim() || `Answer ${'ABCD'[round.correct]}`;
    const p0 = { ...base, media: [picture] };
    return buildQuiz(p0, [{ picture, answers: filled, correct: Math.max(0, filled.indexOf(correctText)), focus: round.url ? round.focus : { x: 0.72, y: 0.18 }, zoom: round.url ? round.zoom : undefined }], { ...opts, firstRound: roundNumber, sounds: {} }).project;
  }, [settings, opts, round.answers, round.correct, round.focus, round.zoom, round.url, pic, roundNumber]);

  const scale = (settings.height >= settings.width ? PREVIEW_W : 300) / settings.width;
  const W = Math.round(settings.width * scale), H = Math.round(settings.height * scale);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    const sources = { getVisual: (clip: { mediaId?: string }) => (clip.mediaId === PIC_ID ? { src: pic, width: (pic as HTMLImageElement).naturalWidth || pic.width, height: (pic as HTMLImageElement).naturalHeight || pic.height } : null) };
    let raf = 0, last = performance.now(), lastUi = 0;
    const draw = (now: number) => {
      if (playing) timeRef.current = (timeRef.current + (now - last) / 1000) % len;
      last = now;
      try { renderFrame(ctx, project, timeRef.current, sources, { scale, draft: true }); } catch { /* keep the last frame */ }
      if (now - lastUi > 100) { setProgress(timeRef.current / len); lastUi = now; }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [project, playing, len, scale, pic]);

  const thinkEnd = (intro + 1 + opts.thinkSeconds) / len;
  const jump = (sec: number) => { timeRef.current = Math.min(len - 0.01, sec); setProgress(timeRef.current / len); };
  return (
    <div className="quiz-preview">
      <canvas ref={canvasRef} width={W} height={H} style={{ width: W, height: H }} aria-label="Quiz preview" role="img" onClick={() => setPlaying(!playing)} />
      <div className="quiz-preview-bar" aria-hidden>
        <div style={{ width: `${progress * 100}%` }} />
        <i style={{ left: `${thinkEnd * 100}%` }} />
        {intro > 0 && <i className="intro-mark" style={{ left: `${(intro / len) * 100}%` }} />}
      </div>
      <div className="row" style={{ gap: 4, justifyContent: 'center' }}>
        <button className="icon-btn sm" onClick={() => setPlaying(!playing)} aria-label={playing ? 'Pause preview' : 'Play preview'}><Icon name={playing ? 'pause' : 'play'} size={14} /></button>
        {intro > 0 && <button className="btn sm ghost" onClick={() => jump(0)}>Intro</button>}
        <button className="btn sm ghost" onClick={() => jump(intro + 1 + opts.thinkSeconds * 0.4)}>Question</button>
        <button className="btn sm ghost" onClick={() => jump(intro + 1 + opts.thinkSeconds + 1)}>Answer</button>
      </div>
      <small className="faint">Live preview{round.url ? '' : ' — pick a picture to see yours'}</small>
    </div>
  );
}
