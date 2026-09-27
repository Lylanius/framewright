/**
 * Record a short voice clip (e.g. shouting the quiz title) with the device
 * microphone. Stays on this device: it's decoded, trimmed and turned into a WAV
 * right here, then handed back like any other file.
 */
import { useEffect, useRef, useState } from 'react';
import { wavBytes } from '../core/sfx';
import { tidyVoice, toMono } from '../core/voiceTrim';
import { Icon } from './components/Icon';

const MAX_SECONDS = 8;

export function VoiceRecorder({ onDone, onError }: { onDone: (f: File) => void; onError: (msg: string) => void }) {
  const [state, setState] = useState<'idle' | 'recording' | 'working'>('idle');
  const [secs, setSecs] = useState(0);
  const rec = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const cleanup = () => {
    window.clearInterval(timer.current);
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  };
  useEffect(() => () => { rec.current?.state === 'recording' && rec.current.stop(); cleanup(); }, []);

  const finish = async (blob: Blob) => {
    setState('working');
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
      void ctx.close();
      const chans = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
      const clean = tidyVoice(toMono(chans), buf.sampleRate);
      if (clean.length < buf.sampleRate * 0.15) { onError('Didn’t catch anything — try again a little closer to the mic.'); return; }
      onDone(new File([wavBytes(clean, buf.sampleRate)], 'Intro voice (recorded).wav', { type: 'audio/wav' }));
    } catch {
      onError('Couldn’t read that recording. Try again, or add a sound file instead.');
    } finally { setState('idle'); }
  };

  const start = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { onError('Recording isn’t available here — add a sound file instead.'); return; }
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      onError('Framewright needs the microphone for this. Allow it in your browser/phone settings and try again.');
      return;
    }
    const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported?.(t));
    const r = new MediaRecorder(stream.current, type ? { mimeType: type } : undefined);
    const parts: Blob[] = [];
    r.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    r.onstop = () => { cleanup(); void finish(new Blob(parts, { type: r.mimeType || type || 'audio/webm' })); };
    rec.current = r;
    r.start();
    setSecs(0);
    setState('recording');
    const t0 = performance.now();
    timer.current = window.setInterval(() => {
      const s = (performance.now() - t0) / 1000;
      setSecs(s);
      if (s >= MAX_SECONDS && r.state === 'recording') r.stop();
    }, 100);
  };

  if (state === 'recording') {
    return (
      <button className="btn sm danger rec-btn" onClick={() => rec.current?.stop()} aria-label="Stop recording">
        <span className="rec-dot" />Stop · {secs.toFixed(1)}s
      </button>
    );
  }
  return (
    <button className="btn sm" onClick={() => void start()} disabled={state === 'working'} aria-label="Record your voice">
      <Icon name="audio" size={13} />{state === 'working' ? 'Tidying…' : 'Record'}
    </button>
  );
}
