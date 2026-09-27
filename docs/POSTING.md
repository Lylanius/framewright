# Post planner — posting to YouTube, Instagram and TikTok

Open it from the home screen (**Post planner**), the editor's **Post** button, or **Post or schedule** after an export.

## What it does

- One video → YouTube, Instagram and TikTok together.
- A shared caption and hashtags, with a different caption, hashtags or (YouTube) title per platform when you want.
- Post now, **add to your queue** (the next free time from your weekly posting times), pick an exact date and time, or save a draft.
- Week calendar, a "Needs you" list, posted history with links, hashtag sets, and checks for each platform's limits (caption length, 30 hashtags on Instagram, video length/format).

## Two ways a post goes out

| | Post for me | Remind me |
|---|---|---|
| Where | Desktop app, with the account connected | Everywhere (desktop, web, phone) |
| At the time | Framewright uploads it itself | You get a notification; the caption is copied and the video is ready to share into the app |
| Needs | Your own free developer access for that platform (below) | Nothing |

Posts are kept on your device until their time and go only to the platforms you picked. Nothing goes through a Framewright server.

**Timing:** YouTube schedules posts itself (Framewright uploads straight away with a publish time), so those go out even if your computer is off. Instagram and TikTok have no scheduling in their posting APIs, so the desktop app posts at the time — turn on **Settings → Keep running in the background** so it keeps going in the system tray when you close the window. If the computer was off or asleep, the post waits in **Needs you** and asks you. On phones, reminders are system notifications, so they arrive even when the app is closed.

## Connecting accounts (desktop app, one-time)

The platforms only let apps post if they're registered with them. Registering your own is free and takes about 10 minutes each; the app shows these steps too (Post planner → Accounts).

### YouTube
1. [Google Cloud Console](https://console.cloud.google.com/) → create a project.
2. APIs & Services → Library → enable **YouTube Data API v3**.
3. Google Auth Platform / OAuth consent screen → External → name + your email. Audience → **Publish app** (otherwise Google ends the sign-in every 7 days).
4. Clients → Create client → **Desktop app** → copy the Client ID and secret into Framewright → Connect.
5. Google warns the app isn't verified — it's yours, so Advanced → Go to Framewright.

**Limit:** Google locks videos uploaded by un-audited projects to *private*. Make them public in YouTube Studio, or apply for YouTube's free API audit.

### Instagram
1. The account must be **professional** (Business or Creator).
2. [Meta for Developers](https://developers.facebook.com/apps/) → Create app → Instagram use case.
3. Instagram → API setup with Instagram login → Generate access tokens → add your account.
4. Paste the token into Framewright. It lasts 60 days and is renewed each time Framewright posts.

**Limits:** Reels of 3 s – 15 min, MP4, up to 300 MB; about 100 posts a day.

### TikTok
1. [TikTok for Developers](https://developers.tiktok.com/apps/) → Connect an app (platform: Desktop).
2. Add **Login Kit** and **Content Posting API** (turn on Direct Post). Scopes: `user.info.basic`, `video.upload`, `video.publish`.
3. Desktop redirect URI: `http://127.0.0.1:*/callback/`
4. Copy the client key and secret into Framewright → Connect. In sandbox, add your account as a target user.

**Limit:** until TikTok audits your app, direct posts are "Only me" (switch them to public in the TikTok app). Or tick **Send to my TikTok drafts**: the video lands in your TikTok inbox to finish there (the caption is copied for you).

## Privacy and security
- Sign-in tokens and client secrets are stored by the desktop app, encrypted with the system keychain (Windows DPAPI / macOS Keychain / Linux secret service where available) — never in the page's storage.
- The app can only reach the platforms' own addresses for posting (Google, Instagram/Facebook, TikTok).
- The planner keeps its own copy of a scheduled video until it's posted everywhere (then deletes it, unless you switch that off). Your project and exports are never touched.

## Tested
- Unit tests for captions, hashtags, limits, queue slots and scheduling, and for each uploader against fake platform servers (chunking, resumes, errors, token renewal).
- Browser tests for the planner on phone and desktop sizes (compose, queue, calendar, reminders, share, settings, export → post).
- `tests/desktop/publish-smoke.mjs`: the desktop app connects all three accounts (browser sign-in through the 127.0.0.1 callback, token paste), posts one video to all three, and schedules a YouTube post — against fake servers.
- **Not yet tried against the real platforms** (that needs your developer apps and accounts). The requests follow each platform's current documentation.
