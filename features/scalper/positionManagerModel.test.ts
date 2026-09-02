// 모델 어댑터 — 진입 후 관리가 백테스트 기하(±3% 대칭/120분, 2026-09-01)대로 나가는지, 청산 사유가 제대로 붙는지.
// 규칙 자체의 판정은 core/model/exitRule.test.ts, 여기서는 **배선**(모드 판정·인계 문구·틱 → 매매 → 정산)을 본다.
// 트레일링(−5%/−2%)은 MODEL_EXIT_SYMMETRIC=false 롤백 경로로 보존 — 그 배선 검증은 스위치를 되돌릴 때 되살린다.

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

  it('설정값이 백테스트 기하 그대로다 — 이 값이 바뀌면 검증 숫자의 근거가 사라진다', () => {
    // 대칭(현행, 2026-09-01 워크포워드): ±3% / 120분. 트레일(롤백)은 trailPct에 남아 있다.
    expect(MODEL_CONFIG.tpPct).toBe(0.03);
    expect(MODEL_CONFIG.stopLossPct).toBe(0.03);
    expect(MODEL_CONFIG.maxHoldMin).toBe(120);
    expect(MODEL_CONFIG.trailPct).toBe(0.05);
  });
});

describe('makePositionManager — 모델 어댑터(±3% 대칭)', () => {
  it('인계 문구에 익절·손절·최장 보유가 나오고, 게이지 양끝이 익절선·손절선이다', async () => {
    const h = harness();
    expect(h.pm.label).toBe('모델 ±3% 관리');
    expect(await h.pm.arm({ qty: 10, avgPrice: 100 })).toEqual({ ok: true });
    expect(h.events.at(-1)).toContain('모델 ±3% 관리 인계 · 10주 · 평단 100.00');
    expect(h.events.at(-1)).toContain('익절 103.00(+3%)');
    expect(h.events.at(-1)).toContain('손절 97.00(−3%)');
    expect(h.events.at(-1)).toContain('최장 120분 보유');
    const g = h.pm.gaugeView();
    expect(g.rangeKind).toBe('orders');
    expect([g.buyPrice, g.sellPrice]).toEqual([97, 103]);
  });

  it('+3%에 닿으면 전량 매도 → 청산 사유는 TAKE_PROFIT, exitSnapshot에 판정가·익절선이 남는다', async () => {
    const h = harness();
    await h.pm.arm({ qty: 10, avgPrice: 100 });
    h.setPrice(101);
    await h.pm.tick({ canStart: true });
    expect(h.broker.placed).toHaveLength(0); // 아직 어느 선에도 안 닿았다

    h.setPrice(103.5);
    await h.pm.tick({ canStart: true });
    await flush();
    expect(h.events.some((e) => e.includes('익절 · 현재가 103.50 ≥ 밴드 상단 103.00'))).toBe(true);
    const result = await h.pm.poll();
    expect(result.kind).toBe('sold');
    if (result.kind === 'sold') {
      expect(result.record.exitReason).toBe('TAKE_PROFIT');
      expect(result.record.qty).toBe(10);
      expect(result.record.exitSnapshot).toMatchObject({ price: 103.5, line: 103, kind: 'TAKE_PROFIT' });
    }
  });

  it('−3%에 닿으면 전량 매도 → 청산 사유는 STOP_LOSS, 매도선은 손절선', async () => {
    const h = harness();
    await h.pm.arm({ qty: 10, avgPrice: 100 });
    h.setPrice(96.9);
    await h.pm.tick({ canStart: true });
    await flush();
    expect(h.events.some((e) => e.includes('손절 · 현재가 96.90 ≤ 밴드 하단 97.00'))).toBe(true);
    const result = await h.pm.poll();
    expect(result.kind).toBe('sold');
    if (result.kind === 'sold') {
      expect(result.record.exitReason).toBe('STOP_LOSS');
      expect(result.record.exitSnapshot).toMatchObject({ price: 96.9, line: 97, kind: 'STOP_LOSS' });
    }
  });

  it('어느 선에도 안 닿고 120분이 지나면 전량 매도 → 청산 사유는 TIMEOUT', async () => {
    const h = harness();
    await h.pm.arm({ qty: 10, avgPrice: 100 });
    h.setPrice(100.5);
    await h.pm.tick({ canStart: true });
    expect(h.broker.placed).toHaveLength(0);

    h.clock.advance(120 * 60_000);
    await h.pm.tick({ canStart: true });
    await flush();
    expect(h.events.some((e) => e.includes('시간 청산 · 진입 후 120분'))).toBe(true);
    const result = await h.pm.poll();
    expect(result.kind).toBe('sold');
    if (result.kind === 'sold') expect(result.record.exitReason).toBe('TIMEOUT');
  });

  it('래칫 배선(2026-09-02) — 익절 터치 때 슬롯의 모델 확률이 좋으면 팔지 않고 밴드가 올라간다', async () => {
    const clock = fakeClock(1_000);
    const broker = new FakeBroker({ autoFill: true });
    broker.position = { qty: 10, avgPrice: 100 };
    const events: string[] = [];
    let price = 100;
    const pm = makePositionManager(
      'model',
      { model: MODEL_CONFIG },
      deps(broker, clock, events, () => price, {
        modelVerdict: () => ({ prob: 0.99, at: clock.now() }), // 스캐너가 방금 밀어 넣은 높은 확률
      }),
    );
    await pm.arm({ qty: 10, avgPrice: 100 });
    price = 103.5;
    await pm.tick({ canStart: true });
    await flush();
    expect(broker.placed).toHaveLength(0); // 보류 — 안 판다
    const g = pm.gaugeView();
    expect(g.sellPrice).toBeCloseTo(106.09, 6); // 밴드가 한 계단 올라갔다
    expect(g.buyPrice).toBeCloseTo(99.91, 6); // 하단은 본전 근처로 잠김
    // 진입 후 고저(2026-09-02 게이지 마커) — 시작은 평단(100), 103.5 틱으로 최고가 갱신.
    expect(g.sinceEntryHigh).toBeCloseTo(103.5, 9);
    expect(g.sinceEntryLow).toBeCloseTo(100, 9);

    price = 99.5; // 되밀림 — 새 하단에서 손절(이익 잠금)
    await pm.tick({ canStart: true });
    await flush();
    const result = await pm.poll();
    expect(result.kind).toBe('sold');
    if (result.kind === 'sold') {
      expect(result.record.exitReason).toBe('STOP_LOSS');
      expect(result.record.exitSnapshot?.line).toBeCloseTo(99.91, 6);
    }
    expect(events.some((e) => e.includes('래칫 1계단'))).toBe(true);
  });

  it('오체결 한 건으로는 팔지 않는다 — 다음 틱이 확인해야 반영한다', async () => {
    const h = harness();
    await h.pm.arm({ qty: 10, avgPrice: 100 });
    h.setPrice(1000); // ×10 오체결 — 익절선(103) 위지만 이상치라 보류
    await h.pm.tick({ canStart: true });
    expect(h.broker.placed).toHaveLength(0);

    h.setPrice(100.5); // 정상 복귀 — 아무 일도 없다
    await h.pm.tick({ canStart: true });
    expect(h.broker.placed).toHaveLength(0);
    expect(h.pm.gaugeView().sellPrice).toBe(103);
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
