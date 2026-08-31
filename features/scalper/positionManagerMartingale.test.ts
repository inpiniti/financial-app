// ±3% 단타 모드 어댑터(2026-08-27 ADR 0006 → 2026-09-01 물타기 제거 ADR 0007) — 모드 판정·인계 문구·익절·손절·마감 청산 → 정산.
// 규칙 자체의 판정은 core/martingale/index.test.ts, 여기서는 **배선**을 본다.

import { describe, expect, it } from 'vitest';

import { FakeBroker, fakeClock, flush } from './fakes';
import {
  MARTINGALE_POSITION_CONFIG,
  MODEL_CONFIG,
  TREND_CONFIG,
  makePositionManager,
  resolvePositionMode,
  type PositionManagerDeps,
} from './positionManager';

function deps(
  broker: FakeBroker,
  clock: ReturnType<typeof fakeClock>,
  events: string[],
  price: () => number,
  extra: Partial<PositionManagerDeps> = {},
): PositionManagerDeps {
  return {
    ticker: 'A',
    broker,
    clock,
    price: () => ({ price: price(), lastTradeAt: clock.now(), dayLow: 90, dayHigh: 110 }),
    regularSession: () => true,
    entry: { entryTs: clock.now(), entrySnapshot: { price: 100, slope: 0, accel: 0, ts: clock.now() } },
    adopted: false,
    feeRate: 0,
    onEvent: (t) => events.push(t),
    ...extra,
  };
}

/** 2026-08-27 10:00 ET(EDT) — 정규장 한복판. 마감 청산(19:55)까지 여유가 있다. */
const TEN_AM_ET = Date.UTC(2026, 7, 27, 14, 0);

function harness(startPrice = 100) {
  const clock = fakeClock(TEN_AM_ET);
  const broker = new FakeBroker({ autoFill: true });
  broker.position = { qty: 10, avgPrice: 100 };
  const events: string[] = [];
  let price = startPrice;
  const pm = makePositionManager(
    'martingale',
    { martingale: MARTINGALE_POSITION_CONFIG, model: MODEL_CONFIG },
    deps(broker, clock, events, () => price),
  );
  return { pm, broker, clock, events, setPrice: (p: number) => (price = p) };
}

describe('모드 판정 — ±3% 단타가 모델보다 우선한다', () => {
  it('martingale 주입이 있으면 martingale, 없으면 기존 우선순위', () => {
    expect(resolvePositionMode({ martingale: MARTINGALE_POSITION_CONFIG, model: MODEL_CONFIG, trend: TREND_CONFIG })).toBe(
      'martingale',
    );
    expect(resolvePositionMode({ model: MODEL_CONFIG, trend: TREND_CONFIG })).toBe('model');
  });

  it('설정값 — 익절 +3% · 손절 −3% · 마감 19:55 ET (2026-09-01 사용자 확정)', () => {
    expect(MARTINGALE_POSITION_CONFIG.tpPct).toBe(0.03);
    expect(MARTINGALE_POSITION_CONFIG.stopLossPct).toBe(0.03);
    expect(MARTINGALE_POSITION_CONFIG.closeAtMin).toBe(19 * 60 + 55);
  });
});

describe('makePositionManager — ±3% 단타 어댑터', () => {
  it('인계 문구에 익절·손절 선이 나오고, 게이지는 익절가/손절선', async () => {
    const h = harness();
    expect(h.pm.label).toBe('±3% 관리');
    expect(await h.pm.arm({ qty: 10, avgPrice: 100 })).toEqual({ ok: true });
    const text = h.events.at(-1)!;
    expect(text).toContain('±3% 관리 인계 · 10주 · 평단 100.00');
    expect(text).toContain('익절 103.00(+3%)');
    expect(text).toContain('손절 97.00(−3%)');
    expect(text).toContain('물타기 없어요');
    expect(text).toContain('19:55 ET 마감 청산');
    const g = h.pm.gaugeView();
    expect(g.rangeKind).toBe('orders');
    expect([g.buyPrice, g.sellPrice]).toEqual([97, 103]);
  });

  it('익절: +3%에 닿으면 전량 매도 → TAKE_PROFIT, exitSnapshot.line = 목표가', async () => {
    const h = harness();
    await h.pm.arm({ qty: 10, avgPrice: 100 });
    h.setPrice(102.9);
    await h.pm.tick({ canStart: true });
    expect(h.broker.placed).toHaveLength(0);
    h.setPrice(103.2);
    await h.pm.tick({ canStart: true });
    await flush();
    expect(h.events.some((e) => e.includes('익절 · 현재가 103.20 ≥ 평단 +3%(103.00)'))).toBe(true);
    const r = await h.pm.poll();
    expect(r.kind).toBe('sold');
    if (r.kind === 'sold') {
      expect(r.record.exitReason).toBe('TAKE_PROFIT');
      expect(r.record.qty).toBe(10);
      expect(r.record.exitSnapshot).toMatchObject({ price: 103.2, line: 103, kind: 'TAKE_PROFIT' });
    }
  });

  it('손절: −3%에 닿으면 전량 매도 → STOP_LOSS, exitSnapshot.line = 손절선', async () => {
    const h = harness();
    await h.pm.arm({ qty: 10, avgPrice: 100 });
    h.setPrice(97.1);
    await h.pm.tick({ canStart: true });
    expect(h.broker.placed).toHaveLength(0);
    h.setPrice(96.8);
    await h.pm.tick({ canStart: true });
    await flush();
    expect(h.events.some((e) => e.includes('손절 · 현재가 96.80 ≤ 평단 −3%(97.00)'))).toBe(true);
    const r = await h.pm.poll();
    expect(r.kind).toBe('sold');
    if (r.kind === 'sold') {
      expect(r.record.exitReason).toBe('STOP_LOSS');
      expect(r.record.qty).toBe(10);
      expect(r.record.exitSnapshot).toMatchObject({ price: 96.8, line: 97, kind: 'STOP_LOSS' });
    }
  });

  it('물타기는 없다 — −3% 아래에서 BUY 신호가 와도 사지 않는다', async () => {
    const h = harness();
    await h.pm.arm({ qty: 10, avgPrice: 100 });
    h.clock.advance(5 * 60_000);
    h.pm.onSignal('BUY', 96);
    await flush();
    // BUY는 규칙(decide)이 null이라 매수가 나가지 않는다 — 대신 다음 틱 판정이 손절을 낸다.
    expect(h.broker.placed.filter((p) => p.side === 'buy')).toHaveLength(0);
  });

  it('마감 청산: 19:55 ET가 되면 목표 미달이어도 전량 매도 → SESSION_END', async () => {
    const h = harness();
    await h.pm.arm({ qty: 10, avgPrice: 100 });
    h.setPrice(99);
    h.clock.set(Date.UTC(2026, 7, 27, 23, 55)); // 19:55 EDT
    await h.pm.tick({ canStart: true });
    await flush();
    const r = await h.pm.poll();
    expect(r.kind).toBe('sold');
    if (r.kind === 'sold') expect(r.record.exitReason).toBe('SESSION_END');
  });

  it('SELL 신호는 무시한다 — 청산은 익절·손절·마감뿐(틱 판정)', async () => {
    const h = harness();
    await h.pm.arm({ qty: 10, avgPrice: 100 });
    h.pm.onSignal('SELL', 98);
    await flush();
    expect(h.broker.placed).toHaveLength(0);
  });
});
