import { useMemo, useRef, useState } from 'react';
import { formatShort } from '../../core/time';
import type { MediaItem } from '../../core/types';
import { ACCEPT_ATTR, filesFromDataTransfer } from '../../engine/media';
import { addMediaToTimeline } from '../actions';
import { Waveform } from '../components/Controls';
import { Icon } from '../components/Icon';
import { MEDIA_DRAG_TYPE } from '../Timeline';
import { useApp, useTime } from '../store';
import { SFX, sfxFile } from '../../core/sfx';

/** Framewright's own synthesised sound effects: preview, then add at the playhead. */
function SfxList() {
  const importFiles = useApp((s) => s.importFiles);
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const preview = (id: string) => {
    audio.current?.pause();
    const def = SFX.find((x) => x.id === id)!;
    const url = URL.createObjectURL(sfxFile(def));
    const a = new Audio(url);
    audio.current = a;
    setPlaying(id);
    a.onended = () => { setPlaying(null); URL.revokeObjectURL(url); };
    void a.play().catch(() => setPlaying(null));
  };
  return (
    <div className="section">
      <div className="label">Sound effects (made by Framewright)</div>
      <div className="sfx-list">
        {SFX.map((d) => (
          <div key={d.id} className="sfx-row">
            <button className="icon-btn sm" onClick={() => preview(d.id)} aria-label={`Preview ${d.name}`}><Icon name={playing === d.id ? 'volume' : 'play'} size={13} /></button>
            <span className="grow"><b>{d.name}</b><small className="faint"> {d.description}</small></span>
            <button className="btn sm" onClick={async () => { const at = useTime.getState().time; const [id] = await importFiles([sfxFile(d)]); if (id) addMediaToTimeline(id, at); }} aria-label={`Add ${d.name}`}><Icon name="plus" size={13} /></button>
          </div>
        ))}
      </div>
    </div>
  );
}

type SortKey = 'recent' | 'name' | 'duration' | 'size';
type KindFilter = 'all' | 'video' | 'image' | 'audio' | 'fav';

function bytes(n: number): string {
  if (n > 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n > 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

export function MediaPanel({ audioOnly = false }: { audioOnly?: boolean }) {
  const project = useApp((s) => s.project)!;
  const importJob = useApp((s) => s.importJob);
  const missing = useApp((s) => s.missingMedia);
  const proxyProgress = useApp((s) => s.proxyProgress);
  const { importFiles, apply, relinkMedia } = useApp();
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const relinkRef = useRef<HTMLInputElement>(null);
  const [relinkId, setRelinkId] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('recent');
  const [kind, setKind] = useState<KindFilter>(audioOnly ? 'audio' : 'all');
  const [folder, setFolder] = useState<string>('');
  const [drag, setDrag] = useState(false);
  const [info, setInfo] = useState<string | null>(null);

  const folders = useMemo(() => [...new Set(project.media.map((m) => m.folder).filter(Boolean) as string[])].sort(), [project.media]);
  const items = useMemo(() => {
    let list = project.media.slice();
    if (audioOnly) list = list.filter((m) => m.kind === 'audio');
    else if (kind === 'fav') list = list.filter((m) => m.favourite);
    else if (kind !== 'all') list = list.filter((m) => m.kind === kind);
    if (folder) list = list.filter((m) => m.folder === folder);
    if (q) list = list.filter((m) => m.name.toLowerCase().includes(q.toLowerCase()));
    const cmp: Record<SortKey, (a: MediaItem, b: MediaItem) => number> = {
      recent: (a, b) => b.importedAt - a.importedAt,
      name: (a, b) => a.name.localeCompare(b.name),
      duration: (a, b) => b.duration - a.duration,
      size: (a, b) => b.size - a.size,
    };
    return list.sort(cmp[sort]);
  }, [project.media, q, sort, kind, folder, audioOnly]);

  const patch = (id: string, p: Partial<MediaItem>, label: string) =>
    apply(label, (proj) => ({ ...proj, media: proj.media.map((m) => (m.id === id ? { ...m, ...p } : m)) }));

  const inUse = (id: string) => project.tracks.some((t) => t.clips.some((c) => c.mediaId === id));
  const infoItem = project.media.find((m) => m.id === info);

  return (
    <>
      <div
        className={`import-zone${drag ? ' drag' : ''}`}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true); } }}
        onDragLeave={() => setDrag(false)}
        onDrop={async (e) => { e.preventDefault(); setDrag(false); void importFiles(await filesFromDataTransfer(e.dataTransfer)); }}
      >
        <button className="btn primary" onClick={() => fileRef.current?.click()}><Icon name="upload" size={16} />{audioOnly ? 'Import music & sounds' : 'Import media'}</button>
        <div className="row">
          <button className="btn sm grow" onClick={() => folderRef.current?.click()}><Icon name="folder" size={14} />Folder</button>
          {!audioOnly && <button className="btn sm grow phone-only" onClick={() => cameraRef.current?.click()} title="Open your phone's camera app"><Icon name="camera" size={14} />Camera</button>}
          <button className="btn sm grow" onClick={() => useApp.getState().setRecorder(audioOnly ? 'voice' : 'screen')} title={audioOnly ? 'Record a voiceover at the playhead' : 'Record your screen, camera or a voiceover'}><span className="rec-dot sm" />{audioOnly ? 'Voiceover' : 'Record'}</button>
        </div>
        <small className="faint">{audioOnly ? 'MP3, WAV, AAC, M4A, FLAC. Framewright ships no music — bring your own tracks and effects.' : 'Drag files or folders here. Your originals are never changed.'}</small>
        <input ref={fileRef} type="file" multiple accept={audioOnly ? 'audio/*,.flac,.m4a,.aac,.opus' : ACCEPT_ATTR} hidden
          onChange={(e) => { void importFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
        <input ref={folderRef} type="file" multiple hidden {...({ webkitdirectory: '', directory: '' } as object)}
          onChange={(e) => { void importFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
        <input ref={cameraRef} type="file" accept="video/*,image/*" capture="environment" hidden
          onChange={(e) => { void importFiles(Array.from(e.target.files ?? []), undefined); e.target.value = ''; }} />
        <input ref={relinkRef} type="file" hidden accept={ACCEPT_ATTR}
          onChange={(e) => { const f = e.target.files?.[0]; if (f && relinkId) void relinkMedia(relinkId, f); e.target.value = ''; }} />
      </div>

      {audioOnly && <SfxList />}
      {importJob && (
        <div className="section" aria-live="polite">
          <small className="muted">Importing {importJob.done + 1} of {importJob.total}: {importJob.current}</small>
          <div className="progress"><i style={{ width: `${(importJob.done / importJob.total) * 100}%` }} /></div>
        </div>
      )}

      <div className="lib-tools">
        <input className="input" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search media" />
        <select className="input" style={{ width: 104 }} value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort media">
          <option value="recent">Recent</option><option value="name">Name</option><option value="duration">Length</option><option value="size">Size</option>
        </select>
      </div>
      {!audioOnly && (
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          {(['all', 'video', 'image', 'audio', 'fav'] as KindFilter[]).map((k) => (
            <button key={k} className={`chip${kind === k ? ' on' : ''}`} onClick={() => setKind(k)}>
              {k === 'fav' ? <><Icon name="star" size={11} />Favourites</> : k === 'all' ? 'All' : k[0].toUpperCase() + k.slice(1)}
            </button>
          ))}
        </div>
      )}
      {folders.length > 0 && (
        <select className="input" value={folder} onChange={(e) => setFolder(e.target.value)} aria-label="Folder">
          <option value="">All folders</option>
          {folders.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
      )}

      {items.length === 0 ? (
        <p className="faint" style={{ fontSize: 13 }}>{project.media.length ? 'Nothing matches.' : 'No media yet.'}</p>
      ) : audioOnly ? (
        <div className="fx-list">
          {items.map((m) => (
            <div key={m.id} className="media-row-audio" draggable onDragStart={(e) => { e.dataTransfer.setData(MEDIA_DRAG_TYPE, m.id); e.dataTransfer.effectAllowed = 'copy'; }}>
              <button className="icon-btn sm" onClick={() => addMediaToTimeline(m.id)} title="Add at playhead" aria-label={`Add ${m.name}`}><Icon name="plus" size={15} /></button>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="name">{m.name}</div>
                <div className="wave"><Waveform peaks={m.peaks} perSecond={m.peaksPerSecond} color="#4fc58d" /></div>
              </div>
              <span className="mono faint" style={{ fontSize: 11 }}>{formatShort(m.duration)}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="media-grid">
          {items.map((m) => {
            const isMissing = missing.includes(m.id);
            const thumb = m.thumbnails?.[Math.floor((m.thumbnails.length - 1) / 2)];
            return (
              <div key={m.id} className={`media-tile${isMissing ? ' missing' : ''}`} draggable={!isMissing} data-proxy={m.proxy ?? 'none'}
                onDragStart={(e) => { e.dataTransfer.setData(MEDIA_DRAG_TYPE, m.id); e.dataTransfer.effectAllowed = 'copy'; }}
                title={m.warning ?? m.name}>
                <div className="thumb" style={{ backgroundImage: thumb ? `url(${thumb})` : undefined }}>
                  {!thumb && <Icon name={m.kind === 'audio' ? 'audio' : m.kind === 'image' ? 'image' : 'film'} size={24} />}
                  {m.kind === 'audio' && m.peaks && <div style={{ position: 'absolute', inset: '30% 8px 8px' }}><Waveform peaks={m.peaks} perSecond={m.peaksPerSecond} color="#4fc58d" /></div>}
                  {m.kind !== 'image' && <span className="dur">{formatShort(m.duration)}</span>}
                  {m.favourite && <span className="fav"><Icon name="star" size={13} /></span>}
                  {m.warning && <span className="warn"><Icon name="warning" size={13} /></span>}
                  {m.proxy === 'pending' && (
                    <span className="proxy-badge" title="Making a light copy so this plays smoothly while editing. Exports still use the full-quality original.">
                      Optimising {Math.round((proxyProgress[m.id] ?? 0) * 100)}%
                    </span>
                  )}
                  {isMissing ? (
                    <button className="add" style={{ opacity: 1 }} onClick={() => { setRelinkId(m.id); relinkRef.current?.click(); }} title="Re-link: pick the original file" aria-label={`Re-link ${m.name}`}><Icon name="folderOpen" size={14} /></button>
                  ) : (
                    <button className="add" onClick={() => addMediaToTimeline(m.id)} title="Add at playhead" aria-label={`Add ${m.name} to timeline`}><Icon name="plus" size={16} /></button>
                  )}
                </div>
                <div className="caption">
                  <span>{m.name}</span>
                  <button className="icon-btn sm" style={{ width: 20, height: 20 }} onClick={() => setInfo(info === m.id ? null : m.id)} aria-label="Details"><Icon name="more" size={14} /></button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {infoItem && (
        <div className="fx-card" aria-live="polite">
          <header><span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{infoItem.name}</span><button className="icon-btn sm" onClick={() => setInfo(null)} aria-label="Close details"><Icon name="close" size={14} /></button></header>
          <div className="mono faint" style={{ fontSize: 11, lineHeight: 1.6 }}>
            {infoItem.kind} · {bytes(infoItem.size)}{infoItem.width ? ` · ${infoItem.width}×${infoItem.height}` : ''}{infoItem.duration ? ` · ${formatShort(infoItem.duration)}` : ''}<br />
            {Object.entries(infoItem.meta ?? {}).map(([k, v]) => `${k}: ${v}`).join(' · ')}
          </div>
          {infoItem.warning && <small style={{ color: 'var(--accent)' }}>{infoItem.warning}</small>}
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button className="btn sm" onClick={() => patch(infoItem.id, { favourite: !infoItem.favourite }, 'Favourite')}><Icon name="star" size={13} />{infoItem.favourite ? 'Unfavourite' : 'Favourite'}</button>
            <input className="input" style={{ height: 26, flex: 1, minWidth: 90 }} placeholder="Folder" defaultValue={infoItem.folder ?? ''}
              onBlur={(e) => patch(infoItem.id, { folder: e.target.value.trim() || undefined }, 'Set folder')} aria-label="Folder name" />
            <button className="btn sm danger" disabled={inUse(infoItem.id)} title={inUse(infoItem.id) ? 'Remove its clips from the timeline first' : 'Remove from this project (the file on your device is not deleted)'}
              onClick={() => { apply('Remove media', (p) => ({ ...p, media: p.media.filter((x) => x.id !== infoItem.id) })); setInfo(null); }}>
              Remove
            </button>
          </div>
        </div>
      )}
    </>
  );
}
