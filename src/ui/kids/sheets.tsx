/**
 * Kids Studio pop-up sheets: stickers, words, music, sounds, talking, joins,
 * colours, speed, making a clip shorter and how long things show.
 * Every choice does something straight away (and "Oops" undoes it).
 */
import { useEffect, useRef, useState } from 'react';
import {
  addEmoji, addPictureSticker, addSound, addWords, clipRange, currentLook, editWords, KID_JOINS, KID_LOOKS, KID_MOTIONS, KID_SPEEDS, KID_TEXT, KID_TEXT_COLOURS, KID_TEXT_IN,
  setBackwards, setClipVolume, setJoins, setKidSpeed, setLook, setMotion, setMusic, setShowFor, textStyleOf, trimInStrip,
} from '../../core/kids';
import { KID_TUNES, tuneFile } from '../../core/kidsMusic';
import { SFX, sfxFile } from '../../core/sfx';
import { findClip } from '../../core/timeline';
import type { Clip, Project, TextAnimation } from '../../core/types';
import { VoiceRecorder } from '../VoiceRecorder';
import { useApp, useTime } from '../store';

export type SheetId = 'stickers' | 'words' | 'music' | 'sounds' | 'talk' | 'joins' | 'colours' | 'speed' | 'trim' | 'showfor' | 'motion' | 'volume';

/* ---------------- shared bits ---------------- */

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <>
      <div className="k-sheet-back" onClick={onClose} />
      <section className="k-sheet" role="dialog" aria-label={title}>
        <header><h2>{title}</h2><button className="k-x" onClick={onClose} aria-label="Close">✕</button></header>
        <div className="k-sheet-body">{children}</div>
      </section>
    </>
  );
}

const now = () => useTime.getState().time;
const apply = (label: string, fn: (p: Project) => Project) => useApp.getState().apply(label, fn);
const toast = (t: string) => useApp.getState().toast(t, 'success');

/** Play a sound file once (the last one stops when another starts). */
let playing: HTMLAudioElement | null = null;
export function hear(f: Blob): void {
  playing?.pause();
  const url = URL.createObjectURL(f);
  playing = new Audio(url);
  playing.onended = () => URL.revokeObjectURL(url);
  void playing.play().catch(() => URL.revokeObjectURL(url));
}
export function stopHearing(): void { playing?.pause(); playing = null; }

async function importOne(f: File): Promise<string | undefined> {
  return (await useApp.getState().importFiles([f]))[0];
}
const mediaById = (id?: string) => useApp.getState().project?.media.find((m) => m.id === id);

/* ---------------- stickers ---------------- */

export const KID_EMOJI = ['🦄', '🐶', '🐱', '🐰', '🦊', '🐼', '🐸', '🦖', '🐬', '🦋', '🐝', '🐙', '🌈', '⭐', '🌟', '✨', '❤️', '💖', '🎉', '🎈',
  '🎂', '🍕', '🍦', '🍩', '🍓', '🌸', '🌻', '☀️', '🌙', '❄️', '⚽', '🎮', '🎨', '🎵', '👑', '😎', '😂', '🥳', '😍', '👍'];

export function StickersSheet({ onClose, onAdded }: { onClose: () => void; onAdded: (id: string) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const add = (emoji: string) => {
    let id = '';
    apply('Add sticker', (p) => { const r = addEmoji(p, emoji, now()); id = r.id; return r.project; });
    onAdded(id);
  };
  return (
    <Sheet title="Stickers" onClose={onClose}>
      <div className="k-emoji-grid">
        {KID_EMOJI.map((e) => <button key={e} className="k-emoji" onClick={() => add(e)} aria-label={`Add ${e}`}>{e}</button>)}
      </div>
      <button className="k-btn sky wide" onClick={() => fileRef.current?.click()}><span className="k-ico">📷</span>Use a photo as a sticker</button>
      <input ref={fileRef} type="file" accept="image/*" hidden aria-label="Picture sticker" onChange={async (e) => {
        const f = e.target.files?.[0]; e.target.value = '';
        if (!f) return;
        const m = mediaById(await importOne(f));
        if (!m) return;
        let id = '';
        apply('Add picture sticker', (p) => { const r = addPictureSticker(p, m, now()); id = r.id; return r.project; });
        onAdded(id);
      }} />
      <p className="k-hint">Drag to move it, pinch to resize or turn it.</p>
    </Sheet>
  );
}

/* ---------------- words ---------------- */

export function WordsSheet({ onClose, onAdded, editId }: { onClose: () => void; onAdded: (id: string) => void; editId?: string }) {
  const editing = editId ? findClip(useApp.getState().project!, editId)?.clip : undefined;
  const [words, setWords] = useState(editing?.text?.content ?? '');
  const [style, setStyle] = useState(editing ? textStyleOf(editing) : KID_TEXT[0].id);
  const [colour, setColour] = useState<string | null>(null);
  const [animIn, setAnimIn] = useState<TextAnimation>(editing?.text?.animIn ?? 'pop');
  const two = !!KID_TEXT.find((s) => s.id === style)?.style.gradient;
  const done = () => {
    if (!words.trim()) { onClose(); return; }
    const o = { colour, animIn };
    if (editing) { apply('Edit text', (p) => editWords(p, editing.id, words, style, o)); onClose(); return; }
    let id = '';
    apply('Add text', (p) => { const r = addWords(p, words, style, now(), o); id = r.id; return r.project; });
    onAdded(id);
  };
  return (
    <Sheet title={editing ? 'Edit text' : 'Text'} onClose={onClose}>
      <textarea className="k-input" rows={2} maxLength={80} value={words} autoFocus placeholder="Type here…" aria-label="Your text"
        onChange={(e) => setWords(e.target.value)} />
      <div className="k-text-styles" role="radiogroup" aria-label="Font">
        {KID_TEXT.map((s) => (
          <button key={s.id} role="radio" aria-checked={style === s.id} className={`k-text-style${style === s.id ? ' on' : ''}`} onClick={() => setStyle(s.id)}>
            <span style={{
              fontFamily: `"${s.style.fontFamily}"`, fontWeight: s.style.fontWeight ?? 400,
              color: s.style.gradient ? s.style.gradient.from : (colour ?? s.style.color), background: s.style.background ?? undefined,
              WebkitTextStroke: s.style.strokeWidth && s.id !== 'game' ? `${Math.min(1.5, s.style.strokeWidth / 8)}px ${s.style.strokeColor}` : undefined,
              fontSize: s.id === 'game' ? 13 : 24,
            }}>Aa</span>
            <small>{s.name}</small>
          </button>
        ))}
      </div>
      <div className="k-colours" role="radiogroup" aria-label="Colour">
        <button role="radio" aria-checked={!colour} className={`k-colour auto${!colour ? ' on' : ''}`} onClick={() => setColour(null)} aria-label="Style’s own colour">✦</button>
        {KID_TEXT_COLOURS.map((c) => (
          <button key={c} role="radio" aria-checked={colour === c} disabled={two} className={`k-colour${colour === c ? ' on' : ''}`} style={{ background: c }} onClick={() => setColour(c)} aria-label={`Colour ${c}`} />
        ))}
      </div>
      <div className="k-choice-row left" role="radiogroup" aria-label="How it appears">
        {KID_TEXT_IN.map((a) => (
          <button key={a.id} role="radio" aria-checked={animIn === a.id} className={`k-chip${animIn === a.id ? ' on' : ''}`} onClick={() => setAnimIn(a.id)}>{a.name}</button>
        ))}
      </div>
      <button className="k-btn sun wide" onClick={done} disabled={!words.trim()}>{editing ? 'Done' : 'Add text'}</button>
    </Sheet>
  );
}

/* ---------------- music ---------------- */

const LOUDNESS = [{ v: 0.25, name: 'Quiet' }, { v: 0.45, name: 'Medium' }, { v: 0.7, name: 'Loud' }];
const tuneMedia = new Map<string, string>();

export function MusicSheet({ onClose }: { onClose: () => void }) {
  const project = useApp((s) => s.project)!;
  const current = project.kids?.music;
  const currentTune = current ? KID_TUNES.find((t) => mediaById(current.mediaId)?.name.startsWith(`Music - ${t.name}`))?.id : null;
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => () => stopHearing(), []);
  const choose = async (id: string) => {
    setBusy(id);
    try {
      let mid = tuneMedia.get(id);
      if (!mid || !mediaById(mid)) { mid = await importOne(tuneFile(id)); if (mid) tuneMedia.set(id, mid); }
      if (mid) apply('Add music', (p) => setMusic(p, mid!, current?.volume ?? 0.45));
      toast(`${KID_TUNES.find((t) => t.id === id)!.name} is playing under your video.`);
    } finally { setBusy(null); }
  };
  return (
    <Sheet title="Music" onClose={onClose}>
      <div className="k-list">
        {KID_TUNES.map((t) => (
          <div key={t.id} className={`k-row${currentTune === t.id ? ' on' : ''}`}>
            <button className="k-row-main" onClick={() => void choose(t.id)} disabled={!!busy} aria-pressed={currentTune === t.id}>
              <span className="k-big-emoji">{t.emoji}</span>
              <span className="grow"><b>{t.name}</b><small>{busy === t.id ? 'Getting it ready…' : t.description}</small></span>
              {currentTune === t.id && <span className="k-tick" aria-label="Chosen">✓</span>}
            </button>
            <button className="k-round sky" onClick={() => hear(tuneFile(t.id))} aria-label={`Hear ${t.name}`}>▶</button>
          </div>
        ))}
        <div className={`k-row${!current ? ' on' : ''}`}>
          <button className="k-row-main" onClick={() => apply('No music', (p) => setMusic(p, null))} aria-pressed={!current}>
            <span className="k-big-emoji">🔇</span><span className="grow"><b>No music</b></span>
            {!current && <span className="k-tick" aria-label="Chosen">✓</span>}
          </button>
        </div>
      </div>
      {current && (
        <div className="k-choice-row" role="radiogroup" aria-label="How loud">
          {LOUDNESS.map((l) => (
            <button key={l.name} role="radio" aria-checked={Math.abs(current.volume - l.v) < 0.01} className={`k-chip${Math.abs(current.volume - l.v) < 0.01 ? ' on' : ''}`}
              onClick={() => apply('Music loudness', (p) => setMusic(p, current.mediaId, l.v))}>{l.name}</button>
          ))}
        </div>
      )}
    </Sheet>
  );
}

/* ---------------- sounds ---------------- */

const KID_SFX: { id: string; emoji: string; name: string }[] = [
  { id: 'pop', emoji: '🫧', name: 'Pop' }, { id: 'boing', emoji: '🦘', name: 'Boing' }, { id: 'whee', emoji: '🎢', name: 'Wheee!' },
  { id: 'tada', emoji: '🎉', name: 'Ta-da' }, { id: 'whoosh', emoji: '💨', name: 'Whoosh' }, { id: 'sparkle', emoji: '✨', name: 'Sparkle' },
  { id: 'boom', emoji: '💥', name: 'Boom' }, { id: 'ding', emoji: '🔔', name: 'Ding' }, { id: 'buzzer', emoji: '🙈', name: 'Uh-oh' },
  { id: 'riser', emoji: '😮', name: 'Suspense' },
];

export function SoundsSheet({ onClose }: { onClose: () => void }) {
  const add = async (id: string) => {
    const def = SFX.find((s) => s.id === id)!;
    const f = sfxFile(def);
    hear(f);
    const m = mediaById(await importOne(f));
    if (!m) return;
    apply('Add sound', (p) => addSound(p, m, now()).project);
    toast(`Added ${KID_SFX.find((s) => s.id === id)!.name} here.`);
  };
  return (
    <Sheet title="Sounds" onClose={onClose}>
      <p className="k-hint">Tap one to add it at the playhead (and hear it).</p>
      <div className="k-tiles">
        {KID_SFX.map((s) => (
          <button key={s.id} className="k-tile" onClick={() => void add(s.id)}><span className="k-big-emoji">{s.emoji}</span>{s.name}</button>
        ))}
      </div>
    </Sheet>
  );
}

/* ---------------- talk (voice-over) ---------------- */

export function TalkSheet({ onClose }: { onClose: () => void }) {
  const [count, setCount] = useState(0);
  return (
    <Sheet title="Voiceover" onClose={onClose}>
      <p className="k-hint">Record up to 30 seconds. It starts at the playhead.</p>
      <div className="k-talk">
        <VoiceRecorder className="k-btn pink huge" label="Record" maxSeconds={30} fileName={`Voiceover ${count + 1}.wav`}
          onError={(m) => useApp.getState().toast(m, 'error')}
          onDone={async (f) => {
            const m = mediaById(await importOne(f));
            if (!m) return;
            apply('Add voiceover', (p) => addSound(p, m, now()).project);
            setCount((n) => n + 1);
            toast('Voiceover added — press play to hear it.');
          }} />
      </div>
    </Sheet>
  );
}

/* ---------------- joins ---------------- */

export function JoinsSheet({ onClose }: { onClose: () => void }) {
  const project = useApp((s) => s.project)!;
  const current = project.kids?.joins ?? null;
  return (
    <Sheet title="Transitions" onClose={onClose}>
      <p className="k-hint">How each clip changes into the next one — used between all of them.</p>
      <div className="k-tiles">
        {KID_JOINS.map((j) => (
          <button key={j.id} className={`k-tile${current === j.type ? ' on' : ''}`} aria-pressed={current === j.type}
            onClick={() => apply('Transitions', (p) => setJoins(p, j.type))}>
            <span className="k-big-emoji">{j.emoji}</span>{j.name}
          </button>
        ))}
      </div>
    </Sheet>
  );
}

/* ---------------- colours ---------------- */

export function ColoursSheet({ onClose, clip }: { onClose: () => void; clip?: Clip }) {
  const live = useApp((s) => (clip ? s.project && findClip(s.project, clip.id)?.clip : undefined));
  const current = live ? currentLook(live) : null;
  return (
    <Sheet title={clip ? 'Filter' : 'Filter for every clip'} onClose={onClose}>
      <div className="k-tiles">
        {KID_LOOKS.map((l) => (
          <button key={l.id} className={`k-tile${current === l.id ? ' on' : ''}`} aria-pressed={current === l.id}
            onClick={() => apply('Filter', (p) => setLook(p, clip?.id ?? null, l.id))}>
            <span className="k-swatch" style={{ background: `linear-gradient(135deg, ${l.swatch[0]}, ${l.swatch[1]})` }}>{l.emoji}</span>{l.name}
          </button>
        ))}
      </div>
      {clip && current && <button className="k-btn sky wide" onClick={() => { apply('Filter on every clip', (p) => setLook(p, null, current)); toast('Every clip has that filter now.'); }}>Use on every clip</button>}
    </Sheet>
  );
}

/* ---------------- speed ---------------- */

export function SpeedSheet({ onClose, clip }: { onClose: () => void; clip: Clip }) {
  const live = useApp((s) => s.project && findClip(s.project, clip.id)?.clip) ?? clip;
  return (
    <Sheet title="Speed" onClose={onClose}>
      <div className="k-tiles four">
        {KID_SPEEDS.map((s) => (
          <button key={s.id} className={`k-tile${live.speed === s.speed ? ' on' : ''}`} aria-pressed={live.speed === s.speed}
            onClick={() => apply('Speed', (p) => setKidSpeed(p, clip.id, s.speed))}>
            <span className="k-big-emoji">{s.emoji}</span>{s.name}
          </button>
        ))}
      </div>
      {live.kind === 'video' && (
        <button className={`k-btn wide ${live.reverse ? 'pink' : 'sky'}`} aria-pressed={live.reverse} onClick={() => apply('Backwards', (p) => setBackwards(p, clip.id, !live.reverse))}>
          <span className="k-ico">🔄</span>{live.reverse ? 'Reverse is on' : 'Reverse'}
        </button>
      )}
    </Sheet>
  );
}

/* ---------------- make it shorter ---------------- */

const fmt = (s: number) => `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;

export function TrimSheet({ onClose, clip }: { onClose: () => void; clip: Clip }) {
  const project = useApp((s) => s.project)!;
  const live = findClip(project, clip.id)?.clip ?? clip;
  const media = project.media.find((m) => m.id === live.mediaId);
  if (live.kind !== 'video' || !media) {
    return (
      <Sheet title="Length" onClose={onClose}>
        <p className="k-hint">How long this photo shows for.</p>
        <div className="k-tiles four">
          {[2, 3, 5, 8].map((s) => (
            <button key={s} className={`k-tile${Math.abs(live.duration - s) < 0.05 ? ' on' : ''}`} onClick={() => apply('Length', (p) => trimInStrip(p, clip.id, 0, s))}>
              <span className="k-big-emoji">{s <= 2 ? '⚡' : s <= 3 ? '👍' : s <= 5 ? '🙂' : '🐌'}</span>{s} seconds
            </button>
          ))}
        </div>
      </Sheet>
    );
  }
  return <VideoTrim clip={live} total={media.duration} thumbs={media.thumbnails ?? []} onClose={onClose} />;
}

function VideoTrim({ clip, total, thumbs, onClose }: { clip: Clip; total: number; thumbs: string[]; onClose: () => void }) {
  const project = useApp((s) => s.project)!;
  const r = clipRange(project, clip);
  const [range, setRange] = useState<[number, number]>([r.from, r.to]);
  const [active, setActive] = useState<0 | 1 | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const MIN = Math.min(0.5, total);
  const at = (clientX: number) => {
    const b = barRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - b.left) / b.width)) * total;
  };
  const commit = (a: number, b: number) => {
    useApp.getState().apply('Trim', (p) => trimInStrip(p, clip.id, a, b), `kid-trim:${clip.id}`);
    const c = findClip(useApp.getState().project!, clip.id)?.clip;
    if (c) useApp.getState().player?.seek(c.start);
  };
  const thumbAt = (sec: number) => thumbs.length ? thumbs[Math.min(thumbs.length - 1, Math.floor((sec / Math.max(0.01, total)) * thumbs.length))] : null;
  const showing = active === null ? null : thumbAt(range[active]);
  const pct = (s: number) => `${(s / total) * 100}%`;
  return (
    <Sheet title="Trim" onClose={onClose}>
      <p className="k-hint">Drag the yellow handles to choose the part to keep.</p>
      {showing && <img className="k-trim-peek" src={showing} alt="" />}
      <div className="k-trim" ref={barRef}
        onPointerMove={(e) => {
          if (active === null) return;
          const t = at(e.clientX);
          setRange(([a, b]) => (active === 0 ? [Math.min(t, b - MIN), b] : [a, Math.max(t, a + MIN)]));
        }}
        onPointerUp={() => { if (active !== null) { setActive(null); commit(range[0], range[1]); } }}
        onPointerCancel={() => setActive(null)}>
        <div className="k-trim-film">{(thumbs.length ? thumbs : [null]).map((t, i) => <span key={i} style={t ? { backgroundImage: `url(${t})` } : undefined} />)}</div>
        <div className="k-trim-dim" style={{ left: 0, width: pct(range[0]) }} />
        <div className="k-trim-dim" style={{ left: pct(range[1]), right: 0 }} />
        <div className="k-trim-keep" style={{ left: pct(range[0]), width: pct(range[1] - range[0]) }} />
        {[0, 1].map((h) => (
          <button key={h} className="k-trim-handle" style={{ left: pct(range[h]) }} aria-label={h ? 'End' : 'Start'}
            role="slider" aria-valuemin={0} aria-valuemax={Math.round(total * 10) / 10} aria-valuenow={Math.round(range[h] * 10) / 10}
            onPointerDown={(e) => { e.currentTarget.parentElement!.setPointerCapture(e.pointerId); setActive(h as 0 | 1); }}
            onKeyDown={(e) => {
              const d = e.key === 'ArrowLeft' ? -0.25 : e.key === 'ArrowRight' ? 0.25 : 0;
              if (!d) return;
              e.preventDefault();
              const next: [number, number] = h ? [range[0], Math.min(total, Math.max(range[0] + MIN, range[1] + d))] : [Math.max(0, Math.min(range[1] - MIN, range[0] + d)), range[1]];
              setRange(next); commit(next[0], next[1]);
            }} />
        ))}
      </div>
      <p className="k-trim-info">Keeping <b>{fmt(range[0])} – {fmt(range[1])}</b> ({fmt(range[1] - range[0])} of {fmt(total)})</p>
      <button className="k-btn sun wide" onClick={onClose}>Done</button>
    </Sheet>
  );
}

/* ---------------- how long a sticker / words show ---------------- */

export function ShowForSheet({ onClose, clip }: { onClose: () => void; clip: Clip }) {
  const choices: { v: number | 'all'; name: string; emoji: string }[] = [
    { v: 1, name: '1 second', emoji: '⚡' }, { v: 2, name: '2 seconds', emoji: '👍' }, { v: 3, name: '3 seconds', emoji: '🙂' },
    { v: 5, name: '5 seconds', emoji: '🐢' }, { v: 'all', name: 'The whole video', emoji: '🎬' },
  ];
  return (
    <Sheet title="Length" onClose={onClose}>
      <p className="k-hint">How long it stays on screen, from where it starts.</p>
      <div className="k-tiles">
        {choices.map((c) => (
          <button key={c.name} className="k-tile" onClick={() => { apply('Length', (p) => setShowFor(p, clip.id, c.v)); onClose(); }}>
            <span className="k-big-emoji">{c.emoji}</span>{c.name}
          </button>
        ))}
      </div>
    </Sheet>
  );
}

/* ---------------- motion (stickers and text) ---------------- */

export function MotionSheet({ onClose, clip }: { onClose: () => void; clip: Clip }) {
  const live = useApp((s) => s.project && findClip(s.project, clip.id)?.clip) ?? clip;
  const cur = live.motion?.loop ?? 'none';
  return (
    <Sheet title="Motion" onClose={onClose}>
      <p className="k-hint">How it moves while it’s on screen.</p>
      <div className="k-tiles">
        {KID_MOTIONS.map((m) => (
          <button key={m.id} className={`k-tile${cur === m.id ? ' on' : ''}`} aria-pressed={cur === m.id} onClick={() => apply('Motion', (p) => setMotion(p, clip.id, m.id))}>
            <span className="k-big-emoji">{m.emoji}</span>{m.name}
          </button>
        ))}
      </div>
    </Sheet>
  );
}

/* ---------------- a video's own sound ---------------- */

const VOLUMES = [{ v: 0, name: 'Off', emoji: '🔇' }, { v: 0.5, name: 'Quiet', emoji: '🔈' }, { v: 1, name: 'Normal', emoji: '🔉' }, { v: 1.6, name: 'Loud', emoji: '🔊' }];

export function VolumeSheet({ onClose, clip }: { onClose: () => void; clip: Clip }) {
  const live = useApp((s) => s.project && findClip(s.project, clip.id)?.clip) ?? clip;
  const cur = live.muted ? 0 : live.volume;
  return (
    <Sheet title="Volume" onClose={onClose}>
      <p className="k-hint">The video’s own sound (music and voiceovers aren’t changed).</p>
      <div className="k-tiles four">
        {VOLUMES.map((v) => (
          <button key={v.name} className={`k-tile${Math.abs(cur - v.v) < 0.01 ? ' on' : ''}`} aria-pressed={Math.abs(cur - v.v) < 0.01} onClick={() => apply('Volume', (p) => setClipVolume(p, clip.id, v.v))}>
            <span className="k-big-emoji">{v.emoji}</span>{v.name}
          </button>
        ))}
      </div>
    </Sheet>
  );
}
