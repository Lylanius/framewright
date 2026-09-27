import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/fonts';
import './styles/app.css';
import { App } from './ui/App';
import { installCapacitorBridge } from './platform/capacitor';

void installCapacitorBridge();
void import('./styles/fonts').then((m) => m.restoreUploadedFonts());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Installable, offline-capable app when served normally (not inside an embedding host).
const embedded = !!(window as unknown as { claude?: unknown }).claude || window.self !== window.top;
if (import.meta.env.PROD && import.meta.env.MODE !== 'single' && !embedded && 'serviceWorker' in navigator && location.protocol.startsWith('http') && !(window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.()) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => undefined); });
}
