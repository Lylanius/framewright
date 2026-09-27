/** Align, distribute and layer-order commands for the selected layers (Canva-style). */
import { alignBox, distribute, type Align, type Box } from '../core/snap';
import { findClip, moveClipLayer } from '../core/timeline';
import { propValue, setProps } from './propEdit';
import { useApp } from './store';

function selectedBoxes(): { id: string; box: Box }[] {
  const { player, selection, project } = useApp.getState();
  if (!player || !project) return [];
  return selection
    .map((id) => ({ id, b: player.lastBounds.find((x) => x.clipId === id) }))
    .filter((x): x is { id: string; b: NonNullable<typeof x.b> } => !!x.b && !findClip(project, x.id)?.clip.locked)
    .map(({ id, b }) => ({ id, box: { cx: b.cx, cy: b.cy, w: b.w, h: b.h } }));
}

function moveTo(id: string, box: Box, cx: number, cy: number): void {
  const { player, project } = useApp.getState();
  const clip = project && findClip(project, id)?.clip;
  if (!player || !clip) return;
  const W = player.canvas.width, H = player.canvas.height;
  setProps(id, { x: propValue(clip, 'x') + (cx - box.cx) / W, y: propValue(clip, 'y') + (cy - box.cy) / H }, 'Align');
}

/** One layer: align to the frame. Several: align to the selection's outer edges. */
export function alignSelected(a: Align): number {
  const items = selectedBoxes();
  const player = useApp.getState().player;
  if (!items.length || !player) return 0;
  const frame = { left: 0, top: 0, right: player.canvas.width, bottom: player.canvas.height };
  const bounds = items.length === 1 ? frame : {
    left: Math.min(...items.map((i) => i.box.cx - i.box.w / 2)), right: Math.max(...items.map((i) => i.box.cx + i.box.w / 2)),
    top: Math.min(...items.map((i) => i.box.cy - i.box.h / 2)), bottom: Math.max(...items.map((i) => i.box.cy + i.box.h / 2)),
  };
  for (const it of items) { const c = alignBox(it.box, bounds, a); moveTo(it.id, it.box, c.cx, c.cy); }
  player.requestRender();
  return items.length;
}

export function distributeSelected(axis: 'x' | 'y'): number {
  const items = selectedBoxes();
  if (items.length < 3) return 0;
  const centres = distribute(items.map((i) => i.box), axis);
  items.forEach((it, i) => moveTo(it.id, it.box, axis === 'x' ? centres[i] : it.box.cx, axis === 'y' ? centres[i] : it.box.cy));
  return items.length;
}

export function arrange(dir: 'up' | 'down' | 'front' | 'back'): boolean {
  const { selection, apply, toast } = useApp.getState();
  if (selection.length !== 1) return false;
  const ok = apply(dir === 'up' ? 'Bring forward' : dir === 'down' ? 'Send backward' : dir === 'front' ? 'Bring to front' : 'Send to back', (p) => moveClipLayer(p, selection[0], dir));
  if (!ok) toast(dir === 'up' || dir === 'front' ? 'Already in front at this point.' : 'Already at the back (just above the main footage).');
  return ok;
}
