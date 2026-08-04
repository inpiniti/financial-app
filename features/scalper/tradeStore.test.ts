import { describe, expect, it } from 'vitest';
import type { TradeRecord } from '../../core/cycle';
import { FakeStore, fakeClock } from './fakes';
import {
  appendTradeRecord,
  readTodayTrades,
  readTradesByDate,
  tradeKeyFor,
  TRADE_KEY_PREFIX,
} from './tradeStore';

function sampleTrade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    ticker: 'AAPL',
    qty: 2,
    entryPrice: 100,
    entryTs: 0,
    exitPrice: 105,
    exitTs: Date.UTC(2026, 6, 29, 12, 0, 0), // 2026-07-29
    pnl: 10,
    entrySnapshot: { price: 100, slope: 1, accel: 0, ts: 0 },
    exitSnapshot: { price: 105, slope: -1, accel: 0, ts: 0 },
    exitReason: 'SELL_SIGNAL',
    ...overrides,
  };
}

describe('tradeStore — 일자별 append/조회', () => {
  it('exitTs 일자 키(trades.YYYY-MM-DD)에 instanceId를 포함해 append한다', async () => {
    const store = new FakeStore();
    await appendTradeRecord(store, 'inst-1', sampleTrade());

    const key = tradeKeyFor(Date.UTC(2026, 6, 29, 12, 0, 0));
    expect(key).toBe(`${TRADE_KEY_PREFIX}2026-07-29`);

    const list = await readTradesByDate(store, '2026-07-29');
    expect(list).toHaveLength(1);
    expect(list[0].instanceId).toBe('inst-1');
    expect(list[0].ticker).toBe('AAPL');
    expect(list[0].pnl).toBe(10);
  });

  it('같은 날짜에 여러 건을 순서대로 누적한다', async () => {
    const store = new FakeStore();
    await appendTradeRecord(store, 'inst-1', sampleTrade({ ticker: 'AAPL' }));
    await appendTradeRecord(store, 'inst-2', sampleTrade({ ticker: 'MSFT' }));

    const list = await readTradesByDate(store, '2026-07-29');
    expect(list.map((t) => t.instanceId)).toEqual(['inst-1', 'inst-2']);
    expect(list.map((t) => t.ticker)).toEqual(['AAPL', 'MSFT']);
  });

  it('readTodayTrades는 clock 기준 오늘 키를 읽는다', async () => {
    const store = new FakeStore();
    const clock = fakeClock(Date.UTC(2026, 6, 29, 23, 0, 0));
    await appendTradeRecord(store, 'inst-1', sampleTrade());

    const today = await readTodayTrades(store, clock);
    expect(today).toHaveLength(1);
    expect(today[0].instanceId).toBe('inst-1');
  });
});
