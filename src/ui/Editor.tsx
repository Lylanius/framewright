import { useEffect, useRef, useState } from 'react';
import { saveFile } from '../platform/download';
import { handleShortcut, prettyCombo, setShortcutKeys, shortcutKeys, SHORTCUTS, comboFromEvent } from './actions';
import { Dialog } from './components/Controls';
import { Icon, Logo } from './components/Icon';
import { ExportDialog } from './ExportDialog';
import { RecorderDialog } from './Recorder';
import { popOutPreview } from './popout';
import { Inspector } from './Inspector';
import { PanelContent, PANELS, Rail, SidePanel } from './panels/SidePanel';
import { Preview } from './Preview';
import { usePublish } from './publisher/pubStore';
import { useApp } from './store';
import { Timeline } from './Timeline';
import { prefs } from '../storage/db';
import { renderCache } from '../engine/renderCache';
import { markSessionClosed } from '../storage/recovery';

function SaveBadge() {
  const s = useApp((st) => st.saveState);
  const text = { saved: 'Saved on device', saving: 'Saving…', unsaved: 'Unsaved changes', 'memory-only': 'Not saved — storage blocked' }[s];
  return <span className={`save-state ${s}`} title={s === 'memory-only' ? 'This browser blocks local storage. Use “Save project file” to keep your work.' : 'Projects autosave to this device only.'}><span className="dot" /><span className="desktop-only">{text}</span></span>;
}

function TopBar() {
  useEffect(() => { renderCache.enabled = prefs.get('bgRender', true); }, []);
  const project = useApp((s) => s.project)!;
  const { closeProject, apply, undo, redo, history, setExportOpen, exportProjectFile, toast, setShortcutsOpen } = useApp();
  const [menu, setMenu] = useState(false);
  const saveProjectFile = async () => {
    const json = exportProjectFile();
    if (!json) return;
    try {
      const r = await saveFile(`${project.name.replace(/[^\w\- ]+/g, '').trim() || 'project'}.framewright.json`, json);
      if (r === 'saved') toast('Project file saved. Media stays on this device; re-link it if you open the file elsewhere.', 'success');
    } catch (e) { toast((e as Error).message, 'error'); }
    setMenu(false);
  };
  return (
    <header className="topbar">
      <button className="icon-btn" onClick={() => void closeProject()} title="All projects" aria-label="Back to projects"><Icon name="back" /></button>
      <span className="desktop-only" style={{ display: 'inline-flex' }}><Logo size={24} /></span>
      <input className="title-input" value={project.name} onChange={(e) => apply('Rename project', (p) => ({ ...p, name: e.target.value }), 'rename')} aria-label="Project name" />
      <SaveBadge />
      <div className="spacer" />
      <button className="icon-btn desktop-only" onClick={undo} disabled={!history.past.length} title={`Undo${history.past.length ? ' ' + history.past[history.past.length - 1].label.toLowerCase() : ''} (Ctrl+Z)`} aria-label="Undo"><Icon name="undo" /></button>
      <button className="icon-btn desktop-only" onClick={redo} disabled={!history.future.length} title="Redo (Ctrl+Shift+Z)" aria-label="Redo"><Icon name="redo" /></button>
      <div style={{ position: 'relative' }}>
        <button className="icon-btn" onClick={() => setMenu(!menu)} aria-label="More" aria-expanded={menu}><Icon name="more" /></button>
        {menu && (
          <div className="fx-card" style={{ position: 'absolute', right: 0, top: 38, zIndex: 30, width: 240, background: 'var(--raised-2)' }} onMouseLeave={() => setMenu(false)}>
            <button className="btn ghost" style={{ justifyContent: 'flex-start' }} onClick={() => { void useApp.getState().saveNow('Manual save').then(() => toast('Saved on this device.', 'success')); setMenu(false); }}><Icon name="save" size={15} />Save now + snapshot</button>
            <button className="btn ghost" style={{ justifyContent: 'flex-start' }} onClick={saveProjectFile}><Icon name="export" size={15} />Save project file (.json)</button>
            <button className="btn ghost" style={{ justifyContent: 'flex-start' }} onClick={() => { useApp.getState().setRecorder('screen'); setMenu(false); }}><Icon name="camera" size={15} />Record screen / camera / voice</button>
            <button className="btn ghost desktop-only" style={{ justifyContent: 'flex-start' }} onClick={() => { popOutPreview(); setMenu(false); }}><Icon name="screen" size={15} />Pop out preview (2nd screen)</button>
            <button className="btn ghost desktop-only" style={{ justifyContent: 'flex-start' }} onClick={() => { setShortcutsOpen(true); setMenu(false); }}><Icon name="keyboard" size={15} />Keyboard shortcuts</button>
            <label className="row" style={{ fontSize: 13, padding: '4px 12px' }} title="Makes light copies of 4K / 60 fps footage so the preview plays smoothly. Exports always use the originals.">
              <input type="checkbox" defaultChecked={prefs.get('proxies', true)} onChange={(e) => { prefs.set('proxies', e.target.checked); toast(e.target.checked ? 'Smooth-preview copies on for new imports.' : 'Smooth-preview copies off.'); }} />
              Smooth-preview copies for 4K
            </label>
            <label className="row" style={{ fontSize: 13, padding: '4px 12px' }} title="While you're not editing, heavy parts of the timeline (effects, masks, keying, transitions) are rendered in the background so they play back smoothly. Green on the timeline = ready.">
              <input type="checkbox" defaultChecked={prefs.get('bgRender', true)} onChange={(e) => { prefs.set('bgRender', e.target.checked); renderCache.enabled = e.target.checked; if (!e.target.checked) renderCache.clear(); }} />
              Background rendering
            </label>
            <button className="btn ghost" style={{ justifyContent: 'flex-start' }} onClick={() => {
              setMenu(false);
              toast('Rendering heavy sections…');
              void renderCache.renderAll().then(() => toast('Preview rendered — heavy sections now play from the render.', 'success'));
            }}><Icon name="play" size={15} />Render preview now</button>
          </div>
        )}
      </div>
      <button className="btn" onClick={() => usePublish.getState().setOpen(true)} title="Post planner: schedule to YouTube, Instagram and TikTok" aria-label="Post planner"><Icon name="history" size={16} /><span className="desktop-only">Post</span></button>
      <button className="btn primary" onClick={() => setExportOpen(true)}><Icon name="export" size={16} />Export</button>
    </header>
  );
}

function ShortcutsDialog() {
  const setOpen = useApp((s) => s.setShortcutsOpen);
  const [capturing, setCapturing] = useState<string | null>(null);
  const [, force] = useState(0);
  useEffect(() => {
    if (!capturing) return;
    const k = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') { setCapturing(null); return; }
      const combo = comboFromEvent(e);
      if (!combo || ['Mod', 'Shift', 'Alt'].includes(combo)) return;
      setShortcutKeys(capturing, [combo]);
      setCapturing(null);
      force((n) => n + 1);
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [capturing]);
  return (
    <Dialog title="Keyboard shortcuts" onClose={() => setOpen(false)} footer={
      <button className="btn" onClick={() => { prefs.set('shortcuts', {}); force((n) => n + 1); }}>Reset all to defaults</button>
    }>
      <p className="faint" style={{ margin: 0, fontSize: 12 }}>Click a shortcut to change it, then press the new key combination.</p>
      <div>
        {SHORTCUTS.map((s) => (
          <div key={s.id} className="shortcut-row">
            <span>{s.label}</span>
            <span className="keys">{capturing === s.id ? <span className="kbd" style={{ color: 'var(--accent)' }}>Press keys…</span> : shortcutKeys(s.id).map((k) => <span key={k} className="kbd">{prettyCombo(k)}</span>)}</span>
            <button className="btn sm" onClick={() => setCapturing(s.id)}>Change</button>
          </div>
        ))}
      </div>
    </Dialog>
  );
}

function MobileSheet() {
  const sheet = useApp((s) => s.mobileSheet);
  const panel = useApp((s) => s.panel);
  const setSheet = useApp((s) => s.setMobileSheet);
  const start = useRef<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  if (!sheet) return null;
  const def = PANELS.find((p) => p.id === panel)!;
  return (
    <>
      <div className="sheet-backdrop mobile-only" onClick={() => setSheet(null)} />
      <div className="sheet" ref={ref} role="dialog" aria-label={sheet === 'panel' ? def.label : 'Edit clip'}>
        <div className="grabber"
          onPointerDown={(e) => { start.current = e.clientY; (e.target as HTMLElement).setPointerCapture(e.pointerId); }}
          onPointerMove={(e) => { if (start.current !== null && ref.current) ref.current.style.transform = `translateY(${Math.max(0, e.clientY - start.current)}px)`; }}
          onPointerUp={(e) => { const dy = start.current === null ? 0 : e.clientY - start.current; start.current = null; if (ref.current) ref.current.style.transform = ''; if (dy > 70) setSheet(null); }}
        />
        {sheet === 'panel' ? (
          <div className="panel">
            <div className="panel-head"><h3>{def.label}</h3><button className="icon-btn" onClick={() => setSheet(null)} aria-label="Close"><Icon name="close" /></button></div>
            <div className="panel-body"><PanelContent id={panel} /></div>
          </div>
        ) : (
          <>
            <div className="panel-head" style={{ padding: '0 14px' }}><h3 style={{ margin: 0, flex: 1, fontSize: 15 }}>Edit clip</h3><button className="icon-btn" onClick={() => setSheet(null)} aria-label="Close"><Icon name="close" /></button></div>
            <Inspector />
          </>
        )}
      </div>
    </>
  );
}

function MobileTabs() {
  const { panel, setPanel, setMobileSheet, mobileSheet, selection } = useApp();
  return (
    <nav className="mobile-tabs" aria-label="Tools">
      {selection.length === 1 && (
        <button className="edit" onClick={() => setMobileSheet('inspector')}><Icon name="adjust" size={20} />Edit</button>
      )}
      {PANELS.map((p) => (
        <button key={p.id} className={mobileSheet === 'panel' && panel === p.id ? 'on' : ''} onClick={() => { setPanel(p.id); setMobileSheet('panel'); }}>
          <Icon name={p.icon} size={20} />{p.label}
        </button>
      ))}
    </nav>
  );
}

function TimelineSplitter() {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const h = prefs.get<number>('timelineH', 300);
    document.documentElement.style.setProperty('--tl-h', `${h}px`);
  }, []);
  return (
    <div className={`split-handle${dragging ? ' drag' : ''}`} role="separator" aria-orientation="horizontal" aria-label="Resize timeline"
      onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); setDragging(true); }}
      onPointerMove={(e) => {
        if (!dragging) return;
        const h = Math.max(160, Math.min(window.innerHeight - 260, window.innerHeight - e.clientY));
        document.documentElement.style.setProperty('--tl-h', `${h}px`);
      }}
      onPointerUp={(e) => { setDragging(false); prefs.set('timelineH', window.innerHeight - e.clientY); }}
    />
  );
}

export function Editor() {
  const exportOpen = useApp((s) => s.exportOpen);
  const shortcutsOpen = useApp((s) => s.shortcutsOpen);
  const recorder = useApp((s) => s.recorder);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (useApp.getState().exportOpen || useApp.getState().shortcutsOpen || useApp.getState().recorder) return;
      handleShortcut(e);
    };
    window.addEventListener('keydown', k);
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (useApp.getState().saveState === 'unsaved') { void useApp.getState().saveNow(); e.preventDefault(); }
    };
    window.addEventListener('beforeunload', beforeUnload);
    // Phones may kill a backgrounded app without warning: save the moment we're hidden.
    const hidden = () => { if (document.visibilityState === 'hidden' && useApp.getState().saveState === 'unsaved') void useApp.getState().saveNow(); };
    // A normal close (everything saved) isn't a crash.
    const pageHide = () => { if (useApp.getState().saveState === 'saved') markSessionClosed(); };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', pageHide);
    return () => {
      window.removeEventListener('keydown', k); window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', pageHide);
    };
  }, []);
  return (
    <div className="editor">
      <TopBar />
      <Rail />
      <SidePanel />
      <Preview />
      <Inspector />
      <TimelineSplitter />
      <Timeline />
      <MobileTabs />
      <MobileSheet />
      {exportOpen && <ExportDialog />}
      {shortcutsOpen && <ShortcutsDialog />}
      {recorder && <RecorderDialog />}
    </div>
  );
}
