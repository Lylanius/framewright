/**
 * Kids Studio editor: one big picture, a strip of photos/videos in order, and
 * a tray of big buttons that changes with what's tapped — just like the apps
 * kids already know, with fewer, friendlier choices.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { addToStrip, copyInStrip, currentLook, extras, KID_LOOKS, KID_SPEEDS, kidsLength, mainClips, moveExtraTo, moveInStrip, removeExtra, removeFromStrip, splitInStrip } from '../../core/kids';
import { findClip, updateClip } from '../../core/timeline';
import type { Clip, MediaItem } from '../../core/types';
import { getBlob } from '../../engine/media';
import { propValue, setProps } from '../propEdit';
import { useApp, useTime } from '../store';
import { KidsSave } from './KidsSave';
import { KidsStage } from './KidsStage';
import {
  ColoursSheet, hear, JoinsSheet, MotionSheet, MusicSheet, ShowForSheet, SoundsSheet, SpeedSheet, StickersSheet, TalkSheet, TrimSheet, VolumeSheet, WordsSheet, type SheetId,
} from './sheets';

const clock = (t: number) => { const m = Math.floor(t / 60), s = Math.floor(t - m * 60); return `${m}:${s < 10 ? '0' : ''}${s}`; };

function useThumb(m: MediaItem | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!m) return;
    if (m.thumbnails?.length) { setUrl(m.thumbnails[Math.floor((m.thumbnails.length - 1) / 2)]); return; }
    const b = m.kind === 'image' ? getBlob(m.id) : null;
    if (!b) return;
    const u = URL.createObjectURL(b);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [m]);
  return url;
}

function StripTile({ clip, media, on, onTap }: { clip: Clip; media?: MediaItem; on: boolean; onTap: () => void }) {
  const thumb = useThumb(media);
  const look = currentLook(clip);
  const speed = KID_SPEEDS.find((s) => s.speed === clip.speed);
  return (
    <button className={`k-clip${on ? ' on' : ''}`} onClick={onTap} aria-pressed={on} aria-label={`${clip.kind === 'image' ? 'Photo' : 'Video'}, ${Math.round(clip.duration)} seconds`}>
      {thumb ? <img src={thumb} alt="" draggable={false} /> : <span className="k-clip-blank">{clip.kind === 'image' ? '🖼️' : '🎬'}</span>}
      <span className="k-clip-badges">
        {look !== 'none' && <i>{KID_LOOKS.find((l) => l.id === look)?.emoji}</i>}
        {speed && speed.speed !== 1 && <i>{speed.emoji}</i>}
        {clip.reverse && <i>🔄</i>}
        {clip.muted && <i>🔇</i>}
      </span>
      <span className="k-clip-time">{Math.round(clip.duration * 10) / 10}s</span>
    </button>
  );
}

function extraLabel(c: Clip): { icon: string; text: string } {
  if (c.kind === 'text') return { icon: 'Aa', text: c.text?.content ?? 'Text' };
  if (c.shape?.emoji) return { icon: c.shape.emoji, text: 'Sticker' };
  if (c.kind === 'image') return { icon: '📷', text: 'Picture' };
  if (c.kind === 'audio') return /voice/i.test(c.name) ? { icon: '🎤', text: 'Voiceover' } : { icon: '🔊', text: c.name.replace(/^SFX - /, '').replace(/\.wav$/, '') };
  return { icon: '⭐', text: c.name };
}

/** A big tray button. */
function Tool({ emoji, label, colour, onClick, disabled, pressed }: { emoji: string; label: string; colour: string; onClick: () => void; disabled?: boolean; pressed?: boolean }) {
  return (
    <button className={`k-tool ${colour}`} onClick={onClick} disabled={disabled} aria-pressed={pressed}>
      <span className="k-tool-ico" aria-hidden>{emoji}</span>{label}
    </button>
  );
}

export function KidsEditor() {
  const project = useApp((s) => s.project)!;
  const selection = useApp((s) => s.selection);
  const history = useApp((s) => s.history);
  const time = useTime((s) => s.time);
  const [playing, setPlaying] = useState(false);
  const [sheet, setSheet] = useState<SheetId | null>(null);
  const [editWordsId, setEditWordsId] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { apply, select, undo, importFiles, closeProject } = useApp.getState();

  const strip = mainClips(project);
  const extraClips = extras(project);
  const end = kidsLength(project);
  const sel = selection.length === 1 ? findClip(project, selection[0])?.clip : undefined;
  const selInStrip = !!sel && strip.some((c) => c.id === sel.id);
  const selExtra = !!sel && !selInStrip ? sel : undefined;
  const mediaOf = useMemo(() => new Map(project.media.map((m) => [m.id, m])), [project.media]);

  const seek = (t: number) => useApp.getState().player?.seek(Math.max(0, Math.min(end, t)));
  const close = () => { setSheet(null); setEditWordsId(undefined); };
  // Show a thing after its pop-in, so it's visible (and grabbable) straight away.
  const showExtra = (id: string) => {
    const c = findClip(useApp.getState().project!, id)?.clip;
    if (c) seek(c.start + Math.min(0.45, c.duration / 2));
  };
  const added = (id: string) => { close(); if (id) { select([id]); showExtra(id); } };

  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    const ids = await importFiles(files);
    const media = ids.map((id) => useApp.getState().project!.media.find((m) => m.id === id)).filter(Boolean) as MediaItem[];
    let first = '';
    apply('Add photos and videos', (p) => { const r = addToStrip(p, media); first = r.ids[0] ?? ''; return r.project; });
    if (first) { const c = findClip(useApp.getState().project!, first)?.clip; if (c) seek(c.start); }
  };

  // Tapping a strip clip jumps to it.
  const tapClip = (c: Clip) => {
    if (sel?.id === c.id) { select([]); return; }
    select([c.id]);
    seek(c.start + 0.05);
  };

  const scale = (k: number) => {
    if (!sel) return;
    setProps(sel.id, { scale: Math.min(6, Math.max(0.1, propValue(sel, 'scale') * k)) }, k > 1 ? 'Bigger' : 'Smaller');
  };

  // Stop playback when a sheet opens, so choices land where you are.
  useEffect(() => { if (sheet || saving) useApp.getState().player?.pause(); }, [sheet, saving]);

  let tray: React.ReactNode;
  if (sel && selInStrip) {
    const i = strip.findIndex((c) => c.id === sel.id);
    const canSplit = time > sel.start + 0.2 && time < sel.start + sel.duration - 0.2;
    tray = <>
      <Tool emoji="✂️" label={sel.kind === 'image' ? 'Length' : 'Trim'} colour="sun" onClick={() => setSheet('trim')} />
      <Tool emoji="🔪" label="Split" colour="orange" disabled={!canSplit} onClick={() => {
        let id = '';
        apply('Split', (p) => { const r = splitInStrip(p, sel.id, useTime.getState().time); id = r?.id ?? ''; return r?.project; });
        if (id) select([id]);
      }} />
      {sel.kind === 'video' && <Tool emoji="🐇" label="Speed" colour="mint" onClick={() => setSheet('speed')} />}
      <Tool emoji="🎨" label="Filter" colour="pink" onClick={() => setSheet('colours')} />
      {sel.kind === 'video' && <Tool emoji={sel.muted ? '🔇' : '🔊'} label="Volume" colour="grape" onClick={() => setSheet('volume')} />}
      <Tool emoji="⬅️" label="Move left" colour="sky" disabled={i <= 0} onClick={() => apply('Move left', (p) => moveInStrip(p, sel.id, -1))} />
      <Tool emoji="➡️" label="Move right" colour="sky" disabled={i >= strip.length - 1} onClick={() => apply('Move right', (p) => moveInStrip(p, sel.id, 1))} />
      <Tool emoji="📄" label="Copy" colour="mint" onClick={() => {
        let id = '';
        apply('Copy', (p) => { const r = copyInStrip(p, sel.id); id = r?.id ?? ''; return r?.project; });
        if (id) { select([id]); const c = findClip(useApp.getState().project!, id)?.clip; if (c) seek(c.start + 0.05); }
      }} />
      <Tool emoji={sel.fit === 'cover' ? '🖼️' : '🔍'} label={sel.fit === 'cover' ? 'Fit' : 'Fill'} colour="grape"
        onClick={() => apply('Fill or fit', (p) => updateClip(p, sel.id, { fit: sel.fit === 'cover' ? 'contain' : 'cover' }))} />
      <Tool emoji="🗑️" label="Delete" colour="white" onClick={() => { apply('Delete', (p) => removeFromStrip(p, sel.id)); select([]); }} />
      <Tool emoji="✔️" label="Done" colour="white" onClick={() => select([])} />
    </>;
  } else if (selExtra) {
    const startHere = () => apply('Start here', (p) => moveExtraTo(p, selExtra.id, useTime.getState().time));
    tray = <>
      {selExtra.kind !== 'audio' && <>
        <Tool emoji="➕" label="Bigger" colour="mint" onClick={() => scale(1.25)} />
        <Tool emoji="➖" label="Smaller" colour="sky" onClick={() => scale(0.8)} />
        <Tool emoji="💫" label="Motion" colour="grape" onClick={() => setSheet('motion')} />
        <Tool emoji="⏱️" label="Length" colour="sun" onClick={() => setSheet('showfor')} />
      </>}
      {selExtra.kind === 'text' && <Tool emoji="✏️" label="Edit text" colour="pink" onClick={() => { setEditWordsId(selExtra.id); setSheet('words'); }} />}
      {selExtra.kind === 'audio' && <Tool emoji="▶️" label="Listen" colour="mint" onClick={() => { const b = selExtra.mediaId && getBlob(selExtra.mediaId); if (b) hear(b); }} />}
      <Tool emoji="📍" label="Start here" colour="orange" onClick={startHere} />
      <Tool emoji="🗑️" label="Delete" colour="white" onClick={() => { apply('Delete', (p) => removeExtra(p, selExtra.id)); select([]); }} />
      <Tool emoji="✔️" label="Done" colour="white" onClick={() => select([])} />
    </>;
  } else {
    const none = !strip.length;
    tray = <>
      <Tool emoji="➕" label="Add" colour="sun" onClick={() => fileRef.current?.click()} />
      <Tool emoji="🔤" label="Text" colour="pink" disabled={none} onClick={() => setSheet('words')} />
      <Tool emoji="😀" label="Stickers" colour="mint" disabled={none} onClick={() => setSheet('stickers')} />
      <Tool emoji="🎵" label="Music" colour="grape" disabled={none} onClick={() => setSheet('music')} />
      <Tool emoji="🔊" label="Sounds" colour="orange" disabled={none} onClick={() => setSheet('sounds')} />
      <Tool emoji="🎤" label="Voiceover" colour="sky" disabled={none} onClick={() => setSheet('talk')} />
      <Tool emoji="✨" label="Transitions" colour="sun" disabled={strip.length < 2} onClick={() => setSheet('joins')} />
      <Tool emoji="🎨" label="Filters" colour="pink" disabled={none} onClick={() => setSheet('colours')} />
    </>;
  }

  return (
    <div className="k-editor">
      <header className="k-top">
        <button className="k-round white" onClick={() => void closeProject()} aria-label="My videos">🏠</button>
        <input className="k-title" value={project.name} aria-label="Video name" maxLength={40}
          onChange={(e) => apply('Rename', (p) => ({ ...p, name: e.target.value }), 'rename')} />
        <button className="k-btn sun" onClick={() => setSaving(true)} disabled={!strip.length}><span className="k-ico">⭐</span>Save video</button>
      </header>

      <KidsStage onPlaying={setPlaying} />

      <div className="k-transport">
        <button className="k-play" onClick={() => useApp.getState().player?.toggle()} disabled={!strip.length} aria-label={playing ? 'Pause' : 'Play'}>{playing ? '❚❚' : '▶'}</button>
        <input type="range" className="k-scrub" min={0} max={Math.max(0.1, end)} step={0.01} value={Math.min(time, end)} aria-label="Where you are in the video"
          onChange={(e) => seek(+e.target.value)} disabled={!strip.length} />
        <span className="k-time">{clock(time)} / {clock(end)}</span>
        <button className="k-round white" onClick={undo} disabled={!history.past.length} aria-label="Undo" title={history.past.length ? `Undo ${history.past[history.past.length - 1].label.toLowerCase()}` : 'Undo'}>↩️</button>
      </div>

      <div className="k-strip" role="list" aria-label="Your photos and videos">
        {strip.map((c) => <StripTile key={c.id} clip={c} media={c.mediaId ? mediaOf.get(c.mediaId) : undefined} on={sel?.id === c.id} onTap={() => tapClip(c)} />)}
        <button className="k-clip add" onClick={() => fileRef.current?.click()} aria-label="Add photos and videos"><span>➕</span>Add</button>
      </div>
      <input ref={fileRef} type="file" accept="image/*,video/*" multiple hidden aria-label="Photos and videos"
        onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ''; void addFiles(fs); }} />

      {extraClips.length > 0 && (
        <div className="k-extras" aria-label="Things you added">
          {extraClips.map((c) => {
            const l = extraLabel(c);
            return (
              <button key={c.id} className={`k-extra${sel?.id === c.id ? ' on' : ''}`} onClick={() => { select([c.id]); showExtra(c.id); }}>
                <span className="k-extra-ico">{l.icon}</span><span className="k-extra-text">{l.text}</span><small>{clock(c.start)}</small>
              </button>
            );
          })}
        </div>
      )}

      <nav className="k-tray" aria-label={sel ? 'Edit' : 'Add'}>{tray}</nav>

      {sheet === 'stickers' && <StickersSheet onClose={close} onAdded={added} />}
      {sheet === 'words' && <WordsSheet onClose={close} onAdded={added} editId={editWordsId} />}
      {sheet === 'music' && <MusicSheet onClose={close} />}
      {sheet === 'sounds' && <SoundsSheet onClose={close} />}
      {sheet === 'talk' && <TalkSheet onClose={close} />}
      {sheet === 'joins' && <JoinsSheet onClose={close} />}
      {sheet === 'colours' && <ColoursSheet onClose={close} clip={selInStrip ? sel : undefined} />}
      {sheet === 'speed' && sel && <SpeedSheet onClose={close} clip={sel} />}
      {sheet === 'trim' && sel && <TrimSheet onClose={close} clip={sel} />}
      {sheet === 'showfor' && sel && <ShowForSheet onClose={close} clip={sel} />}
      {sheet === 'motion' && sel && <MotionSheet onClose={close} clip={sel} />}
      {sheet === 'volume' && sel && <VolumeSheet onClose={close} clip={sel} />}
      {saving && <KidsSave onClose={() => setSaving(false)} />}
    </div>
  );
}
