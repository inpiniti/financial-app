import { describe, expect, it } from 'vitest';
import {
  easeOutQuad,
  generatePriceSteps,
  getTickDirection,
  interpolatePrice,
} from './animatedPriceMath';

describe('animatedPriceMath', () => {
  describe('easeOutQuad', () => {
    it('returns 0 at t=0 and 1 at t=1', () => {
      expect(easeOutQuad(0)).toBe(0);
      expect(easeOutQuad(1)).toBe(1);
    });

    it('decelerates towards the end (t=0.5 yields > 0.5)', () => {
      expect(easeOutQuad(0.5)).toBe(0.75);
    });
  });

  describe('interpolatePrice', () => {
    it('returns toPrice if prices are identical or progress >= 1', () => {
      expect(interpolatePrice(100, 100, 0.5)).toBe(100);
      expect(interpolatePrice(100, 110, 1.2)).toBe(110);
    });

    it('returns fromPrice if progress <= 0', () => {
      expect(interpolatePrice(100, 110, 0)).toBe(100);
      expect(interpolatePrice(100, 110, -0.1)).toBe(100);
    });

    it('interpolates intermediate prices with ease-out', () => {
      // 100 -> 110, at p=0.5 eased=0.75, 100 + 10 * 0.75 = 107.5
      expect(interpolatePrice(100, 110, 0.5)).toBe(107.5);
    });

    it('interpolates downwards smoothly', () => {
      // 110 -> 100, at p=0.5 eased=0.75, 110 - 10 * 0.75 = 102.5
      expect(interpolatePrice(110, 100, 0.5)).toBe(102.5);
    });
  });

  describe('getTickDirection', () => {
    it('returns same for identical or null prices', () => {
      expect(getTickDirection(null, 100)).toBe('same');
      expect(getTickDirection(100, null)).toBe('same');
      expect(getTickDirection(100, 100)).toBe('same');
    });

    it('returns up when price increases', () => {
      expect(getTickDirection(100, 100.5)).toBe('up');
    });

    it('returns down when price decreases', () => {
      expect(getTickDirection(100, 99.5)).toBe('down');
    });
  });

  describe('generatePriceSteps', () => {
    it('returns toPrice for single step or identical values', () => {
      expect(generatePriceSteps(100, 100, 5)).toEqual([100]);
      expect(generatePriceSteps(100, 110, 1)).toEqual([110]);
    });

    it('generates ascending discrete steps towards toPrice', () => {
      const steps = generatePriceSteps(100, 110, 5);
      expect(steps.length).toBe(5);
      expect(steps[steps.length - 1]).toBe(110);
      // Verify strictly ascending
      for (let i = 1; i < steps.length; i++) {
        expect(steps[i]).toBeGreaterThan(steps[i - 1]);
      }
    });
  });
});
