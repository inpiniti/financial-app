import { describe, expect, it } from 'vitest';

import { SLOPE_CONFIG, SLOPE_EXIT_TICK_MS, SlopeRule, evaluateSlopeTransition } from './index';

describe('evaluateSlopeTransition — 문턱 전환에서만 신호', () => {
  it('아래(또는 모름)에서 +1% 이상으로 올라서면 BUY, 그 뒤 위에 머무는 동안은 조용하다', () => {
    expect(evaluateSlopeTransition(null, 0.4)).toEqual({ state: false, signal: null });
    expect(evaluateSlopeTransition(false, 1.0)).toEqual({ state: true, signal: 'BUY' });
    expect(evaluateSlopeTransition(null, 2.5)).toEqual({ state: true, signal: 'BUY' });
    expect(evaluateSlopeTransition(true, 1.7)).toEqual({ state: true, signal: null });
  });

  it('위에서 +1% 미만으로 내려오면 SELL — null(체결 끊김)도 내려온 것으로 본다', () => {
    expect(evaluateSlopeTransition(true, 0.99)).toEqual({ state: false, signal: 'SELL' });
    expect(evaluateSlopeTransition(true, -3)).toEqual({ state: false, signal: 'SELL' });
    expect(evaluateSlopeTransition(true, null)).toEqual({ state: false, signal: 'SELL' });
    expect(evaluateSlopeTransition(false, null)).toEqual({ state: false, signal: null });
  });

  it('문턱을 다르게 두면 그 사이 띠에서는 상태를 유지한다(히스테리시스)', () => {
    const cfg = { entryPct: 1, exitPct: 0.5 };
    expect(evaluateSlopeTransition(true, 0.7, cfg)).toEqual({ state: true, signal: null });
    expect(evaluateSlopeTransition(false, 0.7, cfg)).toEqual({ state: false, signal: null });
    expect(evaluateSlopeTransition(true, 0.4, cfg)).toEqual({ state: false, signal: 'SELL' });
  });

  it('기본값 — 진입·청산 문턱 둘 다 1%, 빠른 틱 100ms', () => {
    expect(SLOPE_CONFIG).toEqual({ entryPct: 1, exitPct: 1 });
    expect(SLOPE_EXIT_TICK_MS).toBe(100);
  });
});

describe('SlopeRule — 보유 중 규칙은 "전량 매도"뿐', () => {
  it('SELL 신호면 전량 매도, BUY 신호는 무시(물타기 없음)', () => {
    const r = new SlopeRule({ qty: 10, avgPrice: 100 });
    expect(r.decide('BUY', 97)).toBeNull();
    expect(r.decide('SELL', 101)).toEqual({ side: 'sell', qty: 10 });
  });

  it('틱 판정: 기울기 ≥ 1%면 보유, 미만·null이면 전량 매도', () => {
    let rate: number | null = 1.5;
    const r = new SlopeRule({ qty: 10, avgPrice: 100 }, { slope: () => rate });
    expect(r.onPrice(100)).toBeNull();
    rate = 0.9;
    expect(r.onPrice(100)).toEqual({ side: 'sell', qty: 10 });
    expect(r.lastRate).toBe(0.9);
    rate = null;
    expect(r.onPrice(100)).toEqual({ side: 'sell', qty: 10 });
  });

  it('기울기 공급이 없으면(슬롯 없는 입양 포지션) 틱 판정을 하지 않는다', () => {
    const r = new SlopeRule({ qty: 10, avgPrice: 100 });
    expect(r.onPrice(50)).toBeNull();
  });

  it('취소선 없음 — 매도는 어떤 가격에서도 접지 않는다', () => {
    const r = new SlopeRule({ qty: 10, avgPrice: 100 }, { slope: () => 0 });
    r.onPrice(100);
    expect(r.shouldAbort('sell', 120)).toBe(false);
    expect(r.shouldAbort('sell', 80)).toBe(false);
  });

  it('view — 가격 조건선이 없어 두 선 자리는 평단, setPosition으로 잔고를 따라간다', () => {
    const r = new SlopeRule({ qty: 10, avgPrice: 100 });
    expect(r.view).toEqual({ qty: 10, avgPrice: 100, entryQty: 10, sellLine: 100, buyLine: 100 });
    r.setPosition({ qty: 7, avgPrice: 100 });
    expect(r.decide('SELL', 100)).toEqual({ side: 'sell', qty: 7 });
  });
});
