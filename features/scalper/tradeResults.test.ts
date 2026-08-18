import { describe, expect, it } from 'vitest';

import type { TradeRecord } from '../../core/cycle';
import { FakeStore } from './fakes';
import {
  fetchTradeReturns,
  TRADE_RESULTS_PENDING_KEY,
  TradeResultRecorder,
  toTradeResultRow,
  type TradeResultRow,
  type TradeResultsInsertClient,
  type TradeResultsSelectClient,
} from './tradeResults';

const RECORD: TradeRecord = {
  ticker: 'A',
  qty: 3,
  entryPrice: 10,
  entryTs: Date.UTC(2026, 7, 18, 1, 0, 0),
  exitPrice: 11,
  exitTs: Date.UTC(2026, 7, 18, 1, 5, 0),
  pnl: 2.9,
  grossPnl: 3,
  fees: 0.1,
  entrySnapshot: { price: 10, slope: 0, accel: 0, ts: 0 },
  exitSnapshot: null,
  exitReason: 'SELL_SIGNAL',
};

/** insert 가짜 — 실패 스위치·중복 코드·기록 보관. */
class FakeInsertClient implements TradeResultsInsertClient {
  rows: Record<string, unknown>[] = [];
  fail = false;
  duplicate = false;
  from(_table: string) {
    return {
      insert: async (values: Record<string, unknown>) => {
        if (this.fail) return { error: { message: 'network' } };
        if (this.duplicate) return { error: { message: 'duplicate key value violates unique constraint', code: '23505' } };
        this.rows.push(values);
        return { error: null };
      },
    };
  }
}

describe('toTradeResultRow', () => {
  it('TradeRecord → 행 매핑(ISO 시각·순손익·기본 fixed)', () => {
    const row = toTradeResultRow({ accountNo: '12345678-01', strategy: 'trend', record: RECORD, market: 'NAS', name: '에이', equityUsd: 1000 });
    expect(row).toMatchObject({
      account_no: '12345678-01',
      strategy: 'trend',
      exit_reason: 'SELL_SIGNAL',
      ticker: 'A',
      market: 'NAS',
      name: '에이',
      qty: 3,
      entry_price: 10,
      exit_price: 11,
      gross_pnl: 3,
      fees: 0.1,
      pnl: 2.9,
      equity_usd: 1000,
      sizing_mode: 'fixed',
      kelly_fraction: null,
    });
    expect(row.entry_at).toBe('2026-08-18T01:00:00.000Z');
    expect(row.exit_at).toBe('2026-08-18T01:05:00.000Z');
  });

  it('옛 기록(grossPnl·fees 없음)은 총손익을 되계산하고 수수료 0', () => {
    const { grossPnl: _g, fees: _f, ...legacy } = RECORD;
    const row = toTradeResultRow({ accountNo: 'x', strategy: 'inflection', record: legacy as TradeRecord });
    expect(row.gross_pnl).toBe(3);
    expect(row.fees).toBe(0);
    expect(row.market).toBeNull();
  });
});

describe('TradeResultRecorder', () => {
  const row = (ticker = 'A'): TradeResultRow => toTradeResultRow({ accountNo: 'acc', strategy: 'trend', record: { ...RECORD, ticker } });

  it('성공하면 insert 1건, 대기열 없음', async () => {
    const client = new FakeInsertClient();
    const store = new FakeStore();
    const rec = new TradeResultRecorder({ client, storage: store });
    expect(await rec.record(row())).toBe(true);
    expect(client.rows).toHaveLength(1);
    expect(await rec.pendingCount()).toBe(0);
  });

  it('실패하면 throw 없이 대기열에 남기고 이벤트 1건, 이후 flushPending으로 재전송', async () => {
    const client = new FakeInsertClient();
    const store = new FakeStore();
    const events: string[] = [];
    const rec = new TradeResultRecorder({ client, storage: store, onEvent: (t) => events.push(t) });
    client.fail = true;
    expect(await rec.record(row('A'))).toBe(false);
    expect(await rec.record(row('B'))).toBe(false);
    expect(await rec.pendingCount()).toBe(2);
    expect(events.filter((e) => e.includes('업로드 실패'))).toHaveLength(2);
    expect(client.rows).toHaveLength(0);

    client.fail = false;
    expect(await rec.flushPending()).toBe(2);
    expect(client.rows.map((r) => r.ticker)).toEqual(['A', 'B']); // 순서 유지
    expect(await rec.pendingCount()).toBe(0);
    expect(events.some((e) => e.includes('재전송 완료'))).toBe(true);
  });

  it('재전송 도중 실패하면 거기서 멈추고 나머지는 대기열에 남는다', async () => {
    const client = new FakeInsertClient();
    const store = new FakeStore();
    const rec = new TradeResultRecorder({ client, storage: store });
    client.fail = true;
    await rec.record(row('A'));
    await rec.record(row('B'));
    // 첫 건만 성공하도록 — 성공 후 다시 실패로.
    let calls = 0;
    const orig = client.from.bind(client);
    client.from = (t: string) => {
      const c = orig(t);
      return {
        insert: async (v: Record<string, unknown>) => {
          calls += 1;
          client.fail = calls > 1;
          return c.insert(v);
        },
      };
    };
    client.fail = false;
    expect(await rec.flushPending()).toBe(1);
    expect(await rec.pendingCount()).toBe(1);
    const left = JSON.parse((await store.getItem(TRADE_RESULTS_PENDING_KEY))!) as TradeResultRow[];
    expect(left[0].ticker).toBe('B');
  });

  it('유니크 위반(이미 올라간 행)은 성공으로 본다 — 재전송 중복 방지', async () => {
    const client = new FakeInsertClient();
    const rec = new TradeResultRecorder({ client, storage: new FakeStore() });
    client.duplicate = true;
    expect(await rec.record(row())).toBe(true);
    expect(await rec.pendingCount()).toBe(0);
  });

  it('클라이언트가 throw해도 record는 throw하지 않는다', async () => {
    const client: TradeResultsInsertClient = {
      from: () => ({
        insert: () => {
          throw new Error('boom');
        },
      }),
    };
    const rec = new TradeResultRecorder({ client, storage: new FakeStore() });
    expect(await rec.record(row())).toBe(false);
    expect(await rec.pendingCount()).toBe(1);
  });
});

describe('fetchTradeReturns', () => {
  function fakeSelect(rows: { return_pct: number | string | null }[], capture: { limit?: number; eqs: string[][] }) {
    const thenable = (data: typeof rows) => ({
      then: (res: (v: { data: typeof rows; error: null }) => unknown) => Promise.resolve({ data, error: null }).then(res),
    });
    const client: TradeResultsSelectClient = {
      from: () => ({
        select: () => ({
          eq: (c1: string, v1: string) => ({
            eq: (c2: string, v2: string) => {
              capture.eqs.push([c1, v1], [c2, v2]);
              return {
                order: () => ({
                  ...thenable(rows),
                  limit: (n: number) => {
                    capture.limit = n;
                    return thenable(rows.slice(0, n));
                  },
                }),
              };
            },
          }),
        }),
      }),
    } as unknown as TradeResultsSelectClient;
    return client;
  }

  it('전략·계좌 필터, 최근 n건 limit, %→소수', async () => {
    const cap: { limit?: number; eqs: string[][] } = { eqs: [] };
    const client = fakeSelect([{ return_pct: 5 }, { return_pct: '-1.5' }, { return_pct: null }], cap);
    const xs = await fetchTradeReturns(client, 'acc', 'trend', 2);
    expect(xs).toEqual([0.05, -0.015]);
    expect(cap.limit).toBe(2);
    expect(cap.eqs).toEqual([
      ['account_no', 'acc'],
      ['strategy', 'trend'],
    ]);
  });

  it('limit 미지정이면 전체 — null return_pct는 버린다', async () => {
    const cap: { limit?: number; eqs: string[][] } = { eqs: [] };
    const client = fakeSelect([{ return_pct: 5 }, { return_pct: null }, { return_pct: 2 }], cap);
    const xs = await fetchTradeReturns(client, 'acc', 'trend');
    expect(xs).toEqual([0.05, 0.02]);
    expect(cap.limit).toBeUndefined();
  });
});
