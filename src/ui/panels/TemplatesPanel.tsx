import { useEffect, useRef, useState } from 'react';
import { formatShort } from '../../core/time';
import { slotsOf, templateDuration, templateToProject, type TemplateDoc } from '../../core/templates';
import { renderFrame } from '../../engine/compositor';
import { Icon } from '../components/Icon';
import { allBuiltins, deleteTemplate, exportTemplate, fillSlotsWithFiles, fillSlotWith, importTemplate, saveProjectAsTemplate, savedTemplates, useTemplate } from '../library';
import { useApp } from '../store';
import { QuizMaker } from '../QuizMaker';

const thumbs = new Map<string, string>();

/** Picture of a template (drawn with the real renderer; slots show as numbered boxes). */
function thumbFor(doc: TemplateDoc): string {
  if (doc.thumbnail) return doc.thumbnail;
  const hit = thumbs.get(doc.id);
  if (hit) return hit;
  const p = templateToProject(doc);
  const scale = 200 / Math.max(p.settings.width, p.settings.height);
  const c = document.createElement('canvas');
  c.width = Math.round(p.settings.width * scale); c.height = Math.round(p.settings.height * scale);
  try {
    renderFrame(c.getContext('2d')!, p, Math.min(1.4, templateDuration(doc) / 2), { getVisual: () => null }, { scale, placeholders: true });
  } catch { /* leave blank */ }
  const url = c.toDataURL('image/jpeg', 0.8);
  thumbs.set(doc.id, url);
  return url;
}

function TemplateCard({ doc, onDelete }: { doc: TemplateDoc; onDelete?: () => void }) {
  const slots = slotsOf(templateToProject(doc)).length;
  const { width: w, height: h } = doc.settings;
  return (
    <article className="tpl-card">
      <img src={thumbFor(doc)} alt="" style={{ aspectRatio: `${w} / ${h}` }} />
      <div className="tpl-meta">
        <strong>{doc.name}</strong>
        <small className="faint">{doc.description}</small>
        <small className="mono faint">{w > h ? '16:9' : w === h ? '1:1' : '9:16'} · {formatShort(templateDuration(doc))} · {slots} slot{slots === 1 ? '' : 's'}</small>
        <div className="row" style={{ gap: 4 }}>
          <button className="btn sm primary" onClick={() => void useTemplate(doc)} aria-label={`Use template ${doc.name}`}>Use</button>
          {!doc.builtIn && <button className="icon-btn sm" onClick={() => void exportTemplate(doc)} title="Save as a file to share or back up" aria-label="Export template"><Icon name="export" size={14} /></button>}
          {onDelete && <button className="icon-btn sm" onClick={onDelete} aria-label="Delete template"><Icon name="trash" size={14} /></button>}
        </div>
      </div>
    </article>
  );
}

function SlotFiller() {
  const project = useApp((s) => s.project)!;
  const toast = useApp((s) => s.toast);
  const fileRef = useRef<HTMLInputElement>(null);
  const slots = slotsOf(project);
  if (!slots.length) return null;
  return (
    <div className="ai-card slot-card">
      <h4><Icon name="templates" size={16} /><span>Fill your slots ({slots.length} left)</span></h4>
      <p>Pick your clips in order and they drop into the numbered slots. Clips shorter than a slot play a little slower to fit.</p>
      <button className="btn primary" onClick={() => fileRef.current?.click()}><Icon name="upload" size={15} />Pick clips for the slots</button>
      <input ref={fileRef} type="file" multiple accept="video/*,image/*,audio/*" hidden
        onChange={async (e) => { const f = Array.from(e.target.files ?? []); e.target.value = ''; if (f.length) { const n = await fillSlotsWithFiles(f); toast(`Filled ${n} slot${n === 1 ? '' : 's'}.`, 'success'); } }} />
      {slots.map((s) => {
        const options = project.media.filter((m) => (s.accepts === 'audio' ? m.kind === 'audio' : m.kind !== 'audio'));
        return (
          <div key={s.index} className="row slot-row">
            <span className="slot-num">{s.index + 1}</span>
            <span className="grow">{s.label} <small className="faint mono">{formatShort(s.duration)}</small></span>
            <select className="input sm" value="" onChange={(e) => e.target.value && fillSlotWith(s.index, e.target.value)} aria-label={`Fill slot ${s.index + 1}`} disabled={!options.length}>
              <option value="">{options.length ? 'Choose…' : 'Import media first'}</option>
              {options.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
        );
      })}
    </div>
  );
}

export function TemplatesPanel() {
  const project = useApp((s) => s.project);
  const toast = useApp((s) => s.toast);
  const [mine, setMine] = useState<TemplateDoc[]>([]);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [keepMusic, setKeepMusic] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const refresh = () => savedTemplates().then(setMine);
  useEffect(() => { void refresh(); }, []);
  const [quiz, setQuiz] = useState(false);
  const builtins = allBuiltins();
  const cats = [...new Set(builtins.map((b) => b.category))];

  return (
    <>
      {quiz && <QuizMaker onClose={() => setQuiz(false)} />}
      {project && (
        <div className="ai-card quiz-card">
          <h4><Icon name="templates" size={16} /><span>Quiz maker</span></h4>
          <p>“Guess who / guess what” rounds in one go: type the answers, pick the pictures, and it builds the background, reveal, countdown, green right answer and sounds.</p>
          <button className="btn primary" onClick={() => setQuiz(true)}><Icon name="plus" size={15} />Make a quiz</button>
        </div>
      )}
      {project && <SlotFiller />}
      <div className="section">
        <div className="row"><div className="label grow">Your templates</div>
          <button className="btn sm" onClick={() => importRef.current?.click()}><Icon name="folderOpen" size={13} />Import</button>
        </div>
        <input ref={importRef} type="file" accept=".json,application/json" hidden onChange={async (e) => {
          const f = e.target.files?.[0]; e.target.value = '';
          if (!f) return;
          try { const d = await importTemplate(f); toast(`Added template “${d.name}”.`, 'success'); void refresh(); } catch (err) { toast((err as Error).message, 'error'); }
        }} />
        {project && !saving && <button className="btn" onClick={() => { setName(project.name); setSaving(true); }}><Icon name="save" size={15} />Save this project as a template</button>}
        {project && saving && (
          <div className="fx-card">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} aria-label="Template name" placeholder="Template name" />
            <label className="row" style={{ fontSize: 13 }}><input type="checkbox" checked={keepMusic} onChange={() => setKeepMusic(!keepMusic)} /> Keep the music in the template</label>
            <small className="faint">Your videos and photos become numbered slots. Text, stickers, shapes, effects, transitions and timing are kept.</small>
            <div className="row">
              <button className="btn sm ghost" onClick={() => setSaving(false)}>Cancel</button>
              <button className="btn sm primary" onClick={async () => {
                const d = await saveProjectAsTemplate(name.trim() || 'My template', '', keepMusic);
                setSaving(false);
                if (d) { toast(`Saved template “${d.name}”.`, 'success'); void refresh(); }
              }}>Save template</button>
            </div>
          </div>
        )}
        {mine.length === 0 && <small className="faint">Templates you save appear here, ready to reuse with new footage.</small>}
        <div className="tpl-grid">
          {mine.map((d) => (
            <TemplateCard key={d.id} doc={d} onDelete={() => {
              if (confirm !== d.id) { setConfirm(d.id); toast('Tap delete again to remove this template.'); return; }
              void deleteTemplate(d.id).then(refresh); setConfirm(null);
            }} />
          ))}
        </div>
      </div>
      {cats.map((c) => (
        <div key={c} className="section">
          <div className="label">{c}</div>
          <div className="tpl-grid">{builtins.filter((b) => b.category === c).map((d) => <TemplateCard key={d.id} doc={d} />)}</div>
        </div>
      ))}
      <small className="faint">“Use” starts a new project — your current one stays saved.</small>
    </>
  );
}
