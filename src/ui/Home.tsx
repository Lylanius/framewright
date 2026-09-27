import { useEffect, useRef, useState } from 'react';
import { FORMAT_PRESETS, FPS_OPTIONS, sanitiseSize, settingsFromPreset } from '../core/presets';
import { formatShort } from '../core/time';
import { Icon, Logo } from './components/Icon';
import { useApp } from './store';
import { crashedSession, dismissCrash } from '../storage/recovery';
import { SyncPanel } from './SyncPanel';
import { usePublish } from './publisher/pubStore';

function ratioBox(w: number, h: number) {
  const s = 26 / Math.max(w, h);
  return { width: Math.round(w * s), height: Math.round(h * s) };
}

function ago(ts: number): string {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

export function Home() {
  const { summaries, storageOk, refreshSummaries, newProject, openProject, openProjectFile, duplicateProject, renameProject, removeProject } = useApp();
  const [custom, setCustom] = useState({ w: 1080, h: 1920, fps: 30 });
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const [crash, setCrash] = useState(crashedSession);

  useEffect(() => { void refreshSummaries(); }, [refreshSummaries]);

  const start = (name: string, w: number, h: number, fps: number) => {
    const size = sanitiseSize(w, h);
    void newProject(name, { ...size, fps, background: '#000000', sampleRate: 48000 });
  };
  const shown = summaries.filter((s) => s.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <main className="home">
      <div className="home-head">
        <div className="brand">
          <Logo size={36} />
          <div>
            <div className="brand-name">Framewright</div>
            <div className="brand-tag">Private video editor · every tool unlocked</div>
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <span className="privacy-pill" title="Projects and media are stored in this browser. Nothing is uploaded."><Icon name="device" size={14} />Everything stays on this device</span>
        <button className="btn" onClick={() => usePublish.getState().setOpen(true)}><Icon name="history" size={16} />Post planner</button>
        <button className="btn" onClick={() => fileRef.current?.click()}><Icon name="folderOpen" size={16} />Open project file</button>
        <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void openProjectFile(f); e.target.value = ''; }} />
      </div>

      {crash && (
        <div className="notice recovery" role="alert">
          <Icon name="history" size={18} />
          <div className="grow">
            Framewright didn’t close properly last time you were editing <b>{crash.name}</b>.
            {crash.savedAt ? <> Everything up to {new Date(crash.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} was saved.</> : <> It autosaves as you go.</>}
          </div>
          <button className="btn primary sm" onClick={() => { dismissCrash(); setCrash(null); void openProject(crash.projectId); }}>Reopen it</button>
          <button className="btn sm ghost" onClick={() => { dismissCrash(); setCrash(null); }}>Dismiss</button>
        </div>
      )}

      {!storageOk && (
        <div className="notice"><Icon name="warning" size={18} /><div>This browser is blocking local storage, so projects will only last until you close the page. Use <b>Save project file</b> in the editor to keep your work.</div></div>
      )}

      <h2>New project</h2>
      <div className="preset-grid">
        {FORMAT_PRESETS.map((p) => (
          <button key={p.id} className="preset" onClick={() => void newProject(`${p.label} project`, settingsFromPreset(p))}>
            <span className="frame" style={ratioBox(p.width, p.height)} />
            <strong>{p.label}</strong>
            <small>{p.width}×{p.height} · {p.ratio} · {p.fps}fps</small>
          </button>
        ))}
      </div>
      <div className="custom-row" style={{ marginTop: 14 }}>
        <label className="field"><span>Width</span><input className="input mono" type="number" value={custom.w} min={16} max={7680} onChange={(e) => setCustom({ ...custom, w: +e.target.value })} /></label>
        <label className="field"><span>Height</span><input className="input mono" type="number" value={custom.h} min={16} max={7680} onChange={(e) => setCustom({ ...custom, h: +e.target.value })} /></label>
        <label className="field"><span>Frame rate</span>
          <select className="input" value={custom.fps} onChange={(e) => setCustom({ ...custom, fps: +e.target.value })}>
            {FPS_OPTIONS.map((f) => <option key={f} value={f}>{f} fps</option>)}
          </select>
        </label>
        <button className="btn" onClick={() => start('Custom project', custom.w, custom.h, custom.fps)}><Icon name="plus" size={16} />Custom size</button>
      </div>

      <div className="row" style={{ marginTop: 32, marginBottom: 12 }}>
        <h2 style={{ margin: 0, flex: 1 }}>Your projects</h2>
        {summaries.length > 4 && (
          <input className="input" style={{ width: 200 }} placeholder="Search projects" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Search projects" />
        )}
      </div>
      <SyncPanel />
      {shown.length === 0 ? (
        <div className="empty-note">{summaries.length ? 'No projects match that search.' : 'No projects yet. Pick a format above to start editing — your work saves automatically on this device.'}</div>
      ) : (
        <div className="project-grid">
          {shown.map((s) => (
            <article key={s.id} className="project-card">
              <button className="thumb" style={{ backgroundImage: s.thumbnail ? `url(${s.thumbnail})` : undefined }} onClick={() => void openProject(s.id)} aria-label={`Open ${s.name}`}>
                {!s.thumbnail && <Icon name="film" size={28} />}
              </button>
              <div className="meta">
                <div>
                  {renaming === s.id ? (
                    <input className="input" autoFocus defaultValue={s.name} aria-label="Project name"
                      onBlur={(e) => { void renameProject(s.id, e.target.value.trim() || s.name); setRenaming(null); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null); }} />
                  ) : (
                    <div className="name" title={s.name}>{s.name}</div>
                  )}
                  <div className="sub mono">{s.width}×{s.height} · {formatShort(s.duration)} · {ago(s.updatedAt)}</div>
                </div>
                {confirmDelete === s.id ? (
                  <>
                    <button className="btn sm danger" onClick={() => { void removeProject(s.id); setConfirmDelete(null); }}>Delete</button>
                    <button className="btn sm" onClick={() => setConfirmDelete(null)}>Keep</button>
                  </>
                ) : (
                  <>
                    <button className="icon-btn sm" title="Rename" onClick={() => setRenaming(s.id)} aria-label="Rename"><Icon name="text" size={15} /></button>
                    <button className="icon-btn sm" title="Duplicate" onClick={() => void duplicateProject(s.id)} aria-label="Duplicate"><Icon name="copy" size={15} /></button>
                    <button className="icon-btn sm" title="Delete project (your original media files are not touched)" onClick={() => setConfirmDelete(s.id)} aria-label="Delete"><Icon name="trash" size={15} /></button>
                  </>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      <p className="faint" style={{ marginTop: 36, fontSize: 12 }}>
        Deleting a project removes Framewright’s own copy of its media from this browser. The files on your phone or computer are never changed or deleted.
      </p>
    </main>
  );
}
