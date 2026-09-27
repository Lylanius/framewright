import { describe, expect, it } from 'vitest';
import {
  adjustMatrix, applyMatrixToPixel, createEffect, EFFECTS, effectMatrix, hueMatrix, IDENTITY, isIdentity, LOOKS, lookMatrix, multiply, saturationMatrix,
} from '../../src/core/effects';

describe('effects catalogue', () => {
  it('creates every effect with default params', () => {
    for (const def of EFFECTS) {
      const fx = createEffect(def.type);
      for (const p of def.params) expect(fx.params[p.key]).toBe(p.default);
    }
  });
  it('rejects unknown effects', () => {
    expect(() => createEffect('nope')).toThrow();
  });
});

describe('colour matrices', () => {
  it('neutral adjust is identity', () => {
    expect(isIdentity(adjustMatrix({}))).toBe(true);
    expect(isIdentity(multiply(IDENTITY, IDENTITY))).toBe(true);
  });
  it('zero saturation produces grey', () => {
    const [r, g, b] = applyMatrixToPixel(saturationMatrix(0), 200, 50, 50, 255);
    expect(Math.abs(r - g)).toBeLessThan(1);
    expect(Math.abs(g - b)).toBeLessThan(1);
  });
  it('360° hue rotation returns the original colour', () => {
    const [r, g, b] = applyMatrixToPixel(hueMatrix(360), 200, 80, 30, 255);
    expect(r).toBeCloseTo(200, 0); expect(g).toBeCloseTo(80, 0); expect(b).toBeCloseTo(30, 0);
  });
  it('brightness raises and exposure scales', () => {
    expect(applyMatrixToPixel(adjustMatrix({ brightness: 50 }), 100, 100, 100, 255)[0]).toBeGreaterThan(100);
    expect(applyMatrixToPixel(adjustMatrix({ exposure: -50 }), 100, 100, 100, 255)[0]).toBeCloseTo(50, 0);
  });
  it('warm temperature boosts red over blue', () => {
    const [r, , b] = applyMatrixToPixel(adjustMatrix({ temperature: 80 }), 128, 128, 128, 255);
    expect(r).toBeGreaterThan(b);
  });
  it('every look is a valid matrix and strength 0 is identity', () => {
    LOOKS.forEach((_, i) => {
      expect(lookMatrix(i)).toHaveLength(20);
      expect(isIdentity(effectMatrix(createEffect('look', { look: i, strength: 0 }))!)).toBe(true);
    });
  });
  it('non-colour effects have no matrix', () => {
    expect(effectMatrix(createEffect('blur'))).toBeNull();
  });
});
