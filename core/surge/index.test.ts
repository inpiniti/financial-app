import { describe, expect, it } from 'vitest';
import { SurgeDetector, type SurgeAlert, type SurgeSignal } from './index';

/** t0(epoch ms)부터 초당 1틱, 가격 고정 — 기준선 워밍업용. 마지막 틱 시각(ms)을 돌려준다. */
function feedBaseline(d: SurgeDetector, t0: number, seconds: number, price = 100): number {
  let last = t0;
  for (let i = 0; i < seconds; i += 1) {
    last = t0 + i * 1000;
    d.onTick(price, last);
  }
  return last;
}

/** 같은 1초 안에 n틱을 step씩 변화시키며 밀어 넣는다. 발화한 이벤트(경보·신호)를 돌려준다. */
function feedBurst(
  d: SurgeDetector,
  t0: number,
  n: number,
  startPrice: number,
  step: number,
): (SurgeAlert | SurgeSignal)[] {
  const out: (SurgeAlert | SurgeSignal)[] = [];
  for (let i = 0; i < n; i += 1) {
    const res = d.onTick(startPrice + step * (i + 1), t0 + i * 50);
    if (res) out.push(res);
  }
  return out;
}

const alerts = (events: (SurgeAlert | SurgeSignal)[]) => events.filter((e) => e.kind === 'alert');

describe('SurgeDetector — 조기경보(1단계)', () => {
  it('기준선 워밍업(60초) 미달이면 폭주해도 무발화', () => {
    const d = new SurgeDetector();
    const last = feedBaseline(d, 0, 30);
    expect(alerts(feedBurst(d, last + 1000, 12, 100, 0.01))).toHaveLength(0);
    expect(d.warmedUp).toBe(false);
  });

  it('기준선 1틱/초 대비 틱 폭주 + 연속 업틱이면 경보', () => {
    const d = new SurgeDetector();
    const last = feedBaseline(d, 0, 100);
    const fired = alerts(feedBurst(d, last + 1000, 12, 100, 0.01));
    expect(fired.length).toBeGreaterThanOrEqual(1);
    expect(fired[0].shortRate).toBeGreaterThanOrEqual(fired[0].baselineRate * 3);
  });

  it('다운틱 폭주는 경보를 내지 않는다 — 하락은 급등 세트(추적)로만 다룬다', () => {
    const d = new SurgeDetector();
    const last = feedBaseline(d, 0, 100);
    expect(alerts(feedBurst(d, last + 1000, 12, 100, -0.01))).toHaveLength(0);
  });

  it('틱 폭주라도 방향이 지그재그면 경보 없음', () => {
    const d = new SurgeDetector();
    const last = feedBaseline(d, 0, 100);
    const fired: (SurgeAlert | SurgeSignal)[] = [];
    for (let i = 0; i < 12; i += 1) {
      const res = d.onTick(i % 2 === 0 ? 100.01 : 99.99, last + 1000 + i * 50);
      if (res) fired.push(res);
    }
    expect(fired).toHaveLength(0);
  });

  it('경보는 쿨다운(10초) 안에 재발화하지 않는다', () => {
    const d = new SurgeDetector();
    const last = feedBaseline(d, 0, 100);
    expect(alerts(feedBurst(d, last + 1000, 12, 100, 0.01))).toHaveLength(1);
    expect(alerts(feedBurst(d, last + 4000, 12, 100.2, 0.01))).toHaveLength(0); // 쿨다운 중.
    expect(alerts(feedBurst(d, last + 12_000, 12, 100.4, 0.01))).toHaveLength(1); // 해제.
  });
});

describe('SurgeDetector — 급등 확정(2단계, 청크 정배열)', () => {
  /** 워밍업 + 폭주(rate hot)까지 만든 감지기와 폭주 종료 시각을 돌려준다. */
  function hotDetector(): { d: SurgeDetector; at: number } {
    const d = new SurgeDetector();
    const last = feedBaseline(d, 0, 100);
    feedBurst(d, last + 1000, 12, 100, 0.01);
    return { d, at: last + 1000 + 12 * 50 };
  }

  it('연속 상승 청크 4개 + 최근 틱속도 성립 → surge(진입시점)', () => {
    const { d, at } = hotDetector();
    const signals: SurgeSignal[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = d.onChunkClose(100.1 + i * 0.1, at + (i + 1) * 1000);
      if (res) signals.push(res);
    }
    expect(signals).toHaveLength(1);
    expect(signals[0].kind).toBe('surge');
    expect(signals[0].runLength).toBeGreaterThanOrEqual(4);
    expect(d.getSnapshot().tracking).toBe(true); // 확정 즉시 이탈 추적 시작.
  });

  it('연속 하락 청크는 아무 신호도 내지 않는다 — 단독 하락 감지는 없다', () => {
    const { d, at } = hotDetector();
    const signals: SurgeSignal[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = d.onChunkClose(100.5 - i * 0.1, at + (i + 1) * 1000);
      if (res) signals.push(res);
    }
    expect(signals).toHaveLength(0);
  });

  it('청크가 지그재그면 런이 끊겨 확정 없음', () => {
    const { d, at } = hotDetector();
    const prices = [100.1, 100.2, 100.15, 100.25, 100.2, 100.3, 100.25];
    const signals = prices
      .map((p, i) => d.onChunkClose(p, at + (i + 1) * 1000))
      .filter((s): s is SurgeSignal => s !== null);
    expect(signals).toHaveLength(0);
  });

  it('틱속도 성립이 rateHotWindow(10초)보다 오래됐으면 정배열이어도 확정 없음', () => {
    const { d, at } = hotDetector();
    const late = at + 20_000;
    const signals: SurgeSignal[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = d.onChunkClose(100.1 + i * 0.1, late + i * 1000);
      if (res) signals.push(res);
    }
    expect(signals).toHaveLength(0);
  });

  it('워밍업 미달이면 정배열이어도 무발화', () => {
    const d = new SurgeDetector();
    feedBaseline(d, 0, 20);
    const signals: SurgeSignal[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = d.onChunkClose(100 + i * 0.1, 21_000 + i * 1000);
      if (res) signals.push(res);
    }
    expect(signals).toHaveLength(0);
  });
});

describe('SurgeDetector — 이탈 확정(3단계, 트레일링 하락)', () => {
  /** 워밍업 → 폭주 → surge 확정까지 진행된 감지기. 확정 직전 고점은 ~100.6. */
  function surgedDetector(): { d: SurgeDetector; at: number } {
    const d = new SurgeDetector();
    const last = feedBaseline(d, 0, 100);
    feedBurst(d, last + 1000, 12, 100, 0.01);
    let at = last + 1000 + 12 * 50;
    for (let i = 0; i < 5; i += 1) {
      at = last + 2000 + i * 1000;
      d.onChunkClose(100.1 + i * 0.1, at);
    }
    expect(d.getSnapshot().tracking).toBe(true);
    return { d, at };
  }

  it('폭주가 식은 뒤에는 고점 대비 1%만 하락해도 soft 이탈 — 힘 빠진 급등을 빨리 끊는다', () => {
    const { d, at } = surgedDetector();
    // 폭주 열기(10초)가 완전히 식은 뒤, 드문드문(5초 간격) 틱으로 스르르 하락.
    const t0 = at + 30_000;
    const events: (SurgeAlert | SurgeSignal)[] = [];
    const prices = [100.4, 100.0, 99.2]; // 트레일링 고점 100.4 대비 −1%(99.396) 아래는 99.2뿐.
    prices.forEach((p, i) => {
      const res = d.onTick(p, t0 + i * 5000);
      if (res) events.push(res);
    });
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('exit');
    expect((events[0] as SurgeSignal).exitReason).toBe('soft');
    expect((events[0] as SurgeSignal).trailingHigh).toBe(100.4);
    expect(d.getSnapshot().tracking).toBe(false);
  });

  it('폭주가 살아 있는 동안 1% 눌림은 참고, 3%가 무너지면 속도 무관 hard 이탈(투매)', () => {
    const { d, at } = surgedDetector();
    // 확정 직후 — 폭주 열기(rateHotWindow 10초)가 아직 살아 있는 구간.
    // 고점 100.12 기준 soft선 99.12, hard선 97.12.
    expect(d.onTick(99.0, at + 1000)).toBeNull(); // −1.1% — 뜨거우므로 soft 억제(잔파동 관용).
    const res = d.onTick(97.0, at + 2000); // −3.1% — 뜨거워도 무조건 이탈.
    expect(res?.kind).toBe('exit');
    expect((res as SurgeSignal).exitReason).toBe('hard');
  });

  it('추적 중 신고점이 나오면 이탈 기준도 따라 올라간다(트레일링)', () => {
    const { d, at } = surgedDetector();
    const t0 = at + 15_000; // 폭주 식음 — soft선(−1%) 활성.
    d.onTick(105, t0); // 신고점 — 기준 고점 100.12 → 105, soft선 103.95.
    expect(d.onTick(104.2, t0 + 5000)).toBeNull(); // 105 대비 −0.76% — 아직.
    const res = d.onTick(103.9, t0 + 10_000); // 105 대비 −1.05% — soft 이탈.
    expect(res?.kind).toBe('exit');
    expect((res as SurgeSignal).trailingHigh).toBe(105);
  });

  it('추적 중에는 재정배열이 와도 새 surge를 내지 않는다(세트 유지)', () => {
    const { d, at } = surgedDetector();
    feedBurst(d, at + 2000, 12, 100.7, 0.01); // 다시 폭주.
    const signals: SurgeSignal[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = d.onChunkClose(100.8 + i * 0.1, at + 3000 + i * 1000);
      if (res) signals.push(res);
    }
    expect(signals).toHaveLength(0);
    expect(d.getSnapshot().tracking).toBe(true);
  });

  it('exit 후 쿨다운(60초)이 지나고 다시 폭주+정배열이면 새 surge — 새 세트 시작', () => {
    const { d, at } = surgedDetector();
    const exitRes = d.onTick(97.0, at + 15_000); // 고점 100.6 대비 −3.5% — 이탈.
    expect(exitRes?.kind).toBe('exit');
    // 쿨다운 내 재급등 시도 — 막힌다.
    feedBurst(d, at + 20_000, 12, 97, 0.01);
    let blocked = 0;
    for (let i = 0; i < 6; i += 1) {
      if (d.onChunkClose(97.1 + i * 0.1, at + 21_000 + i * 1000)) blocked += 1;
    }
    expect(blocked).toBe(0);
    // 쿨다운 해제 후 — 새 세트.
    const t2 = at + 90_000;
    feedBurst(d, t2, 12, 98, 0.01);
    const signals: SurgeSignal[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = d.onChunkClose(98.1 + i * 0.1, t2 + 1000 + i * 1000);
      if (res) signals.push(res);
    }
    expect(signals).toHaveLength(1);
    expect(signals[0].kind).toBe('surge');
  });
});

describe('SurgeDetector — 속도 정배열 경로(B, 워밍업 불필요)', () => {
  /** 초당 틱수를 1,2,3,4,5개로 가속시키며 밀어 넣는다(t0초부터 5초). step 부호가 가격 방향. */
  function feedAccelerating(d: SurgeDetector, t0: number, startPrice: number, step: number): void {
    let price = startPrice;
    for (let sec = 0; sec < 5; sec += 1) {
      for (let j = 0; j <= sec; j += 1) {
        price += step;
        d.onTick(price, t0 + sec * 1000 + j * 100);
      }
    }
  }

  it('워밍업 전이라도 틱수 정배열(1<2<3<4<5) + 연속 업틱이면 경보', () => {
    const d = new SurgeDetector();
    feedAccelerating(d, 0, 100, 0.01);
    const fired: (SurgeAlert | SurgeSignal)[] = [];
    for (let j = 0; j < 4; j += 1) {
      const res = d.onTick(100.2 + j * 0.01, 5000 + j * 100);
      if (res) fired.push(res);
    }
    expect(d.warmedUp).toBe(false);
    expect(alerts(fired).length).toBeGreaterThanOrEqual(1);
  });

  it('워밍업 전이라도 속도 정배열 + 청크 정배열이면 surge 확정', () => {
    const d = new SurgeDetector();
    feedAccelerating(d, 0, 100, 0.01);
    for (let j = 0; j < 4; j += 1) d.onTick(100.2 + j * 0.01, 5000 + j * 100);
    const signals: SurgeSignal[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = d.onChunkClose(100.3 + i * 0.1, 6000 + i * 1000);
      if (res) signals.push(res);
    }
    expect(signals).toHaveLength(1);
    expect(signals[0].kind).toBe('surge');
  });

  it('틱수가 늘지 않는 균일 속도(계단 없음)는 워밍업 전 무발화 — 정배열 경로의 의도된 한계', () => {
    const d = new SurgeDetector();
    const fired: (SurgeAlert | SurgeSignal)[] = [];
    for (let sec = 0; sec < 10; sec += 1) {
      for (let j = 0; j < 3; j += 1) {
        const res = d.onTick(100 + sec * 0.03 + j * 0.01, sec * 1000 + j * 300);
        if (res) fired.push(res);
      }
    }
    expect(fired).toHaveLength(0);
  });
});

describe('SurgeDetector — 스냅샷·리셋', () => {
  it('reset 후 워밍업을 처음부터 다시 하고 추적도 해제된다', () => {
    const d = new SurgeDetector();
    feedBaseline(d, 0, 100);
    expect(d.warmedUp).toBe(true);
    d.reset();
    expect(d.warmedUp).toBe(false);
    expect(d.getSnapshot().baselineRate).toBeNull();
    expect(d.getSnapshot().tracking).toBe(false);
  });
});
