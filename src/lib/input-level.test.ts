import { describe, expect, it } from 'vitest';
import { inputLevel } from './input-level';

describe('microphone level display', () => {
  it('makes the measured quiet-phone signal visible without amplifying PCM', () => {
    expect(inputLevel(0.01065)).toBeGreaterThan(0.4);
    expect(inputLevel(0.01065)).toBeLessThan(0.6);
    expect(inputLevel(0.1)).toBeGreaterThan(inputLevel(0.01));
  });
  it('keeps silence, invalid inputs and overload within display bounds', () => {
    for (const value of [0, -1, NaN, Infinity, 0.00001]) expect(inputLevel(value)).toBe(0);
    expect(inputLevel(1)).toBe(1);
  });
});
