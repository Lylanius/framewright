/** Home-screen card for the optional sync folder (see storage/syncFolder.ts). */
import { useEffect, useState } from 'react';
import { chooseSyncFolder, listSynced, readSynced, reconnectSyncFolder, stopSync, syncStatus, type RemoteProject, type SyncStatus } from '../storage/syncFolder';
import { Icon } from './components/Icon';
import { useApp } from './store';

export function SyncPanel() {
  const { summaries, openProjectFile, toast } = useApp();
  const [st, setSt] = useState<SyncStatus | null>(null);
  const [remote, setRemote] = useState<RemoteProject[]>([]);
  const refresh = async () => {
    const s = await syncStatus();
    setSt(s);
    setRemote(s.state === 'on' ? await listSynced() : []);
  };
  useEffect(() => { void refresh(); }, []);
  if (!st || st.state === 'unsupported') return null;

  // Projects in the folder that are new here, or newer than this device's copy.
  const incoming = remote.filter((r) => { const local = summaries.find((s) => s.id === r.id); return !local || r.updatedAt > local.updatedAt + 1000; });

  return (
    <section className="sync-card">
      <Icon name="folder" size={18} />
      <div className="grow">
        {st.state === 'off' && <><b>Sync folder</b> <span className="faint">(optional)</span><br /><small className="faint">Pick a folder inside OneDrive, Dropbox, Google Drive or iCloud Drive and your project edits follow you to your other computers. Only the small project files go there — never your videos — and Framewright never talks to a server.</small></>}
        {st.state === 'needs-permission' && <><b>Sync folder: {st.name}</b><br /><small className="faint">Your browser needs permission again to use this folder.</small></>}
        {st.state === 'on' && <><b>Syncing edits to “{st.name}”</b><br /><small className="faint">{incoming.length ? `${incoming.length} project${incoming.length > 1 ? 's' : ''} from your other devices:` : 'Up to date. Projects save there automatically.'}</small></>}
        {st.state === 'on' && incoming.length > 0 && (
          <div className="sync-list">
            {incoming.map((r) => (
              <button key={r.fileName} className="btn sm" onClick={async () => {
                const f = await readSynced(r.fileName);
                if (f) await openProjectFile(f); else toast('That file has gone from the folder.', 'error');
              }}><Icon name="folderOpen" size={13} />{r.name}{summaries.some((s) => s.id === r.id) ? ' (newer)' : ''}</button>
            ))}
          </div>
        )}
      </div>
      {st.state === 'off' && <button className="btn sm" onClick={async () => { const n = await chooseSyncFolder(); if (n) { toast(`Syncing project edits to “${n}”.`, 'success'); void refresh(); } }}>Choose folder…</button>}
      {st.state === 'needs-permission' && <button className="btn sm primary" onClick={async () => { if (await reconnectSyncFolder()) void refresh(); }}>Reconnect</button>}
      {st.state !== 'off' && <button className="btn sm ghost" onClick={async () => { await stopSync(); void refresh(); }}>Stop syncing</button>}
    </section>
  );
}
