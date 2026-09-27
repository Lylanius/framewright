import { useApp } from './store';
import { Editor } from './Editor';
import { ErrorBoundary } from './ErrorBoundary';
import { Home } from './Home';
import { Icon } from './components/Icon';
import { useEffect } from 'react';
import { installNativeHooks } from './nativeHooks';
import { Publisher } from './publisher/Publisher';
import { startScheduler } from './publisher/pubStore';

function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>
          <Icon name={t.kind === 'error' ? 'warning' : t.kind === 'success' ? 'check' : 'info'} size={16} />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

export function App() {
  const screen = useApp((s) => s.screen);
  const project = useApp((s) => s.project);
  useEffect(() => { installNativeHooks(); const t = setTimeout(installNativeHooks, 1500); return () => clearTimeout(t); }, []);
  // Editor: lock the page so it can't scroll or rubber-band on phones.
  useEffect(() => { document.documentElement.classList.toggle('fw-editor', screen === 'editor'); }, [screen]);
  // Post planner: checks for posts that are due, whichever screen is open.
  useEffect(() => { startScheduler(); }, []);
  return (
    <>
      {screen === 'editor' && project ? <ErrorBoundary key={project.id}><Editor /></ErrorBoundary> : <Home />}
      <Publisher />
      <Toasts />
    </>
  );
}
