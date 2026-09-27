import { useEffect, useMemo, useRef, useState } from 'react';
import type { VideoCodec } from 'mediabunny';
import { projectDuration } from '../core/timeline';
import { formatShort } from '../core/time';
import {
  autoBitrate, exportProject, ExportCancelled, RESOLUTION_PRESETS, sizeForShortSide, supportedVideoCodecs,
  type ExportFormat, type ExportProgress, type ExportResult, type ExportSettings,
} from '../engine/exporter';
import { canSaveExtension, saveFile } from '../platform/download';
import { usePublish } from './publisher/pubStore';
import { videoInfo } from './publisher/videoInfo';
import { cleanupExportTemp } from '../platform/exportSink';
import { nativeBridge, shellKind } from '../platform/native';
import { keepAwake } from '../platform/wakeLock';
import { slotsOf } from '../core/templates';
import { prefs } from '../storage/db';
import { Dialog, Seg } from './components/Controls';
import { Icon } from './components/Icon';
import { useApp, useTime } from './store';

const FORMATS: { value: ExportFormat; label: string; kind: 'video' | 'audio' | 'image' }[] = [
  { value: 'mp4', label: 'MP4', kind: 'video' }, { value: 'webm', label: 'WebM', kind: 'video' }, { value: 'mov', label: 'MOV', kind: 'video' },
  { value: 'gif', label: 'GIF', kind: 'video' }, { value: 'wav', label: 'WAV', kind: 'audio' }, { value: 'mp3', label: 'MP3', kind: 'audio' },
  { value: 'png', label: 'PNG frame', kind: 'image' }, { value: 'jpeg', label: 'JPEG frame', kind: 'image' },
];
const CODEC_LABEL: Record<string, string> = { avc: 'H.264', hevc: 'H.265 / HEVC', vp9: 'VP9', av1: 'AV1', vp8: 'VP8' };

function mb(n: number) { return n > 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`; }

export function ExportDialog() {
  const project = useApp((s) => s.project)!;
  const setOpen = useApp((s) => s.setExportOpen);
  const toast = useApp((s) => s.toast);
  const duration = projectDuration(project);
  const saved = prefs.get<Partial<ExportSettings> & { short?: number }>('export', {});
  const [format, setFormat] = useState<ExportFormat>(saved.format ?? 'mp4');
  const [short, setShort] = useState<number>(saved.short ?? Math.min(project.settings.width, project.settings.height));
  const [fps, setFps] = useState(project.settings.fps);
  const [quality, setQuality] = useState<ExportSettings['quality']>(saved.quality ?? 'high');
  const [customBitrate, setCustomBitrate] = useState<number>(0);
  const [codec, setCodec] = useState<VideoCodec>('avc');
  const [codecs, setCodecs] = useState<VideoCodec[] | null>(null);
  const [audioBitrate, setAudioBitrate] = useState(saved.audioBitrate ?? 192000);
  const [sampleRate, setSampleRate] = useState<44100 | 48000>(saved.sampleRate ?? 48000);
  const [hardware, setHardware] = useState<ExportSettings['hardware']>(saved.hardware ?? 'no-preference');
  const [includeAudio, setIncludeAudio] = useState(true);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const kind = FORMATS.find((f) => f.value === format)!.kind;
  const size = useMemo(() => sizeForShortSide(project, short), [project, short]);
  const isStill = kind === 'image';
  const ext = format === 'jpeg' ? 'jpg' : format;

  useEffect(() => {
    if (kind !== 'video' || format === 'gif') return;
    let live = true;
    setCodecs(null);
    void supportedVideoCodecs(format, size.width, size.height).then((list) => {
      if (!live) return;
      setCodecs(list);
      if (list.length) setCodec((c) => (list.includes(c) ? c : list[0]));
    });
    return () => { live = false; };
  }, [format, size.width, size.height, kind]);

  useEffect(() => () => { if (resultUrl?.startsWith('blob:')) URL.revokeObjectURL(resultUrl); }, [resultUrl]);
  // Streamed exports sit in the browser's private disk area; tidy up older ones.
  // (Only when a new export dialog opens, so a download still reading the last file isn't cut short.)
  useEffect(() => { void cleanupExportTemp(0); }, []);

  const bitrate = customBitrate || autoBitrate(size.width, size.height, fps, quality, codec);
  const estBytes = kind === 'video' && format !== 'gif' ? ((bitrate + (includeAudio ? audioBitrate : 0)) / 8) * duration : null;

  const start = async () => {
    setError(null); setResult(null);
    const settings: ExportSettings = {
      format, width: size.width, height: size.height, fps, videoCodec: codec, videoBitrate: customBitrate, quality,
      audioBitrate, sampleRate, hardware, range: null, stillTime: useTime.getState().time, includeAudio,
    };
    prefs.set('export', { format, short, quality, audioBitrate, sampleRate, hardware });
    abort.current = new AbortController();
    setProgress({ phase: 'preparing', fraction: 0 });
    void keepAwake(true);
    try {
      const r = await exportProject(project, settings, setProgress, abort.current.signal);
      setResult(r);
      setResultUrl(r.native ? r.native.url : URL.createObjectURL(r.blob));
    } catch (e) {
      if (e instanceof ExportCancelled) setError(null);
      else setError((e as Error).message || 'Export failed.');
      console.error(e);
    } finally {
      void keepAwake(false);
      setProgress(null);
      abort.current = null;
    }
  };

  const save = async () => {
    if (!result) return;
    try {
      const native = nativeBridge();
      if (result.native && native?.saveExport) {
        const o = await native.saveExport(result.native.token, result.filename);
        if (o === 'saved') toast(`Saved ${result.filename}`, 'success');
        return;
      }
      if (native?.shareFile && (native.shell === 'ios' || native.shell === 'android')) {
        const o = await native.shareFile(result.blob, result.filename);
        if (o === 'shared') toast('Shared.', 'success');
        return;
      }
      const outcome = await saveFile(result.filename, result.blob);
      if (outcome === 'saved') toast(`Saved ${result.filename}`, 'success');
      else if (outcome === 'unavailable') toast('Saving files isn’t available in this view. Open Framewright in its own tab to download.', 'error');
    } catch (e) { toast((e as Error).message, 'error'); }
  };

  const busy = !!progress;
  // Hand the finished video to the post planner.
  const postIt = async () => {
    if (!result) return;
    const blob = result.native ? await (await fetch(result.native.url)).blob() : result.blob;
    const typed = blob.type ? blob : new Blob([blob], { type: 'video/mp4' });
    const info = await videoInfo(typed);
    setOpen(false);
    await usePublish.getState().compose({ blob: typed, name: result.filename, duration: info.duration, width: info.width, height: info.height, thumbnail: info.thumbnail, projectName: project.name });
  };
  const isPhone = shellKind() === 'ios' || shellKind() === 'android';
  const close = () => { abort.current?.abort(); setOpen(false); };

  return (
    <Dialog title="Export" onClose={close} wide footer={
      busy ? <button className="btn" onClick={() => abort.current?.abort()}>Cancel export</button>
        : result ? <>
          <button className="btn" onClick={() => { setResult(null); setResultUrl(null); }}>Change settings</button>
          {kind === 'video' && /mp4|quicktime/.test(result.blob.type || result.filename) && <button className="btn" onClick={() => void postIt()}><Icon name="history" size={16} />Post or schedule</button>}
          <button className="btn primary" onClick={save}><Icon name="save" size={16} />{isPhone ? `Save or share ${result.filename}` : `Save ${result.filename}`}</button>
        </>
        : <>
          <span className="faint" style={{ marginRight: 'auto', fontSize: 12, alignSelf: 'center' }}>
            <Icon name="device" size={13} style={{ verticalAlign: '-2px' }} /> Rendered on this device. No watermark.
          </span>
          <button className="btn" onClick={close}>Close</button>
          <button className="btn primary" onClick={start} disabled={(duration === 0 && !isStill) || (kind === 'video' && format !== 'gif' && codecs !== null && codecs.length === 0)}>
            <Icon name="export" size={16} />Export {isStill ? 'frame' : formatShort(duration)}
          </button>
        </>
    }>
      {busy && progress && (
        <div className="section" aria-live="polite">
          <div className="row"><b className="grow">{progress.phase === 'preparing' ? 'Preparing…' : progress.phase === 'finalising' ? 'Finishing file…' : progress.phase === 'audio' ? 'Mixing audio…' : `Rendering frame ${progress.framesDone ?? 0} of ${progress.framesTotal ?? '…'}`}</b>
            <span className="mono muted">{Math.round(progress.fraction * 100)}%{progress.etaSeconds ? ` · ${formatShort(progress.etaSeconds)} left` : ''}</span></div>
          <div className="bigbar"><i style={{ width: `${progress.fraction * 100}%` }} /></div>
          <small className="faint">You can keep this tab in the background. Very long or 4K exports can take a while on phones.</small>
        </div>
      )}
      {error && <div className="notice"><Icon name="warning" size={18} /><div>{error}</div></div>}
      {result && resultUrl && (
        <div className="export-done section">
          {kind === 'video' && format !== 'gif' && <video src={resultUrl} controls playsInline />}
          {(format === 'gif' || isStill) && <img src={resultUrl} alt="Export preview" />}
          {kind === 'audio' && <audio src={resultUrl} controls style={{ width: '100%' }} />}
          <div className="mono muted" style={{ fontSize: 12, textAlign: 'center' }}>{result.filename} · {mb(result.size)} · took {formatShort(result.seconds)}{result.via === 'disk' ? ' · streamed to disk' : ''}</div>
          {!canSaveExtension(ext) && <div className="notice"><Icon name="info" size={16} /><div>This view can only save MP4, WebM, GIF, PNG and JPEG files. Open Framewright in its own browser tab (or the desktop build) to save .{ext} files.</div></div>}
        </div>
      )}
      {!busy && !result && (
        <>
          {slotsOf(project).length > 0 && <div className="notice"><Icon name="warning" size={16} /><div>{slotsOf(project).length} template slot{slotsOf(project).length > 1 ? 's are' : ' is'} still empty — {slotsOf(project).length > 1 ? 'they' : 'it'} will export as blank. Fill them from the Templates panel.</div></div>}
          <div className="field"><span>Format</span>
            <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
              {FORMATS.map((f) => <button key={f.value} className={`chip${format === f.value ? ' on' : ''}`} onClick={() => setFormat(f.value)}>{f.label}</button>)}
            </div>
          </div>
          {kind !== 'audio' && (
            <div className="export-grid">
              <label className="field"><span>Resolution</span>
                <select className="input" value={short} onChange={(e) => setShort(+e.target.value)}>
                  {RESOLUTION_PRESETS.map((r) => <option key={r.short} value={r.short}>{r.label} ({sizeForShortSide(project, r.short).width}×{sizeForShortSide(project, r.short).height})</option>)}
                  {!RESOLUTION_PRESETS.some((r) => r.short === Math.min(project.settings.width, project.settings.height)) && (
                    <option value={Math.min(project.settings.width, project.settings.height)}>Project ({project.settings.width}×{project.settings.height})</option>
                  )}
                </select>
              </label>
              {!isStill && (
                <label className="field"><span>Frame rate</span>
                  <select className="input" value={fps} onChange={(e) => setFps(+e.target.value)}>
                    {[24, 25, 30, 50, 60].concat(project.settings.fps).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b).map((f) => <option key={f} value={f}>{f} fps{format === 'gif' && f > 15 ? ' (GIF uses 15)' : ''}</option>)}
                  </select>
                </label>
              )}
              {kind === 'video' && format !== 'gif' && (
                <label className="field"><span>Video codec</span>
                  <select className="input" value={codec} onChange={(e) => setCodec(e.target.value as VideoCodec)} disabled={!codecs}>
                    {!codecs && <option>Checking this device…</option>}
                    {codecs?.map((c) => <option key={c} value={c}>{CODEC_LABEL[c] ?? c}</option>)}
                  </select>
                </label>
              )}
            </div>
          )}
          {kind === 'video' && format !== 'gif' && (
            <>
              <div className="export-grid">
                <div className="field"><span>Quality</span>
                  <Seg label="Quality" value={quality} onChange={(q) => { setQuality(q); setCustomBitrate(0); }} options={[{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Med' }, { value: 'high', label: 'High' }, { value: 'max', label: 'Max' }]} />
                </div>
                <label className="field"><span>Video bitrate (Mbps)</span>
                  <input className="input mono" type="number" min={0.2} max={200} step={0.5} value={+(bitrate / 1e6).toFixed(1)} onChange={(e) => setCustomBitrate(Math.max(0.2, +e.target.value) * 1e6)} />
                </label>
                <label className="field"><span>Hardware encoding</span>
                  <select className="input" value={hardware} onChange={(e) => setHardware(e.target.value as ExportSettings['hardware'])}>
                    <option value="no-preference">Automatic</option><option value="prefer-hardware">Prefer GPU (faster)</option><option value="prefer-software">Prefer CPU (compatible)</option>
                  </select>
                </label>
              </div>
            </>
          )}
          {(kind === 'audio' || (kind === 'video' && format !== 'gif')) && (
            <div className="export-grid">
              {kind === 'video' && <label className="row" style={{ alignSelf: 'end', height: 32 }}><input type="checkbox" checked={includeAudio} onChange={() => setIncludeAudio(!includeAudio)} /> Include audio</label>}
              {format !== 'wav' && (
                <label className="field"><span>Audio bitrate</span>
                  <select className="input" value={audioBitrate} onChange={(e) => setAudioBitrate(+e.target.value)}>
                    {[96000, 128000, 192000, 256000, 320000].map((b) => <option key={b} value={b}>{b / 1000} kbps</option>)}
                  </select>
                </label>
              )}
              <label className="field"><span>Sample rate</span>
                <select className="input" value={sampleRate} onChange={(e) => setSampleRate(+e.target.value as 44100 | 48000)}>
                  <option value={48000}>48 kHz</option><option value={44100}>44.1 kHz</option>
                </select>
              </label>
            </div>
          )}
          <div className="muted mono" style={{ fontSize: 12 }}>
            {isStill ? `Current frame at ${formatShort(useTime.getState().time)} · ${size.width}×${size.height}` :
              `${formatShort(duration)} · ${kind === 'audio' ? `${sampleRate / 1000} kHz` : `${size.width}×${size.height} @ ${fps} fps`}${estBytes ? ` · about ${mb(estBytes)}` : ''}`}
          </div>
          {kind === 'video' && format !== 'gif' && codecs?.length === 0 && (
            <div className="notice"><Icon name="warning" size={16} /><div>This browser can’t encode {format.toUpperCase()} video at this size. Try another format or a lower resolution.</div></div>
          )}
        </>
      )}
    </Dialog>
  );
}
