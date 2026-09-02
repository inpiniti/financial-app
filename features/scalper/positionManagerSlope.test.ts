// 기울기 단타 모드 어댑터(2026-09-02 ADR 0011) — 모드 판정·인계 문구·SELL 신호·틱 판정(기울기 < +1%) → 정산.
// 규칙 자체는 core/slope/index.test.ts, 여기서는 **배선**을 본다.

import { describe, expect, it } from 'vitest';

import { FakeBroker, fakeClock, flush } from './fakes';
import {
  MARTINGALE_POSITION_CONFIG,
  MODEL_CONFIG,
  SLOPE_POSITION_CONFIG,
  makePositionManager,
  resolvePositionMode,
  type PositionManagerDeps,
} from './positionManager';

/** 2026-08-27 22:00 ET — 주간거래. 마감 청산이 없음을 겸해 본다. */
const T0 = Date.UTC(2026, 7, 28, 2, 0);

function harness(opts: { slope?: () => number | null } = {}) {
  const clock = fakeClock(T0);
  const broker = new FakeBroker({ autoFill: true });
  broker.position = { qty: 10, avgPrice: 100 };
  const events: string[] = [];
  let price = 100;
  let slope: number | null = 2;
  const deps: PositionManagerDeps = {
    ticker: 'A',
    broker,
    clock,
    price: () => ({ price, lastTradeAt: clock.now(), dayLow: 90, dayHigh: 110 }),
    regularSession: () => false,
    entry: { entryTs: clock.now(), entrySnapshot: { price: 100, slope: 0, accel: 0, ts: clock.now() } },
    adopted: false,
    feeRate: 0,
    onEvent: (t) => events.push(t),
    ...('slope' in opts ? { slopeRate: opts.slope } : { slopeRate: () => slope }),
  };
  const pm = makePositionManager('slope', { slope: SLOPE_POSITION_CONFIG, martingale: MARTINGALE_POSITION_CONFIG, model: MODEL_CONFIG }, deps);
  return { pm, broker, clock, events, setPrice: (p: number) => (price = p), setSlope: (s: number | null) => (slope = s) };
}

describe('모드 판정 — 기울기 단타가 물타기·모델보다 우선한다', () => {
  it('slope 주입이 있으면 slope, 없으면 기존 우선순위', () => {
    expect(resolvePositionMode({ slope: SLOPE_POSITION_CONFIG, martingale: MARTINGALE_POSITION_CONFIG, model: MODEL_CONFIG })).toBe('slope');
    expect(resolvePositionMode({ martingale: MARTINGALE_POSITION_CONFIG, model: MODEL_CONFIG })).toBe('martingale');
  });

  it('설정값 — 진입·청산 문턱 +1%', () => {
    expect(SLOPE_POSITION_CONFIG.entryPct).toBe(1);
    expect(SLOPE_POSITION_CONFIG.exitPct).toBe(1);
  });
});

describe('makePositionManager — 기울기 단타 어댑터', () => {
  it('인계 문구에 규칙이 나오고, 게이지는 오늘 고저 축(가격 조건선 없음)', async () => {
    const h = harness();
    expect(h.pm.label).toBe('기울기 관리');
    expect(await h.pm.arm({ qty: 10, avgPrice: 100 })).toEqual({ ok: true });
    const text = h.events.at(-1)!;
    expect(text).toContain('기울기 관리 인계 · 10주 · 평단 100.00');
    expect(text).toContain('+1% 아래로 내려오면 즉시 전량 매도');
    expect(text).toContain('익절·손절·물타기·마감 청산 없어요');
    expect(h.pm.gaugeView().rangeKind).toBe('dayRange');
  });

  it('틱 판정: 기울기 ≥ +1%면 손실 중에도 들고, +1% 미만으로 내려오면 손익 무관 전량 매도 → SELL_SIGNAL', async () => {
    const h = harness();
    await h.pm.arm({ qty: 10, avgPrice: 100 });
    h.setPrice(93); // −7%인데 기울기 2% — 손절 없음
    await h.pm.tick({ canStart: true });
    await flush();
    expect(h.broker.placed).toHaveLength(0);
    h.setPrice(108); // +8%인데 기울기 2% — 익절 없음
    await h.pm.tick({ canStart: true });
    await flush();
    expect(h.broker.placed).toHaveLength(0);
    h.setSlope(0.9);
    await h.pm.tick({ canStart: true });
    await flush();
    expect(h.broker.placed).toHaveLength(1);
    expect(h.events.some((e) => e.includes('기울기 청산 · 기울기/10초 +0.9% < +1%'))).toBe(true);
    const r = await h.pm.poll();
    expect(r.kind).toBe('sold');
    if (r.kind === 'sold') {
      expect(r.record.exitReason).toBe('SELL_SIGNAL');
      expect(r.record.qty).toBe(10);
    }
  });

  it('기울기 null(체결 끊김)도 판다', async () => {
    const h = harness();
    await h.pm.arm({ qty: 10, avgPrice: 100 });
    h.setSlope(null);
    await h.pm.tick({ canStart: true });
    await flush();
    expect(h.broker.placed).toHaveLength(1);
    expect(h.events.some((e) => e.includes('체결 끊김'))).toBe(true);
  });

  it('슬롯 SELL 신호도 전량 매도, BUY 신호는 무시(물타기 없음)', async () => {
    const h = harness();
    await h.pm.arm({ qty: 10, avgPrice: 100 });
    h.pm.onSignal('BUY', 95);
    await flush();
    expect(h.broker.placed).toHaveLength(0);
    h.pm.onSignal('SELL', 101);
    await flush();
    expect(h.broker.placed).toHaveLength(1);
    expect(h.broker.placed[0]).toMatchObject({ side: 'sell', qty: 10 });
  });

  it('기울기 공급이 없으면(슬롯 없는 입양) 틱 판정을 하지 않는다', async () => {
    const h = harness({ slope: undefined });
    await h.pm.arm({ qty: 10, avgPrice: 100 });
    await h.pm.tick({ canStart: true });
    await flush();
    expect(h.broker.placed).toHaveLength(0);
  });

  it('매도는 가격이 되돌아와도 접지 않는다(취소선 없음)', async () => {
    const h = harness();
    await h.pm.arm({ qty: 10, avgPrice: 100 });
    h.setSlope(0);
    await h.pm.tick({ canStart: true });
    await flush();
    expect(h.broker.placed).toHaveLength(1);
    h.setPrice(130);
    await h.pm.tick({ canStart: true });
    await flush();
    expect(h.broker.canceled).toHaveLength(0);
  });
});
