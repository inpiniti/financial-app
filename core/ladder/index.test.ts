import { describe, expect, it } from 'vitest';

import { LadderDetector } from './index';

/** 청크 마감가 배열을 순서대로 흘리고 신호 목록을 모은다. */
function replay(detector: LadderDetector, prices: number[]) {
  const signals: Array<{ index: number; price: number }> = [];
  let last: ReturnType<LadderDetector['detect']> | null = null;
  prices.forEach((price, index) => {
    last = detector.detect(price);
    if (last.signal === 'BUY') signals.push({ index, price });
  });
  return { signals, last: last! };
}

describe('LadderDetector — 가상 그리드 사다리(홀 카운트) 진입', () => {
  it('잔파동(간격 미만의 찔끔 하락·찔끔 반등)에서는 절대 신호가 없다 — 기존 SG 오판의 회귀 테스트', () => {
    const d = new LadderDetector({ interval: 0.01, triggerCount: 3 });
    // 100 기준 ±0.5%(간격 1%의 절반) 잔파동 — 옛 감지기는 이런 곳에서 "바닥"을 선언했다.
    const wiggle = [100, 99.6, 100.1, 99.5, 100.2, 99.7, 100.3, 99.6, 100.1];
    const { signals, last } = replay(d, wiggle);
    expect(signals).toHaveLength(0);
    expect(last.count).toBe(0); // 홀이 한 번도 안 찍힌다.
  });

  it('계단 하락으로 홀 N번(기본 3)이 쌓이면 그 청크에서 BUY가 나온다', () => {
    const d = new LadderDetector({ interval: 0.01, triggerCount: 3 });
    // 100 → 99 → 98.01 → 97.02 : 각각 −1%씩 관통(홀 1·2·3).
    const { signals } = replay(d, [100, 99, 98.01, 97.02]);
    expect(signals).toHaveLength(1);
    expect(signals[0].index).toBe(3); // 3번째 홀이 찍힌 청크.
  });

  it('홀 N−1번 후 간격만큼 반등하면 가상 익절로 리셋 — 신호 없이 처음부터 다시 센다', () => {
    const d = new LadderDetector({ interval: 0.01, triggerCount: 3 });
    // 홀 2번(99, 98.01) 후 +1% 이상 반등(99.1 ≥ 98.01×1.01=98.9901) → 리셋.
    const r = replay(d, [100, 99, 98.01, 99.1]);
    expect(r.signals).toHaveLength(0);
    expect(r.last.count).toBe(0);
    // 리셋 후 앵커는 99.1 — 다시 3레벨(≈96.16)까지 내려가야 BUY.
    expect(d.detect(98.1).count).toBe(1);
    expect(d.detect(97.12).count).toBe(2);
    expect(d.detect(96.15).signal).toBe('BUY');
  });

  it('급락 1청크가 여러 레벨을 관통하면 관통 수만큼 센다 — 즉시 N 도달 시 그 청크에서 BUY', () => {
    const d = new LadderDetector({ interval: 0.01, triggerCount: 3 });
    d.detect(100);
    // 100 → 96 : 1% 사다리 3레벨(99, 98.01, 97.02) 관통 → 홀 3 → 즉시 BUY.
    expect(d.detect(96).signal).toBe('BUY');
  });

  it('트레일링 앵커 — 카운트 0에서 오른 고점을 즉시 따라가 낙폭을 "최근 고점 대비"로 잰다', () => {
    const d = new LadderDetector({ interval: 0.01, triggerCount: 3 });
    replay(d, [100, 105, 110]); // 상승만 — 신호 없음, 앵커 110.
    // 110 기준 3레벨 = 110×0.99³ ≈ 106.73 — 100 기준이었다면 이미 발화했을 낙폭이 아니다.
    expect(d.detect(107).count).toBe(2); // 108.9, 107.8 관통.
    expect(d.detect(106.7).signal).toBe('BUY'); // 3번째 레벨(≈106.73) 관통.
  });

  it('상승장에서는 진입이 없다 — 추격 매수를 하지 않는다', () => {
    const d = new LadderDetector({ interval: 0.01, triggerCount: 3 });
    const { signals, last } = replay(d, [100, 101, 102, 103, 104, 105]);
    expect(signals).toHaveLength(0);
    expect(last.count).toBe(0);
  });

  it('BUY 게이트 — 거래량 스파이크 미달이면 카운트 N에서도 발화를 보류하고(buyGateBlocked), 통과하는 순간 발화한다', () => {
    const d = new LadderDetector({ interval: 0.01, triggerCount: 3, minVolumeSpikeRatio: 1.5 });
    d.detect(100, { volumeSpike: 1 });
    d.detect(99, { volumeSpike: 1 });
    d.detect(98.01, { volumeSpike: 1 });
    const blocked = d.detect(97.02, { volumeSpike: 1 }); // 홀 3 도달, 게이트 미통과.
    expect(blocked.signal).toBeNull();
    expect(blocked.buyGateBlocked).toBe(true);
    expect(blocked.count).toBe(3);
    const fired = d.detect(97.05, { volumeSpike: 2 }); // 스파이크 도착 — 발화.
    expect(fired.signal).toBe('BUY');
  });

  it('BUY 게이트 — 입력 null(판정 불가)이면 통과시킨다(fail-open, detector와 동일 계약)', () => {
    const d = new LadderDetector({ interval: 0.01, triggerCount: 3, minVolumeSpikeRatio: 1.5 });
    replay(d, [100, 99, 98.01]);
    expect(d.detect(97.02, { volumeSpike: null }).signal).toBe('BUY');
  });

  it('게이트 보류 중 반등하면 리셋이 우선한다 — 낡은 카운트로 발화하지 않는다', () => {
    const d = new LadderDetector({ interval: 0.01, triggerCount: 3, minVolumeSpikeRatio: 1.5 });
    replay(d, [100, 99, 98.01]);
    d.detect(97.02, { volumeSpike: 1 }); // 홀 3, 보류.
    const rebound = d.detect(98.1, { volumeSpike: 2 }); // +1% 이상 반등 → 리셋(발화 없음).
    expect(rebound.signal).toBeNull();
    expect(rebound.count).toBe(0);
  });

  it('BUY 발화 후 사다리가 리셋된다 — 같은 하락으로 중복 발화하지 않는다', () => {
    const d = new LadderDetector({ interval: 0.01, triggerCount: 3 });
    replay(d, [100, 99, 98.01, 97.02]); // BUY 발화.
    const after = d.detect(97.0); // 발화가에서 미세 하락 — 새 사다리 기준 홀 0.
    expect(after.signal).toBeNull();
    expect(after.count).toBe(0);
  });

  it('triggerCount 옵션 — 1이면 첫 레벨 관통에서 바로 발화한다', () => {
    const d = new LadderDetector({ interval: 0.02, triggerCount: 1 });
    d.detect(100);
    expect(d.detect(97.9).signal).toBe('BUY'); // −2.1% — 1레벨 관통.
  });

  it('비정상 옵션은 기본값(간격 1%·횟수 3)으로 방어한다', () => {
    const d = new LadderDetector({ interval: Number.NaN, triggerCount: 0 });
    const { signals } = replay(d, [100, 99, 98.01, 97.02]);
    expect(signals).toHaveLength(1); // 기본값으로 정상 동작.
  });

  it('비정상 가격(NaN·0 이하)은 무시한다 — 상태가 오염되지 않는다', () => {
    const d = new LadderDetector({ interval: 0.01, triggerCount: 3 });
    replay(d, [100, 99]);
    expect(d.detect(Number.NaN).count).toBe(1);
    expect(d.detect(0).count).toBe(1);
    expect(d.detect(-5).count).toBe(1);
    expect(d.detect(98.01).count).toBe(2); // 이어서 정상 카운트.
  });

  it('reset() — 다음 청크에서 앵커를 새로 세운다', () => {
    const d = new LadderDetector({ interval: 0.01, triggerCount: 3 });
    replay(d, [100, 99, 98.01]);
    d.reset();
    expect(d.detect(50).count).toBe(0); // 새 앵커 50 — 이전 카운트·레벨과 무관.
    expect(d.detect(49.5).count).toBe(1);
  });
});
