/**
 * The post planner: queue, week calendar, reminders, history, accounts and
 * settings. Opens over the editor or home screen.
 */
import { useEffect, useMemo, useState } from 'react';
import { finalText, nextQueueSlot, PLATFORM_NAME, PLATFORMS, postState, youtubeTitle, type Platform, type Post, type QueueSlot } from '../../core/publish';
import { saveFile } from '../../platform/download';
import { nativeBridge } from '../../platform/native';
import { Icon } from '../components/Icon';
import { useApp } from '../store';
import { Accounts } from './Accounts';
import { OPEN_URL, PlatformBadge, StatusChip, when } from './bits';
import { Composer } from './Composer';
import { usePublish } from './pubStore';

type View = 'queue' | 'calendar' | 'needs' | 'posted' | 'drafts' | 'accounts' | 'settings';
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Reminder: copy the caption, then share / save the video to post it yourself. */
async function shareFor(post: Post, p: Platform, blob: Blob | null, toast: (t: string, k?: 'info' | 'error' | 'success') => void) {
  const text = p === 'youtube' ? `${youtubeTitle(post)}\n\n${finalText(post, p)}` : finalText(post, p);
  try { await navigator.clipboard.writeText(text); toast('Caption copied — paste it when you post.', 'success'); } catch { /* clipboard blocked */ }
  if (!blob) { toast('The video for this post is missing.', 'error'); return; }
  const n = nativeBridge();
  const name = post.video.name || 'video.mp4';
  if (n?.shareFile && (n.shell === 'ios' || n.shell === 'android')) { await n.shareFile(blob, name); return; }
  const file = new File([blob], name, { type: blob.type || 'video/mp4' });
  if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], text }); return; } catch { /* cancelled */ } }
  await saveFile(name, blob);
}

function PostCard({ post }: { post: Post }) {
  const { edit, deletePost, postNow, updateTarget, videoBlob, busy } = usePublish();
  const toast = useApp((s) => s.toast);
  const [confirm, setConfirm] = useState(false);
  const state = postState(post);
  const targets = PLATFORMS.map((p) => post.targets[p]).filter((t) => t.enabled);
  return (
    <article className={`post-card st-${state}`}>
      {post.video.thumbnail ? <img className="post-thumb" src={post.video.thumbnail} alt="" /> : <div className="post-thumb" />}
      <div className="post-body">
        <div className="row wrap" style={{ gap: 6 }}>
          <b className="post-when">{post.when === 'draft' ? 'Draft' : when(post.publishAt)}</b>
          {targets.map((t) => <StatusChip key={t.platform} t={t} />)}
        </div>
        <p className="post-caption">{post.targets.youtube.enabled && post.targets.youtube.title ? <b>{post.targets.youtube.title} · </b> : null}{post.caption || <span className="faint">No caption</span>}</p>
        {post.hashtags.length > 0 && <small className="faint">{post.hashtags.map((t) => `#${t}`).join(' ')}</small>}
        {targets.map((t) => {
          const key = `${post.id}/${t.platform}`;
          return (
            <div key={t.platform} className="post-target">
              {t.status === 'uploading' && <div className="bigbar sm"><i style={{ width: `${(t.progress ?? 0) * 100}%` }} /></div>}
              {t.status === 'uploading' && busy[key] && <small className="faint">{PLATFORM_NAME[t.platform]}: {busy[key]}…</small>}
              {t.error && <small className="err"><PlatformBadge p={t.platform} size={14} /> {t.error}</small>}
              {t.result?.note && <small className="faint"><PlatformBadge p={t.platform} size={14} /> {t.result.note}</small>}
              {t.result?.url && <a className="link" href={t.result.url} target="_blank" rel="noreferrer"><PlatformBadge p={t.platform} size={14} /> View on {PLATFORM_NAME[t.platform]}</a>}
              {t.status === 'reminded' && (
                <div className="row wrap reminder-row">
                  <PlatformBadge p={t.platform} />
                  <b className="grow">Post it on {PLATFORM_NAME[t.platform]}</b>
                  <button className="btn sm primary" onClick={async () => shareFor(post, t.platform, await videoBlob(post), toast)}><Icon name="export" size={13} />Copy caption & share video</button>
                  <a className="btn sm" href={OPEN_URL[t.platform]} target="_blank" rel="noreferrer">Open {PLATFORM_NAME[t.platform]}</a>
                  {t.delivery === 'direct' && <button className="btn sm" onClick={() => void postNow(post.id, t.platform)}>Post for me now</button>}
                  <button className="btn sm ghost" onClick={() => void updateTarget(post.id, t.platform, { status: 'shared', error: undefined, doneAt: Date.now() })}><Icon name="check" size={13} />Done</button>
                </div>
              )}
              {t.status === 'failed' && (
                <div className="row wrap" style={{ gap: 6 }}>
                  {t.delivery === 'direct' && <button className="btn sm" onClick={() => void postNow(post.id, t.platform)}>Try again</button>}
                  <button className="btn sm" onClick={async () => shareFor(post, t.platform, await videoBlob(post), toast)}>Share it myself</button>
                  <button className="btn sm ghost" onClick={() => void updateTarget(post.id, t.platform, { status: 'skipped' })}>Skip {PLATFORM_NAME[t.platform]}</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="post-actions">
        {state !== 'done' && state !== 'working' && <button className="icon-btn" onClick={() => edit(post)} aria-label="Edit post" title="Edit"><Icon name="settings" size={15} /></button>}
        {state !== 'working' && <button className="icon-btn" onClick={() => { if (!confirm) { setConfirm(true); toast('Tap delete again to remove this post.'); return; } void deletePost(post.id); }} aria-label="Delete post" title="Delete"><Icon name="trash" size={15} /></button>}
      </div>
    </article>
  );
}

function Calendar({ posts }: { posts: Post[] }) {
  const { settings, edit, compose } = usePublish();
  const [week, setWeek] = useState(0);
  const start = useMemo(() => {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + week * 7); // Monday
    return d;
  }, [week]);
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  const today = new Date().toDateString();
  return (
    <div className="calendar">
      <div className="row" style={{ gap: 8 }}>
        <button className="icon-btn" onClick={() => setWeek(week - 1)} aria-label="Previous week"><Icon name="stepBack" size={15} /></button>
        <b>{days[0].toLocaleDateString([], { day: 'numeric', month: 'short' })} – {days[6].toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}</b>
        <button className="icon-btn" onClick={() => setWeek(week + 1)} aria-label="Next week"><Icon name="stepFwd" size={15} /></button>
        {week !== 0 && <button className="btn sm ghost" onClick={() => setWeek(0)}>This week</button>}
      </div>
      <div className="cal-grid">
        {days.map((d) => {
          const items = posts.filter((p) => p.publishAt && new Date(p.publishAt).toDateString() === d.toDateString()).sort((a, b) => a.publishAt! - b.publishAt!);
          const slots = settings.queue.filter((s) => s.day === d.getDay()).map((s) => s.time).sort();
          return (
            <div key={d.toISOString()} className={`cal-day${d.toDateString() === today ? ' today' : ''}`}>
              <div className="cal-head">{d.toLocaleDateString([], { weekday: 'short' })} <b>{d.getDate()}</b></div>
              {items.map((p) => (
                <button key={p.id} className={`cal-item st-${postState(p)}`} onClick={() => postState(p) === 'done' ? undefined : edit(p)} title={p.caption}>
                  <span className="mono">{new Date(p.publishAt!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  <span className="row" style={{ gap: 2 }}>{PLATFORMS.filter((x) => p.targets[x].enabled).map((x) => <PlatformBadge key={x} p={x} size={14} />)}</span>
                  <span className="cal-cap">{p.caption || p.video.name}</span>
                </button>
              ))}
              {slots.filter((s) => !items.some((p) => new Date(p.publishAt!).toTimeString().slice(0, 5) === s)).filter((s) => { const [h, m] = s.split(':').map(Number); const t = new Date(d); t.setHours(h, m); return t.getTime() > Date.now(); }).map((s) => (
                <button key={s} className="cal-slot" onClick={() => void compose().then(() => { const e = usePublish.getState().editing; if (e) { const [h, m] = s.split(':').map(Number); const t = new Date(d); t.setHours(h, m, 0, 0); usePublish.getState().edit({ ...e, publishAt: t.getTime() }); } })}>
                  {s} · empty
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function QueueSettings() {
  const { settings, saveSettings } = usePublish();
  const [adding, setAdding] = useState<{ day: number; time: string }>({ day: 1, time: '19:00' });
  const byDay = (d: number) => settings.queue.filter((s) => s.day === d).sort((a, b) => a.time.localeCompare(b.time));
  // Always from the latest list, so quick taps don't bring a removed time back.
  const remove = (s: QueueSlot) => void saveSettings({ queue: usePublish.getState().settings.queue.filter((x) => !(x.day === s.day && x.time === s.time)) });
  return (
    <div className="section">
      <div className="label">Posting times (your queue)</div>
      <small className="faint">“Add to queue” puts each new post in the next free time.</small>
      <div className="queue-days">
        {[1, 2, 3, 4, 5, 6, 0].map((d) => (
          <div key={d} className="queue-day">
            <b>{DAYS[d].slice(0, 3)}</b>
            {byDay(d).map((s) => <span key={s.time} className="tag-chip">{s.time}<button onClick={() => remove(s)} aria-label={`Remove ${DAYS[d]} ${s.time}`}><Icon name="close" size={11} /></button></span>)}
          </div>
        ))}
      </div>
      <div className="row" style={{ gap: 6 }}>
        <select className="input sm" value={adding.day} onChange={(e) => setAdding({ ...adding, day: +e.target.value })} aria-label="Day">
          <option value={-1}>Every day</option>
          {[1, 2, 3, 4, 5, 6, 0].map((d) => <option key={d} value={d}>{DAYS[d]}</option>)}
        </select>
        <input className="input sm" type="time" value={adding.time} onChange={(e) => setAdding({ ...adding, time: e.target.value })} aria-label="Time" />
        <button className="btn sm" onClick={() => {
          const days = adding.day === -1 ? [0, 1, 2, 3, 4, 5, 6] : [adding.day];
          const cur = usePublish.getState().settings.queue;
          const add = days.map((day) => ({ day, time: adding.time })).filter((s) => !cur.some((x) => x.day === s.day && x.time === s.time));
          void saveSettings({ queue: [...cur, ...add] });
        }}><Icon name="plus" size={13} />Add time</button>
      </div>
    </div>
  );
}

function Settings() {
  const { settings, saveSettings } = usePublish();
  const n = nativeBridge();
  return (
    <div className="pub-settings">
      <QueueSettings />
      <div className="section">
        <div className="label">Hashtag sets</div>
        {!settings.hashtagSets.length && <small className="faint">Save sets from the composer (type hashtags, then “Save as set”).</small>}
        {settings.hashtagSets.map((s) => (
          <div key={s.id} className="row" style={{ gap: 8 }}>
            <b>{s.name}</b><small className="faint grow">{s.tags.map((t) => `#${t}`).join(' ')}</small>
            <button className="icon-btn sm" onClick={() => void saveSettings({ hashtagSets: settings.hashtagSets.filter((x) => x.id !== s.id) })} aria-label={`Delete set ${s.name}`}><Icon name="trash" size={13} /></button>
          </div>
        ))}
      </div>
      <div className="section">
        <div className="label">While waiting to post</div>
        {n?.setBackground && (
          <label className="row"><input type="checkbox" checked={settings.background} onChange={() => void saveSettings({ background: !settings.background })} />
            Keep running in the background (system tray) so scheduled posts go out when the window is closed</label>
        )}
        <label className="row"><input type="checkbox" checked={settings.deleteVideoAfter} onChange={() => void saveSettings({ deleteVideoAfter: !settings.deleteVideoAfter })} />
          Delete the planner’s copy of a video once it’s posted everywhere (your project and exports are untouched)</label>
        <small className="faint">Videos wait on this device until their time and are only sent to the platforms you picked. If your computer is off or asleep at the time, the post waits and asks you when Framewright opens again. YouTube posts are scheduled on YouTube itself, so they go out even if your computer is off.</small>
      </div>
    </div>
  );
}

export function Publisher() {
  const { open, setOpen, posts, editing, compose, load, loaded } = usePublish();
  const [view, setView] = useState<View>('queue');
  useEffect(() => { if (open && !loaded) void load(); }, [open, loaded, load]);
  // Close with Escape when no composer is open.
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !usePublish.getState().editing) setOpen(false); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [setOpen]);
  const needs = posts.filter((p) => ['needs-you', 'failed', 'partly'].includes(postState(p)));
  const upcoming = posts.filter((p) => ['scheduled', 'working'].includes(postState(p)));
  const done = posts.filter((p) => postState(p) === 'done').sort((a, b) => (b.publishAt ?? 0) - (a.publishAt ?? 0));
  const drafts = posts.filter((p) => postState(p) === 'draft');
  const next = nextQueueSlot(usePublish.getState().settings.queue, posts.filter((p) => p.publishAt && p.when === 'at').map((p) => p.publishAt!));
  if (!open) return editing ? <Composer /> : null;
  const tabs: [View, string, number?][] = [['queue', 'Queue', upcoming.length], ['calendar', 'Calendar'], ['needs', 'Needs you', needs.length], ['posted', 'Posted', done.length], ['drafts', 'Drafts', drafts.length], ['accounts', 'Accounts'], ['settings', 'Settings']];
  return (
    <div className="publisher" role="dialog" aria-label="Post planner">
      <header className="pub-head">
        <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Close planner"><Icon name="back" size={18} /></button>
        <h2>Post planner</h2>
        <span className="faint pub-sub">YouTube · Instagram · TikTok</span>
        <span className="grow" />
        <button className="btn primary" onClick={() => void compose()}><Icon name="plus" size={15} />New post</button>
      </header>
      <nav className="pub-tabs" role="tablist">
        {tabs.map(([v, label, n]) => (
          <button key={v} role="tab" aria-selected={view === v} className={`${view === v ? 'on' : ''}${v === 'needs' && n ? ' alert' : ''}`} onClick={() => setView(v)}>
            {label}{n ? <span className="count">{n}</span> : null}
          </button>
        ))}
      </nav>
      <div className="pub-body">
        {view === 'queue' && (
          <>
            {needs.length > 0 && <div className="notice"><Icon name="warning" size={16} /><div className="grow">{needs.length} post{needs.length === 1 ? ' needs' : 's need'} you.</div><button className="btn sm" onClick={() => setView('needs')}>Show</button></div>}
            {!upcoming.length && <div className="empty-state"><Icon name="history" size={30} /><p>Nothing scheduled yet.</p><small className="faint">{next ? `Your next free slot is ${when(next)}.` : 'Add posting times in Settings.'}</small><button className="btn primary" onClick={() => void compose()}><Icon name="plus" size={15} />New post</button></div>}
            {upcoming.map((p) => <PostCard key={p.id} post={p} />)}
          </>
        )}
        {view === 'calendar' && <Calendar posts={posts} />}
        {view === 'needs' && (needs.length ? needs.map((p) => <PostCard key={p.id} post={p} />) : <div className="empty-state"><Icon name="check" size={30} /><p>Nothing needs you right now.</p></div>)}
        {view === 'posted' && (done.length ? done.map((p) => <PostCard key={p.id} post={p} />) : <div className="empty-state"><p>Posts appear here once they’re out.</p></div>)}
        {view === 'drafts' && (drafts.length ? drafts.map((p) => <PostCard key={p.id} post={p} />) : <div className="empty-state"><p>No drafts.</p></div>)}
        {view === 'accounts' && <Accounts />}
        {view === 'settings' && <Settings />}
      </div>
      {editing && <Composer />}
    </div>
  );
}
