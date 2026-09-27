/** Snap guide lines shown on the preview while dragging (canvas pixels). */
import { create } from 'zustand';

export const useGuides = create<{ x: number[]; y: number[]; set(x: number[], y: number[]): void }>((set) => ({
  x: [], y: [],
  set: (x, y) => set({ x, y }),
}));
