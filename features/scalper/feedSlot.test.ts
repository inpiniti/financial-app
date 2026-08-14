import { describe, expect, it, vi } from 'vitest';

import { FeedSlot } from './feedSlot';
import { fakeClock } from './fakes';

// core/integration.test.ts에서 검증된 V자(버퍼 7·청크 1초): 하락→바닥→상승 → BUY 1회.
const V = [20, 16, 12, 8, 4, 2, 4, 8, 12, 16, 20];

function makeSlot(clock = fakeClock(1000)) {
  const slot = new FeedSlot({
    ticker: 'AAPL',
    clock,
    chunkSeconds: 1,
    bufferSize: 7,
    minSellMomentum: 0,
  });
  return { slot, clock };
}

/** 초당 1틱 재생 — 틱마다 fake clock도 같이 흐른다(틱/초 계산이 실제와 같은 조건). */
function replay(slot: FeedSlot, clock: ReturnType<typeof fakeClock>, prices: number[], startIndex = 0) {
  for (let i = 0; i < prices.length; i += 1) {
    slot.pushTick(prices[i], (startIndex + i) * 1000);
    clock.advance(1000);
  }
}

describe('FeedSlot — 상시 수신(틱/초·리샘플) + detector 탈부착', () => {
  it('detector 미부착이면 버퍼만 채우고 신호는 없다', () => {
    const { slot, clock } = makeSlot();
    replay(slot, clock, V);
    const view = slot.getView();
    expect(view.warmedUp).toBe(true);
    expect(view.watched).toBe(false);
    expect(view.lastSignal).toBeNull();
    expect(view.price).toBe(20);
  });

  it('워밍업 공백 없음 — 버퍼가 찬 뒤 부착하면 재워밍업 없이 이어지는 청크에서 BUY가 나온다', () => {
    const { slot, clock } = makeSlot();
    // 하락~바닥 구간(8틱 = 7청크 마감)으로 버퍼를 미리 채운다 — 감시 대상이 아니던 기간.
    replay(slot, clock, V.slice(0, 8)); // [20,16,12,8,4,2,4,8]
    expect(slot.warmedUp).toBe(true);

    const onSignal = vi.fn();
    slot.attachDetector(onSignal); // 틱/초 상위 3에 진입 — 감시 시작.

    // 남은 상승 구간만 흘린다 — detector를 처음부터 달고 있던 인스턴스와 같은 시퀀스 소비량.
    replay(slot, clock, V.slice(8), 8); // [12,16,20]
    slot.pushTick(20, V.length * 1000); // 캡 틱 — 마지막 청크 마감.

    expect(onSignal).toHaveBeenCalledTimes(1);
    const [signal, ctx] = onSignal.mock.calls[0];
    expect(signal).toBe('BUY');
    expect(ctx.ticker).toBe('AAPL');
    expect(ctx.price).toBeGreaterThan(0);
    expect(slot.getView().lastSignal).toBe('BUY');
  });

  it('detach하면 신호가 멈추고 수치는 지워진다 — 리샘플·틱/초는 계속', () => {
    const { slot, clock } = makeSlot();
    replay(slot, clock, V.slice(0, 8));
    const onSignal = vi.fn();
    slot.attachDetector(onSignal);
    slot.detachDetector();

    replay(slot, clock, V.slice(8), 8);
    slot.pushTick(20, V.length * 1000);

    expect(onSignal).not.toHaveBeenCalled();
    const view = slot.getView();
    expect(view.watched).toBe(false);
    expect(view.slope).toBeNull();
    expect(view.warmedUp).toBe(true); // 버퍼는 계속 살아 있다.
  });

  it('틱/초 — 현재 시점 순간값(10초 윈도우)이고 틱이 끊기면 내려간다', () => {
    const clock = fakeClock(0);
    const slot = new FeedSlot({ ticker: 'AAPL', clock, tickRateWindowMs: 10_000 });
    for (let i = 0; i < 20; i += 1) {
      slot.pushTick(100, i * 500);
      clock.advance(500); // 0.5초 간격 20틱 = 10초
    }
    expect(slot.tickRate()).toBeCloseTo(1.9, 1); // 윈도우 경계 1틱 탈락 허용
    clock.advance(20_000); // 무틱 20초 경과.
    expect(slot.tickRate()).toBe(0);
  });

  it('기울기/초 — 상시 기록되고 뷰에 현재값·시계열 5칸이 실린다', () => {
    const clock = fakeClock(0);
    const slot = new FeedSlot({ ticker: 'AAPL', clock });
    // 1초 간격 균일 상승 100→101 (+1%/10초) — detector 미부착이어도 기록된다.
    for (let i = 0; i <= 10; i += 1) {
      slot.pushTick(100 + i * 0.1, i * 1000);
      clock.advance(1000);
    }
    const view = slot.getView();
    expect(view.slopeRate).toBeCloseTo(0.1, 1); // 초당 약 +0.1%
    expect(view.tickRateSeries).toHaveLength(5);
    expect(view.slopeRateSeries).toHaveLength(5);
    expect(view.slopeRateSeries[4]).toBe(view.slopeRate);

    clock.advance(30_000); // 무틱 30초 — 판정 불가는 null(0 아님).
    expect(slot.getView().slopeRate).toBeNull();
    expect(slot.getView().tickRate).toBe(0);
  });

  it('호가 캐시 — 유효값만 저장하고 quote 게터로 노출한다', () => {
    const { slot } = makeSlot();
    expect(slot.quote).toBeNull();
    slot.pushQuote(99.5, 100.5);
    expect(slot.quote).toEqual({ bid1: 99.5, ask1: 100.5, at: 1000 });
    slot.pushQuote(Number.NaN, 0);
    expect(slot.quote).toBeNull();
  });

  it('BUY 게이트 — 거래량이 평평하면 매수 신호가 없고, 재부착(detector 재생성) 후에도 게이트가 유지된다', () => {
    const clock = fakeClock(1000);
    const slot = new FeedSlot({
      ticker: 'AAPL',
      clock,
      chunkSeconds: 1,
      bufferSize: 7,
      minBuyMomentum: 0,
      minSellMomentum: 0,
      minVolumeSpikeRatio: 1.5,
    });
    const onSignal = vi.fn();
    slot.attachDetector(onSignal);
    // 거래량 평평(스파이크 없음) — 게이트가 BUY를 막는다.
    for (let i = 0; i < V.length; i += 1) {
      slot.pushTick(V[i], i * 1000, { volume: 10 });
      clock.advance(1000);
    }
    slot.pushTick(20, V.length * 1000, { volume: 10 });
    expect(onSignal).not.toHaveBeenCalled();

    // 재부착 — attachDetector가 detectorOptions로 detector를 재생성해도 게이트 설정이 그대로 살아있어야 한다.
    // (두 번째 재생은 앞 상승과 이어져 하락 전환 SELL이 나올 수 있다 — 게이트는 BUY 전용이므로 BUY만 센다.)
    slot.attachDetector(onSignal);
    for (let i = 0; i < V.length; i += 1) {
      slot.pushTick(V[i], (V.length + 1 + i) * 1000, { volume: 10 });
      clock.advance(1000);
    }
    slot.pushTick(20, (2 * V.length + 1) * 1000, { volume: 10 });
    const buyCalls = onSignal.mock.calls.filter((c) => c[0] === 'BUY');
    expect(buyCalls).toHaveLength(0);
  });

  it('BUY 게이트 — 변곡 부근 거래량 스파이크가 있으면 매수 신호가 나온다', () => {
    const clock = fakeClock(1000);
    const slot = new FeedSlot({
      ticker: 'AAPL',
      clock,
      chunkSeconds: 1,
      bufferSize: 7,
      minBuyMomentum: 0,
      minSellMomentum: 0,
      minVolumeSpikeRatio: 1.5,
    });
    const onSignal = vi.fn();
    slot.attachDetector(onSignal);
    for (let i = 0; i < V.length; i += 1) {
      slot.pushTick(V[i], i * 1000, { volume: i >= 8 ? 100 : 10 });
      clock.advance(1000);
    }
    slot.pushTick(20, V.length * 1000, { volume: 100 });
    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(onSignal.mock.calls[0][0]).toBe('BUY');
  });

  it('사다리 모드 — 간격×횟수만큼 계단 하락해야 BUY, 잔파동은 무신호 (2026-08-07 plan V-1)', () => {
    const clock = fakeClock(1000);
    const slot = new FeedSlot({
      ticker: 'AAPL',
      clock,
      chunkSeconds: 1,
      bufferSize: 7,
      ladder: { interval: 0.01, triggerCount: 3 },
    });
    const onSignal = vi.fn();

    // 잔파동(±0.5%) — 옛 SG는 여기서 바닥을 선언했지만 사다리는 침묵해야 한다.
    const wiggle = [100, 99.6, 100.1, 99.5, 100.2, 99.7, 100.3, 99.6];
    replay(slot, clock, wiggle);
    slot.attachDetector(onSignal);
    replay(slot, clock, [100.1, 99.6, 100.2, 99.5, 100.1], wiggle.length);
    expect(onSignal).not.toHaveBeenCalled();
    expect(slot.getView().watched).toBe(true);

    // 계단 하락 −1%×3 — 3번째 홀에서 BUY.
    const start = wiggle.length + 5;
    replay(slot, clock, [99, 98.01, 97.02, 97.02], start);
    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(onSignal.mock.calls[0][0]).toBe('BUY');
    expect(slot.getView().lastSignal).toBe('BUY');
  });

  it('사다리 모드 — 워밍업(버퍼 가득)을 기다리지 않는다: 첫 청크가 앵커, 즉시 판정 시작 (2026-08-09)', () => {
    const clock = fakeClock(1000);
    const slot = new FeedSlot({
      ticker: 'AAPL',
      clock,
      chunkSeconds: 1,
      bufferSize: 7, // 버퍼가 차려면 7청크 — 그 전에 BUY가 나와야 한다.
      ladder: { interval: 0.01, triggerCount: 3 },
    });
    const onSignal = vi.fn();
    slot.attachDetector(onSignal); // 구독 직후 바로 감시 — 과거 틱 이력 없음.

    // 앵커(100) 포함 5청크 만에 −1%×3 관통 — 버퍼(7)가 차기 전이다.
    replay(slot, clock, [100, 99, 98.01, 97.02, 97.02]);
    expect(slot.warmedUp).toBe(false); // 아직 워밍업 전임을 못박는다.
    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(onSignal.mock.calls[0][0]).toBe('BUY');
  });

  it('사다리 모드 — 뷰에 홀 카운트·다음 매수선이 노출되고 detach로 지워진다', () => {
    const clock = fakeClock(1000);
    const slot = new FeedSlot({
      ticker: 'AAPL',
      clock,
      chunkSeconds: 1,
      bufferSize: 7,
      ladder: { interval: 0.01, triggerCount: 3 },
    });
    const onSignal = vi.fn();
    replay(slot, clock, [100, 100, 100, 100, 100, 100, 100]);
    slot.attachDetector(onSignal);
    replay(slot, clock, [100, 99, 98.9], 7); // 앵커 100 → 홀 1(99) → 유지.
    const view = slot.getView();
    expect(view.ladder).not.toBeNull();
    expect(view.ladder!.count).toBe(1);
    expect(view.ladder!.triggerCount).toBe(3);
    expect(view.ladder!.nextBuyLevel).toBeCloseTo(98.01, 2);

    slot.detachDetector();
    expect(slot.getView().ladder).toBeNull();
    expect(slot.getView().watched).toBe(false);
  });

  it('사다리 옵션이 없으면 기존 SG 감지 그대로다 — 회귀 안전', () => {
    const { slot, clock } = makeSlot(); // ladder 미주입.
    const onSignal = vi.fn();
    replay(slot, clock, V.slice(0, 8));
    slot.attachDetector(onSignal);
    replay(slot, clock, V.slice(8), 8);
    slot.pushTick(20, V.length * 1000);
    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(onSignal.mock.calls[0][0]).toBe('BUY');
  });

  it('[사고 재현] setLadderOptions — 감시 중에도 새 간격·횟수가 즉시 먹는다(앱 재시작 불필요)', () => {
    const clock = fakeClock(1000);
    const slot = new FeedSlot({
      ticker: 'AAPL',
      clock,
      chunkSeconds: 1,
      bufferSize: 7,
      ladder: { interval: 0.01, triggerCount: 3 },
    });
    const onSignal = vi.fn();
    slot.attachDetector(onSignal);
    replay(slot, clock, [100, 99, 99]); // 앵커 100(첫 청크 마감) → 홀 1칸(99).
    expect(slot.getView().ladder!.count).toBe(1);

    // 설정 탭에서 간격 2%·2칸으로 저장 — 감시 중인 슬롯도 새 앵커에서 다시 센다.
    expect(slot.setLadderOptions({ interval: 0.02, triggerCount: 2 })).toBe(true);
    expect(slot.getView().ladder).toBeNull(); // 새 감지기 — 앵커부터 다시.
    expect(slot.getView().watched).toBe(true);

    replay(slot, clock, [100, 98, 96, 96], 3); // 새 앵커 100 → −2%×2(98→96) → BUY.
    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(slot.getView().ladder!.triggerCount).toBe(2);
  });

  it('setLadderOptions — 값이 같으면 감지기를 건드리지 않는다(홀 카운트 유지)', () => {
    const clock = fakeClock(1000);
    const slot = new FeedSlot({
      ticker: 'AAPL',
      clock,
      chunkSeconds: 1,
      bufferSize: 7,
      ladder: { interval: 0.01, triggerCount: 3 },
    });
    slot.attachDetector(vi.fn());
    replay(slot, clock, [100, 99, 99]);
    expect(slot.getView().ladder!.count).toBe(1);

    expect(slot.setLadderOptions({ interval: 0.01, triggerCount: 3 })).toBe(false);
    expect(slot.getView().ladder!.count).toBe(1);
  });

  it('setLadderOptions — 미감시 슬롯은 값만 갈아끼우고, 다음 부착부터 새 값으로 판정한다', () => {
    const clock = fakeClock(1000);
    const slot = new FeedSlot({
      ticker: 'AAPL',
      clock,
      chunkSeconds: 1,
      bufferSize: 7,
      ladder: { interval: 0.01, triggerCount: 3 },
    });
    expect(slot.setLadderOptions({ interval: 0.02, triggerCount: 2 })).toBe(true);
    expect(slot.getView().watched).toBe(false);

    slot.attachDetector(vi.fn());
    replay(slot, clock, [100, 98, 98]);
    expect(slot.getView().ladder!.triggerCount).toBe(2);
    expect(slot.getView().ladder!.count).toBe(1);
  });

  it('재부착하면 이전 감시의 lastSignal이 초기화된다', () => {
    const { slot, clock } = makeSlot();
    const onSignal = vi.fn();
    slot.attachDetector(onSignal);
    replay(slot, clock, V);
    slot.pushTick(20, V.length * 1000);
    expect(slot.getView().lastSignal).toBe('BUY');

    slot.attachDetector(onSignal); // 새 감시 세션.
    expect(slot.getView().lastSignal).toBeNull();
  });
});
