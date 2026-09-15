import { describe, expect, it } from 'vitest';
import {
  calcRaceProgress,
  calcStartingGateRpm,
  getTensionZone,
  START_LINE_POS,
  FINISH_LINE_POS,
  SCALE_IN_POS,
} from './raceMath';

describe('raceMath', () => {
  describe('getTensionZone', () => {
    it('handles null values as idle', () => {
      expect(getTensionZone(null)).toBe('idle');
    });

    it('returns goal when pnl >= 3%', () => {
      expect(getTensionZone(0.03)).toBe('goal');
      expect(getTensionZone(0.05)).toBe('goal');
    });

    it('returns reach when 2% <= pnl < 3%', () => {
      expect(getTensionZone(0.02)).toBe('reach');
      expect(getTensionZone(0.029)).toBe('reach');
    });

    it('returns nitro when 1% <= pnl < 2%', () => {
      expect(getTensionZone(0.01)).toBe('nitro');
      expect(getTensionZone(0.019)).toBe('nitro');
    });

    it('returns cruise when -1% <= pnl < 1%', () => {
      expect(getTensionZone(0.0)).toBe('cruise');
      expect(getTensionZone(0.005)).toBe('cruise');
      expect(getTensionZone(-0.009)).toBe('cruise');
    });

    it('returns danger when pnl < -1%', () => {
      expect(getTensionZone(-0.015)).toBe('danger');
      expect(getTensionZone(-0.03)).toBe('danger');
    });
  });

  describe('calcRaceProgress', () => {
    it('returns starting position when current or avg is missing', () => {
      const res = calcRaceProgress(null, 100);
      expect(res.trackPos).toBe(START_LINE_POS);
      expect(res.zone).toBe('idle');
    });

    it('calculates exact 50% halfway position at +1.0% gain (default tp=3%)', () => {
      // 0% -> 0.25, 3% -> 1.0. At 1.0%, 0.25 + (1/3)*0.75 = 0.50
      const res = calcRaceProgress(101, 100);
      expect(res.trackPos).toBeCloseTo(0.5, 4);
      expect(res.zone).toBe('nitro');
      expect(res.remainingPct).toBeCloseTo(2.0, 2);
      expect(res.isGoal).toBe(false);
    });

    it('calculates 75% reach position at +2.0% gain', () => {
      // At 2.0%, 0.25 + (2/3)*0.75 = 0.75
      const res = calcRaceProgress(102, 100);
      expect(res.trackPos).toBeCloseTo(0.75, 4);
      expect(res.zone).toBe('reach');
      expect(res.remainingPct).toBeCloseTo(1.0, 2);
    });

    it('calculates 100% finish line goal position at +3.0% gain', () => {
      const res = calcRaceProgress(103, 100);
      expect(res.trackPos).toBe(FINISH_LINE_POS);
      expect(res.zone).toBe('goal');
      expect(res.isGoal).toBe(true);
      expect(res.remainingPct).toBe(0);
    });

    it('calculates danger/pit stop position at -1.5% drop', () => {
      // 0% -> 0.25, -3% -> 0.0. At -1.5%, 0.25 - 0.5*0.25 = 0.125
      const res = calcRaceProgress(98.5, 100);
      expect(res.trackPos).toBeCloseTo(0.125, 4);
      expect(res.zone).toBe('danger');
      expect(res.isScaleInZone).toBe(false);
    });

    it('hits scale-in booster line at -3% drop', () => {
      const res = calcRaceProgress(97, 100);
      expect(res.trackPos).toBe(SCALE_IN_POS);
      expect(res.zone).toBe('danger');
      expect(res.isScaleInZone).toBe(true);
    });
  });

  describe('calcStartingGateRpm', () => {
    it('returns baseline idling RPM for dormant stocks', () => {
      const rpm = calcStartingGateRpm(100, 110, 0, 0);
      expect(rpm).toBe(20);
    });

    it('increases RPM as tick rate and positive slope rise', () => {
      const rpm = calcStartingGateRpm(100, 110, 5, 2);
      expect(rpm).toBe(70); // 20 + 30 + 20
    });

    it('reaches maximum RPM when 5-line breakout is imminent', () => {
      // 5 tick/sec, +2 slope, price right at MA5
      const rpm = calcStartingGateRpm(100, 100, 5, 2);
      expect(rpm).toBe(100); // 20 + 30 + 20 + 30 = 100
    });
  });
});
