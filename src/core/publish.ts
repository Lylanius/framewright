/**
 * Post planner ("Buffer"-style): one video, posted to YouTube, Instagram and
 * TikTok — now, at a set time, or in the next free queue slot — with a shared
 * caption and hashtags that can be tweaked per platform.
 *
 * Pure data + rules here (no network, no storage) so it's easy to test.
 */

export type Platform = 'youtube' | 'instagram' | 'tiktok';
export const PLATFORMS: Platform[] = ['youtube', 'instagram', 'tiktok'];
export const PLATFORM_NAME: Record<Platform, string> = { youtube: 'YouTube', instagram: 'Instagram', tiktok: 'TikTok' };

/** How a post reaches the platform. */
export type Delivery =
  /** Framewright uploads it itself (desktop app, connected account). */
  | 'direct'
  /** At the time, you get a reminder with the video and caption ready to share. */
  | 'reminder';

export interface YouTubeOptions {
  privacy: 'public' | 'unlisted' | 'private';
  madeForKids: boolean;
  /** YouTube category id (22 = People & Blogs, 24 = Entertainment, 20 = Gaming…). */
  categoryId: string;
  /** Add #Shorts (vertical videos up to 3 minutes become Shorts anyway). */
  shortsTag: boolean;
}
export interface InstagramOptions {
  /** Also show the Reel in the profile grid. */
  shareToFeed: boolean;
  /** Cover frame, seconds into the video. */
  coverAt: number;
}
export type TikTokPrivacy = 'PUBLIC_TO_EVERYONE' | 'MUTUAL_FOLLOW_FRIENDS' | 'FOLLOWER_OF_CREATOR' | 'SELF_ONLY';
export interface TikTokOptions {
  privacy: TikTokPrivacy;
  allowComments: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
  /** Send to your TikTok drafts/inbox to finish in the app, instead of posting straight away. */
  asDraft: boolean;
}
export type PlatformOptions = { youtube: YouTubeOptions; instagram: InstagramOptions; tiktok: TikTokOptions };

export type TargetStatus = 'waiting' | 'uploading' | 'scheduled' | 'posted' | 'drafted' | 'reminded' | 'shared' | 'failed' | 'skipped';

export interface PostTarget<P extends Platform = Platform> {
  platform: P;
  enabled: boolean;
  accountId: string | null;
  delivery: Delivery;
  /** YouTube title (other platforms have no separate title). */
  title: string;
  /** Per-platform caption; null = use the shared caption. */
  caption: string | null;
  /** Per-platform hashtags; null = use the shared ones. */
  hashtags: string[] | null;
  options: PlatformOptions[P];
  status: TargetStatus;
  /** 0..1 while uploading. */
  progress?: number;
  error?: string;
  /** Link to the live post / video, id on the platform, or a note. */
  result?: { url?: string; id?: string; note?: string };
  doneAt?: number;
}

export type When = 'now' | 'at' | 'draft';

export interface Post {
  id: string;
  createdAt: number;
  updatedAt: number;
  /** The video (stored separately as a Blob under this key). */
  video: { key: string; name: string; size: number; mime: string; duration: number; width: number; height: number; thumbnail?: string };
  caption: string;
  hashtags: string[];
  when: When;
  /** Epoch ms for 'at' (and filled in with the post time for 'now'). */
  publishAt: number | null;
  targets: { youtube: PostTarget<'youtube'>; instagram: PostTarget<'instagram'>; tiktok: PostTarget<'tiktok'> };
  projectName?: string;
}

export interface HashtagSet { id: string; name: string; tags: string[] }

/** Weekly posting times ("queue"): "Add to queue" picks the next free one. */
export interface QueueSlot { day: number; /* 0 = Sunday */ time: string /* "HH:MM" */ }

export const DEFAULT_QUEUE: QueueSlot[] = [1, 2, 3, 4, 5].flatMap((d) => [{ day: d, time: '12:30' }, { day: d, time: '18:00' }])
  .concat([0, 6].map((d) => ({ day: d, time: '11:00' })));

/* ------------------------------------------------------------------ */
/* Limits                                                               */
/* ------------------------------------------------------------------ */

export const LIMITS = {
  youtube: { title: 100, caption: 5000, tagsChars: 500, maxShortSeconds: 180 },
  instagram: { caption: 2200, hashtags: 30, minSeconds: 3, maxSeconds: 900, maxBytes: 300 * 1024 * 1024 },
  tiktok: { caption: 2200, minSeconds: 3, maxSeconds: 600, maxBytes: 4 * 1024 * 1024 * 1024 },
} as const;

/* ------------------------------------------------------------------ */
/* Hashtags & captions                                                  */
/* ------------------------------------------------------------------ */

/** "#Pokemon, quiz  #who's_that" → ["Pokemon", "quiz", "whos_that"]. Keeps letters/numbers/underscores (any language). */
export function parseHashtags(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const t = raw.replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '');
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}

/** Hashtags already typed inside a caption. */
export function hashtagsInText(text: string): string[] {
  return parseHashtags((text.match(/#[\p{L}\p{N}_]+/gu) ?? []).join(' '));
}

export function captionFor(post: Post, p: Platform): string {
  const t = post.targets[p];
  return (t.caption ?? post.caption).trim();
}

export function hashtagsFor(post: Post, p: Platform): string[] {
  const t = post.targets[p];
  const tags = [...(t.hashtags ?? post.hashtags)];
  if (p === 'youtube' && (t as PostTarget<'youtube'>).options.shortsTag && isShort(post) && !tags.some((x) => x.toLowerCase() === 'shorts')) tags.push('Shorts');
  return tags;
}

/** Final text posted: caption, then any hashtags not already in it on their own line. */
export function finalText(post: Post, p: Platform): string {
  const cap = captionFor(post, p);
  const have = new Set(hashtagsInText(cap).map((x) => x.toLowerCase()));
  const extra = hashtagsFor(post, p).filter((x) => !have.has(x.toLowerCase()));
  return [cap, extra.map((x) => `#${x}`).join(' ')].filter(Boolean).join('\n\n');
}

/** YouTube title: the one you typed, or the caption's first line. */
export function youtubeTitle(post: Post): string {
  const t = post.targets.youtube.title.trim() || captionFor(post, 'youtube').split('\n')[0].replace(/#[\p{L}\p{N}_]+/gu, '').trim() || post.video.name.replace(/\.[^.]+$/, '');
  return t.slice(0, LIMITS.youtube.title);
}

export function isShort(post: Post): boolean {
  return post.video.height >= post.video.width && post.video.duration <= LIMITS.youtube.maxShortSeconds;
}

/** Characters as the platforms count them (emoji = 1). */
export function charCount(s: string): number {
  return [...s].length;
}

export interface Issue { level: 'error' | 'warn'; text: string }

export function checkTarget(post: Post, p: Platform): Issue[] {
  const t = post.targets[p];
  if (!t.enabled) return [];
  const out: Issue[] = [];
  const text = finalText(post, p);
  const v = post.video;
  if (p === 'youtube') {
    const title = youtubeTitle(post);
    if (!post.targets.youtube.title.trim() && !captionFor(post, p)) out.push({ level: 'warn', text: 'No title — the file name will be used.' });
    if (charCount(post.targets.youtube.title) > LIMITS.youtube.title) out.push({ level: 'error', text: `Title is ${charCount(post.targets.youtube.title)} characters (YouTube allows ${LIMITS.youtube.title}).` });
    if (/[<>]/.test(title) || /[<>]/.test(text)) out.push({ level: 'error', text: 'YouTube doesn’t allow < or > in titles or descriptions.' });
    if (charCount(text) > LIMITS.youtube.caption) out.push({ level: 'error', text: `Description is ${charCount(text)} characters (YouTube allows ${LIMITS.youtube.caption}).` });
    const tagChars = hashtagsFor(post, p).reduce((a, x) => a + x.length + 1, 0);
    if (tagChars > LIMITS.youtube.tagsChars) out.push({ level: 'warn', text: 'Too many tags for YouTube — some will be dropped.' });
    if (hashtagsFor(post, p).length > 15) out.push({ level: 'warn', text: 'YouTube ignores all hashtags when there are more than 15.' });
    if (isShort(post)) out.push({ level: 'warn', text: 'Vertical and 3 minutes or less — this will be a YouTube Short.' });
  }
  if (p === 'instagram') {
    if (charCount(text) > LIMITS.instagram.caption) out.push({ level: 'error', text: `Caption is ${charCount(text)} characters (Instagram allows ${LIMITS.instagram.caption}).` });
    const n = hashtagsInText(text).length;
    if (n > LIMITS.instagram.hashtags) out.push({ level: 'error', text: `${n} hashtags — Instagram allows ${LIMITS.instagram.hashtags}.` });
    if (v.duration && v.duration < LIMITS.instagram.minSeconds) out.push({ level: 'error', text: 'Reels must be at least 3 seconds long.' });
    if (v.duration > LIMITS.instagram.maxSeconds) out.push({ level: 'error', text: 'Reels posted this way can be up to 15 minutes.' });
    if (v.size > LIMITS.instagram.maxBytes) out.push({ level: 'error', text: 'Video is over 300 MB — export at a lower quality for Instagram.' });
    if (v.width > v.height) out.push({ level: 'warn', text: 'Reels look best vertical (9:16).' });
  }
  if (p === 'tiktok') {
    if (charCount(text) > LIMITS.tiktok.caption) out.push({ level: 'error', text: `Caption is ${charCount(text)} characters (TikTok allows ${LIMITS.tiktok.caption}).` });
    if (v.duration && v.duration < LIMITS.tiktok.minSeconds) out.push({ level: 'error', text: 'TikTok videos must be at least 3 seconds long.' });
    if (v.duration > LIMITS.tiktok.maxSeconds) out.push({ level: 'warn', text: 'Over 10 minutes — only some accounts can post videos this long.' });
    if (v.width > v.height) out.push({ level: 'warn', text: 'TikTok videos look best vertical (9:16).' });
  }
  if (!/mp4|quicktime|mov/i.test(v.mime) && !/\.(mp4|mov)$/i.test(v.name)) out.push({ level: 'error', text: `${PLATFORM_NAME[p]} needs an MP4 (or MOV) video — export as MP4.` });
  return out;
}

/* ------------------------------------------------------------------ */
/* Scheduling                                                           */
/* ------------------------------------------------------------------ */

function slotDate(base: Date, slot: QueueSlot): Date {
  const [h, m] = slot.time.split(':').map(Number);
  const d = new Date(base);
  d.setHours(h, m, 0, 0);
  return d;
}

/**
 * Next queue slot after `now` that no scheduled post already uses (within the
 * same minute). Looks up to 8 weeks ahead.
 */
export function nextQueueSlot(slots: QueueSlot[], taken: number[], now = Date.now()): number | null {
  if (!slots.length) return null;
  const used = new Set(taken.map((t) => Math.floor(t / 60000)));
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  for (let day = 0; day < 56; day++) {
    const d = new Date(start);
    d.setDate(start.getDate() + day);
    const todays = slots.filter((s) => s.day === d.getDay()).map((s) => slotDate(d, s).getTime()).sort((a, b) => a - b);
    for (const t of todays) if (t > now + 60_000 && !used.has(Math.floor(t / 60000))) return t;
  }
  return null;
}

/** Targets whose time has come and still need doing. */
export function dueTargets(posts: Post[], now = Date.now()): { post: Post; platform: Platform }[] {
  const out: { post: Post; platform: Platform }[] = [];
  for (const post of posts) {
    if (post.when === 'draft' || post.publishAt === null || post.publishAt > now) continue;
    for (const p of PLATFORMS) {
      const t = post.targets[p];
      if (t.enabled && t.status === 'waiting') out.push({ post, platform: p });
    }
  }
  return out;
}

/**
 * YouTube schedules posts itself: a direct YouTube post set for later is
 * uploaded straight away as private with a publish time.
 */
export function uploadEarly(post: Post, p: Platform, now = Date.now()): boolean {
  const t = post.targets[p];
  return p === 'youtube' && t.enabled && t.delivery === 'direct' && t.status === 'waiting' && post.when === 'at' && post.publishAt !== null && post.publishAt > now + 60_000;
}

export type PostState = 'draft' | 'scheduled' | 'working' | 'needs-you' | 'done' | 'failed' | 'partly';

export function postState(post: Post): PostState {
  if (post.when === 'draft') return 'draft';
  const ts = PLATFORMS.map((p) => post.targets[p]).filter((t) => t.enabled);
  if (!ts.length) return 'draft';
  if (ts.some((t) => t.status === 'uploading')) return 'working';
  if (ts.some((t) => t.status === 'reminded')) return 'needs-you';
  const done = (t: PostTarget) => ['posted', 'scheduled', 'drafted', 'shared', 'skipped'].includes(t.status);
  if (ts.every(done)) return 'done';
  if (ts.some((t) => t.status === 'failed')) return ts.some(done) ? 'partly' : 'failed';
  return 'scheduled';
}

/* ------------------------------------------------------------------ */
/* New posts                                                            */
/* ------------------------------------------------------------------ */

let seq = 0;
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function defaultTarget<P extends Platform>(platform: P, accountId: string | null, delivery: Delivery): PostTarget<P> {
  const options = {
    youtube: { privacy: 'public', madeForKids: false, categoryId: '24', shortsTag: true } as YouTubeOptions,
    instagram: { shareToFeed: true, coverAt: 0 } as InstagramOptions,
    tiktok: { privacy: 'PUBLIC_TO_EVERYONE', allowComments: true, allowDuet: true, allowStitch: true, asDraft: false } as TikTokOptions,
  }[platform] as PlatformOptions[P];
  return { platform, enabled: false, accountId, delivery, title: '', caption: null, hashtags: null, options, status: 'waiting' };
}

export function newPost(video: Post['video'], defaults: { accounts: Partial<Record<Platform, string | null>>; direct: Partial<Record<Platform, boolean>> } = { accounts: {}, direct: {} }): Post {
  const now = Date.now();
  const t = <P extends Platform>(p: P) => defaultTarget(p, defaults.accounts[p] ?? null, defaults.direct[p] ? 'direct' : 'reminder');
  return {
    id: newId('post'), createdAt: now, updatedAt: now, video, caption: '', hashtags: [], when: 'at', publishAt: null,
    targets: { youtube: t('youtube'), instagram: t('instagram'), tiktok: t('tiktok') },
  };
}
