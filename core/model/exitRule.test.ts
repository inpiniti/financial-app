// 모델 청산 규칙 — 백테스트 기하(+5%/−2%/120분)를 그대로 지키는지.

import { describe, expect, it } from 'vitest';
import { MODEL_EXIT_CONFIG, ModelExitRule } from './exitRule';

const seed = { qty: 10, avgPrice: 100 };
const T0 = Date.parse('2026-08-18T13:00:00Z');
const make = (nowRef: { now: number }) =>
  new ModelExitRule(seed, { ...MODEL_EXIT_CONFIG, entryAtMs: T0, clock: { now: () => nowRef.now } });

describe('ModelExitRule', () => {
  it('장벽 가격은 평단 기준 +5% / −2%', () => {
    const r = make({ now: T0 });
    expect(r.takeProfitPrice).toBeCloseTo(105, 9);
    expect(r.stopLossPrice).toBeCloseTo(98, 9);
    expect(r.timeoutAtMs).toBe(T0 + 120 * 60_000);
  });

  it('+5%에 닿으면 전량 매도(TAKE_PROFIT)', () => {
    const r = make({ now: T0 });
    expect(r.onPrice(104.99)).toBeNull();
    expect(r.onPrice(105)).toEqual({ side: 'sell', qty: 10 });
    expect(r.exitKind).toBe('TAKE_PROFIT');
  });

  it('−2%에 닿으면 전량 매도(STOP_LOSS)', () => {
    const r = make({ now: T0 });
    expect(r.onPrice(98.01)).toBeNull();
    expect(r.onPrice(98)).toEqual({ side: 'sell', qty: 10 });
    expect(r.exitKind).toBe('STOP_LOSS');
  });

  it('120분이 지나면 장벽에 안 닿아도 전량 매도(TIMEOUT)', () => {
    const now = { now: T0 + 119 * 60_000 };
    const r = make(now);
    expect(r.onPrice(100)).toBeNull();
    now.now = T0 + 120 * 60_000;
    expect(r.onPrice(100)).toEqual({ side: 'sell', qty: 10 });
    expect(r.exitKind).toBe('TIMEOUT');
  });

  it('양쪽이 한꺼번에 걸리면 하단(패)로 본다 — 백테스트의 동시 터치 보수 규약', () => {
    // 평단 100, 두 장벽 사이가 아닌 값(예: 폭이 겹치도록 좁힌 설정)에서 하단이 먼저 판정된다.
    const r = new ModelExitRule(seed, {
      takeProfitPct: 0.01,
      stopLossPct: 0.01,
      timeoutMinutes: 120,
      entryAtMs: T0,
    });
    expect(r.onPriceAt(101)).toEqual({ side: 'sell', qty: 10 });
    expect(r.exitKind).toBe('TAKE_PROFIT');
    expect(r.onPriceAt(99)).toEqual({ side: 'sell', qty: 10 });
    expect(r.exitKind).toBe('STOP_LOSS');
  });

  it('신호로는 아무것도 하지 않는다 — 모델은 청산 신호를 내지 않는다(물타기도 없다)', () => {
    const r = make({ now: T0 });
    expect(r.decide('SELL', 90)).toBeNull();
    expect(r.decide('BUY', 90)).toBeNull();
  });

  it('취소선 없음 — 어떤 가격에도 추격을 이어간다', () => {
    const r = make({ now: T0 });
    expect(r.shouldAbort('sell', 1)).toBe(false);
    expect(r.shouldAbort('buy', 1_000)).toBe(false);
  });

  it('평단이 갱신되면 장벽도 따라 움직인다(입양 포지션 재조회)', () => {
    const r = make({ now: T0 });
    r.setPosition({ qty: 20, avgPrice: 50 });
    expect(r.takeProfitPrice).toBeCloseTo(52.5, 9);
    expect(r.onPrice(49)).toEqual({ side: 'sell', qty: 20 });
  });

  it('clock이 없으면 시간 청산은 하지 않는다 — 가격 판정만', () => {
    const r = new ModelExitRule(seed, { ...MODEL_EXIT_CONFIG, entryAtMs: T0 });
    expect(r.onPrice(100)).toBeNull();
  });
});
