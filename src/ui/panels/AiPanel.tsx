import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  applyReframe, attachToTrack, cutRanges, DEFAULT_SILENCE, detectScenes, detectSilence, findFillers, linkedClips,
  sourceToTimeline, suggestHighlights, suggestThresholdDb, totalLength, type Highlight, type Range,
} from '../../core/analysis';
import { addCaptions, CAPTION_STYLES, cuesFromWords, phrasesToWords } from '../../core/captions';
import { createEffect } from '../../core/effects';
import { uid } from '../../core/ids';
import { formatShort } from '../../core/time';
import { clipEnd, findClip, splitClip, trimEnd, trimStart, updateClip } from '../../core/timeline';
import { trackedBlur } from '../../core/analysis';
import type { Clip, MediaItem, WordTiming } from '../../core/types';
import {
  analyseVideo, ASR_MODELS, bundledModelsAvailable, faceTrack, generateImage, trackPoint, transcribeMedia, transcriptionAvailable, type GenSettings,
} from '../../engine/ai';
import { PEAKS_PER_SECOND } from '../../engine/media';
import { runJob } from '../../engine/workerClient';
import type { WorkerResponse } from '../../engine/media.worker';
import { inArtifactHost } from '../../platform/download';
import { prefs } from '../../storage/db';
import { seek } from '../actions';
import { PropRow, Seg } from '../components/Controls';
import { Icon } from '../components/Icon';
import { useApp, useTime } from '../store';

type Where = 'device' | 'download' | 'server';
const WHERE_LABEL: Record<Where, string> = { device: 'On this device', download: 'One-time model download', server: 'Your own server' };

function Card({ title, where, children, desc }: { title: string; where: Where; desc: string; children: ReactNode }) {
  return (
    <section className="ai-card">
      <h4><span>{title}</span><em className={`where ${where}`} title={where === 'device' ? 'Nothing is uploaded.' : where === 'download' ? 'The model is downloaded once and cached. Your audio and video never leave the device.' : 'Only your prompt is sent, to an address you set.'}>{WHERE_LABEL[where]}</em></h4>
      <p>{desc}</p>
      {children}
    </section>
  );
}

function Progress({ value, label }: { value: number; label: string }) {
  return (
    <div className="section" aria-live="polite" style={{ gap: 4 }}>
      <small className="muted">{label}</small>
      <div className="progress"><i style={{ width: `${Math.round(value * 100)}%` }} /></div>
    </div>
  );
}

function useSelectedClip(kinds: Clip['kind'][]): { clip: Clip | null; media: MediaItem | null } {
  const project = useApp((s) => s.project)!;
  const selection = useApp((s) => s.selection);
  return useMemo(() => {
    const clip = selection.map((id) => findClip(project, id)?.clip).find((c): c is Clip => !!c && kinds.includes(c.kind)) ?? null;
    const media = clip?.mediaId ? project.media.find((m) => m.id === clip.mediaId) ?? null : null;
    return { clip, media };
  }, [project, selection, kinds]);
}

const VIDEO_AUDIO: Clip['kind'][] = ['video', 'audio'];
const VIDEO: Clip['kind'][] = ['video'];
const VISUAL_MEDIA: Clip['kind'][] = ['video', 'image'];
const OVERLAY: Clip['kind'][] = ['text', 'image', 'solid', 'video'];

function NeedClip({ what }: { what: string }) {
  return <p className="faint" style={{ fontStyle: 'italic' }}>Select {what} on the timeline first.</p>;
}

/* ------------------------------------------------------------------ */
/* Transcription shared helper                                            */
/* ------------------------------------------------------------------ */

async function ensureTranscript(media: MediaItem, model: string, language: string | null, onProgress: (p: number, label: string) => void): Promise<MediaItem['transcript']> {
  const st = useApp.getState();
  if (media.transcript && media.transcript.model === model) return media.transcript;
  const r = await transcribeMedia(media.id, media.duration, model, language, (p) => {
    const label = p.stage === 'download' ? `Downloading speech model (one time only) · ${p.detail ?? ''}` : p.stage === 'audio' ? 'Reading the audio…' : p.stage === 'loading' ? 'Starting the speech model…' : `Listening… ${p.detail ?? ''}`;
    onProgress(p.fraction, label);
  });
  const words = r.wordLevel ? r.words : phrasesToWords(r.words);
  const transcript = { words, wordLevel: r.wordLevel, model, language, createdAt: Date.now() };
  st.patchMedia(media.id, { transcript });
  return transcript;
}

/** Transcript words mapped onto the timeline for one clip (forward-playing clips only). */
function timelineWords(clip: Clip, words: WordTiming[]): WordTiming[] {
  if (clip.reverse) return [];
  const s0 = clip.sourceIn, s1 = clip.sourceIn + clip.duration * clip.speed;
  return words
    .filter((w) => w.end > s0 && w.start < s1)
    .map((w) => ({ text: w.text, start: clip.start + (Math.max(w.start, s0) - s0) / clip.speed, end: clip.start + (Math.min(w.end, s1) - s0) / clip.speed }));
}

/* ------------------------------------------------------------------ */
/* Tools                                                                  */
/* ------------------------------------------------------------------ */

function AutoCaptions() {
  const project = useApp((s) => s.project)!;
  const { apply, toast } = useApp();
  const [model, setModel] = useState(prefs.get('asrModel', ASR_MODELS[0].id));
  const [lang, setLang] = useState<string>('english');
  const [chunk, setChunk] = useState('3');
  const [style, setStyle] = useState('punch');
  const [busy, setBusy] = useState<{ p: number; label: string } | null>(null);
  const avail = transcriptionAvailable();
  const m = ASR_MODELS.find((x) => x.id === model) ?? ASR_MODELS[0];

  const run = async () => {
    const sources = project.tracks.filter((t) => !t.muted).flatMap((t) => t.clips)
      .filter((c) => (c.kind === 'video' || c.kind === 'audio') && !c.muted && project.media.find((x) => x.id === c.mediaId)?.hasAudio);
    if (!sources.length) { toast('Add a video or audio clip with speech first.'); return; }
    prefs.set('asrModel', model);
    try {
      const mediaIds = [...new Set(sources.map((c) => c.mediaId!))];
      const transcripts = new Map<string, WordTiming[]>();
      for (let i = 0; i < mediaIds.length; i++) {
        const media = useApp.getState().project!.media.find((x) => x.id === mediaIds[i])!;
        const t = await ensureTranscript(media, model, m.english ? null : lang === 'auto' ? null : lang, (p, label) => setBusy({ p: (i + p) / mediaIds.length, label }));
        transcripts.set(media.id, t!.words);
      }
      const words = sources.flatMap((c) => timelineWords(c, transcripts.get(c.mediaId!) ?? [])).sort((a, b) => a.start - b.start);
      if (!words.length) { toast('No speech was found.'); return; }
      const cues = cuesFromWords(words, +chunk);
      apply('Auto-captions', (p) => addCaptions(p, cues, style, true));
      toast(`Added ${cues.length} captions from ${words.length} words. Edit them in the Captions panel.`, 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title="Auto-captions" where="download" desc="Turns the speech in your timeline into timed, animated captions. Runs on your device; the speech model downloads once and is cached.">
      {!avail.ok ? <p style={{ color: 'var(--accent)' }}>{avail.reason}</p> : (
        <>
          <div className="grid2">
            <label className="field"><span>Model</span>
              <select className="input" value={model} onChange={(e) => setModel(e.target.value)}>
                {ASR_MODELS.map((x) => <option key={x.id} value={x.id}>{x.label} ({x.size})</option>)}
              </select>
            </label>
            {!m.english ? (
              <label className="field"><span>Language</span>
                <select className="input" value={lang} onChange={(e) => setLang(e.target.value)}>
                  {['auto', 'english', 'french', 'german', 'spanish', 'italian', 'portuguese', 'dutch', 'polish', 'japanese', 'korean', 'chinese'].map((l) => <option key={l} value={l}>{l === 'auto' ? 'Detect' : l[0].toUpperCase() + l.slice(1)}</option>)}
                </select>
              </label>
            ) : (
              <label className="field"><span>Look</span>
                <select className="input" value={style} onChange={(e) => setStyle(e.target.value)}>
                  {CAPTION_STYLES.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
            )}
          </div>
          {!m.english && (
            <label className="field"><span>Look</span>
              <select className="input" value={style} onChange={(e) => setStyle(e.target.value)}>
                {CAPTION_STYLES.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          )}
          <div className="field"><span>Words per caption</span>
            <Seg label="Words per caption" value={chunk} onChange={setChunk} options={[{ value: '1', label: '1' }, { value: '2', label: '2' }, { value: '3', label: '3' }, { value: '0', label: 'Sentence' }]} />
          </div>
          {busy ? <Progress value={busy.p} label={busy.label} /> : <button className="btn primary" onClick={() => void run()}><Icon name="captions" size={15} />Caption my video</button>}
        </>
      )}
    </Card>
  );
}

function RemoveSilence() {
  const { clip, media } = useSelectedClip(VIDEO_AUDIO);
  const { apply, toast, patchMedia } = useApp();
  const [threshold, setThreshold] = useState<number | null>(null);
  const [minSilence, setMinSilence] = useState(DEFAULT_SILENCE.minSilence);
  const [padding, setPadding] = useState(DEFAULT_SILENCE.padding);
  const [analysing, setAnalysing] = useState<number | null>(null);
  const loud = media?.loudness;
  const suggested = useMemo(() => (loud ? suggestThresholdDb(loud) : DEFAULT_SILENCE.thresholdDb), [loud]);
  const thr = threshold ?? suggested;
  const ranges: Range[] = useMemo(() => {
    if (!clip || !loud) return [];
    return sourceToTimeline(clip, detectSilence(loud, media!.peaksPerSecond ?? PEAKS_PER_SECOND, { thresholdDb: thr, minSilence, padding }));
  }, [clip, loud, media, thr, minSilence, padding]);

  useEffect(() => setThreshold(null), [media?.id]);

  if (!clip || !media) return <Card title="Remove silences" where="device" desc="Cuts out pauses and dead air, then closes the gaps."><NeedClip what="a video or audio clip" /></Card>;

  const analyse = async () => {
    const blob = (await import('../../engine/media')).getData(media.id);
    if (!blob) return;
    setAnalysing(0);
    try {
      const r = await runJob<Extract<WorkerResponse, { type: 'audio' }>>({ type: 'analyseAudio', data: blob, perSecond: PEAKS_PER_SECOND }, setAnalysing).promise;
      patchMedia(media.id, { peaks: r.peaks, loudness: r.loudness, peaksPerSecond: PEAKS_PER_SECOND });
    } catch (e) { toast((e as Error).message, 'error'); } finally { setAnalysing(null); }
  };

  return (
    <Card title="Remove silences" where="device" desc="Cuts out pauses and dead air on the selected clip, then closes the gaps. Music on other tracks keeps playing.">
      {!media.hasAudio ? <p>This clip has no sound.</p> : !loud ? (
        analysing !== null ? <Progress value={analysing} label="Listening for pauses…" /> : <button className="btn" onClick={() => void analyse()}>Analyse audio</button>
      ) : (
        <>
          <PropRow label="Quieter than" value={thr} min={-60} max={-15} step={1} unit="dB" onChange={setThreshold} />
          <PropRow label="Pause longer" value={minSilence} min={0.2} max={3} step={0.05} unit="s" onChange={setMinSilence} />
          <PropRow label="Keep padding" value={padding} min={0} max={0.5} step={0.01} unit="s" onChange={setPadding} />
          <small className="faint">Found {ranges.length} pause{ranges.length === 1 ? '' : 's'} totalling {formatShort(totalLength(ranges))}.{threshold === null ? ' Threshold set automatically for this recording.' : ''}</small>
          <button className="btn primary" disabled={!ranges.length} onClick={() => { apply('Remove silences', (p) => cutRanges(p, linkedClips(p, clip.id), ranges)); toast(`Removed ${ranges.length} pauses (${formatShort(totalLength(ranges))}).`, 'success'); }}>
            <Icon name="split" size={15} />Remove {ranges.length} pause{ranges.length === 1 ? '' : 's'}
          </button>
        </>
      )}
    </Card>
  );
}

function RemoveFillers() {
  const { clip, media } = useSelectedClip(VIDEO_AUDIO);
  const { apply, toast } = useApp();
  const [busy, setBusy] = useState<{ p: number; label: string } | null>(null);
  const [extra, setExtra] = useState('');
  const avail = transcriptionAvailable();
  const fillers = useMemo(() => {
    if (!clip || !media?.transcript) return [];
    return findFillers(timelineWords(clip, media.transcript.words), extra.split(',').map((x) => x.trim()).filter(Boolean));
  }, [clip, media, extra]);
  if (!clip || !media) return <Card title="Remove filler words" where="download" desc="Finds “um”, “uh”, “erm” and cuts them out."><NeedClip what="a clip with speech" /></Card>;
  const counts = fillers.reduce<Record<string, number>>((a, w) => { const k = w.text.toLowerCase().replace(/[^\p{L}']/gu, ''); a[k] = (a[k] ?? 0) + 1; return a; }, {});
  return (
    <Card title="Remove filler words" where="download" desc="Finds “um”, “uh”, “erm” (and any words you add) in the selected clip and cuts them out.">
      {!avail.ok ? <p style={{ color: 'var(--accent)' }}>{avail.reason}</p> : !media.transcript ? (
        busy ? <Progress value={busy.p} label={busy.label} /> : (
          <button className="btn" onClick={async () => {
            try { await ensureTranscript(media, prefs.get('asrModel', ASR_MODELS[0].id), null, (p, label) => setBusy({ p, label })); } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(null); }
          }}>Transcribe this clip</button>
        )
      ) : (
        <>
          {!media.transcript.wordLevel && <small style={{ color: 'var(--accent)' }}>This model gave phrase timings only, so cut points are estimates.</small>}
          <input className="input" placeholder="Also remove… (e.g. like, you know)" value={extra} onChange={(e) => setExtra(e.target.value)} aria-label="Extra words to remove" />
          <small className="faint">{fillers.length ? Object.entries(counts).map(([k, v]) => `${k} ×${v}`).join(' · ') : 'No filler words found in this clip.'}</small>
          <button className="btn primary" disabled={!fillers.length} onClick={() => {
            const ranges: Range[] = fillers.map((w) => [w.start - 0.03, w.end + 0.03]);
            apply('Remove filler words', (p) => cutRanges(p, linkedClips(p, clip.id), ranges));
            toast(`Removed ${fillers.length} filler word${fillers.length === 1 ? '' : 's'}.`, 'success');
          }}>Remove {fillers.length} filler{fillers.length === 1 ? '' : 's'}</button>
        </>
      )}
    </Card>
  );
}

function SceneDetect() {
  const { clip, media } = useSelectedClip(VIDEO);
  const { apply, toast } = useApp();
  const [sens, setSens] = useState(0.5);
  const [busy, setBusy] = useState<number | null>(null);
  const [data, setData] = useState<{ mediaId: string; diffs: number[]; times: number[] } | null>(null);
  const cuts = useMemo(() => {
    if (!clip || !data || data.mediaId !== clip.mediaId) return [];
    return detectScenes(data.diffs, data.times, sens)
      .filter((s) => s > clip.sourceIn + 0.1 && s < clip.sourceIn + clip.duration * clip.speed - 0.1)
      .map((s) => clip.start + (s - clip.sourceIn) / clip.speed);
  }, [clip, data, sens]);
  if (!clip || !media) return <Card title="Scene detection" where="device" desc="Finds the camera cuts inside a recording."><NeedClip what="a video clip" /></Card>;
  const run = async () => {
    setBusy(0);
    try {
      const r = await analyseVideo(media.id, { perSecond: 10 }, setBusy);
      setData({ mediaId: media.id, diffs: r.diffs, times: r.times });
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(null); }
  };
  return (
    <Card title="Scene detection" where="device" desc="Finds the camera cuts inside the selected video so you can split it into shots.">
      {busy !== null ? <Progress value={busy} label="Watching for scene changes…" /> : !data || data.mediaId !== media.id ? (
        <button className="btn" onClick={() => void run()}>Find scenes</button>
      ) : (
        <>
          <PropRow label="Sensitivity" value={sens} min={0} max={1} step={0.05} display={100} unit="%" onChange={setSens} />
          <small className="faint">{cuts.length} scene change{cuts.length === 1 ? '' : 's'} found.</small>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button className="btn sm" disabled={!cuts.length} onClick={() => apply('Scene markers', (p) => ({ ...p, markers: [...p.markers, ...cuts.map((t, i) => ({ id: uid('mk'), time: t, label: `Scene ${i + 2}`, color: '#3cf0ff' }))].sort((a, b) => a.time - b.time) }))}><Icon name="marker" size={13} />Add markers</button>
            <button className="btn sm primary" disabled={!cuts.length} onClick={() => apply('Split at scenes', (p) => {
              let proj = p; let id = clip.id;
              for (const t of cuts) { const r = splitClip(proj, id, t); if (r) { proj = r.project; id = r.rightId; } }
              return proj;
            })}><Icon name="split" size={13} />Split into {cuts.length + 1} shots</button>
          </div>
        </>
      )}
    </Card>
  );
}

function Highlights() {
  const { clip, media } = useSelectedClip(VIDEO_AUDIO);
  const { apply, toast } = useApp();
  const [length, setLength] = useState('30');
  const [busy, setBusy] = useState<number | null>(null);
  const [results, setResults] = useState<{ clipId: string; list: Highlight[] } | null>(null);
  if (!clip || !media) return <Card title="Highlight finder" where="device" desc="Suggests the most exciting parts of a long recording."><NeedClip what="a long video or audio clip" /></Card>;
  const run = async () => {
    setBusy(0);
    try {
      const s0 = clip.sourceIn, s1 = clip.sourceIn + clip.duration * clip.speed;
      const video = media.kind === 'video' ? await analyseVideo(media.id, { perSecond: 4 }, setBusy).catch(() => null) : null;
      const pps = media.peaksPerSecond ?? PEAKS_PER_SECOND;
      const loud = media.loudness?.slice(Math.floor(s0 * pps), Math.ceil(s1 * pps));
      const list = suggestHighlights({
        duration: s1 - s0, length: +length, count: 3,
        loudness: loud, perSecond: pps,
        diffs: video?.diffs.filter((_, i) => video.times[i] >= s0 && video.times[i] < s1),
        times: video?.times.filter((t) => t >= s0 && t < s1).map((t) => t - s0),
      }).map((h) => ({ ...h, start: clip.start + h.start / clip.speed, end: clip.start + h.end / clip.speed }));
      setResults({ clipId: clip.id, list });
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(null); }
  };
  const list = results?.clipId === clip.id ? results.list : null;
  return (
    <Card title="Highlight finder" where="device" desc="Scores loud, energetic audio and busy on-screen action to suggest the best moments — great for cutting Shorts from long gaming sessions.">
      <div className="field"><span>Highlight length</span>
        <Seg label="Highlight length" value={length} onChange={(v) => { setLength(v); setResults(null); }} options={[{ value: '15', label: '15s' }, { value: '30', label: '30s' }, { value: '60', label: '60s' }]} />
      </div>
      {busy !== null ? <Progress value={busy} label="Scanning the recording…" /> : <button className="btn" onClick={() => void run()}>Find highlights</button>}
      {list && (
        <div className="result-list">
          {list.map((h, i) => (
            <div key={i} className="result-row">
              <span><b>{formatShort(h.start)}–{formatShort(h.end)}</b> <span className="faint">{h.reason}</span></span>
              <button className="icon-btn sm" onClick={() => seek(h.start)} title="Jump there" aria-label="Jump to highlight"><Icon name="play" size={12} /></button>
              <button className="btn sm" onClick={() => apply('Keep highlight', (p) => trimEnd(trimStart(p, clip.id, h.start), clip.id, h.end))} title="Trim the clip to just this part">Keep only this</button>
            </div>
          ))}
          <button className="btn sm" onClick={() => apply('Highlight markers', (p) => ({ ...p, markers: [...p.markers, ...list.map((h, i) => ({ id: uid('mk'), time: h.start, label: `Highlight ${i + 1}`, color: '#ff3fd1' }))].sort((a, b) => a.time - b.time) }))}>
            <Icon name="marker" size={13} />Mark all
          </button>
        </div>
      )}
    </Card>
  );
}

function AutoReframe() {
  const { clip, media } = useSelectedClip(VIDEO);
  const project = useApp((s) => s.project)!;
  const { apply, toast } = useApp();
  const [mode, setMode] = useState<'action' | 'faces'>('action');
  const [smooth, setSmooth] = useState(0.85);
  const [busy, setBusy] = useState<number | null>(null);
  if (!clip || !media) return <Card title="Auto-reframe" where="device" desc="Keeps the subject in shot when changing shape (e.g. 16:9 → 9:16)."><NeedClip what="a video clip" /></Card>;
  const aspectDiff = media.width && media.height ? Math.abs(media.width / media.height - project.settings.width / project.settings.height) > 0.05 : false;
  const run = async () => {
    setBusy(0);
    try {
      const s0 = clip.sourceIn, s1 = clip.sourceIn + clip.duration * clip.speed;
      let times: number[], xs: number[], ys: number[] | null = null;
      if (mode === 'faces') {
        const r = await faceTrack(media.id, s0, s1, 4, setBusy);
        if (!r.found) { toast('No faces found — try “Follow the action”.'); return; }
        times = r.times; xs = r.xs; ys = r.ys;
      } else {
        const r = await analyseVideo(media.id, { perSecond: 6, start: s0, end: s1 }, setBusy);
        times = r.times; xs = r.motionX;
        if (!xs.some((x) => x >= 0)) { toast('Not enough movement to follow in this clip.'); return; }
      }
      apply('Auto-reframe', (p) => applyReframe(p, clip.id, times, xs, ys, smooth));
      toast('Reframed. Fine-tune the pan with the Position X keyframes.', 'success');
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(null); }
  };
  return (
    <Card title="Auto-reframe" where="device" desc="Fills the frame and pans with keyframes so the subject stays in shot — ideal for turning landscape gameplay or camera footage into vertical Shorts.">
      {!aspectDiff && <small style={{ color: 'var(--accent)' }}>This clip already matches the project shape, so there’s nothing to pan across.</small>}
      {bundledModelsAvailable().ok && <Seg label="Follow" value={mode} onChange={setMode} options={[{ value: 'action', label: 'Follow the action' }, { value: 'faces', label: 'Follow faces' }]} />}
      <PropRow label="Smoothness" value={smooth} min={0.5} max={0.97} step={0.01} display={100} unit="%" onChange={setSmooth} />
      {busy !== null ? <Progress value={busy} label={mode === 'faces' ? 'Looking for faces…' : 'Following the action…'} /> : <button className="btn primary" disabled={!aspectDiff} onClick={() => void run()}><Icon name="fit" size={15} />Reframe</button>}
    </Card>
  );
}

function TrackAttach() {
  const { clip: overlay } = useSelectedClip(OVERLAY);
  const project = useApp((s) => s.project)!;
  const { apply, toast, setPickMode } = useApp();
  const [boxSize, setBoxSize] = useState(0.1);
  const [busy, setBusy] = useState<number | null>(null);
  // The footage to follow: a video on a lower track under the overlay.
  const base = useMemo(() => {
    if (!overlay) return null;
    const oi = project.tracks.findIndex((t) => t.clips.some((c) => c.id === overlay.id));
    for (let i = project.tracks.length - 1; i > oi; i--) {
      const c = project.tracks[i].clips.find((x) => x.kind === 'video' && x.start < clipEnd(overlay) && clipEnd(x) > overlay.start);
      if (c) return c;
    }
    return null;
  }, [overlay, project]);
  if (!overlay) return <Card title="Motion tracking" where="device" desc="Make text, a sticker or an image follow something in your video."><NeedClip what="the text, image or overlay you want to follow something" /></Card>;
  const start = () => {
    if (!base) { toast('Put the overlay on a track above the video it should follow.'); return; }
    seek(Math.max(overlay.start, base.start) + 0.01);
    setPickMode({
      clipId: base.id,
      label: 'Click the thing to follow',
      onPick: async (u, v) => {
        const media = project.media.find((m) => m.id === base.mediaId)!;
        const aspect = (media.width ?? 16) / (media.height ?? 9);
        const t0 = Math.max(overlay.start, base.start), t1 = Math.min(clipEnd(overlay), clipEnd(base));
        const s0 = base.sourceIn + (t0 - base.start) * base.speed, s1 = base.sourceIn + (t1 - base.start) * base.speed;
        setBusy(0);
        try {
          const r = await trackPoint(media.id, s0, s1, { x: u, y: v, w: boxSize, h: boxSize * aspect }, setBusy);
          const lost = r.confidence.filter((c) => c < 0.35).length;
          apply('Track motion', (p) => attachToTrack(p, base.id, overlay.id, r.times, r.points));
          toast(lost > r.confidence.length * 0.3 ? 'Tracked, but the target was hard to follow in places — check the keyframes.' : 'Tracked! The overlay now follows it.', lost > r.confidence.length * 0.3 ? 'info' : 'success');
        } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(null); }
      },
    });
  };
  return (
    <Card title="Motion tracking" where="device" desc="Makes the selected text, image or sticker follow something moving in the video underneath (e.g. a character, a ball, a card).">
      <small className="faint">{base ? `Following footage: ${base.name}` : 'No video under this overlay yet.'}</small>
      <PropRow label="Target size" value={boxSize} min={0.03} max={0.3} step={0.01} display={100} unit="% of width" onChange={setBoxSize} />
      {busy !== null ? <Progress value={busy} label="Tracking…" /> : <button className="btn primary" disabled={!base} onClick={start}><Icon name="ai" size={15} />Pick what to follow</button>}
      <p className="faint" style={{ fontSize: 11 }}>Face tracking uses the same tool: click on the face.</p>
    </Card>
  );
}

function TrackedBlur() {
  const { clip, media } = useSelectedClip(VIDEO);
  const { apply, toast, setPickMode, select } = useApp();
  const [kind, setKind] = useState<'blur' | 'pixelate'>('blur');
  const [size, setSize] = useState(0.14);
  const [busy, setBusy] = useState<number | null>(null);
  const desc = 'Hide a face, name tag, screen or number plate — the blur follows it as it moves.';
  if (!clip || !media) return <Card title="Tracked blur" where="device" desc={desc}><NeedClip what="the video clip" /></Card>;
  const start = () => {
    if (clip.reverse) { toast('Turn off Reverse on this clip first.'); return; }
    const now = useTime.getState().time;
    if (now < clip.start || now >= clipEnd(clip)) seek(clip.start + 0.01);
    setPickMode({
      clipId: clip.id,
      label: 'Click what to hide',
      onPick: async (u, v) => {
        const aspect = (media.width ?? 16) / (media.height ?? 9);
        const s0 = clip.sourceIn, s1 = clip.sourceIn + clip.duration * clip.speed;
        setBusy(0);
        try {
          const tStart = clip.sourceIn + (Math.max(clip.start, useTime.getState().time) - clip.start) * clip.speed;
          // Track forwards from the picked moment and backwards to the clip start.
          const fwd = await trackPoint(media.id, tStart, s1, { x: u, y: v, w: size * 0.8, h: size * 0.8 * aspect }, (x) => setBusy(tStart > s0 + 0.1 ? x * 0.6 : x));
          let times = fwd.times, points = fwd.points;
          if (tStart > s0 + 0.1) {
            // Backwards from the picked frame to the start of the clip, then join the two runs.
            const back = await trackPoint(media.id, tStart, s0, { x: u, y: v, w: size * 0.8, h: size * 0.8 * aspect }, (x) => setBusy(0.6 + x * 0.4));
            const bt = back.times.slice(1).reverse(), bp = back.points.slice(1).reverse();
            times = [...bt, ...times]; points = [...bp, ...points];
          }
          let newId: string | null = null;
          apply(kind === 'blur' ? 'Tracked blur' : 'Tracked pixelate', (p) => {
            const r = trackedBlur(p, clip.id, times, points, { kind, size, amount: kind === 'blur' ? 18 : 16 });
            newId = r?.clipId ?? null;
            return r?.project;
          });
          if (newId) { select([newId]); toast('Done. Fine-tune the size, strength or path in the Cutout and Effects tabs.', 'success'); }
          else toast('Couldn’t follow that — try clicking a more distinct spot.', 'error');
        } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(null); }
      },
    });
  };
  return (
    <Card title="Tracked blur" where="device" desc={desc}>
      <Seg label="Style" value={kind} onChange={setKind} options={[{ value: 'blur', label: 'Blur' }, { value: 'pixelate', label: 'Pixelate' }]} />
      <PropRow label="Size" value={size} min={0.04} max={0.5} step={0.01} display={100} unit="% of width" onChange={setSize} />
      {busy !== null ? <Progress value={busy} label="Following…" /> : <button className="btn primary" onClick={start}><Icon name="eyeOff" size={15} />Pick what to hide</button>}
      <p className="faint" style={{ fontSize: 11 }}>Tip: pause where the thing is clearly visible before picking. Face detection runs on-device; nothing is uploaded.</p>
    </Card>
  );
}

function RemoveBackground() {
  const { clip } = useSelectedClip(VISUAL_MEDIA);
  const player = useApp((s) => s.player);
  const { apply } = useApp();
  const [, force] = useState(0);
  useEffect(() => player?.onState(() => force((n) => n + 1)), [player]);
  const models = bundledModelsAvailable();
  if (!models.ok) return <Card title="Remove background" where="device" desc="Cuts people out of their background."><p style={{ color: 'var(--accent)' }}>{models.reason}</p></Card>;
  if (!clip) return <Card title="Remove background" where="device" desc="Cuts people out of their background."><NeedClip what="a video or photo of a person" /></Card>;
  const fx = clip.effects.find((e) => e.type === 'bgRemove');
  return (
    <Card title="Remove background" where="device" desc="Cuts people out of their background with a model built into the app, so tracks underneath show through. Works best on one or two people.">
      {player?.maskError && <small style={{ color: 'var(--danger)' }}>{player.maskError}</small>}
      {fx ? (
        <div className="row">
          <span className="grow" style={{ fontSize: 12 }}>On. Adjust edge softness in the Effects tab.</span>
          <button className="btn sm" onClick={() => apply('Keep background', (p) => updateClip(p, clip.id, (c) => ({ ...c, effects: c.effects.filter((e) => e.type !== 'bgRemove') })))}>Turn off</button>
        </div>
      ) : (
        <button className="btn primary" onClick={() => apply('Remove background', (p) => updateClip(p, clip.id, (c) => ({ ...c, effects: [createEffect('bgRemove'), ...c.effects] })))}><Icon name="image" size={15} />Remove background</button>
      )}
      <p className="faint" style={{ fontSize: 11 }}>The preview may lag a frame behind while playing; exports are exact.</p>
    </Card>
  );
}

function GenerateImage() {
  const project = useApp((s) => s.project)!;
  const { importFiles, toast } = useApp();
  const [settings, setSettings] = useState<GenSettings>(prefs.get('genSettings', { provider: 'automatic1111', url: 'http://127.0.0.1:7860' }));
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const embedded = inArtifactHost();
  const save = (s: GenSettings) => { setSettings(s); prefs.set('genSettings', s); };
  const run = async () => {
    if (!prompt.trim()) return;
    setBusy(true);
    abort.current = new AbortController();
    try {
      const blob = await generateImage(settings, prompt, Math.min(1024, project.settings.width), Math.min(1024, project.settings.height), abort.current.signal);
      const file = new File([blob], `${prompt.slice(0, 30).replace(/[^\w ]+/g, '').trim() || 'generated'}.png`, { type: 'image/png' });
      await importFiles([file], useTime.getState().time);
    } catch (e) {
      toast((e as Error).name === 'AbortError' ? 'Cancelled.' : `${(e as Error).message} Is the server running with CORS allowed for this app?`, 'error');
    } finally { setBusy(false); }
  };
  return (
    <Card title="Generate an image" where="server" desc="Uses an image model you run yourself (e.g. Stable Diffusion WebUI on your PC). Only the prompt is sent, and only to the address below.">
      {embedded ? <p style={{ color: 'var(--accent)' }}>This view can’t reach other addresses. Use the installed app to connect your own image server.</p> : (
        <>
          <div className="grid2">
            <label className="field"><span>Server type</span>
              <select className="input" value={settings.provider} onChange={(e) => save({ ...settings, provider: e.target.value as GenSettings['provider'] })}>
                <option value="automatic1111">Stable Diffusion WebUI (A1111 / Forge)</option>
                <option value="openai-compatible">OpenAI-compatible (LocalAI etc.)</option>
              </select>
            </label>
            <label className="field"><span>Address</span><input className="input mono" value={settings.url} onChange={(e) => save({ ...settings, url: e.target.value })} /></label>
          </div>
          <textarea className="input" rows={2} placeholder="A glowing booster pack on a desk, cinematic lighting" value={prompt} onChange={(e) => setPrompt(e.target.value)} aria-label="Image prompt" />
          {busy ? <button className="btn" onClick={() => abort.current?.abort()}>Cancel</button> : <button className="btn primary" disabled={!prompt.trim()} onClick={() => void run()}><Icon name="image" size={15} />Generate and add</button>}
          <p className="faint" style={{ fontSize: 11 }}>A1111: start it with <code>--api --cors-allow-origins=*</code>. Video generation from local models is planned; the app has a slot ready for it.</p>
        </>
      )}
    </Card>
  );
}

export function AiPanel() {
  return (
    <>
      <p className="faint" style={{ margin: 0, fontSize: 12 }}>
        Every tool says where it runs. Nothing you import is ever uploaded; tools marked “one-time model download” fetch a model file once and then work offline.
      </p>
      <AutoCaptions />
      <RemoveSilence />
      <RemoveFillers />
      <Highlights />
      <SceneDetect />
      <AutoReframe />
      <TrackAttach />
      <TrackedBlur />
      <RemoveBackground />
      <GenerateImage />
    </>
  );
}

