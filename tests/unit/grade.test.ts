import { describe, expect, it } from 'vitest';
import {
  applyChroma, applyGrade, assetToLut, bakeLut, bandWeights, chromaUniforms, curveTable, gradeUniforms, hslToRgb, lutToAsset, parseCube,
  rgbToHsl, sampleLut, toCube, type RGB,
} from '../../src/core/grade';
import { createEffect } from '../../src/core/effects';

const close3 = (a: RGB, b: RGB, d = 0.01) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], Math.round(-Math.log10(d))));

describe('grade', () => {
  it('neutral grade leaves colours unchanged', () => {
    const u = gradeUniforms(createEffect('grade'));
    for (const c of [[0.1, 0.5, 0.9], [0, 0, 0], [1, 1, 1], [0.3, 0.3, 0.3]] as RGB[]) close3(applyGrade(c, u), c, 0.001);
  });
  it('shadows lift dark tones more than bright ones', () => {
    const u = gradeUniforms(createEffect('grade', { shadows: 100 }));
    expect(applyGrade([0.2, 0.2, 0.2], u)[0] - 0.2).toBeGreaterThan(applyGrade([0.9, 0.9, 0.9], u)[0] - 0.9);
  });
  it('a warm gain wheel pushes highlights warm', () => {
    const [r, , b] = applyGrade([0.8, 0.8, 0.8], gradeUniforms(createEffect('grade', { gainY: 0.6, gainX: -0.3 })));
    expect(r).toBeGreaterThan(b);
  });
  it('HSL: desaturating greens leaves reds alone', () => {
    const u = gradeUniforms(createEffect('grade', { 'hsl.green.s': -100 }));
    const g = applyGrade([0.2, 0.8, 0.2], u), r = applyGrade([0.8, 0.2, 0.2], u);
    expect(Math.abs(g[0] - g[1])).toBeLessThan(0.05);
    close3(r, [0.8, 0.2, 0.2], 0.01);
  });
  it('band weights sum to 1 and pick neighbours', () => {
    for (const h of [0, 15, 90, 200, 350]) expect(bandWeights(h).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(bandWeights(120)[3]).toBeCloseTo(1);
  });
  it('HSL conversions round-trip', () => {
    for (const c of [[0.9, 0.2, 0.1], [0.1, 0.6, 0.9], [0.5, 0.5, 0.5]] as RGB[]) close3(hslToRgb(...rgbToHsl(...c)), c, 0.001);
  });
  it('curves are monotone and hit their points', () => {
    const t = curveTable([[0, 0], [0.25, 0.1], [0.75, 0.9], [1, 1]]);
    expect(t[64]).toBeCloseTo(0.1, 1);
    for (let i = 1; i < 256; i++) expect(t[i]).toBeGreaterThanOrEqual(t[i - 1] - 1e-6);
  });
  it('curves in a grade effect apply', () => {
    const fx = createEffect('grade');
    fx.data = { curves: { master: [[0, 0], [0.5, 0.7], [1, 1]], r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]] } };
    expect(applyGrade([0.5, 0.5, 0.5], gradeUniforms(fx))[0]).toBeCloseTo(0.7, 2);
  });
});

describe('LUTs', () => {
  const cube = `TITLE "Invert"\nLUT_3D_SIZE 2\n1 1 1\n0 1 1\n1 0 1\n0 0 1\n1 1 0\n0 1 0\n1 0 0\n0 0 0\n`;
  it('parses .cube files and samples trilinearly', () => {
    const lut = parseCube(cube);
    expect(lut.name).toBe('Invert');
    close3(sampleLut(lut, 0, 0, 0), [1, 1, 1]);
    close3(sampleLut(lut, 0.25, 0.5, 1), [0.75, 0.5, 0]);
  });
  it('rejects broken files', () => {
    expect(() => parseCube('LUT_3D_SIZE 3\n0 0 0\n')).toThrow(/Expected/);
    expect(() => parseCube('hello')).toThrow(/LUT_3D_SIZE/);
    expect(() => parseCube('LUT_1D_SIZE 4')).toThrow(/1D/);
  });
  it('bakes, exports and re-imports a grade', () => {
    const u = gradeUniforms(createEffect('grade', { shadows: 40, gainY: 0.3 }));
    const lut = bakeLut((c) => applyGrade(c, u), 17);
    const back = parseCube(toCube(lut));
    close3(sampleLut(back, 0.3, 0.5, 0.7), applyGrade([0.3, 0.5, 0.7], u), 0.02);
  });
  it('stores compactly in the project', () => {
    const lut = parseCube(cube);
    const back = assetToLut(lutToAsset('l1', lut));
    expect(back.size).toBe(2);
    back.data.forEach((v, i) => expect(v).toBeCloseTo(lut.data[i], 4));
  });
});

describe('chroma key', () => {
  const u = chromaUniforms(createEffect('chroma', { keyR: 0, keyG: 200, keyB: 60 }));
  it('removes the key colour and keeps skin tones', () => {
    expect(applyChroma([0, 200 / 255, 60 / 255], 1, u)[3]).toBeLessThan(0.05);
    expect(applyChroma([0.85, 0.65, 0.55], 1, u)[3]).toBeGreaterThan(0.95);
  });
  it('suppresses green spill on kept pixels', () => {
    const [r, g] = applyChroma([0.6, 0.75, 0.55], 1, { ...u, tolerance: 0 });
    expect(g - r).toBeLessThan(0.75 - 0.6);
  });
});
