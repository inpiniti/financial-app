import { describe, expect, it } from 'vitest';

import { TrendExitRule } from './exitRule';

describe('TrendExitRule', () => {
  it('SELL이면 손실 중이어도 전량 매도 지시', () => {
    const r = new TrendExitRule({ qty: 7, avgPrice: 100 });
    expect(r.decide('SELL', 80)).toEqual({ side: 'sell', qty: 7 });
    expect(r.decide('SELL', 120)).toEqual({ side: 'sell', qty: 7 });
  });

  it('BUY는 항상 null(물타기 없음)', () => {
    const r = new TrendExitRule({ qty: 7, avgPrice: 100 });
    expect(r.decide('BUY', 50)).toBeNull();
  });

  it('취소선 없음 — shouldAbort는 항상 false', () => {
    const r = new TrendExitRule({ qty: 7, avgPrice: 100 });
    expect(r.shouldAbort('sell', 1)).toBe(false);
    expect(r.shouldAbort('sell', 1000)).toBe(false);
  });

  it('view는 게이지 호환 — sellLine=buyLine=평단, setPosition으로 갱신', () => {
    const r = new TrendExitRule({ qty: 7, avgPrice: 100 });
    expect(r.view).toEqual({ qty: 7, avgPrice: 100, entryQty: 7, sellLine: 100, buyLine: 100 });
    r.setPosition({ qty: 3, avgPrice: 90 });
    expect(r.view.qty).toBe(3);
    expect(r.view.avgPrice).toBe(90);
    expect(r.decide('SELL', 1)).toEqual({ side: 'sell', qty: 3 });
  });

  it('수량 0·비유한 가격이면 null', () => {
    const r = new TrendExitRule({ qty: 0, avgPrice: 100 });
    expect(r.decide('SELL', 100)).toBeNull();
    const r2 = new TrendExitRule({ qty: 5, avgPrice: 100 });
    expect(r2.decide('SELL', Number.NaN)).toBeNull();
  });
});
