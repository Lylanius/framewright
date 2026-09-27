/**
 * Posts one platform's part of a post, using whichever publisher fits.
 * Returns the new target state plus any renewed sign-in tokens to save.
 */
import { finalText, hashtagsFor, isShort, youtubeTitle, type Platform, type Post, type PostTarget } from '../../core/publish';
import { PublishError, type Http, type PlatformApp, type Progress, type Tokens, type VideoSource } from './http';
import { instagramFresh, instagramPublish } from './instagram';
import { tiktokFresh, tiktokPublish } from './tiktok';
import { youtubeFresh, youtubeUpload } from './youtube';

export interface Account {
  id: string;
  platform: Platform;
  name: string;
  handle: string;
  avatar?: string;
  /** Channel id (YouTube), user id (Instagram), open id (TikTok). */
  remoteId: string;
  tokens: Tokens;
  addedAt: number;
}

export interface PublishOutcome { target: PostTarget; tokens: Tokens }

export async function publishTarget(http: Http, post: Post, platform: Platform, account: Account, app: PlatformApp | null, video: VideoSource, onProgress: Progress = () => undefined): Promise<PublishOutcome> {
  const target = post.targets[platform];
  let tokens = account.tokens;
  const text = finalText(post, platform);
  try {
    if (platform === 'youtube') {
      if (!app) throw new PublishError('Add your Google Cloud client ID and secret in Accounts first.');
      tokens = await youtubeFresh(http, app, tokens);
      const o = post.targets.youtube.options;
      const r = await youtubeUpload(http, tokens, video, {
        title: youtubeTitle(post), description: text, tags: hashtagsFor(post, 'youtube'), categoryId: o.categoryId,
        privacy: o.privacy, madeForKids: o.madeForKids, publishAt: post.when === 'at' ? post.publishAt ?? undefined : undefined, short: isShort(post),
      }, onProgress);
      const scheduled = post.when === 'at' && !!post.publishAt && post.publishAt > Date.now() + 60_000;
      return { tokens, target: { ...target, status: scheduled ? 'scheduled' : 'posted', progress: 1, error: undefined, result: { id: r.id, url: r.url, note: r.note }, doneAt: Date.now() } };
    }
    if (platform === 'instagram') {
      tokens = await instagramFresh(http, tokens);
      const o = post.targets.instagram.options;
      const r = await instagramPublish(http, tokens, account.remoteId, video, { caption: text, shareToFeed: o.shareToFeed, coverAt: o.coverAt }, onProgress);
      return { tokens, target: { ...target, status: 'posted', progress: 1, error: undefined, result: { id: r.id, url: r.url }, doneAt: Date.now() } };
    }
    if (!app) throw new PublishError('Add your TikTok client key and secret in Accounts first.');
    tokens = await tiktokFresh(http, app, tokens);
    const o = post.targets.tiktok.options;
    const r = await tiktokPublish(http, tokens, video, { caption: text, privacy: o.privacy, allowComments: o.allowComments, allowDuet: o.allowDuet, allowStitch: o.allowStitch, asDraft: o.asDraft, coverAt: post.targets.instagram.options.coverAt }, onProgress);
    return { tokens, target: { ...target, status: r.drafted ? 'drafted' : 'posted', progress: 1, error: undefined, result: { id: r.id, url: r.url, note: r.note }, doneAt: Date.now() } };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { tokens, target: { ...target, status: 'failed', progress: undefined, error: msg } };
  }
}

export { PublishError };
export type { Http, PlatformApp, Tokens, VideoSource };
