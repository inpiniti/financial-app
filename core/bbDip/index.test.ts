import { describe, expect, it } from 'vitest';
import {
  BollingerBandMeter,
  evaluateBbDipEntry,
  BbDipExitRule,
  DEFAULT_BBDIP_CONFIG,
} from './index';

describe('core/bbDip — BollingerBandMeter', () => {
  it('20틱이 차기 전에는 isReady=false, 20틱 후 isReady=true', () => {
    const meter = new BollingerBandMeter(20, 2.0);
    for (let i = 1; i < 20; i++) {
      meter.record(100);
      expect(meter.isReady).toBe(false);
    }
    meter.record(100);
    expect(meter.isReady).toBe(true);
    expect(meter.ma20).toBe(100);
    expect(meter.lowerBb).toBe(100);
    expect(meter.upperBb).toBe(100);
  });

  it('변동성이 있는 가격 시퀀스에서 lowerBb < ma20 < upperBb 계산 검증', () => {
    const meter = new BollingerBandMeter(20, 2.0);
    // 100을 중심으로 90~110 진동
    for (let i = 0; i < 20; i++) {
      meter.record(i % 2 === 0 ? 105 : 95);
    }
    expect(meter.ma20).toBe(100);
    expect(meter.lowerBb).toBeLessThan(100);
    expect(meter.upperBb).toBeGreaterThan(100);
  });
});

describe('core/bbDip — evaluateBbDipEntry', () => {
  const cfg = { ...DEFAULT_BBDIP_CONFIG, minRm: 50, minFr: 0.10, dipThreshold: -0.004, s10Min: 0.05 };

  it('4가지 조건(하단 -0.4% 이탈, s10 > 0.05, rm >= 50, fr >= 0.10) 모두 만족 시 true', () => {
    const lowerBb = 100;
    const currentPrice = 99.5; // -0.5% 이탈 (문턱 -0.4% 통과)
    const s10 = 0.08; // > 0.05%
    const rm = 60; // >= 50
    const fr = 0.15; // >= 0.10

    expect(evaluateBbDipEntry(currentPrice, lowerBb, s10, rm, fr, cfg)).toBe(true);
  });

  it('하단 이탈 부족 시 false', () => {
    const lowerBb = 100;
    const currentPrice = 99.8; // -0.2% 이탈 (문턱 -0.4% 미달)
    expect(evaluateBbDipEntry(currentPrice, lowerBb, 0.08, 60, 0.15, cfg)).toBe(false);
  });

  it('10초 기울기 반등 미달 시 false', () => {
    const lowerBb = 100;
    const currentPrice = 99.5;
    expect(evaluateBbDipEntry(currentPrice, lowerBb, 0.02, 60, 0.15, cfg)).toBe(false);
  });

  it('틱속도 미달(rm < 50) 시 false', () => {
    const lowerBb = 100;
    const currentPrice = 99.5;
    expect(evaluateBbDipEntry(currentPrice, lowerBb, 0.08, 30, 0.15, cfg)).toBe(false);
  });

  it('체결강도 미달(fr < 0.10) 시 false', () => {
    const lowerBb = 100;
    const currentPrice = 99.5;
    expect(evaluateBbDipEntry(currentPrice, lowerBb, 0.08, 60, 0.05, cfg)).toBe(false);
  });
});

describe('core/bbDip — BbDipExitRule', () => {
  it('1순위: 볼린저 중심선(MA20) 도달 시 즉시 전량 매도', () => {
    let currentMa20 = 100.5;
    const rule = new BbDipExitRule(
      { qty: 10, avgPrice: 100 },
      {
        config: DEFAULT_BBDIP_CONFIG,
        getMa20: () => currentMa20,
      }
    );

    // 아직 MA20 미달
    expect(rule.onPrice(100.2)).toBeNull();

    // MA20 도달 (100.5)
    const decision = rule.onPrice(100.5);
    expect(decision).toEqual({ side: 'sell', qty: 10 });
    expect(rule.lastExitReason).toContain('볼린저 중심선(MA20) 회귀 익절');
  });

  it('2순위: 목표 익절 (+1.2%) 도달 시 전량 매도', () => {
    const rule = new BbDipExitRule(
      { qty: 10, avgPrice: 100 },
      {
        config: DEFAULT_BBDIP_CONFIG,
        getMa20: () => 105, // 중심선이 아주 높은 상태
      }
    );

    const decision = rule.onPrice(101.2); // +1.2%
    expect(decision).toEqual({ side: 'sell', qty: 10 });
    expect(rule.lastExitReason).toContain('목표 익절 도달');
  });

  it('3순위: 트레일링 익절 (+1.0% 이상 급등 후 고점 대비 0.5% 반납)', () => {
    const rule = new BbDipExitRule(
      { qty: 10, avgPrice: 100 },
      {
        config: DEFAULT_BBDIP_CONFIG,
        getMa20: () => 105,
      }
    );

    // 101.1(+1.1%)까지 상승
    rule.onPrice(101.1);
    // 100.55로 하락 (-0.55% 반납)
    const decision = rule.onPrice(100.55);
    expect(decision).toEqual({ side: 'sell', qty: 10 });
    expect(rule.lastExitReason).toContain('트레일링 익절');
  });

  it('4순위: 조기 칼손절 (-0.8%) 도달 시 즉시 매도', () => {
    const rule = new BbDipExitRule(
      { qty: 10, avgPrice: 100 },
      {
        config: DEFAULT_BBDIP_CONFIG,
        getMa20: () => 105,
      }
    );

    const decision = rule.onPrice(99.2); // -0.8%
    expect(decision).toEqual({ side: 'sell', qty: 10 });
    expect(rule.lastExitReason).toContain('조기 칼손절');
  });
});
