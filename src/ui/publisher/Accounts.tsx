/**
 * Connected accounts, plus one-time setup guides for each platform's
 * developer access (you use your own — nothing goes through a Framewright server).
 */
import { useState } from 'react';
import { PLATFORM_NAME, PLATFORMS, type Platform } from '../../core/publish';
import { Icon } from '../components/Icon';
import { useApp } from '../store';
import { PlatformBadge } from './bits';
import { canPostDirect, usePublish } from './pubStore';

const GUIDE: Record<Platform, { steps: React.ReactNode[]; limits: string }> = {
  youtube: {
    steps: [
      <>Open <a className="link" href="https://console.cloud.google.com/" target="_blank" rel="noreferrer">Google Cloud Console</a> and create a project (e.g. “Framewright”).</>,
      <>APIs &amp; Services → Library → turn on <b>YouTube Data API v3</b>.</>,
      <>Google Auth Platform (OAuth consent screen) → <b>External</b>, give it a name and your email. Under Audience, click <b>Publish app</b> so sign-ins don’t expire every 7 days.</>,
      <>Clients → Create client → type <b>Desktop app</b>. Copy the <b>Client ID</b> and <b>Client secret</b> below.</>,
      <>Click Connect. Google will say the app isn’t verified — it’s your own app, so choose <b>Advanced → Go to Framewright</b>.</>,
    ],
    limits: 'Until your Google project passes YouTube’s free API audit, videos uploaded this way stay private — make them public in YouTube Studio, or apply for the audit to post publicly. Scheduling is done by YouTube, so it works even if your computer is off.',
  },
  instagram: {
    steps: [
      <>Your Instagram needs to be a <b>professional account</b> (Business or Creator) — in the Instagram app: Settings → Account type and tools.</>,
      <>Open <a className="link" href="https://developers.facebook.com/apps/" target="_blank" rel="noreferrer">Meta for Developers</a> → Create app → choose the Instagram use case (“Manage messaging &amp; content on Instagram”).</>,
      <>In the app: Instagram → <b>API setup with Instagram login</b> → Generate access tokens → Add account, sign in to your Instagram and allow access.</>,
      <>Copy the token and paste it below. It lasts 60 days and Framewright renews it whenever it posts.</>,
    ],
    limits: 'Instagram posts Reels (3 s – 15 min, MP4, up to 300 MB). The app can stay in development mode for your own account. Instagram has no scheduling of its own, so Framewright posts at the time — keep it running (Settings).',
  },
  tiktok: {
    steps: [
      <>Open <a className="link" href="https://developers.tiktok.com/apps/" target="_blank" rel="noreferrer">TikTok for Developers</a> → Manage apps → Connect an app; choose <b>Desktop</b> as the platform.</>,
      <>Add <b>Login Kit</b> and <b>Content Posting API</b> (switch on “Direct Post”). Scopes: user.info.basic, video.upload, video.publish.</>,
      <>Login Kit → Desktop redirect URI: <code>http://127.0.0.1:*/callback/</code></>,
      <>Copy the <b>Client key</b> and <b>Client secret</b> below, then Connect. While the app is in sandbox, add your TikTok account as a target user.</>,
    ],
    limits: 'Until TikTok audits your app, direct posts are “Only me” (change them to public in the TikTok app) — or tick “Send to my TikTok drafts” to finish posting in the app. TikTok has no scheduling of its own, so Framewright posts at the time.',
  },
};

function PlatformAccounts({ p }: { p: Platform }) {
  const { accounts, apps, saveApp, connect, disconnect } = usePublish();
  const toast = useApp((s) => s.toast);
  const mine = accounts.filter((a) => a.platform === p);
  const app = p === 'instagram' ? null : apps[p];
  const [setup, setSetup] = useState(!mine.length);
  const [id, setId] = useState(app?.clientId ?? '');
  const [secret, setSecret] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const direct = canPostDirect();
  const ready = p === 'instagram' ? !!token.trim() : !!app?.clientId && app.hasSecret;

  const doConnect = async () => {
    setBusy(true);
    try {
      if (p !== 'instagram' && (id.trim() !== (app?.clientId ?? '') || secret.trim())) await saveApp(p, id, secret);
      const a = await connect(p, token);
      toast(`Connected ${PLATFORM_NAME[p]}: ${a.name}`, 'success');
      setToken(''); setSecret(''); setSetup(false);
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };

  return (
    <section className="acct-section">
      <div className="row" style={{ gap: 8 }}>
        <PlatformBadge p={p} size={26} /><h3 className="grow">{PLATFORM_NAME[p]}</h3>
        {direct && <button className="btn sm ghost" onClick={() => setSetup(!setup)}>{setup ? 'Hide set-up' : 'Set up / add account'}</button>}
      </div>
      {mine.map((a) => (
        <div key={a.id} className="acct-row">
          {a.avatar ? <img src={a.avatar} alt="" /> : <span className="acct-avatar">{a.name.slice(0, 1)}</span>}
          <div className="grow"><b>{a.name}</b>{a.handle && <small className="faint"> {a.handle.startsWith('@') ? a.handle : `@${a.handle}`}</small>}</div>
          <button className="btn sm" onClick={() => void disconnect(a.id).then(() => toast('Disconnected.'))}>Disconnect</button>
        </div>
      ))}
      {!mine.length && <small className="faint">No account connected — posts to {PLATFORM_NAME[p]} use reminders.</small>}
      {setup && direct && (
        <div className="acct-setup">
          <ol>{GUIDE[p].steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
          {p === 'instagram' ? (
            <label className="field"><span>Instagram access token</span>
              <input className="input" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="IGAA…" aria-label="Instagram access token" autoComplete="off" />
            </label>
          ) : (
            <div className="row wrap" style={{ gap: 8 }}>
              <label className="field grow"><span>{p === 'youtube' ? 'Client ID' : 'Client key'}</span>
                <input className="input" value={id} onChange={(e) => setId(e.target.value)} aria-label={`${PLATFORM_NAME[p]} client id`} autoComplete="off" />
              </label>
              <label className="field grow"><span>Client secret {app?.hasSecret && <small className="faint">(saved — leave blank to keep)</small>}</span>
                <input className="input" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} aria-label={`${PLATFORM_NAME[p]} client secret`} autoComplete="off" />
              </label>
            </div>
          )}
          <button className="btn primary" disabled={busy || (!ready && !(p !== 'instagram' && id.trim() && (secret.trim() || app?.hasSecret)))} onClick={() => void doConnect()}>
            <Icon name="plus" size={14} />{busy ? (p === 'instagram' ? 'Checking…' : 'Waiting for you in the browser…') : `Connect ${PLATFORM_NAME[p]}`}
          </button>
          <small className="faint">{GUIDE[p].limits}</small>
        </div>
      )}
    </section>
  );
}

export function Accounts() {
  const direct = canPostDirect();
  return (
    <div className="accounts">
      {!direct && (
        <div className="notice"><Icon name="info" size={16} /><div>
          Here, every post works by <b>reminder</b>: at the time you’re notified, the caption is copied and the video is ready to share to the app.
          To have posts go out automatically, use the <b>Framewright desktop app</b> and connect your accounts there.
        </div></div>
      )}
      {direct && <p className="faint">Connect once and Framewright can post for you. You use your own free developer access for each platform — your videos go straight from this computer to the platform, never through anyone else. Sign-ins are stored encrypted on this computer.</p>}
      {PLATFORMS.map((p) => <PlatformAccounts key={p} p={p} />)}
    </div>
  );
}
