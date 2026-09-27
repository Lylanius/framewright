/**
 * Smart guides: snap a moving box's edges and centre to the frame and to other
 * layers, and report which guide lines to draw. All values in canvas pixels.
 */
export interface Box { cx: number; cy: number; w: number; h: number }
export interface SnapResult { dx: number; dy: number; guidesX: number[]; guidesY: number[] }

function best(sources: number[], targets: number[], threshold: number): { d: number; at: number[] } {
  let d = 0, bestAbs = threshold + 1e-9;
  for (const s of sources) for (const t of targets) {
    const diff = t - s;
    if (Math.abs(diff) < bestAbs) { bestAbs = Math.abs(diff); d = diff; }
  }
  if (bestAbs > threshold) return { d: 0, at: [] };
  // Every target that lines up after snapping gets a guide.
  const at = new Set<number>();
  for (const s of sources) for (const t of targets) if (Math.abs(s + d - t) < 0.5) at.add(t);
  return { d, at: [...at] };
}

export function snapBox(box: Box, others: Box[], W: number, H: number, threshold: number): SnapResult {
  const xs = [box.cx - box.w / 2, box.cx, box.cx + box.w / 2];
  const ys = [box.cy - box.h / 2, box.cy, box.cy + box.h / 2];
  const tx = [0, W / 2, W], ty = [0, H / 2, H];
  for (const o of others) {
    tx.push(o.cx - o.w / 2, o.cx, o.cx + o.w / 2);
    ty.push(o.cy - o.h / 2, o.cy, o.cy + o.h / 2);
  }
  const bx = best(xs, tx, threshold), by = best(ys, ty, threshold);
  return { dx: bx.d, dy: by.d, guidesX: bx.at, guidesY: by.at };
}

export type Align = 'left' | 'centre' | 'right' | 'top' | 'middle' | 'bottom';

/** New centre for aligning a box to a container (the frame, or a selection's bounds). */
export function alignBox(box: Box, to: { left: number; top: number; right: number; bottom: number }, a: Align): { cx: number; cy: number } {
  switch (a) {
    case 'left': return { cx: to.left + box.w / 2, cy: box.cy };
    case 'centre': return { cx: (to.left + to.right) / 2, cy: box.cy };
    case 'right': return { cx: to.right - box.w / 2, cy: box.cy };
    case 'top': return { cx: box.cx, cy: to.top + box.h / 2 };
    case 'middle': return { cx: box.cx, cy: (to.top + to.bottom) / 2 };
    case 'bottom': return { cx: box.cx, cy: to.bottom - box.h / 2 };
  }
}

/** Even gaps between boxes along an axis (first and last stay put). Returns new centres in input order. */
export function distribute(boxes: Box[], axis: 'x' | 'y'): number[] {
  const key = axis === 'x' ? 'cx' : 'cy', size = axis === 'x' ? 'w' : 'h';
  const order = boxes.map((b, i) => ({ b, i })).sort((a, b) => a.b[key] - b.b[key]);
  const out = boxes.map((b) => b[key]);
  if (boxes.length < 3) return out;
  const first = order[0].b, last = order[order.length - 1].b;
  const span = (last[key] + last[size] / 2) - (first[key] - first[size] / 2);
  const total = order.reduce((a, o) => a + o.b[size], 0);
  const gap = (span - total) / (order.length - 1);
  let edge = first[key] - first[size] / 2;
  for (const o of order) { out[o.i] = edge + o.b[size] / 2; edge += o.b[size] + gap; }
  return out;
}
