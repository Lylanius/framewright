import { useEffect, useRef } from 'react';
import { drawHistogram, drawVectorscope, drawWaveform, grabFrame } from '../engine/scopes';
import { Seg } from './components/Controls';
import { useApp } from './store';

/** Live scopes of the preview picture. Updates ~6×/s while playing, on every change while paused. */
export function Scopes() {
  const scopes = useApp((s) => s.scopes);
  const setScopes = useApp((s) => s.setScopes);
  const player = useApp((s) => s.player);
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (scopes === 'off' || !player) return;
    let raf = 0, last = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (now - last < (player.playing ? 160 : 90)) return;
      last = now;
      const c = ref.current;
      const d = c && grabFrame(player.canvas, scopes === 'waveform' ? 320 : 200);
      if (!c || !d) return;
      if (scopes === 'histogram') drawHistogram(c, d);
      else if (scopes === 'waveform') drawWaveform(c, d);
      else drawVectorscope(c, d);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [scopes, player]);

  if (scopes === 'off') return null;
  return (
    <div className="scopes" role="region" aria-label="Video scopes">
      <div className="row">
        <Seg label="Scope" value={scopes} onChange={setScopes}
          options={[{ value: 'histogram', label: 'Histogram' }, { value: 'waveform', label: 'Waveform' }, { value: 'vectorscope', label: 'Vectorscope' }]} />
        <small className="faint grow" style={{ textAlign: 'right' }}>
          {scopes === 'histogram' ? 'How many pixels at each brightness (left = dark).' : scopes === 'waveform' ? 'Brightness across the picture, 0–100.' : 'Colour direction and strength. Skin sits on the amber line.'}
        </small>
      </div>
      <canvas ref={ref} width={scopes === 'vectorscope' ? 180 : 360} height={scopes === 'vectorscope' ? 180 : 120} data-testid="scope-canvas" />
    </div>
  );
}
