// 모델 어댑터 — 진입 후 관리가 백테스트 기하(+5%/−2%/120분)대로 나가는지, 청산 사유가 제대로 붙는지.
// 규칙 자체의 판정은 core/model/exitRule.test.ts, 여기서는 **배선**(모드 판정·인계 문구·틱 → 매매 → 정산)을 본다.

import { describe, expect, it } from 'vitest';

import { FakeBroker, fakeClock, flush } from './fakes';
import {
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
    price: () => ({ price: price(), lastTradeAt: clock.now(), dayLow: 95, dayHigh: 108 }),
    regularSession: () => true,
    entry: { entryTs: clock.now(), entrySnapshot: { price: 100, slope: 0, accel: 0, ts: clock.now() } },
    adopted: false,
    feeRate: 0.001,
    onEvent: (t) => events.push(t),
    ...extra,
  };
}

function harness(startPrice = 100) {
  const clock = fakeClock(1_000);
  const broker = new FakeBroker({ autoFill: true });
  broker.position = { qty: 10, avgPrice: 100 };
  const events: string[] = [];
  let price = startPrice;
  const pm = makePositionManager('model', { model: MODEL_CONFIG }, deps(broker, clock, events, () => price));
  return { pm, broker, clock, events, setPrice: (p: number) => (price = p) };
}

describe('모드 판정 — 모델이 추세보다 우선한다', () => {
  it('model 주입이 있으면 model, 없으면 기존 우선순위 그대로', () => {
    const grid = { buyWidth: 0.05, sellWidth: 0.02, buyMultiplier: 1 };
    const inflection = { sellProfitPct: 0.02, buyDropPct: 0.03 };
    expect(resolvePositionMode({ grid, inflection, trend: TREND_CONFIG, model: MODEL_CONFIG })).toBe('model');
    expect(resolvePositionMode({ grid, inflection, trend: TREND_CONFIG })).toBe('trend');
    expect(resolvePositionMode({ model: MODEL_CONFIG })).toBe('model');
  });

  it('설정값이 백테스트 기하 그대로다 — 이 값이 바뀌면 FINAL TEST 숫자의 근거가 사라진다', () => {
    expect(MODEL_CONFIG.takeProfitPct).toBe(0.05);
    expect(MODEL_CONFIG.stopLossPct).toBe(0.02);
    expect(MODEL_CONFIG.timeoutMinutes).toBe(120);
  });
});

describe('makePositionManager — 모델 어댑터', () => {
  it('인계 문구에 익절선·손절선·시간청산이 다 나오고, 게이지 양끝이 두 장벽이다', async () => {
    const h = harness();
    expect(h.pm.label).toBe('모델 관리');
    expect(await h.pm.arm({ qty: 10, avgPrice: 100 })).toEqual({ ok: true });
    expect(h.events.at(-1)).toContain('모델 관리 인계 · 10주 · 평단 100.00');
    expect(h.events.at(-1)).toContain('익절 105.00(+5%)');
    expect(h.events.at(-1)).toContain('손절 98.00(−2%)');
    expect(h.events.at(-1)).toContain('120분 시간청산');
    expect(h.events.at(-1)).toContain('물타기 없어요');
    const g = h.pm.gaugeView();
    expect(g.rangeKind).toBe('orders');
    expect([g.buyPrice, g.sellPrice]).toEqual([98, 105]);
  });

  it('+5%에 닿으면 전량 매도 → 정산 기록의 청산 사유가 TAKE_PROFIT', async () => {
    const h = harness();
    await h.pm.arm({ qty: 10, avgPrice: 100 });
    h.setPrice(104);
    await h.pm.tick({ canStart: true });
    expect(h.broker.placed).toHaveLength(0); // 아직 장벽 미도달

    h.setPrice(105.2);
    await h.pm.tick({ canStart: true });
    await flush();
    expect(h.events.some((e) => e.includes('익절선 도달 · +5%'))).toBe(true);
    const result = await h.pm.poll();
    expect(result.kind).toBe('sold');
    if (result.kind === 'sold') {
      expect(result.record.exitReason).toBe('TAKE_PROFIT');
      expect(result.record.qty).toBe(10);
    }
  });

  it('−2%에 닿으면 전량 매도 → 청산 사유는 STOP_LOSS', async () => {
    const h = harness();
    await h.pm.arm({ qty: 10, avgPrice: 100 });
    h.setPrice(97.5);
    await h.pm.tick({ canStart: true });
    await flush();
    expect(h.events.some((e) => e.includes('손절선 도달 · −2%'))).toBe(true);
    const result = await h.pm.poll();
    expect(result.kind).toBe('sold');
    if (result.kind === 'sold') expect(result.record.exitReason).toBe('STOP_LOSS');
  });

  it('120분이 지나면 장벽에 안 닿아도 시간 청산 → 청산 사유는 TIMEOUT', async () => {
    const h = harness();
    await h.pm.arm({ qty: 10, avgPrice: 100 });
    h.setPrice(101);
    await h.pm.tick({ canStart: true });
    expect(h.broker.placed).toHaveLength(0);

    h.clock.advance(120 * 60_000);
    await h.pm.tick({ canStart: true });
    await flush();
    expect(h.events.some((e) => e.includes('120분 경과'))).toBe(true);
    const result = await h.pm.poll();
    expect(result.kind).toBe('sold');
    if (result.kind === 'sold') expect(result.record.exitReason).toBe('TIMEOUT');
  });

  it('SELL 신호가 와도 아무것도 하지 않는다 — 청산은 장벽 판정만이다', async () => {
    const h = harness();
    await h.pm.arm({ qty: 10, avgPrice: 100 });
    h.pm.onSignal('SELL', 100);
    await flush();
    expect(h.broker.placed).toHaveLength(0);
    expect(h.pm.busy).toBe(false);
  });

  it('BUY 신호로 물타기하지 않는다', async () => {
    const h = harness();
    await h.pm.arm({ qty: 10, avgPrice: 100 });
    h.pm.onSignal('BUY', 96);
    await flush();
    expect(h.broker.placed).toHaveLength(0);
  });

  it('사용자 전량 매도는 장벽과 무관하게 통한다(USER_SELL)', async () => {
    const h = harness();
    await h.pm.arm({ qty: 10, avgPrice: 100 });
    expect(h.pm.sellNow?.(100)).toBe(true);
    await flush();
    const result = await h.pm.poll();
    expect(result.kind).toBe('sold');
    if (result.kind === 'sold') expect(result.record.exitReason).toBe('USER_SELL');
  });
});
