import { describe, expect, it } from 'vitest';
import type { TradeRecord } from '../../core/cycle';
import { FakeStore, fakeClock } from './fakes';
import {
  appendTradeRecord,
  readTodayTrades,
  readTradesByDate,
  appendTradeAction,
  readTodayTradeActions,
  readTradeActionsByDate,
  readTodayTradeSummary,
  calculateTradeSummaryStats,
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

  it('appendTradeAction 및 readTodayTradeActions가 정상 동작한다', async () => {
    const store = new FakeStore();
    const ts = Date.UTC(2026, 6, 29, 10, 0, 0);
    const clock = fakeClock(ts);

    await appendTradeAction(store, {
      id: 'AAPL-entry-1',
      action: 'ENTRY',
      ticker: 'AAPL',
      price: 150,
      qty: 5,
      amountUsd: 750,
      ts,
      targetPrice: 154.5,
    });

    await appendTradeAction(store, {
      id: 'AAPL-scale-in-1',
      action: 'SCALE_IN',
      ticker: 'AAPL',
      price: 145,
      qty: 5,
      amountUsd: 725,
      ts: ts + 60_000,
      prevAvgPrice: 150,
      newAvgPrice: 147.5,
      totalQty: 10,
    });

    await appendTradeAction(store, {
      id: 'AAPL-exit-1',
      action: 'EXIT',
      ticker: 'AAPL',
      price: 152,
      qty: 10,
      amountUsd: 1520,
      ts: ts + 120_000,
      entryAvgPrice: 147.5,
      pnl: 45,
      returnRatio: 0.0305,
    });

    const actions = await readTodayTradeActions(store, clock);
    expect(actions).toHaveLength(3);
    expect(actions[0].action).toBe('ENTRY');
    expect(actions[1].action).toBe('SCALE_IN');
    expect(actions[2].action).toBe('EXIT');
    expect(actions[1].prevAvgPrice).toBe(150);
    expect(actions[1].newAvgPrice).toBe(147.5);
    expect(actions[2].pnl).toBe(45);
  });

  it('체결 액션이 없고 구버전 StoredTrade만 있을 때 ENTRY, EXIT으로 자동 폴백 변환한다', async () => {
    const store = new FakeStore();
    const clock = fakeClock(Date.UTC(2026, 6, 29, 23, 0, 0));
    await appendTradeRecord(store, 'inst-1', sampleTrade({ ticker: 'TSLA', entryPrice: 200, exitPrice: 206, pnl: 12 }));

    const actions = await readTodayTradeActions(store, clock);
    expect(actions).toHaveLength(2);
    expect(actions[0].action).toBe('ENTRY');
    expect(actions[0].ticker).toBe('TSLA');
    expect(actions[0].price).toBe(200);

    expect(actions[1].action).toBe('EXIT');
    expect(actions[1].ticker).toBe('TSLA');
    expect(actions[1].price).toBe(206);
    expect(actions[1].pnl).toBe(12);
  });

  it('당일 신규 체결 액션과 레거시 StoredTrade가 함께 존재할 때 무손실로 병합한다', async () => {
    const store = new FakeStore();
    const ts = Date.UTC(2026, 6, 29, 14, 0, 0);
    const clock = fakeClock(ts + 300_000);

    // 1. 레거시 사이클 1건 기록 (과거 시각)
    await appendTradeRecord(
      store,
      'inst-legacy',
      sampleTrade({ ticker: 'NVDA', entryPrice: 100, exitPrice: 103, entryTs: ts, exitTs: ts + 60_000, pnl: 30 }),
    );

    // 2. 신규 체결 액션 1건 기록 (이후 시각)
    await appendTradeAction(store, {
      id: 'AAPL-entry-1',
      action: 'ENTRY',
      ticker: 'AAPL',
      price: 150,
      qty: 10,
      amountUsd: 1500,
      ts: ts + 120_000,
    });

    const actions = await readTodayTradeActions(store, clock);
    // 레거시 2건(ENTRY, EXIT) + 신규 1건(ENTRY) = 총 3건이 모두 보존되어야 함
    expect(actions).toHaveLength(3);
    expect(actions[0].ticker).toBe('NVDA');
    expect(actions[0].action).toBe('ENTRY');
    expect(actions[1].ticker).toBe('NVDA');
    expect(actions[1].action).toBe('EXIT');
    expect(actions[2].ticker).toBe('AAPL');
    expect(actions[2].action).toBe('ENTRY');
  });

  it('readTodayTradeSummary는 체결 액션과 통계 요약(entries, scaleIns, exits, totalPnl)을 한 번에 집계한다', async () => {
    const store = new FakeStore();
    const ts = Date.UTC(2026, 6, 29, 14, 0, 0);
    const clock = fakeClock(ts + 300_000);

    await appendTradeAction(store, {
      id: 'AAPL-entry-1',
      action: 'ENTRY',
      ticker: 'AAPL',
      price: 150,
      qty: 10,
      amountUsd: 1500,
      ts: ts + 10_000,
    });

    await appendTradeAction(store, {
      id: 'AAPL-scale-1',
      action: 'SCALE_IN',
      ticker: 'AAPL',
      price: 145,
      qty: 10,
      amountUsd: 1450,
      ts: ts + 20_000,
      prevAvgPrice: 150,
      newAvgPrice: 147.5,
      totalQty: 20,
    });

    await appendTradeAction(store, {
      id: 'AAPL-exit-1',
      action: 'EXIT',
      ticker: 'AAPL',
      price: 152,
      qty: 20,
      amountUsd: 3040,
      ts: ts + 30_000,
      pnl: 90,
      returnRatio: 0.0305,
    });

    const summary = await readTodayTradeSummary(store, clock);
    expect(summary.actions).toHaveLength(3);
    expect(summary.stats.entries).toBe(1);
    expect(summary.stats.scaleIns).toBe(1);
    expect(summary.stats.exits).toBe(1);
    expect(summary.stats.totalPnl).toBe(90);
  });
});
