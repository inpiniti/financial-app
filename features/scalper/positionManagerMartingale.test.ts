// 물타기 시험 모드 어댑터(2026-08-27, ADR 0006) — 모드 판정·인계 문구·5선 변곡 BUY → 배수 물타기 → 평단 갱신 → 익절 사다리 → 정산.
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

/** 2026-08-27 10:00 ET(EDT) — 정규장 한복판. 마감 청산(15:55)까지 여유가 있다. */
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

describe('모드 판정 — 물타기 시험이 모델보다 우선한다', () => {
  it('martingale 주입이 있으면 martingale, 없으면 기존 우선순위', () => {
    expect(resolvePositionMode({ martingale: MARTINGALE_POSITION_CONFIG, model: MODEL_CONFIG, trend: TREND_CONFIG })).toBe(
      'martingale',
    );
    expect(resolvePositionMode({ model: MODEL_CONFIG, trend: TREND_CONFIG })).toBe('model');
  });

  it('설정값이 백테스트 규약 그대로다', () => {
    expect(MARTINGALE_POSITION_CONFIG.tpLadder).toEqual([0.03, 0.02, 0.01]);
    expect(MARTINGALE_POSITION_CONFIG.dropStartPct).toBe(0.03);
    expect(MARTINGALE_POSITION_CONFIG.minGapMs).toBe(5 * 60_000);
    expect(MARTINGALE_POSITION_CONFIG.closeAtMin).toBe(19 * 60 + 55);
  });
});

describe('makePositionManager — 물타기 어댑터', () => {
  it('인계 문구에 익절 목표·사다리·물타기 선이 나오고, 게이지는 익절가/물타기 선', async () => {
    const h = harness();
    expect(h.pm.label).toBe('물타기 관리');
    expect(await h.pm.arm({ qty: 10, avgPrice: 100 })).toEqual({ ok: true });
    const text = h.events.at(-1)!;
    expect(text).toContain('물타기 관리 인계 · 10주 · 평단 100.00');
    expect(text).toContain('익절 103.00(+3%, 물타기 뒤 +3%/+2%/+1%)');
    expect(text).toContain('물타기 선 97.00(−3%)');
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

  it('물타기: 5선 변곡 BUY가 −3% 아래서 오면 보유량×배수를 사고, 평단·익절 목표(+2%)가 갱신된다', async () => {
    const h = harness();
    await h.pm.arm({ qty: 10, avgPrice: 100 });
    // 진입 직후(간격 5분 미만)는 물타지 않는다.
    h.pm.onSignal('BUY', 96);
    await flush();
    expect(h.broker.placed).toHaveLength(0);

    h.clock.advance(5 * 60_000);
    h.pm.onSignal('BUY', 96); // −4% → 3배 = 30주
    await flush();
    expect(h.broker.placed).toHaveLength(1);
    expect(h.broker.placed[0]).toMatchObject({ side: 'buy', qty: 30 });
    // 체결 반영 — 잔고는 KIS 정본(가짜 브로커 position)을 쓴다: 40주 · 평단 97.
    h.broker.position = { qty: 40, avgPrice: 97 };
    const r = await h.pm.poll();
    expect(r.kind).toBe('holding');
    expect(h.events.some((e) => e.includes('물타기 체결 · 30주 · 평단 $97.00 · 40주 보유'))).toBe(true);
    const g = h.pm.gaugeView();
    expect(g.holdingQty).toBe(40);
    expect(g.sellPrice).toBeCloseTo(97 * 1.02, 9); // 1회 물타기 뒤 익절 +2%
    expect(g.buyPrice).toBeCloseTo(97 * 0.97, 9);

    // 익절 +2% 도달 → 전량 40주 매도.
    h.setPrice(99);
    await h.pm.tick({ canStart: true });
    await flush();
    const sold = await h.pm.poll();
    expect(sold.kind).toBe('sold');
    if (sold.kind === 'sold') {
      expect(sold.record.exitReason).toBe('TAKE_PROFIT');
      expect(sold.record.qty).toBe(40);
      expect(sold.record.entryPrice).toBe(97);
    }
  });

  it('물타기 낙폭이 −3%에 못 미치면 BUY 신호가 와도 사지 않는다', async () => {
    const h = harness();
    await h.pm.arm({ qty: 10, avgPrice: 100 });
    h.clock.advance(5 * 60_000);
    h.pm.onSignal('BUY', 97.5);
    await flush();
    expect(h.broker.placed).toHaveLength(0);
  });

  it('현금이 모자라면 그 물타기만 건너뛴다(상한 없음의 유일한 브레이크)', async () => {
    const h = harness();
    const pm = makePositionManager(
      'martingale',
      { martingale: MARTINGALE_POSITION_CONFIG },
      deps(h.broker, h.clock, h.events, () => 90, { fetchBuyableUsd: async () => 100 }),
    );
    await pm.arm({ qty: 10, avgPrice: 100 });
    h.clock.advance(5 * 60_000);
    pm.onSignal('BUY', 90); // −10% → 9배 = 90주 × $90 = $8,100 > $100
    await flush();
    expect(h.broker.placed).toHaveLength(0);
    expect(h.events.some((e) => e.includes('물타기 생략 · 현금 부족'))).toBe(true);
  });

  it('마감 청산: 19:55 ET가 되면 목표 미달이어도 전량 매도 → SESSION_END', async () => {
    const h = harness();
    await h.pm.arm({ qty: 10, avgPrice: 100 });
    h.setPrice(95);
    h.clock.set(Date.UTC(2026, 7, 27, 23, 55)); // 19:55 EDT
    await h.pm.tick({ canStart: true });
    await flush();
    const r = await h.pm.poll();
    expect(r.kind).toBe('sold');
    if (r.kind === 'sold') expect(r.record.exitReason).toBe('SESSION_END');
  });

  it('SELL 신호는 무시한다 — 청산은 익절·마감뿐', async () => {
    const h = harness();
    await h.pm.arm({ qty: 10, avgPrice: 100 });
    h.pm.onSignal('SELL', 90);
    await flush();
    expect(h.broker.placed).toHaveLength(0);
  });
});
