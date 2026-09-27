/**
 * Compose a post: one video, the platforms to send it to, a shared caption and
 * hashtags (customisable per platform), platform options and when to post.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  charCount, checkTarget, finalText, hashtagsInText, isShort, LIMITS, newId, nextQueueSlot, PLATFORM_NAME, PLATFORMS, youtubeTitle,
  type Platform, type Post, type PostTarget, type TikTokPrivacy, type When,
} from '../../core/publish';
import { Dialog, Seg } from '../components/Controls';
import { Icon } from '../components/Icon';
import { useApp } from '../store';
import { HashtagInput, PlatformBadge, toLocalInput, when as whenText } from './bits';
import { canPostDirect, usePublish } from './pubStore';
import { videoInfo } from './videoInfo';

type Tab = 'all' | Platform;

const YT_CATEGORIES: [string, string][] = [['24', 'Entertainment'], ['20', 'Gaming'], ['22', 'People & Blogs'], ['23', 'Comedy'], ['26', 'Howto & Style'], ['27', 'Education'], ['17', 'Sports'], ['10', 'Music'], ['1', 'Film & Animation'], ['28', 'Science & Technology']];
const TT_PRIVACY: [TikTokPrivacy, string][] = [['PUBLIC_TO_EVERYONE', 'Everyone'], ['FOLLOWER_OF_CREATOR', 'Followers'], ['MUTUAL_FOLLOW_FRIENDS', 'Friends'], ['SELF_ONLY', 'Only me']];

function Counter({ n, max }: { n: number; max: number }) {
  return <span className={`mono counter${n > max ? ' over' : n > max * 0.9 ? ' near' : ''}`}>{n}/{max}</span>;
}

/** Rough phone preview of how the post will look on each platform. */
function PhonePreview({ post, p, src }: { post: Post; p: Platform; src: string | null }) {
  const text = finalText(post, p);
  return (
    <div className={`phone-preview pv-${p}`} aria-label={`${PLATFORM_NAME[p]} preview`}>
      {src ? <video src={src} muted playsInline loop autoPlay poster={post.video.thumbnail} /> : post.video.thumbnail ? <img src={post.video.thumbnail} alt="" /> : <div className="pv-empty" />}
      <div className="pv-overlay">
        {p === 'youtube' && <b className="pv-title">{youtubeTitle(post)}</b>}
        <div className="pv-user">@you</div>
        <div className="pv-caption">{(p === 'youtube' ? '' : text).slice(0, 140)}{text.length > 140 && p !== 'youtube' ? '… more' : ''}</div>
      </div>
      <span className="pv-tag">{p === 'youtube' ? (isShort(post) ? 'Short' : 'Video') : p === 'instagram' ? 'Reel' : 'TikTok'}</span>
    </div>
  );
}

export function Composer() {
  const { editing, edit, savePost, accounts, settings, posts, runDue, saveSettings } = usePublish();
  const toast = useApp((s) => s.toast);
  const [post, setPost] = useState<Post>(editing!);
  const [tab, setTab] = useState<Tab>('all');
  const [blob, setBlob] = useState<Blob | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<'now' | 'queue' | 'at' | 'draft'>(editing!.when === 'draft' ? 'draft' : editing!.publishAt ? 'at' : 'queue');
  const [setName, setSetName] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const direct = canPostDirect();

  // Load the stored video for previews.
  useEffect(() => {
    let url: string | null = null;
    void usePublish.getState().videoBlob(post).then((b) => { if (b) { url = URL.createObjectURL(b); setSrc(url); } });
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [post.video.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const taken = useMemo(() => posts.filter((x) => x.id !== post.id && x.when === 'at' && x.publishAt).map((x) => x.publishAt!), [posts, post.id]);
  const queueTime = useMemo(() => nextQueueSlot(settings.queue, taken), [settings.queue, taken]);
  const set = (patch: Partial<Post>) => setPost((p) => ({ ...p, ...patch }));
  const setT = <P extends Platform>(pl: P, patch: Partial<PostTarget<P>>) => setPost((p) => ({ ...p, targets: { ...p.targets, [pl]: { ...p.targets[pl], ...patch } } }));
  const setO = <P extends Platform>(pl: P, patch: Partial<PostTarget<P>['options']>) => setPost((p) => ({ ...p, targets: { ...p.targets, [pl]: { ...p.targets[pl], options: { ...p.targets[pl].options, ...patch } } } }));

  const enabled = PLATFORMS.filter((p) => post.targets[p].enabled);
  const issues = PLATFORMS.flatMap((p) => checkTarget(post, p).map((i) => ({ ...i, p })));
  const errors = issues.filter((i) => i.level === 'error');
  const hasVideo = !!post.video.key && post.video.size > 0;

  const pickVideo = async (f: File) => {
    const info = await videoInfo(f);
    const key = newId('vid');
    setBlob(f);
    if (src) URL.revokeObjectURL(src);
    setSrc(URL.createObjectURL(f));
    set({ video: { key, name: f.name, size: f.size, mime: f.type || 'video/mp4', duration: info.duration, width: info.width, height: info.height, thumbnail: info.thumbnail } });
  };

  const save = async () => {
    const when: When = mode === 'draft' ? 'draft' : mode === 'now' ? 'now' : 'at';
    const publishAt = mode === 'now' ? Date.now() : mode === 'queue' ? queueTime : mode === 'at' ? post.publishAt : post.publishAt;
    if (when === 'at' && !publishAt) { toast('Pick a date and time (or add queue times in Settings).', 'error'); return; }
    if (when === 'at' && publishAt! < Date.now() - 60_000) { toast('That time has already passed.', 'error'); return; }
    setSaving(true);
    try {
      // Anything not yet done goes back to waiting (e.g. after editing a failed post).
      const targets = { ...post.targets };
      for (const p of PLATFORMS) if (!['posted', 'scheduled', 'drafted', 'shared'].includes(targets[p].status)) targets[p] = { ...targets[p], status: 'waiting', error: undefined, progress: undefined } as never;
      await savePost({ ...post, when, publishAt, targets }, blob ?? undefined);
      edit(null);
      toast(when === 'draft' ? 'Saved as a draft.' : when === 'now' ? 'Posting now…' : `Scheduled for ${whenText(publishAt)}.`, 'success');
      if (when === 'now') void runDue();
    } finally { setSaving(false); }
  };

  const label = mode === 'draft' ? 'Save draft' : mode === 'now' ? 'Post now' : mode === 'queue' ? 'Add to queue' : 'Schedule';
  const capOf = (p: Platform) => post.targets[p].caption;
  const tagsOf = (p: Platform) => post.targets[p].hashtags;
  const minCap = Math.min(...enabled.map((p) => LIMITS[p].caption), 2200);

  return (
    <Dialog title={post.createdAt === post.updatedAt && !posts.some((x) => x.id === post.id) ? 'New post' : 'Edit post'} onClose={() => edit(null)} width={1060} footer={<>
      <span className="faint" style={{ marginRight: 'auto', fontSize: 12, alignSelf: 'center' }}>
        {errors.length ? <><Icon name="warning" size={13} /> {errors.length} thing{errors.length === 1 ? '' : 's'} to fix</> : enabled.length ? `${enabled.map((p) => PLATFORM_NAME[p]).join(', ')}` : 'Pick at least one platform'}
      </span>
      <button className="btn" onClick={() => edit(null)}>Cancel</button>
      <button className="btn primary" disabled={saving || !hasVideo || !enabled.length || (mode !== 'draft' && errors.length > 0)} onClick={() => void save()}>
        <Icon name={mode === 'now' ? 'upload' : 'history'} size={15} />{label}
      </button>
    </>}>
      <div className="composer">
        <div className="composer-media">
          {hasVideo ? (
            <>
              {src ? <video src={src} controls playsInline className="composer-video" /> : <img src={post.video.thumbnail} alt="" className="composer-video" />}
              <small className="faint mono">{post.video.name} · {(post.video.size / 1e6).toFixed(1)} MB · {post.video.duration.toFixed(1)} s · {post.video.width}×{post.video.height}</small>
              <button className="btn sm" onClick={() => fileRef.current?.click()}><Icon name="film" size={13} />Change video</button>
            </>
          ) : (
            <button className="composer-pick" onClick={() => fileRef.current?.click()}><Icon name="upload" size={26} /><span>Choose a video</span><small className="faint">MP4 works everywhere</small></button>
          )}
          <input ref={fileRef} type="file" accept="video/mp4,video/quicktime,video/*" hidden aria-label="Video to post" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void pickVideo(f); }} />
        </div>

        <div className="composer-main">
          <div className="label">Post to</div>
          <div className="pf-toggles">
            {PLATFORMS.map((p) => {
              const t = post.targets[p];
              const accs = accounts.filter((a) => a.platform === p);
              const acc = accs.find((a) => a.id === t.accountId);
              return (
                <div key={p} className={`pf-toggle${t.enabled ? ' on' : ''}`}>
                  <label className="row">
                    <input type="checkbox" checked={t.enabled} onChange={() => setT(p, { enabled: !t.enabled })} aria-label={`Post to ${PLATFORM_NAME[p]}`} />
                    <PlatformBadge p={p} /><b>{PLATFORM_NAME[p]}</b>
                  </label>
                  {t.enabled && (accs.length > 1
                    ? <select className="input sm" value={t.accountId ?? ''} onChange={(e) => setT(p, { accountId: e.target.value || null })} aria-label={`${PLATFORM_NAME[p]} account`}>
                        {accs.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </select>
                    : <small className="faint">{acc ? acc.name : 'No account connected'}</small>)}
                  {t.enabled && (
                    <Seg label={`${PLATFORM_NAME[p]} delivery`} value={t.delivery} onChange={(v) => setT(p, { delivery: v, accountId: t.accountId ?? accs[0]?.id ?? null })}
                      options={direct && accs.length ? [{ value: 'direct', label: 'Post for me' }, { value: 'reminder', label: 'Remind me' }] : [{ value: 'reminder', label: 'Remind me' }]} />
                  )}
                </div>
              );
            })}
          </div>
          {!direct && <small className="faint"><Icon name="info" size={12} /> In this version you get a reminder at the time with the video and caption ready to share. The desktop app can post for you once you connect accounts.</small>}

          <div className="tabs composer-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'all'} className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>Caption & hashtags</button>
            {enabled.map((p) => <button key={p} role="tab" aria-selected={tab === p} className={tab === p ? 'on' : ''} onClick={() => setTab(p)}><PlatformBadge p={p} size={16} />{PLATFORM_NAME[p]}</button>)}
          </div>

          {tab === 'all' && (
            <div className="composer-tab">
              <label className="field"><span className="row">Caption <span className="grow" /><Counter n={charCount(post.caption) + post.hashtags.reduce((a, t) => a + t.length + 2, 0)} max={minCap} /></span>
                <textarea className="input" rows={5} value={post.caption} placeholder="Write a caption — ask a question to get comments!" onChange={(e) => set({ caption: e.target.value })} aria-label="Caption" />
              </label>
              <div className="field"><span className="row">Hashtags <span className="grow" /><small className="faint">{post.hashtags.length + hashtagsInText(post.caption).length} in total</small></span>
                <HashtagInput value={post.hashtags} onChange={(hashtags) => set({ hashtags })} label="Hashtags" />
              </div>
              <div className="row wrap" style={{ gap: 6 }}>
                {settings.hashtagSets.map((s) => (
                  <button key={s.id} className="btn sm ghost" onClick={() => set({ hashtags: [...post.hashtags, ...s.tags.filter((t) => !post.hashtags.includes(t))] })} title={s.tags.map((t) => `#${t}`).join(' ')}><Icon name="plus" size={12} />{s.name}</button>
                ))}
                {post.hashtags.length > 0 && (
                  <span className="row" style={{ gap: 4 }}>
                    <input className="input sm" value={setName} placeholder="Save as set…" onChange={(e) => setSetName(e.target.value)} aria-label="Hashtag set name" style={{ width: 130 }} />
                    <button className="btn sm" disabled={!setName.trim()} onClick={() => { void saveSettings({ hashtagSets: [...settings.hashtagSets, { id: newId('tags'), name: setName.trim(), tags: post.hashtags }] }); setSetName(''); toast('Hashtag set saved.', 'success'); }}>Save</button>
                  </span>
                )}
              </div>
              <small className="faint">Each platform uses this unless you change it on its tab.</small>
            </div>
          )}

          {tab !== 'all' && (() => {
            const p = tab;
            const text = finalText(post, p);
            const max = LIMITS[p].caption;
            return (
              <div className="composer-tab two">
                <div className="grow" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {p === 'youtube' && (
                    <label className="field"><span className="row">Title <span className="grow" /><Counter n={charCount(post.targets.youtube.title || youtubeTitle(post))} max={LIMITS.youtube.title} /></span>
                      <input className="input" value={post.targets.youtube.title} placeholder={youtubeTitle(post)} onChange={(e) => setT('youtube', { title: e.target.value })} aria-label="YouTube title" />
                    </label>
                  )}
                  <label className="row"><input type="checkbox" checked={capOf(p) !== null} onChange={() => setT(p, { caption: capOf(p) === null ? post.caption : null })} /> Different {p === 'youtube' ? 'description' : 'caption'} for {PLATFORM_NAME[p]}</label>
                  {capOf(p) !== null && (
                    <label className="field"><span className="row">{p === 'youtube' ? 'Description' : 'Caption'} <span className="grow" /><Counter n={charCount(text)} max={max} /></span>
                      <textarea className="input" rows={4} value={capOf(p) ?? ''} onChange={(e) => setT(p, { caption: e.target.value })} aria-label={`${PLATFORM_NAME[p]} caption`} />
                    </label>
                  )}
                  <label className="row"><input type="checkbox" checked={tagsOf(p) !== null} onChange={() => setT(p, { hashtags: tagsOf(p) === null ? [...post.hashtags] : null })} /> Different hashtags for {PLATFORM_NAME[p]}</label>
                  {tagsOf(p) !== null && <HashtagInput value={tagsOf(p) ?? []} onChange={(h) => setT(p, { hashtags: h })} label={`${PLATFORM_NAME[p]} hashtags`} />}

                  {p === 'youtube' && <>
                    <label className="field"><span>Visibility</span>
                      <Seg label="YouTube visibility" value={post.targets.youtube.options.privacy} onChange={(v) => setO('youtube', { privacy: v })} options={[{ value: 'public', label: 'Public' }, { value: 'unlisted', label: 'Unlisted' }, { value: 'private', label: 'Private' }]} />
                    </label>
                    <label className="field"><span>Made for kids? (YouTube requires an answer)</span>
                      <Seg label="Made for kids" value={post.targets.youtube.options.madeForKids ? 'yes' : 'no'} onChange={(v) => setO('youtube', { madeForKids: v === 'yes' })} options={[{ value: 'no', label: 'No, not made for kids' }, { value: 'yes', label: 'Yes, made for kids' }]} />
                    </label>
                    <label className="field"><span>Category</span>
                      <select className="input" value={post.targets.youtube.options.categoryId} onChange={(e) => setO('youtube', { categoryId: e.target.value })} aria-label="YouTube category">
                        {YT_CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                    </label>
                    {isShort(post) && <label className="row"><input type="checkbox" checked={post.targets.youtube.options.shortsTag} onChange={() => setO('youtube', { shortsTag: !post.targets.youtube.options.shortsTag })} /> Add #Shorts</label>}
                  </>}
                  {p === 'instagram' && <>
                    <label className="row"><input type="checkbox" checked={post.targets.instagram.options.shareToFeed} onChange={() => setO('instagram', { shareToFeed: !post.targets.instagram.options.shareToFeed })} /> Also show in my profile grid</label>
                    <label className="field"><span>Cover frame: {post.targets.instagram.options.coverAt.toFixed(1)} s</span>
                      <input type="range" min={0} max={Math.max(0, post.video.duration - 0.1)} step={0.1} value={post.targets.instagram.options.coverAt} onChange={(e) => setO('instagram', { coverAt: +e.target.value })} aria-label="Cover frame" />
                    </label>
                  </>}
                  {p === 'tiktok' && <>
                    <label className="field"><span>Who can watch</span>
                      <Seg label="TikTok privacy" value={post.targets.tiktok.options.privacy} onChange={(v) => setO('tiktok', { privacy: v })} options={TT_PRIVACY.map(([value, label]) => ({ value, label }))} />
                    </label>
                    <div className="row wrap" style={{ gap: 14 }}>
                      {(['allowComments', 'allowDuet', 'allowStitch'] as const).map((k) => (
                        <label key={k} className="row"><input type="checkbox" checked={post.targets.tiktok.options[k]} onChange={() => setO('tiktok', { [k]: !post.targets.tiktok.options[k] })} /> {k === 'allowComments' ? 'Comments' : k === 'allowDuet' ? 'Duet' : 'Stitch'}</label>
                      ))}
                    </div>
                    {post.targets.tiktok.delivery === 'direct' && (
                      <label className="row"><input type="checkbox" checked={post.targets.tiktok.options.asDraft} onChange={() => setO('tiktok', { asDraft: !post.targets.tiktok.options.asDraft })} /> Send to my TikTok drafts instead (finish and add sounds in the app)</label>
                    )}
                    <small className="faint">By posting you agree to TikTok’s Music Usage Confirmation.</small>
                  </>}
                  <div className="final-text">
                    <div className="label">Will be posted as</div>
                    <pre>{p === 'youtube' ? `${youtubeTitle(post)}\n\n${text}` : text || '(no caption)'}</pre>
                  </div>
                </div>
                <PhonePreview post={post} p={p} src={src} />
              </div>
            );
          })()}

          {issues.length > 0 && (
            <ul className="issues">
              {issues.map((i, k) => <li key={k} className={i.level}><PlatformBadge p={i.p} size={14} /> {i.text}</li>)}
            </ul>
          )}

          <div className="label">When</div>
          <Seg label="When to post" value={mode} onChange={(v) => { setMode(v); if (v === 'at' && !post.publishAt) set({ publishAt: queueTime ?? Date.now() + 3600_000 }); }}
            options={[{ value: 'queue', label: 'Add to queue' }, { value: 'at', label: 'Pick a time' }, { value: 'now', label: 'Post now' }, { value: 'draft', label: 'Save draft' }]} />
          {mode === 'queue' && <small className="faint">{queueTime ? <>Next free slot: <b>{whenText(queueTime)}</b>. Change your posting times in Settings.</> : 'No queue times yet — add some in Settings.'}</small>}
          {mode === 'at' && (
            <input className="input" type="datetime-local" value={post.publishAt ? toLocalInput(post.publishAt) : ''} min={toLocalInput(Date.now())}
              onChange={(e) => set({ publishAt: e.target.value ? new Date(e.target.value).getTime() : null })} aria-label="Post date and time" style={{ maxWidth: 260 }} />
          )}
          {mode !== 'draft' && enabled.some((p) => post.targets[p].delivery === 'reminder') && (
            <small className="faint">Reminders pop up at the time{direct ? ' (keep Framewright running — see Settings → Keep running)' : ''}; open the post to share the video with its caption copied.</small>
          )}
        </div>
      </div>
    </Dialog>
  );
}
