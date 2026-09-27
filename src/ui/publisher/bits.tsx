/** Small shared pieces for the post planner. */
import { useState } from 'react';
import { parseHashtags, PLATFORM_NAME, type Platform, type PostTarget } from '../../core/publish';
import { Icon } from '../components/Icon';

export const PLATFORM_COLOUR: Record<Platform, string> = { youtube: '#ff3b30', instagram: '#d6399a', tiktok: '#25f4ee' };

/** Platform badge (plain lettering in the platform's colour — no logos). */
export function PlatformBadge({ p, size = 22 }: { p: Platform; size?: number }) {
  const letter = { youtube: 'YT', instagram: 'IG', tiktok: 'TT' }[p];
  return <span className={`pf-badge pf-${p}`} style={{ width: size, height: size, fontSize: size * 0.42 }} aria-label={PLATFORM_NAME[p]} title={PLATFORM_NAME[p]}>{letter}</span>;
}

export const STATUS_TEXT: Record<PostTarget['status'], string> = {
  waiting: 'Waiting', uploading: 'Uploading', scheduled: 'Scheduled on YouTube', posted: 'Posted', drafted: 'In TikTok drafts',
  reminded: 'Your turn to post', shared: 'Done', failed: 'Failed', skipped: 'Skipped',
};

export function StatusChip({ t }: { t: PostTarget }) {
  const cls = t.status === 'failed' ? 'bad' : t.status === 'reminded' ? 'warn' : ['posted', 'scheduled', 'drafted', 'shared'].includes(t.status) ? 'good' : '';
  return (
    <span className={`status-chip ${cls}`}>
      <PlatformBadge p={t.platform} size={16} />
      {t.status === 'uploading' ? `Uploading ${Math.round((t.progress ?? 0) * 100)}%` : STATUS_TEXT[t.status]}
    </span>
  );
}

/** Hashtag editor: type or paste; Enter, space or comma adds. */
export function HashtagInput({ value, onChange, label, placeholder = 'Add hashtags' }: { value: string[]; onChange: (v: string[]) => void; label: string; placeholder?: string }) {
  const [text, setText] = useState('');
  const add = (s: string) => {
    const tags = parseHashtags(s);
    if (tags.length) onChange([...value, ...tags.filter((t) => !value.some((v) => v.toLowerCase() === t.toLowerCase()))]);
    setText('');
  };
  return (
    <div className="tag-input" onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus()}>
      {value.map((t) => (
        <span key={t} className="tag-chip">#{t}<button onClick={() => onChange(value.filter((x) => x !== t))} aria-label={`Remove #${t}`}><Icon name="close" size={11} /></button></span>
      ))}
      <input value={text} placeholder={value.length ? '' : placeholder} aria-label={label}
        onChange={(e) => { const v = e.target.value; if (/[\s,;]$/.test(v)) add(v); else setText(v); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); add(text); }
          if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
        }}
        onPaste={(e) => { const t = e.clipboardData.getData('text'); if (/[\s,#]/.test(t)) { e.preventDefault(); add(text + t); } }}
        onBlur={() => text && add(text)} />
    </div>
  );
}

/** "Mon 29 Sep, 18:00" */
export function when(ts: number | null): string {
  if (!ts) return 'No time set';
  const d = new Date(ts), now = new Date();
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (sameDay(d, now)) return `Today, ${time}`;
  if (sameDay(d, tomorrow)) return `Tomorrow, ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}, ${time}`;
}

/** Value for <input type="datetime-local"> in local time. */
export function toLocalInput(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const OPEN_URL: Record<Platform, string> = {
  youtube: 'https://studio.youtube.com/',
  instagram: 'https://www.instagram.com/',
  tiktok: 'https://www.tiktok.com/tiktokstudio/upload',
};
