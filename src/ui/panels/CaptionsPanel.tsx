import { useRef, useState } from 'react';
import {
  addCaptions, CAPTION_STYLES, captionClips, captionTextStyle, chunkCues, mergeCaptionWithNext, parseSubtitles, patchAllCaptions,
  projectCues, rechunkCaptions, restyleCaptions, splitCaption, toSRT, toVTT,
} from '../../core/captions';
import { formatTimecode } from '../../core/time';
import { deleteClips, updateClip } from '../../core/timeline';
import { canSaveExtension, saveFile } from '../../platform/download';
import { seek } from '../actions';
import { PropRow, Section, Seg } from '../components/Controls';
import { Icon } from '../components/Icon';
import { useApp, useTime } from '../store';

const CHUNKS = [{ value: '0', label: 'As is' }, { value: '1', label: '1' }, { value: '2', label: '2' }, { value: '3', label: '3' }, { value: '5', label: '5' }];

export function CaptionsPanel() {
  const project = useApp((s) => s.project)!;
  const selection = useApp((s) => s.selection);
  const { apply, toast, select } = useApp();
  const fileRef = useRef<HTMLInputElement>(null);
  const [styleId, setStyleId] = useState('punch');
  const [chunk, setChunk] = useState('0');
  const caps = captionClips(project);
  const first = caps[0];
  const base = (project.settings.width / 1080);

  const importFile = async (f: File) => {
    try {
      let cues = parseSubtitles(await f.text());
      if (!cues.length) { toast(`${f.name}: no captions found. Is it an SRT or VTT file?`, 'error'); return; }
      if (+chunk > 0) cues = chunkCues(cues, +chunk);
      const had = caps.length;
      apply('Import captions', (p) => addCaptions(p, cues, styleId, true));
      toast(`Added ${cues.length} captions${had ? ` (replaced ${had} — undo to get them back)` : ''}.`, 'success');
    } catch {
      toast(`${f.name} couldn't be read.`, 'error');
    }
  };

  const addAtPlayhead = () => {
    const t = useTime.getState().time;
    let newId = '';
    apply('Add caption', (p) => {
      const next = addCaptions(p, [{ start: t, end: t + 2, text: 'New caption' }], styleId, false);
      const added = captionClips(next).find((c) => Math.abs(c.start - t) < 1e-6 && c.text?.content === 'New caption');
      if (!added) return null;
      newId = added.id;
      // Match the look of existing captions.
      return first ? updateClip(next, newId, (c) => ({ ...c, text: { ...first.text!, content: 'New caption' }, transform: { ...first.transform } })) : next;
    });
    if (newId) select([newId]);
    else toast('There’s already a caption at the playhead.');
  };

  const exportAs = async (fmt: 'srt' | 'vtt') => {
    const cues = projectCues(project);
    if (!cues.length) return;
    const text = fmt === 'srt' ? toSRT(cues) : toVTT(cues);
    const base = project.name.replace(/[^\w\- ]+/g, '').trim() || 'captions';
    const name = canSaveExtension(fmt) ? `${base}.${fmt}` : `${base}.${fmt}.txt`;
    try {
      const r = await saveFile(name, text);
      if (r === 'saved') toast(canSaveExtension(fmt) ? `Saved ${name}` : `Saved ${name} — remove the “.txt” ending to use it as a .${fmt} file.`, 'success');
    } catch (e) { toast((e as Error).message, 'error'); }
  };

  const copySrt = async () => {
    try {
      await navigator.clipboard.writeText(toSRT(projectCues(project)));
      toast('SRT copied to clipboard.', 'success');
    } catch { toast('Copy isn’t allowed here — use Save instead.', 'error'); }
  };

  return (
    <>
      <Section title="Add captions">
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button className="btn primary" onClick={() => fileRef.current?.click()}><Icon name="upload" size={15} />Import SRT / VTT</button>
          <button className="btn" onClick={addAtPlayhead}><Icon name="plus" size={15} />Caption at playhead</button>
        </div>
        <div className="field"><span>Words per caption</span>
          <div className="row"><Seg label="Words per caption" value={chunk} onChange={setChunk} options={CHUNKS} />
            {caps.length > 0 && +chunk > 0 && <button className="btn sm" onClick={() => apply('Re-cut captions', (p) => rechunkCaptions(p, +chunk))}>Re-cut</button>}
          </div>
        </div>
        <input ref={fileRef} type="file" accept=".srt,.vtt,.txt,text/vtt,application/x-subrip" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importFile(f); }} />
        <div className="todo-panel" style={{ padding: 10 }}>
          <span className="badge">Want them automatic?</span>
          <span className="faint" style={{ fontSize: 12 }}>AI tools → <b>Auto-captions</b> listens to your video on this device and writes timed captions with word highlighting.</span>
          <button className="btn sm" onClick={() => useApp.getState().setPanel('ai')}>Open AI tools</button>
        </div>
      </Section>

      <Section title="Style">
        <div className="text-presets">
          {CAPTION_STYLES.map((cs) => {
            const st = captionTextStyle(cs.id, 1080, '').style;
            return (
              <button key={cs.id} aria-label={cs.name} className={`cap-style${styleId === cs.id ? ' on' : ''}`} onClick={() => { setStyleId(cs.id); if (caps.length) apply(`Caption style: ${cs.name}`, (p) => restyleCaptions(p, cs.id)); }} title={cs.name}
                style={{ fontFamily: `"${st.fontFamily}"`, fontWeight: st.fontWeight ?? 400, textTransform: st.uppercase ? 'uppercase' : undefined }}>
                <span style={{ color: st.color, WebkitTextStroke: st.strokeWidth ? `1px ${st.strokeColor}` : undefined, paintOrder: 'stroke fill', background: st.background ?? undefined, padding: st.background ? '0 4px' : undefined, borderRadius: 3 }}>
                  the{' '}
                  <span style={cs.style.highlightMode === 'box' ? { background: cs.style.highlightColor, borderRadius: 4, padding: '0 3px' }
                    : cs.style.highlightMode === 'underline' ? { borderBottom: `3px solid ${cs.style.highlightColor}` }
                    : cs.style.highlightMode && cs.style.highlightMode !== 'none' ? { color: cs.style.highlightColor } : undefined}>best</span>{' '}part
                </span>
              </button>
            );
          })}
        </div>
        {first?.text && (
          <>
            <PropRow label="Size" value={first.text.fontSize} min={16 * base} max={200 * base} step={1} unit="px" onChange={(v) => apply('Caption size', (p) => patchAllCaptions(p, { fontSize: v }), 'capsize')} />
            <PropRow label="Position" value={first.transform.y} min={-0.45} max={0.45} step={0.005} display={100} unit="% from centre" onChange={(v) => apply('Caption position', (p) => patchAllCaptions(p, {}, v), 'capy')} />
          </>
        )}
      </Section>

      <Section title={`Captions (${caps.length})`} right={caps.length > 0 ? (
        <>
          <button className="btn sm" onClick={() => void exportAs('srt')}>SRT</button>
          <button className="btn sm" onClick={() => void exportAs('vtt')}>VTT</button>
          <button className="icon-btn sm" onClick={() => void copySrt()} title="Copy as SRT" aria-label="Copy as SRT"><Icon name="copy" size={13} /></button>
        </>
      ) : undefined}>
        {caps.length === 0 && <p className="faint" style={{ margin: 0, fontSize: 12 }}>No captions yet.</p>}
        <div className="caption-list">
          {caps.map((c) => {
            return (
              <div key={c.id} className={`cap-row${selection.includes(c.id) ? ' on' : ''}`}>
                <span className="t" onClick={() => { seek(c.start + 0.01); select([c.id]); }} title="Jump here">{formatTimecode(c.start, project.settings.fps).slice(3, 8)}</span>
                <textarea className="input" rows={Math.min(3, Math.ceil((c.text?.content.length ?? 0) / 26) || 1)} value={c.text?.content ?? ''} aria-label="Caption text"
                  onFocus={() => select([c.id])}
                  onChange={(e) => apply('Edit caption', (p) => updateClip(p, c.id, (x) => ({ ...x, name: e.target.value.slice(0, 24), text: { ...x.text!, content: e.target.value } })), `cap:${c.id}`)} />
                <div className="row" style={{ gap: 0 }}>
                  <button className="icon-btn sm" title="Split at playhead (at the nearest word)" aria-label="Split caption"
                    onClick={() => { if (!apply('Split caption', (p) => splitCaption(p, c.id, useTime.getState().time)?.project ?? null)) toast('Put the playhead inside this caption (it needs at least two words) to split it.'); }}><Icon name="split" size={13} /></button>
                  <button className="icon-btn sm" title="Merge with next" aria-label="Merge with next caption" onClick={() => apply('Merge captions', (p) => mergeCaptionWithNext(p, c.id))}><Icon name="plus" size={13} /></button>
                  <button className="icon-btn sm" title="Delete" aria-label="Delete caption" onClick={() => apply('Delete caption', (p) => deleteClips(p, [c.id]))}><Icon name="trash" size={13} /></button>
                </div>
              </div>
            );
          })}
        </div>
      </Section>
    </>
  );
}
