/**
 * Post planner state: posts, connected accounts, settings, and the scheduler
 * that posts (or reminds you) when a post's time comes.
 *
 * Privacy: videos and captions stay on this device until a post's time, then
 * go only to the platforms you ticked. Sign-in tokens are kept by the desktop
 * app, encrypted with the system keychain.
 */
import { create } from 'zustand';
import {
  DEFAULT_QUEUE, dueTargets, finalText, newId, newPost, PLATFORM_NAME, PLATFORMS, postState, uploadEarly,
  type HashtagSet, type Platform, type Post, type PostTarget, type QueueSlot,
} from '../../core/publish';
import { blobSource, pkce, randomString, type Http, type PlatformApp, type Tokens } from '../../engine/publish/http';
import { publishTarget, type Account } from '../../engine/publish/index';
import { instagramAccount } from '../../engine/publish/instagram';
import { tiktokAuthUrl, tiktokExchange, tiktokUser } from '../../engine/publish/tiktok';
import { youtubeAuthUrl, youtubeChannel, youtubeExchange } from '../../engine/publish/youtube';
import { nativeBridge } from '../../platform/native';
import { kv } from '../../storage/kv';

export interface PubSettings { queue: QueueSlot[]; hashtagSets: HashtagSet[]; background: boolean; deleteVideoAfter: boolean }
const DEFAULT_SETTINGS: PubSettings = { queue: DEFAULT_QUEUE, hashtagSets: [], background: false, deleteVideoAfter: true };

/** Account as stored (tokens live in the desktop app's encrypted store). */
type StoredAccount = Omit<Account, 'tokens'>;

/** Direct posting needs the desktop app (network access to the platforms + sign-in). */
export function canPostDirect(): boolean {
  const n = nativeBridge();
  return !!(n?.http && n.oauthStart && n.secretGet);
}

const http: Http = (r) => {
  const n = nativeBridge();
  if (!n?.http) throw new Error('Direct posting works in the Framewright desktop app.');
  return n.http(r);
};

const secret = {
  get: async (k: string) => (await nativeBridge()?.secretGet?.(k)) ?? null,
  set: async (k: string, v: string | null) => { await nativeBridge()?.secretSet?.(k, v); },
};

interface PubState {
  loaded: boolean;
  posts: Post[];
  accounts: StoredAccount[];
  /** Your own developer apps (client ids; secrets are in the encrypted store). */
  apps: Partial<Record<'youtube' | 'tiktok', { clientId: string; hasSecret: boolean }>>;
  settings: PubSettings;
  open: boolean;
  /** Post being edited in the composer (null = closed). */
  editing: Post | null;
  busy: Record<string, string>;
  load(): Promise<void>;
  setOpen(v: boolean): void;
  compose(video?: { blob: Blob; name: string; duration: number; width: number; height: number; thumbnail?: string; projectName?: string }): Promise<void>;
  edit(post: Post | null): void;
  savePost(p: Post, blob?: Blob): Promise<void>;
  deletePost(id: string): Promise<void>;
  videoBlob(p: Post): Promise<Blob | null>;
  updateTarget(postId: string, platform: Platform, patch: Partial<PostTarget>): Promise<void>;
  saveSettings(patch: Partial<PubSettings>): Promise<void>;
  saveApp(platform: 'youtube' | 'tiktok', clientId: string, clientSecret: string): Promise<void>;
  connect(platform: Platform, instagramToken?: string): Promise<StoredAccount>;
  disconnect(id: string): Promise<void>;
  /** Scheduler tick: post what's due (direct) or raise reminders. */
  runDue(now?: number): Promise<void>;
  postNow(postId: string, platform: Platform): Promise<void>;
}

async function loadAccountTokens(a: StoredAccount): Promise<Account | null> {
  const t = await secret.get(`acct/${a.id}`);
  return t ? { ...a, tokens: JSON.parse(t) as Tokens } : null;
}

async function appFor(platform: Platform): Promise<PlatformApp | null> {
  if (platform === 'instagram') return null;
  const clientId = (await kv.get<string>(`pubapp/${platform}`)) ?? '';
  const clientSecret = (await secret.get(`app/${platform}`)) ?? '';
  return clientId ? { clientId, clientSecret } : null;
}

function notify(title: string, body: string): void {
  try {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'granted') new Notification(title, { body });
    else if (Notification.permission !== 'denied') void Notification.requestPermission().then((p) => { if (p === 'granted') new Notification(title, { body }); });
  } catch { /* notifications not available */ }
}

/** Numeric id for phone notifications (stable per post+platform). */
function notifyId(postId: string, p: Platform): number {
  let h = 7;
  for (const c of postId + p) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h) % 2_000_000_000;
}

const running = new Set<string>();

export const usePublish = create<PubState>((set, get) => ({
  loaded: false,
  posts: [],
  accounts: [],
  apps: {},
  settings: DEFAULT_SETTINGS,
  open: false,
  editing: null,
  busy: {},

  async load() {
    const [posts, accounts, settings, yt, tt] = await Promise.all([
      kv.list<Post>('post/'), kv.list<StoredAccount>('pubacct/'), kv.get<PubSettings>('pubsettings'),
      kv.get<string>('pubapp/youtube'), kv.get<string>('pubapp/tiktok'),
    ]);
    const has = async (p: string) => !!(await secret.get(`app/${p}`));
    set({
      loaded: true,
      posts: posts.sort((a, b) => (a.publishAt ?? a.createdAt) - (b.publishAt ?? b.createdAt)),
      accounts,
      settings: { ...DEFAULT_SETTINGS, ...settings },
      apps: {
        ...(yt ? { youtube: { clientId: yt, hasSecret: await has('youtube') } } : {}),
        ...(tt ? { tiktok: { clientId: tt, hasSecret: await has('tiktok') } } : {}),
      },
    });
    if (settings?.background) void nativeBridge()?.setBackground?.(true);
  },

  setOpen(open) { set({ open }); if (open && !get().loaded) void get().load(); },

  async compose(video) {
    if (!get().loaded) await get().load();
    const { accounts } = get();
    const direct = canPostDirect();
    const first = (p: Platform) => accounts.find((a) => a.platform === p)?.id ?? null;
    const key = newId('vid');
    const post = newPost(
      video
        ? { key, name: video.name, size: video.blob.size, mime: video.blob.type || 'video/mp4', duration: video.duration, width: video.width, height: video.height, thumbnail: video.thumbnail }
        : { key: '', name: '', size: 0, mime: '', duration: 0, width: 0, height: 0 },
      { accounts: { youtube: first('youtube'), instagram: first('instagram'), tiktok: first('tiktok') }, direct: { youtube: direct && !!first('youtube'), instagram: direct && !!first('instagram'), tiktok: direct && !!first('tiktok') } },
    );
    for (const p of PLATFORMS) post.targets[p].enabled = true;
    post.projectName = video?.projectName;
    if (video) await kv.set(`postvideo/${key}`, video.blob);
    set({ open: true, editing: post });
  },

  edit(editing) { set({ editing }); },

  async savePost(p, blob) {
    const post = { ...p, updatedAt: Date.now() };
    if (blob) await kv.set(`postvideo/${post.video.key}`, blob);
    await kv.set(`post/${post.id}`, post);
    set((s) => ({ posts: [...s.posts.filter((x) => x.id !== post.id), post].sort((a, b) => (a.publishAt ?? a.createdAt) - (b.publishAt ?? b.createdAt)) }));
    // Phones: the system shows reminders at the time even if the app is closed.
    const n = nativeBridge();
    if (n?.notifyAt) {
      for (const pl of PLATFORMS) {
        const t = post.targets[pl];
        await n.cancelNotify?.(notifyId(post.id, pl)).catch(() => undefined);
        if (t.enabled && t.delivery === 'reminder' && t.status === 'waiting' && post.when === 'at' && post.publishAt && post.publishAt > Date.now()) {
          await n.notifyAt(notifyId(post.id, pl), post.publishAt, `Time to post on ${PLATFORM_NAME[pl]}`, finalText(post, pl).slice(0, 120) || post.video.name).catch(() => undefined);
        }
      }
    }
  },

  async deletePost(id) {
    const post = get().posts.find((x) => x.id === id);
    await kv.del(`post/${id}`);
    if (post?.video.key && !get().posts.some((x) => x.id !== id && x.video.key === post.video.key)) await kv.del(`postvideo/${post.video.key}`);
    for (const pl of PLATFORMS) await nativeBridge()?.cancelNotify?.(notifyId(id, pl)).catch(() => undefined);
    set((s) => ({ posts: s.posts.filter((x) => x.id !== id) }));
  },

  videoBlob: (p) => kv.get<Blob>(`postvideo/${p.video.key}`).then((b) => b ?? null),

  async updateTarget(postId, platform, patch) {
    const post = get().posts.find((x) => x.id === postId);
    if (!post) return;
    const next: Post = { ...post, targets: { ...post.targets, [platform]: { ...post.targets[platform], ...patch } } };
    await get().savePost(next);
    // Everything done: free the stored copy of the video (optional).
    if (get().settings.deleteVideoAfter && postState(next) === 'done') {
      const others = get().posts.some((x) => x.id !== postId && x.video.key === next.video.key && postState(x) !== 'done');
      if (!others) await kv.del(`postvideo/${next.video.key}`);
    }
  },

  async saveSettings(patch) {
    const settings = { ...get().settings, ...patch };
    await kv.set('pubsettings', settings);
    set({ settings });
    if ('background' in patch) await nativeBridge()?.setBackground?.(!!patch.background);
  },

  async saveApp(platform, clientId, clientSecret) {
    await kv.set(`pubapp/${platform}`, clientId.trim());
    if (clientSecret.trim()) await secret.set(`app/${platform}`, clientSecret.trim());
    set((s) => ({ apps: { ...s.apps, [platform]: { clientId: clientId.trim(), hasSecret: !!clientSecret.trim() || !!s.apps[platform]?.hasSecret } } }));
  },

  async connect(platform, instagramToken) {
    const n = nativeBridge();
    if (!canPostDirect() || !n) throw new Error('Connecting accounts works in the Framewright desktop app.');
    let acct: Account;
    if (platform === 'instagram') {
      const token = (instagramToken ?? '').trim();
      if (!token) throw new Error('Paste the access token from your Meta app first.');
      const me = await instagramAccount(http, token);
      acct = { id: newId('acct'), platform, name: me.username, handle: me.username, avatar: me.avatar, remoteId: me.userId, tokens: { accessToken: token, expiresAt: Date.now() + 55 * 86400_000 }, addedAt: Date.now() };
    } else {
      const app = await appFor(platform);
      if (!app?.clientId || !app.clientSecret) throw new Error(`Add your ${platform === 'youtube' ? 'Google client ID and secret' : 'TikTok client key and secret'} first.`);
      const { id, redirectUri } = await n.oauthStart!();
      const state = randomString(24);
      const { verifier, challenge } = await pkce(platform === 'tiktok' ? 'hex' : 'base64url');
      const url = platform === 'youtube' ? youtubeAuthUrl(app, redirectUri, state, challenge) : tiktokAuthUrl(app, redirectUri, state, challenge);
      const r = await n.oauthWait!(id, url);
      if (r.error) throw new Error(`Sign-in cancelled: ${r.error}`);
      if (!r.code || r.state !== state) throw new Error('Sign-in didn’t complete — try again.');
      if (platform === 'youtube') {
        const tokens = await youtubeExchange(http, app, r.code, redirectUri, verifier);
        const ch = await youtubeChannel(http, tokens);
        acct = { id: newId('acct'), platform, name: ch.name, handle: ch.handle, avatar: ch.avatar, remoteId: ch.id, tokens, addedAt: Date.now() };
      } else {
        const tokens = await tiktokExchange(http, app, r.code, redirectUri, verifier);
        const u = await tiktokUser(http, tokens);
        acct = { id: newId('acct'), platform, name: u.name, handle: u.handle, avatar: u.avatar, remoteId: u.openId, tokens, addedAt: Date.now() };
      }
    }
    // Reconnecting the same account replaces it.
    const same = get().accounts.find((a) => a.platform === platform && a.remoteId === acct.remoteId);
    if (same) acct.id = same.id;
    const { tokens, ...stored } = acct;
    await secret.set(`acct/${acct.id}`, JSON.stringify(tokens));
    await kv.set(`pubacct/${acct.id}`, stored);
    set((s) => ({ accounts: [...s.accounts.filter((a) => a.id !== acct.id), stored] }));
    return stored;
  },

  async disconnect(id) {
    await secret.set(`acct/${id}`, null);
    await kv.del(`pubacct/${id}`);
    set((s) => ({ accounts: s.accounts.filter((a) => a.id !== id) }));
  },

  async postNow(postId, platform) {
    const key = `${postId}/${platform}`;
    if (running.has(key)) return;
    const post = get().posts.find((x) => x.id === postId);
    if (!post) return;
    const t = post.targets[platform];
    const stored = get().accounts.find((a) => a.id === t.accountId);
    const account = stored ? await loadAccountTokens(stored) : null;
    if (!account || !canPostDirect()) {
      await get().updateTarget(postId, platform, { status: 'failed', error: 'No connected account — connect one in Accounts, or share it yourself.' });
      return;
    }
    const blob = await get().videoBlob(post);
    if (!blob) { await get().updateTarget(postId, platform, { status: 'failed', error: 'The video for this post is missing — attach it again.' }); return; }
    running.add(key);
    try {
      await get().updateTarget(postId, platform, { status: 'uploading', progress: 0, error: undefined });
      let last = 0;
      const out = await publishTarget(http, post, platform, account, await appFor(platform), blobSource(blob, post.video.name), (f, note) => {
        if (f - last < 0.02 && f < 1) return;
        last = f;
        set((s) => ({ busy: { ...s.busy, [key]: note ?? '' }, posts: s.posts.map((x) => (x.id === postId ? { ...x, targets: { ...x.targets, [platform]: { ...x.targets[platform], progress: f } } } : x)) }));
      });
      if (JSON.stringify(out.tokens) !== JSON.stringify(account.tokens)) await secret.set(`acct/${account.id}`, JSON.stringify(out.tokens));
      await get().updateTarget(postId, platform, out.target);
      const ok = out.target.status !== 'failed';
      notify(ok ? `${PLATFORM_NAME[platform]}: ${out.target.status === 'drafted' ? 'sent to drafts' : out.target.status === 'scheduled' ? 'scheduled' : 'posted'}` : `${PLATFORM_NAME[platform]}: post failed`, ok ? (out.target.result?.note ?? post.video.name) : out.target.error ?? '');
      if (out.target.status === 'drafted') await navigator.clipboard?.writeText(finalText(post, platform)).catch(() => undefined);
    } finally {
      running.delete(key);
      set((s) => { const b = { ...s.busy }; delete b[key]; return { busy: b }; });
    }
  },

  async runDue(now = Date.now()) {
    if (!get().loaded) await get().load();
    const { posts } = get();
    // YouTube scheduled posts: upload early, YouTube publishes at the time.
    for (const post of posts) for (const p of PLATFORMS) if (uploadEarly(post, p, now) && canPostDirect()) void get().postNow(post.id, p);
    for (const { post, platform } of dueTargets(posts, now)) {
      const t = post.targets[platform];
      const late = post.publishAt !== null && now - post.publishAt > 15 * 60_000;
      if (t.delivery === 'direct' && canPostDirect() && !late) void get().postNow(post.id, platform);
      else {
        await get().updateTarget(post.id, platform, {
          status: 'reminded',
          error: late && t.delivery === 'direct' ? 'Missed its time while Framewright was closed — post it now or reschedule.' : undefined,
        });
        notify(`Time to post on ${PLATFORM_NAME[platform]}`, finalText(post, platform).slice(0, 120) || post.video.name);
      }
    }
  },
}));

/** Start the scheduler (once, for the app's lifetime). */
let timer: ReturnType<typeof setInterval> | null = null;
export function startScheduler(): void {
  if (timer) return;
  const tick = () => { void usePublish.getState().runDue(); };
  setTimeout(tick, 3000);
  timer = setInterval(tick, 20_000);
}
