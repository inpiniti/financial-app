// 볼린저 하단 투매 반등(BB Dip Snapback) 모드 어댑터 배선 테스트.
// 규칙 자체는 core/bbDip/index.test.ts에서 검증하고, 여기서는 makePositionManager 및 RulePositionManager 배선을 본다.

import { describe, expect, it } from 'vitest';

import { FakeBroker, fakeClock, flush } from './fakes';
import {
  BBDIP_POSITION_CONFIG,
  MARTINGALE_POSITION_CONFIG,
  MODEL_CONFIG,
  SLOPE_POSITION_CONFIG,
  makePositionManager,
  resolvePositionMode,
  type PositionManagerDeps,
} from './positionManager';

const T0 = Date.UTC(2026, 7, 28, 2, 0);

function harness(opts: { ma20?: () => number | null } = {}) {
  const clock = fakeClock(T0);
  const broker = new FakeBroker({ autoFill: true });
  broker.position = { qty: 10, avgPrice: 100 };
  const events: string[] = [];
  let price = 100;
  let ma20: number | null = 100.5;
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
    ...('ma20' in opts ? { ma20: opts.ma20 } : { ma20: () => ma20 }),
  };
  const pm = makePositionManager('bbDip', { bbDip: BBDIP_POSITION_CONFIG }, deps);
  return { pm, broker, clock, events, setPrice: (p: number) => (price = p), setMa20: (m: number | null) => (ma20 = m) };
}

describe('모드 판정 — 볼린저 투매 반등(bbDip)이 최우선한다', () => {
  it('bbDip 주입이 있으면 bbDip, 없으면 기울기/물타기/모델 순', () => {
    expect(
      resolvePositionMode({
        bbDip: BBDIP_POSITION_CONFIG,
        slope: SLOPE_POSITION_CONFIG,
        martingale: MARTINGALE_POSITION_CONFIG,
        model: MODEL_CONFIG,
      }),
    ).toBe('bbDip');

    expect(
      resolvePositionMode({
        slope: SLOPE_POSITION_CONFIG,
        martingale: MARTINGALE_POSITION_CONFIG,
        model: MODEL_CONFIG,
      }),
    ).toBe('slope');
  });

  it('기본 설정값 검증 — takeProfit +1.2%, stopLoss 0.8%, trailingTrigger 1.0%', () => {
    expect(BBDIP_POSITION_CONFIG.takeProfitPct).toBe(0.012);
    expect(BBDIP_POSITION_CONFIG.stopLossPct).toBe(0.008);
    expect(BBDIP_POSITION_CONFIG.trailingTriggerPct).toBe(0.01);
  });
});

describe('makePositionManager — 볼린저 투매 반등 어댑터', () => {
  it('인계 문구에 규칙이 나오고 arm 성공', async () => {
    const h = harness();
    expect(h.pm.label).toBe('볼린저 투매 반등 관리');
    expect(await h.pm.arm({ qty: 10, avgPrice: 100 })).toEqual({ ok: true });
    const text = h.events.at(-1)!;
    expect(text).toContain('볼린저 투매 반등 관리 인계');
    expect(text).toContain('10주 · 평단 100.00');
  });

  it('MA20 중심선 도달 시 전량 청산(TAKE_PROFIT)', async () => {
    const h = harness();
    await h.pm.arm({ qty: 10, avgPrice: 100 });

    // 평단 100, MA20 100.3, 현재가 100.4 (> ma20)
    h.setMa20(100.3);
    h.setPrice(100.4);

    await h.pm.tick({ canStart: true });
    await flush();

    expect(h.broker.placed).toHaveLength(1);
    const polled = await h.pm.poll();
    expect(polled.kind).toBe('sold');
    if (polled.kind === 'sold') {
      expect(polled.record.exitReason).toBe('TAKE_PROFIT');
    }
  });

  it('조기 칼손절(-0.8%) 도달 시 전량 매도(STOP_LOSS)', async () => {
    const h = harness();
    await h.pm.arm({ qty: 10, avgPrice: 100 });

    // 평단 100, 현재가 99.1 (손실 -0.9% <= -0.8%)
    h.setMa20(105); // ma20은 저 멀리 있음
    h.setPrice(99.1);

    await h.pm.tick({ canStart: true });
    await flush();

    expect(h.broker.placed).toHaveLength(1);
    const polled = await h.pm.poll();
    expect(polled.kind).toBe('sold');
    if (polled.kind === 'sold') {
      expect(polled.record.exitReason).toBe('STOP_LOSS');
    }
  });

  it('목표 익절(+1.2%) 도달 시 전량 매도(TAKE_PROFIT)', async () => {
    const h = harness();
    await h.pm.arm({ qty: 10, avgPrice: 100 });

    // 평단 100, 현재가 101.3 (+1.3% >= +1.2%)
    h.setMa20(105);
    h.setPrice(101.3);

    await h.pm.tick({ canStart: true });
    await flush();

    expect(h.broker.placed).toHaveLength(1);
    const polled = await h.pm.poll();
    expect(polled.kind).toBe('sold');
    if (polled.kind === 'sold') {
      expect(polled.record.exitReason).toBe('TAKE_PROFIT');
    }
  });
});
