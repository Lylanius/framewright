/**
 * Pop-out preview: a second window (e.g. on another monitor) that mirrors the
 * preview live. It shows the editor's own preview picture, so it always matches.
 */
import { useApp } from './store';

let win: Window | null = null;

export function popOutPreview(): void {
  const { player, toast } = useApp.getState();
  if (!player) return;
  if (win && !win.closed) { win.focus(); return; }
  const canvas = player.canvas as HTMLCanvasElement & { captureStream?: (fps?: number) => MediaStream };
  if (!canvas.captureStream) { toast('This browser can’t mirror the preview to another window.', 'error'); return; }
  win = window.open('about:blank', 'fw-preview', 'popup,width=960,height=600');
  if (!win) { toast('The pop-out window was blocked. Allow pop-ups for Framewright and try again.', 'error'); return; }
  const d = win.document;
  d.title = 'Framewright preview';
  d.body.style.cssText = 'margin:0;background:#000;height:100vh;display:grid;place-items:center;overflow:hidden;cursor:none';
  const v = d.createElement('video');
  v.autoplay = true; v.muted = true; v.playsInline = true;
  v.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000';
  v.srcObject = canvas.captureStream(60);
  d.body.appendChild(v);
  const tip = d.createElement('div');
  tip.textContent = 'Double-click for full screen · Controls stay in the main window';
  tip.style.cssText = 'position:fixed;bottom:12px;left:50%;transform:translateX(-50%);color:#aaa;font:12px system-ui;background:#0008;padding:6px 10px;border-radius:6px;transition:opacity .6s';
  d.body.appendChild(tip);
  setTimeout(() => { tip.style.opacity = '0'; }, 3500);
  v.addEventListener('dblclick', () => { if (d.fullscreenElement) void d.exitFullscreen(); else void d.documentElement.requestFullscreen?.(); });
  // Render the preview a little sharper while mirrored (it's usually bigger over there).
  player.mirrorBoost = true;
  player.requestRender();
  const t = setInterval(() => { if (!win || win.closed) { clearInterval(t); player.mirrorBoost = false; win = null; } }, 1000);
}
