// makeTradeRecord — 정산 기록 합성의 유일한 자리(사이클·OCO 그리드·조건부 그리드·수동청산 정산이 공유).
import { describe, expect, it } from 'vitest';

import { makeTradeRecord } from './index';

const snap = { price: 10, slope: 0.1, accel: 0.01, ts: 5_000 };

describe('makeTradeRecord', () => {
  it('손익·수수료 — grossPnl=(청산−진입)×수량, fees=편도요율×(매수대금+매도대금), pnl=gross−fees', () => {
    const r = makeTradeRecord({ ticker: 'A', qty: 3, entryPrice: 10, exitPrice: 12, exitReason: 'SELL_SIGNAL', feeRate: 0.001, now: 9_000 });
    expect(r.grossPnl).toBeCloseTo(6);
    expect(r.fees).toBeCloseTo(0.001 * (30 + 36));
    expect(r.pnl).toBeCloseTo(6 - 0.066);
    expect(r.exitTs).toBe(9_000);
    expect(r.exitReason).toBe('SELL_SIGNAL');
  });

  it('수수료율 미지정·NaN·음수는 0으로(pnl=grossPnl)', () => {
    for (const feeRate of [undefined, NaN, -0.1, Infinity]) {
      const r = makeTradeRecord({ ticker: 'A', qty: 1, entryPrice: 10, exitPrice: 11, exitReason: 'STOP_LOSS', feeRate, now: 1 });
      expect(r.fees).toBe(0);
      expect(r.pnl).toBe(r.grossPnl);
    }
  });

  it('진입 정보가 있으면 실측 entryTs·entrySnapshot을, 청산 스냅샷도 그대로 싣는다', () => {
    const r = makeTradeRecord({
      ticker: 'A', qty: 1, entryPrice: 10, exitPrice: 11, exitReason: 'CIRCUIT', now: 9_000,
      entry: { entryTs: 4_000, entrySnapshot: snap }, exitSnapshot: { ...snap, ts: 9_000 },
    });
    expect(r.entryTs).toBe(4_000);
    expect(r.entrySnapshot).toBe(snap);
    expect(r.exitSnapshot?.ts).toBe(9_000);
  });

  it('입양 포지션(진입 정보 없음)은 entryTs=now, 스냅샷은 진입가 기준 0 기울기 폴백, exitSnapshot=null', () => {
    const r = makeTradeRecord({ ticker: 'A', qty: 2, entryPrice: 10, exitPrice: 9, exitReason: 'MANUAL', now: 7_000, entry: null });
    expect(r.entryTs).toBe(7_000);
    expect(r.entrySnapshot).toEqual({ price: 10, slope: 0, accel: 0, ts: 7_000 });
    expect(r.exitSnapshot).toBeNull();
    expect(r.grossPnl).toBe(-2);
  });
});
