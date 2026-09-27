import { Component, type ReactNode } from 'react';
import { saveFile } from '../platform/download';
import { logError } from '../storage/recovery';
import { Icon } from './components/Icon';
import { useApp } from './store';

/**
 * If a bug breaks the editor screen, show a recovery panel instead of a blank
 * page. The project itself is autosaved and untouched; from here you can undo
 * the last change (often the fix), reload, or download a rescue copy.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) { return { error }; }

  componentDidCatch(error: Error) { logError(error.message, 'editor'); }

  private rescue = async () => {
    const json = useApp.getState().exportProjectFile();
    if (json) await saveFile(`${(useApp.getState().project?.name ?? 'project').replace(/[^\w\- ]+/g, '')}-rescue.framewright.json`, json).catch(() => undefined);
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const app = useApp.getState();
    const saved = app.saveState === 'saved';
    return (
      <main className="home" role="alert">
        <div className="notice" style={{ maxWidth: 640, margin: '40px auto', flexDirection: 'column', alignItems: 'stretch', gap: 12 }}>
          <div className="row"><Icon name="warning" size={20} /><b style={{ fontSize: 16 }}>Something went wrong in the editor</b></div>
          <p style={{ margin: 0 }}>Your project is {saved ? 'safely saved on this device' : 'still in memory — download a rescue copy before reloading'}. Undoing the last change usually fixes this.</p>
          <code className="mono faint" style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{error.message}</code>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button className="btn primary" disabled={!app.history.past.length} onClick={() => { useApp.getState().undo(); this.setState({ error: null }); }}>Undo last change and continue</button>
            <button className="btn" onClick={() => this.setState({ error: null })}>Try again</button>
            <button className="btn" onClick={() => void this.rescue()}><Icon name="save" size={15} />Download rescue copy</button>
            <button className="btn ghost" onClick={() => void useApp.getState().closeProject().then(() => this.setState({ error: null }))}>Back to projects</button>
          </div>
        </div>
      </main>
    );
  }
}
