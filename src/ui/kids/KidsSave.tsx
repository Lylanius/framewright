/**
 * "Save video": makes the finished MP4 on this device with sensible settings
 * (no choices to get wrong), then offers to put it in Photos.
 */
import { useEffect, useRef, useState } from 'react';
import { autoBitrate, ExportCancelled, exportProject, sizeForShortSide, supportedVideoCodecs, type ExportProgress, type ExportResult, type ExportSettings } from '../../engine/exporter';
import { saveFile } from '../../platform/download';
import { nativeBridge } from '../../platform/native';
import { keepAwake } from '../../platform/wakeLock';
import { useApp } from '../store';

async function settingsFor(): Promise<ExportSettings> {
  const project = useApp.getState().project!;
  const size = sizeForShortSide(project, Math.min(1080, project.settings.width, project.settings.height));
  let format: ExportSettings['format'] = 'mp4';
  let codecs = await supportedVideoCodecs('mp4', size.width, size.height);
  if (!codecs.length) { format = 'webm'; codecs = await supportedVideoCodecs('webm', size.width, size.height); }
  if (!codecs.length) throw new Error('This device can’t make videos here. Ask a grown-up to try the full editor.');
  const fps = project.settings.fps;
  return {
    format, width: size.width, height: size.height, fps, videoCodec: codecs[0], videoBitrate: autoBitrate(size.width, size.height, fps, 'high', codecs[0]),
    quality: 'high', audioBitrate: 192000, sampleRate: 48000, hardware: 'no-preference', range: null, includeAudio: true,
  };
}

export function KidsSave({ onClose }: { onClose: () => void }) {
  const [progress, setProgress] = useState<ExportProgress | null>({ phase: 'preparing', fraction: 0 });
  const [result, setResult] = useState<ExportResult | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const toast = useApp((s) => s.toast);

  useEffect(() => {
    let live = true;
    abort.current = new AbortController();
    void keepAwake(true);
    (async () => {
      try {
        const r = await exportProject(useApp.getState().project!, await settingsFor(), (p) => live && setProgress(p), abort.current!.signal);
        if (!live) return;
        setResult(r);
        setUrl(r.native ? r.native.url : URL.createObjectURL(r.blob));
      } catch (e) {
        if (live && !(e instanceof ExportCancelled)) setError((e as Error).message || 'Something went wrong making the video.');
      } finally {
        void keepAwake(false);
        if (live) setProgress(null);
      }
    })();
    return () => { live = false; abort.current?.abort(); };
  }, []);
  useEffect(() => () => { if (url?.startsWith('blob:')) URL.revokeObjectURL(url); }, [url]);

  // iPhone: the share sheet is how a web app puts a video in Photos ("Save Video").
  const photosFile = (() => {
    if (!result || result.native || !navigator.canShare) return null;
    const f = new File([result.blob], result.filename, { type: result.blob.type || 'video/mp4' });
    try { return navigator.canShare({ files: [f] }) && matchMedia('(pointer: coarse)').matches ? f : null; } catch { return null; }
  })();

  const save = async () => {
    if (!result) return;
    try {
      const native = nativeBridge();
      if (result.native && native?.saveExport) { if ((await native.saveExport(result.native.token, result.filename)) === 'saved') toast('Saved!', 'success'); return; }
      if (photosFile) {
        await navigator.share({ files: [photosFile] }).then(() => toast('Done! If you tapped “Save Video”, it’s in your Photos.', 'success'), (e: Error) => { if (e.name !== 'AbortError') throw e; });
        return;
      }
      if (native?.shareFile && (native.shell === 'ios' || native.shell === 'android')) { await native.shareFile(result.blob, result.filename); return; }
      const o = await saveFile(result.filename, result.blob);
      if (o === 'saved') toast('Saved!', 'success');
    } catch (e) { toast((e as Error).message, 'error'); }
  };

  const pct = Math.round((progress?.fraction ?? 0) * 100);
  return (
    <div className="k-save" role="dialog" aria-label="Save video">
      {error ? (
        <div className="k-save-card">
          <div className="k-save-emoji">🙈</div>
          <h2>That didn’t work</h2>
          <p>{error}</p>
          <button className="k-btn sun wide" onClick={onClose}>Back to my video</button>
        </div>
      ) : !result ? (
        <div className="k-save-card">
          <div className="k-save-emoji spin">🎬</div>
          <h2>Making your video…</h2>
          <div className="k-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><i style={{ width: `${pct}%` }} /></div>
          <p className="k-big-num">{pct}%</p>
          <p className="k-hint">Keep this screen open until it’s finished.</p>
          <button className="k-btn white" onClick={() => { abort.current?.abort(); onClose(); }}>Stop</button>
        </div>
      ) : (
        <div className="k-save-card done">
          <h2>Your video is ready! 🎉</h2>
          {url && <video className="k-result" src={url} controls playsInline loop />}
          <button className="k-btn sun wide big" onClick={() => void save()}>
            <span className="k-ico">📸</span>{photosFile ? 'Put it in my Photos' : nativeBridge() ? 'Save it' : 'Download it'}
          </button>
          {photosFile && <p className="k-hint">Then tap <b>Save Video</b>.</p>}
          <button className="k-btn white wide" onClick={onClose}>Back to my video</button>
        </div>
      )}
    </div>
  );
}
