// ±3% 단타 모드 어댑터(2026-08-27 ADR 0006 → 2026-09-01 물타기 제거 ADR 0007) — 모드 판정·인계 문구·익절·손절·마감 청산 → 정산.
// 규칙 자체의 판정은 core/martingale/index.test.ts, 여기서는 **배선**을 본다.

import { describe, expect, it } from 'vitest';

import { FakeBroker, fakeClock, flush } from './fakes';
import {
  EXIT_QUOTE_STALE_MS,
  EXIT_RETRY_BASE_MS,
  MARTINGALE_POSITION_CONFIG,
  MODEL_CONFIG,
  PRICE_STALE_MS,
  REST_PRICE_PROBE_MS,
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

describe('청산 매도 발주가 — 매수1호가 크로스(2026-09-01)', () => {
  it('신선한 bid1이 있으면 판정가 대신 bid1로 발주한다(진입의 매도1호가 크로스와 대칭)', async () => {
    const clock = fakeClock(TEN_AM_ET);
    const broker = new FakeBroker({ autoFill: true });
    broker.position = { qty: 10, avgPrice: 100 };
    const events: string[] = [];
    let price = 100;
    const pm = makePositionManager(
      'martingale',
      { martingale: MARTINGALE_POSITION_CONFIG },
      deps(broker, clock, events, () => price, {
        quote: () => ({ bid1: 96.5, ask1: 96.7, at: clock.now() }), // 신선한 1호가
      }),
    );
    await pm.arm({ qty: 10, avgPrice: 100 });
    price = 96.8; // 손절선(97) 이하 — 급락 중이라 체결가(96.8)는 bid1(96.5)보다 위다.
    await pm.tick({ canStart: true });
    await flush();
    expect(broker.placed).toHaveLength(1);
    expect(broker.placed[0].price).toBe(96.5); // 체결가가 아니라 bid1 — 즉시 크로스 체결.
    expect(events.some((e) => e.includes('매수1호가 추격'))).toBe(true);
  });

  it('호가가 오래됐으면(10초 초과) 판정가로 폴백한다', async () => {
    const clock = fakeClock(TEN_AM_ET);
    const broker = new FakeBroker({ autoFill: true });
    broker.position = { qty: 10, avgPrice: 100 };
    const events: string[] = [];
    let price = 100;
    const staleAt = clock.now();
    const pm = makePositionManager(
      'martingale',
      { martingale: MARTINGALE_POSITION_CONFIG },
      deps(broker, clock, events, () => price, { quote: () => ({ bid1: 96.5, ask1: 96.7, at: staleAt }) }),
    );
    await pm.arm({ qty: 10, avgPrice: 100 });
    clock.advance(EXIT_QUOTE_STALE_MS + 1);
    price = 96.8;
    await pm.tick({ canStart: true });
    await flush();
    expect(broker.placed[0]?.price).toBe(96.8);
  });
});

describe('청산 발주 거절 처리(2026-09-01) — 무한 재시도 대신 잔고 확인·백오프', () => {
  it('거절 + 잔고 없음 → 재시도하지 않고 외부 청산(MANUAL)으로 정산한다', async () => {
    const h = harness();
    await h.pm.arm({ qty: 10, avgPrice: 100 });
    h.broker.failPlaceOrder = true;
    h.broker.position = null; // 앱 밖에서 이미 팔린 상태 — 거절의 진짜 원인.
    h.setPrice(96.8);
    await h.pm.tick({ canStart: true });
    await flush();
    expect(h.events.some((e) => e.includes('잔고에도 없어요'))).toBe(true);
    const r = await h.pm.poll();
    expect(r.kind).toBe('sold');
    if (r.kind === 'sold') expect(r.record.exitReason).toBe('MANUAL');
    // 정산 뒤에는 다시 팔지 않는다.
    await h.pm.tick({ canStart: true });
    await flush();
    expect(h.broker.placed).toHaveLength(0);
  });

  it('거절 + 잔고 그대로 → 백오프(10초) 동안 재발주하지 않고, 지나면 다시 시도한다', async () => {
    const h = harness();
    await h.pm.arm({ qty: 10, avgPrice: 100 });
    h.broker.failPlaceOrder = true; // 잔고는 그대로(harness가 10주 세팅) — 세션 간극류 거절.
    h.setPrice(96.8);
    await h.pm.tick({ canStart: true });
    await flush();
    expect(h.events.filter((e) => e.includes('손절 ·'))).toHaveLength(1);
    expect(h.events.some((e) => e.includes('매도 발주 실패') && e.includes('10초 뒤'))).toBe(true);
    // 1초 뒤(예전엔 매초 재발주하던 자리) — 백오프 안이라 판정 자체를 쉰다.
    h.clock.advance(1_000);
    await h.pm.tick({ canStart: true });
    await flush();
    expect(h.events.filter((e) => e.includes('손절 ·'))).toHaveLength(1);
    // 백오프가 지나면 다시 시도 — 이번엔 접수돼 정산까지 간다.
    h.broker.failPlaceOrder = false;
    h.clock.advance(EXIT_RETRY_BASE_MS);
    await h.pm.tick({ canStart: true });
    await flush();
    expect(h.broker.placed).toHaveLength(1);
    const r = await h.pm.poll();
    expect(r.kind === 'sold' && r.record.exitReason).toBe('STOP_LOSS');
  });
});

describe('시세 정지 REST 폴백(2026-09-01) — 구독 거절·WS 무음에도 청산 감시', () => {
  it('틱이 20초 넘게 끊기면 REST 현재가로 손절을 발화한다', async () => {
    const clock = fakeClock(TEN_AM_ET);
    const broker = new FakeBroker({ autoFill: true });
    broker.position = { qty: 10, avgPrice: 100 };
    const events: string[] = [];
    const lastTickAt = clock.now();
    const pm = makePositionManager(
      'martingale',
      { martingale: MARTINGALE_POSITION_CONFIG },
      deps(broker, clock, events, () => 100, {
        // 마지막 틱이 옛날에 멈춘 슬롯 — price는 100에 고정돼 있다(구독 거절 상황 재현).
        price: () => ({ price: 100, lastTradeAt: lastTickAt, dayLow: 90, dayHigh: 110 }),
        fetchRestPrice: async () => 96.5, // 실제 시장은 이미 손절선 아래.
      }),
    );
    await pm.arm({ qty: 10, avgPrice: 100 });
    clock.advance(PRICE_STALE_MS + 1_000);
    await pm.tick({ canStart: true });
    await flush();
    expect(events.some((e) => e.includes('실시간 시세가 끊겼어요'))).toBe(true);
    expect(broker.placed).toHaveLength(1); // 낡은 틱(100)이었다면 안 팔았다 — REST(96.5)로 손절.
    const r = await pm.poll();
    expect(r.kind === 'sold' && r.record.exitReason).toBe('STOP_LOSS');
  });

  it('REST 폴백은 10초 간격으로만 조회한다(유량 방어)', async () => {
    const clock = fakeClock(TEN_AM_ET);
    const broker = new FakeBroker({ autoFill: true });
    broker.position = { qty: 10, avgPrice: 100 };
    let calls = 0;
    const pm = makePositionManager(
      'martingale',
      { martingale: MARTINGALE_POSITION_CONFIG },
      deps(broker, clock, [], () => 100, {
        price: () => ({ price: 100, lastTradeAt: 0, dayLow: 90, dayHigh: 110 }),
        fetchRestPrice: async () => {
          calls += 1;
          return 99; // 손절선 위 — 발주 없이 감시만.
        },
      }),
    );
    await pm.arm({ qty: 10, avgPrice: 100 });
    clock.advance(PRICE_STALE_MS + 1_000);
    await pm.tick({ canStart: true });
    clock.advance(1_000);
    await pm.tick({ canStart: true });
    clock.advance(1_000);
    await pm.tick({ canStart: true });
    expect(calls).toBe(1); // 3틱 동안 REST 1회.
    clock.advance(REST_PRICE_PROBE_MS);
    await pm.tick({ canStart: true });
    expect(calls).toBe(2);
  });
});
