// 볼린저 하단 투매 반등(BB Dip Snapback) FeedSlot 진입 신호 단위 테스트
import { describe, expect, it } from 'vitest';
import { fakeClock } from './fakes';
import { FeedSlot } from './feedSlot';
import type { SlotSignalListener } from './feedSlot';

describe('FeedSlot — 볼린저 투매 반등(bbDip) 진입 신호', () => {
  it('조건 미충족 시 BUY 신호 미발생, 조건 충족 시 BUY 발화', () => {
    const clock = fakeClock(10_000);
    const slot = new FeedSlot({
      ticker: 'TEST',
      clock,
      bbDip: true,
      bbDipConfig: {
        bbPeriod: 20,
        bbDev: 2.0,
        dipThreshold: -0.004,
        s10Min: 0.05,
        minRm: 50,
        minFr: 0.10,
        takeProfitPct: 0.012,
        stopLossPct: 0.008,
        trailingTriggerPct: 0.010,
        trailingDropPct: 0.005,
        breakevenTriggerPct: 0.006,
      },
    });

    const signals: Array<{ side: string; price: number }> = [];
    const listener: SlotSignalListener = (side, ctx) => {
      signals.push({ side, price: ctx.price });
    };
    slot.attachDetector(listener);

    // 1. 20개 틱 수신 시 볼린저 밴드 및 MA20 정상 계산 확인
    for (let i = 0; i < 20; i++) {
      clock.advance(500);
      slot.pushTick(100 + i, clock.now(), { strength: 110 });
    }

    // 20개 틱(100~119)의 평균 = 109.5
    expect(slot.getMa20()).toBeCloseTo(109.5, 4);

    // 2. 추가 틱(120) 수신 시 가장 오래된 100이 빠지고 새 틱이 들어가 평균 갱신 (101~120 평균 = 110.5)
    clock.advance(500);
    slot.pushTick(120, clock.now(), { strength: 115 });
    expect(slot.getMa20()).toBeCloseTo(110.5, 4);

    // 3. 횡보 및 완만한 상승에서는 투매가 아니므로 BUY 신호 없음
    expect(signals).toHaveLength(0);
  });
});
