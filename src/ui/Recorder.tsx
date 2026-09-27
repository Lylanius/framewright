/**
 * Record the screen, a camera or a voiceover straight into the project.
 * Everything is captured and saved on this device.
 */
import { useEffect, useRef, useState } from 'react';
import { createClipFromMedia } from '../core/defaults';
import { insertClipAuto } from '../core/timeline';
import { formatShort } from '../core/time';
import { levelMeter, listDevices, mixAudio, Recording, recordingSupported, screenSupported } from '../engine/recorder';
import { nativeBridge, type CaptureSource } from '../platform/native';
import { keepAwake } from '../platform/wakeLock';
import { Dialog, Seg } from './components/Controls';
import { Icon } from './components/Icon';
import { useApp, useTime } from './store';

type Mode = 'screen' | 'camera' | 'voice';
type Phase = 'setup' | 'countdown' | 'recording' | 'finishing';

const RES: Record<string, { width: number; height: number }> = { '720': { width: 1280, height: 720 }, '1080': { width: 1920, height: 1080 }, '2160': { width: 3840, height: 2160 } };

export function RecorderDialog() {
  const mode0 = useApp((s) => s.recorder)!;
  const { setRecorder, toast, importFiles, apply, player } = useApp();
  const [mode, setMode] = useState<Mode>(mode0 === 'screen' && !screenSupported() ? 'camera' : mode0);
  const [phase, setPhase] = useState<Phase>('setup');
  const [devices, setDevices] = useState<{ cams: MediaDeviceInfo[]; mics: MediaDeviceInfo[] }>({ cams: [], mics: [] });
  const [cam, setCam] = useState('');
  const [mic, setMic] = useState('');
  const [useMic, setUseMic] = useState(true);
  const [systemAudio, setSystemAudio] = useState(true);
  const [camBubble, setCamBubble] = useState(false);
  const [res, setRes] = useState('1080');
  const [fps, setFps] = useState('30');
  const [facing, setFacing] = useState<'user' | 'environment'>('user');
  const [playAlong, setPlayAlong] = useState(true);
  const [sources, setSources] = useState<CaptureSource[] | null>(null);
  const [source, setSource] = useState('');
  const [count, setCount] = useState(3);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [paused, setPaused] = useState(false);
  const [finish, setFinish] = useState(0);
  const [preview, setPreview] = useState<MediaStream | null>(null);
  const recs = useRef<{ main: Recording; cam?: Recording; startAt: number; cleanup: (() => void)[] } | null>(null);
  const native = nativeBridge();
  // The Linux desktop app can't capture computer sound (no loopback in Chromium there).
  const noSystemAudio = !!native && native.os.startsWith('linux');
  const support = recordingSupported();
  const phone = /Android|iPhone|iPad/i.test(navigator.userAgent);

  // Devices (labels appear once permission has been granted once).
  const refreshDevices = () => listDevices().then((d) => {
    setDevices(d);
    if (!cam && d.cams[0]) setCam(d.cams[0].deviceId);
    if (!mic && d.mics[0]) setMic(d.mics[0].deviceId);
  }).catch(() => undefined);
  useEffect(() => { void refreshDevices(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Desktop: list screens and windows for the picker.
  useEffect(() => {
    if (mode !== 'screen' || !native?.captureSources) return;
    let alive = true;
    native.captureSources().then((s) => { if (alive) { setSources(s); if (!source && s[0]) setSource(s[0].id); } }).catch(() => setSources([]));
    return () => { alive = false; };
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live camera preview in the setup screen.
  useEffect(() => {
    if (phase !== 'setup' || mode !== 'camera') return;
    let stream: MediaStream | null = null, alive = true;
    navigator.mediaDevices.getUserMedia({ video: videoConstraints(), audio: false })
      .then((s) => { if (!alive) { s.getTracks().forEach((t) => t.stop()); return; } stream = s; setPreview(s); void refreshDevices(); })
      .catch((e: Error) => toast(permissionMessage(e, 'camera'), 'error'));
    return () => { alive = false; const st = stream; st?.getTracks().forEach((t) => t.stop()); setPreview((p) => (p === st ? null : p)); };
  }, [phase, mode, cam, res, fps, facing]); // eslint-disable-line react-hooks/exhaustive-deps
  const previewRef = (el: HTMLVideoElement | null) => { if (el && el.srcObject !== preview) el.srcObject = preview; };

  function videoConstraints(): MediaTrackConstraints {
    const r = RES[res];
    return {
      ...(phone ? { facingMode: facing } : cam ? { deviceId: { exact: cam } } : {}),
      width: { ideal: r.width }, height: { ideal: r.height }, frameRate: { ideal: Number(fps) },
    };
  }
  const micConstraints = (): MediaTrackConstraints => ({ ...(mic ? { deviceId: { exact: mic } } : {}), echoCancellation: mode !== 'voice' ? true : false, noiseSuppression: true, autoGainControl: true });

  const close = () => {
    if (recs.current) { void recs.current.main.cancel(); void recs.current.cam?.cancel(); recs.current.cleanup.forEach((f) => f()); recs.current = null; void keepAwake(false); }
    player?.setMasterVolume(1);
    setRecorder(null);
  };

  const start = async () => {
    const startAt = useTime.getState().time;
    const cleanup: (() => void)[] = [];
    try {
      let main: MediaStream, camRec: Recording | undefined, meterStream: MediaStream;
      if (mode === 'screen') {
        const sys = systemAudio && !noSystemAudio;
        if (native?.selectCaptureSource && source) await native.selectCaptureSource(source, sys);
        // The desktop app picks the source itself (above); browsers show their own picker.
        const display = native?.selectCaptureSource
          ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: sys })
          : await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: { ideal: Number(fps) } }, audio: sys,
            ...({ systemAudio: sys ? 'include' : 'exclude', selfBrowserSurface: 'exclude', surfaceSwitching: 'include' } as object),
          } as DisplayMediaStreamOptions);
        if (native?.selectCaptureSource) await display.getVideoTracks()[0]?.applyConstraints({ frameRate: Number(fps) }).catch(() => undefined);
        const extra: MediaStream[] = [display];
        if (useMic) extra.push(await navigator.mediaDevices.getUserMedia({ audio: micConstraints() }));
        const mix = mixAudio(extra);
        cleanup.push(mix.close);
        main = new MediaStream([...display.getVideoTracks(), ...(mix.track ? [mix.track] : [])]);
        // If the person stops sharing from the browser's own bar, finish the recording.
        display.getVideoTracks()[0]?.addEventListener('ended', () => { if (recs.current) void stop(); });
        cleanup.push(() => extra.forEach((s) => s.getTracks().forEach((t) => t.stop())));
        if (camBubble) {
          const c = await navigator.mediaDevices.getUserMedia({ video: { ...(cam ? { deviceId: { exact: cam } } : {}), width: { ideal: 1280 }, height: { ideal: 720 } } });
          camRec = new Recording(c, 'video', 'Camera', 6_000_000);
        }
        meterStream = main;
      } else if (mode === 'camera') {
        main = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(), audio: useMic ? micConstraints() : false });
        meterStream = main;
        setPreview(main);
      } else {
        main = await navigator.mediaDevices.getUserMedia({ audio: micConstraints() });
        meterStream = main;
      }
      const rec = new Recording(main, mode === 'voice' ? 'audio' : 'video', mode === 'screen' ? 'Screen' : mode === 'camera' ? 'Camera' : 'Voiceover',
        mode === 'screen' ? 16_000_000 : res === '2160' ? 40_000_000 : 12_000_000);
      const meter = levelMeter(meterStream);
      cleanup.push(meter.close);
      recs.current = { main: rec, cam: camRec, startAt, cleanup };
      void refreshDevices();
      // 3-2-1 so you can get ready.
      setPhase('countdown');
      for (let n = 3; n > 0; n--) { setCount(n); await new Promise((r) => setTimeout(r, 700)); if (!recs.current) return; }
      await keepAwake(true);
      await Promise.all([rec.start(), camRec?.start()]);
      if (mode === 'voice' && player) {
        if (!playAlong) player.setMasterVolume(0);
        player.seek(startAt);
        void player.play();
      }
      setPhase('recording');
      const tick = setInterval(() => { setElapsed(rec.elapsed()); setLevel(meter.read()); }, 100);
      cleanup.push(() => clearInterval(tick));
    } catch (e) {
      cleanup.forEach((f) => f());
      recs.current = null;
      setPhase('setup');
      toast(permissionMessage(e as Error, mode === 'voice' ? 'microphone' : mode === 'screen' ? 'screen' : 'camera'), 'error');
    }
  };

  const stop = async () => {
    const r = recs.current;
    if (!r) return;
    recs.current = null;
    player?.pause();
    player?.setMasterVolume(1);
    setPhase('finishing');
    try {
      const [main, camRes] = await Promise.all([r.main.stop(setFinish), r.cam?.stop()]);
      r.cleanup.forEach((f) => f());
      if (main.seconds < 0.3) { toast('That recording was too short to keep.'); setRecorder(null); return; }
      const [mediaId] = await importFiles([main.file], r.startAt);
      if (camRes && mediaId) {
        const [camId] = await importFiles([camRes.file]);
        const media = useApp.getState().project?.media.find((m) => m.id === camId);
        if (media) {
          apply('Camera bubble', (p) => {
            const c = createClipFromMedia(media, r.startAt);
            c.muted = true;
            c.name = 'Camera';
            c.transform = { ...c.transform, scale: 0.3, x: 0.32, y: 0.32 };
            return insertClipAuto(p, c).project;
          });
        }
      }
      toast(`Recorded ${formatShort(main.seconds)} — added at ${formatShort(r.startAt)}.`, 'success');
      setRecorder(null);
    } catch (e) {
      r.cleanup.forEach((f) => f());
      toast(`The recording couldn’t be saved: ${(e as Error).message}`, 'error');
      setRecorder(null);
    } finally {
      void keepAwake(false);
    }
  };

  const togglePause = () => {
    const r = recs.current;
    if (!r) return;
    if (paused) { r.main.resume(); r.cam?.resume(); if (mode === 'voice') void player?.play(); }
    else { r.main.pause(); r.cam?.pause(); if (mode === 'voice') player?.pause(); }
    setPaused(!paused);
  };

  useEffect(() => () => { if (recs.current) close(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const MODES = [
    ...(screenSupported() ? [{ value: 'screen' as const, label: 'Screen' }] : []),
    { value: 'camera' as const, label: 'Camera' }, { value: 'voice' as const, label: 'Voiceover' },
  ];
  const mics = devices.mics.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>);
  const cams = devices.cams.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Camera ${i + 1}`}</option>);
  const systemAudioNote = native ? (native.os.startsWith('linux') ? 'Computer sound can’t be captured on Linux; use a microphone or add the sound afterwards.' : '') : 'In Chrome/Edge, tick “Share audio” in the picker to include computer sound.';

  if (phase !== 'setup') {
    return (
      <Dialog title={phase === 'finishing' ? 'Saving recording…' : 'Recording'} onClose={() => (phase === 'finishing' ? undefined : close())} footer={
        phase === 'recording' ? <>
          <button className="btn" onClick={close}>Discard</button>
          <button className="btn" onClick={togglePause}><Icon name={paused ? 'play' : 'pause'} size={15} />{paused ? 'Resume' : 'Pause'}</button>
          <button className="btn primary" onClick={() => void stop()} aria-label="Stop recording"><span className="rec-dot" />Stop</button>
        </> : phase === 'countdown' ? <button className="btn" onClick={close}>Cancel</button> : undefined
      }>
        <div className="rec-live">
          {mode === 'camera' && <video ref={previewRef} autoPlay muted playsInline className="rec-preview" />}
          {phase === 'countdown' && <div className="rec-count" aria-live="assertive">{count}</div>}
          {phase === 'recording' && (
            <>
              <div className="rec-time mono"><span className={`rec-dot${paused ? ' paused' : ''}`} />{formatShort(elapsed)}{paused ? ' (paused)' : ''}</div>
              <div className="rec-meter" aria-hidden="true"><i style={{ width: `${Math.min(100, level * 140)}%` }} /></div>
              <small className="faint">{mode === 'screen' ? 'Recording your screen. Come back here (or use the browser’s “Stop sharing”) to finish.' : mode === 'voice' ? 'Speak along with the timeline.' : 'Recording…'}</small>
            </>
          )}
          {phase === 'finishing' && <><div className="progress"><i style={{ width: `${Math.round(finish * 100)}%` }} /></div><small className="faint">Tidying up the file so it scrubs smoothly…</small></>}
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title="Record" onClose={close} wide footer={<>
      <span className="faint" style={{ marginRight: 'auto', fontSize: 12, alignSelf: 'center' }}><Icon name="device" size={13} style={{ verticalAlign: '-2px' }} /> Recorded and saved on this device only.</span>
      <button className="btn" onClick={close}>Cancel</button>
      <button className="btn primary" disabled={!support.ok} onClick={() => void start()}><span className="rec-dot" />Start recording</button>
    </>}>
      {!support.ok && <div className="notice"><Icon name="warning" size={16} /><div>{support.reason}</div></div>}
      <Seg label="What to record" value={mode} onChange={setMode} options={MODES} />
      {mode === 'screen' && (
        <>
          {sources && (
            <div className="source-grid" role="listbox" aria-label="Screen or window">
              {sources.map((s) => (
                <button key={s.id} role="option" aria-selected={source === s.id} className={source === s.id ? 'on' : ''} onClick={() => setSource(s.id)}>
                  <img src={s.thumbnail} alt="" /><span>{s.name}</span>
                </button>
              ))}
            </div>
          )}
          {!native && <small className="faint">You’ll choose a screen, window or tab after pressing Start.</small>}
          <label className="row"><input type="checkbox" checked={systemAudio && !noSystemAudio} disabled={noSystemAudio} onChange={() => setSystemAudio(!systemAudio)} /> Include computer sound (game audio)</label>
          {(systemAudio || noSystemAudio) && systemAudioNote && <small className="faint">{systemAudioNote}</small>}
          <label className="row"><input type="checkbox" checked={useMic} onChange={() => setUseMic(!useMic)} /> Include my microphone (commentary)</label>
          {useMic && <select className="input" value={mic} onChange={(e) => setMic(e.target.value)} aria-label="Microphone">{mics}</select>}
          <label className="row"><input type="checkbox" checked={camBubble} onChange={() => setCamBubble(!camBubble)} /> Also record my camera (added as a corner bubble you can move)</label>
          {camBubble && <select className="input" value={cam} onChange={(e) => setCam(e.target.value)} aria-label="Camera">{cams}</select>}
          <label className="field"><span>Frame rate</span>
            <select className="input" value={fps} onChange={(e) => setFps(e.target.value)}><option value="30">30 fps</option><option value="60">60 fps (smoother gameplay)</option></select>
          </label>
        </>
      )}
      {mode === 'camera' && (
        <>
          <video ref={previewRef} autoPlay muted playsInline className="rec-preview" aria-label="Camera preview" />
          {phone
            ? <Seg label="Camera" value={facing} onChange={setFacing} options={[{ value: 'user', label: 'Front' }, { value: 'environment', label: 'Back' }]} />
            : <select className="input" value={cam} onChange={(e) => setCam(e.target.value)} aria-label="Camera">{cams}</select>}
          <div className="grid2">
            <label className="field"><span>Resolution</span>
              <select className="input" value={res} onChange={(e) => setRes(e.target.value)}><option value="720">720p</option><option value="1080">1080p</option><option value="2160">4K (if the camera supports it)</option></select>
            </label>
            <label className="field"><span>Frame rate</span>
              <select className="input" value={fps} onChange={(e) => setFps(e.target.value)}><option value="30">30 fps</option><option value="60">60 fps</option></select>
            </label>
          </div>
          <label className="row"><input type="checkbox" checked={useMic} onChange={() => setUseMic(!useMic)} /> Record sound</label>
          {useMic && <select className="input" value={mic} onChange={(e) => setMic(e.target.value)} aria-label="Microphone">{mics}</select>}
        </>
      )}
      {mode === 'voice' && (
        <>
          <select className="input" value={mic} onChange={(e) => setMic(e.target.value)} aria-label="Microphone">{mics}</select>
          <label className="row"><input type="checkbox" checked={playAlong} onChange={() => setPlayAlong(!playAlong)} /> Hear the timeline while recording (use headphones to avoid echo)</label>
          <small className="faint">The timeline plays from the playhead ({formatShort(useTime.getState().time)}) and your voice lands on an audio track right there.</small>
        </>
      )}
    </Dialog>
  );
}

function permissionMessage(e: Error, what: string): string {
  if (e.name === 'NotAllowedError') return `Framewright wasn’t allowed to use the ${what}. Allow it in your browser or system settings, then try again.`;
  if (e.name === 'NotFoundError' || e.name === 'OverconstrainedError') return `No ${what} was found (or it doesn’t support those settings).`;
  if (e.name === 'NotReadableError') return `The ${what} is busy — close other apps using it and try again.`;
  return `Couldn’t start the ${what}: ${e.message}`;
}
