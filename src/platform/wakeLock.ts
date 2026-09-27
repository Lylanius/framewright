/** Keep the screen awake during long jobs (exports, recordings). Best effort everywhere. */
import { nativeBridge } from './native';

let sentinel: { release(): Promise<void> } | null = null;
let holders = 0;

export async function keepAwake(on: boolean): Promise<void> {
  holders = Math.max(0, holders + (on ? 1 : -1));
  const want = holders > 0;
  const native = nativeBridge();
  if (native?.keepAwake) { await native.keepAwake(want); return; }
  const wl = (navigator as unknown as { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
  if (!wl) return;
  try {
    if (want && !sentinel) sentinel = await wl.request('screen');
    else if (!want && sentinel) { await sentinel.release(); sentinel = null; }
  } catch { /* not allowed (e.g. page hidden) */ }
}
