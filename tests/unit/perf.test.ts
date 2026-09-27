import { describe, expect, it } from 'vitest';
import { applyGrade, bakeLut, gradeUniforms } from '../../src/core/grade';
import { createEffect } from '../../src/core/effects';
import { lutPixels } from '../../src/engine/effectsRender';

describe('fused colour LUT (fast CPU path)', () => {
  it('is an identity for an identity LUT', () => {
    const lut = bakeLut((c) => c, 33);
    const d = new Uint8ClampedArray(256 * 4);
    for (let i = 0; i < 256; i++) { d[i * 4] = i; d[i * 4 + 1] = (i * 7) & 255; d[i * 4 + 2] = 255 - i; d[i * 4 + 3] = 255; }
    const before = d.slice();
    lutPixels(d, lut);
    for (let i = 0; i < d.length; i++) expect(Math.abs(d[i] - before[i])).toBeLessThanOrEqual(1);
  });
  it('matches the direct colour grade to within ~1%', () => {
    const fx = createEffect('grade', { shadows: 40, highlights: -30, vibrance: 35, liftX: 0.3, gainY: -0.2, 'hsl.blue.s': -40 });
    const u = gradeUniforms(fx);
    const lut = bakeLut((c) => applyGrade(c, u), 33);
    let worst = 0;
    const d = new Uint8ClampedArray(4);
    for (let n = 0; n < 4000; n++) {
      const r = (n * 97) % 256, g = (n * 193) % 256, b = (n * 31 + 7) % 256;
      d[0] = r; d[1] = g; d[2] = b; d[3] = 255;
      lutPixels(d, lut);
      const ref = applyGrade([r / 255, g / 255, b / 255], u);
      for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(d[c] - ref[c] * 255));
    }
    expect(worst).toBeLessThan(4);
  });
  it('skips fully transparent pixels', () => {
    const lut = bakeLut(([r, g, b]) => [1 - r, 1 - g, 1 - b], 17);
    const d = new Uint8ClampedArray([10, 20, 30, 0]);
    lutPixels(d, lut);
    expect([...d]).toEqual([10, 20, 30, 0]);
  });
});
