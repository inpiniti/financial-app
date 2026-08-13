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

/** 같은 1초 안에 n틱을 step씩 상승(음수면 하락)시키며 밀어 넣는다. 발화한 경보들을 돌려준다. */
function feedBurst(d: SurgeDetector, t0: number, n: number, startPrice: number, step: number): SurgeAlert[] {
  const alerts: SurgeAlert[] = [];
  for (let i = 0; i < n; i += 1) {
    const res = d.onTick(startPrice + step * (i + 1), t0 + i * 50);
    if (res) alerts.push(res);
  }
  return alerts;
}

describe('SurgeDetector — 조기경보(1단계)', () => {
  it('기준선 워밍업(60초) 미달이면 폭주해도 무발화', () => {
    const d = new SurgeDetector();
    const last = feedBaseline(d, 0, 30);
    const alerts = feedBurst(d, last + 1000, 12, 100, 0.01);
    expect(alerts).toHaveLength(0);
    expect(d.warmedUp).toBe(false);
  });

  it('기준선 1틱/초 대비 틱 폭주 + 연속 업틱이면 up 경보', () => {
    const d = new SurgeDetector();
    const last = feedBaseline(d, 0, 100);
    const alerts = feedBurst(d, last + 1000, 12, 100, 0.01);
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts[0].direction).toBe('up');
    expect(alerts[0].shortRate).toBeGreaterThanOrEqual(alerts[0].baselineRate * 3);
  });

  it('연속 다운틱 폭주는 down 경보', () => {
    const d = new SurgeDetector();
    const last = feedBaseline(d, 0, 100);
    const alerts = feedBurst(d, last + 1000, 12, 100, -0.01);
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts[0].direction).toBe('down');
  });

  it('틱 폭주라도 방향이 지그재그면 경보 없음', () => {
    const d = new SurgeDetector();
    const last = feedBaseline(d, 0, 100);
    const alerts: SurgeAlert[] = [];
    for (let i = 0; i < 12; i += 1) {
      const res = d.onTick(i % 2 === 0 ? 100.01 : 99.99, last + 1000 + i * 50);
      if (res) alerts.push(res);
    }
    expect(alerts).toHaveLength(0);
  });

  it('경보는 방향별 쿨다운(10초) 안에 재발화하지 않는다', () => {
    const d = new SurgeDetector();
    const last = feedBaseline(d, 0, 100);
    const first = feedBurst(d, last + 1000, 12, 100, 0.01);
    expect(first).toHaveLength(1);
    // 3초 뒤 같은 방향 폭주 — 쿨다운 중.
    const second = feedBurst(d, last + 4000, 12, 100.2, 0.01);
    expect(second).toHaveLength(0);
    // 11초 뒤 — 쿨다운 해제.
    const third = feedBurst(d, last + 12_000, 12, 100.4, 0.01);
    expect(third).toHaveLength(1);
  });
});

describe('SurgeDetector — 확정(2단계, 청크 정배열)', () => {
  /** 워밍업 + 폭주(rate hot)까지 만든 감지기와 폭주 종료 시각을 돌려준다. */
  function hotDetector(): { d: SurgeDetector; at: number } {
    const d = new SurgeDetector();
    const last = feedBaseline(d, 0, 100);
    feedBurst(d, last + 1000, 12, 100, 0.01);
    return { d, at: last + 1000 + 12 * 50 };
  }

  it('연속 상승 청크 4개 + 최근 틱속도 성립 → surge', () => {
    const { d, at } = hotDetector();
    const signals: SurgeSignal[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = d.onChunkClose(100.1 + i * 0.1, at + (i + 1) * 1000);
      if (res) signals.push(res);
    }
    expect(signals).toHaveLength(1);
    expect(signals[0].kind).toBe('surge');
    expect(signals[0].runLength).toBeGreaterThanOrEqual(4);
  });

  it('연속 하락 청크 4개 → plunge', () => {
    const { d, at } = hotDetector();
    const signals: SurgeSignal[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = d.onChunkClose(100.5 - i * 0.1, at + (i + 1) * 1000);
      if (res) signals.push(res);
    }
    expect(signals).toHaveLength(1);
    expect(signals[0].kind).toBe('plunge');
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
    const late = at + 20_000; // 폭주 20초 뒤에야 청크가 오르기 시작.
    const signals: SurgeSignal[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = d.onChunkClose(100.1 + i * 0.1, late + i * 1000);
      if (res) signals.push(res);
    }
    expect(signals).toHaveLength(0);
  });

  it('확정 후 60초 쿨다운 — 그 안의 재정배열은 무시, 지나면 재발화', () => {
    const { d, at } = hotDetector();
    const fire = (t0: number, base: number): SurgeSignal[] => {
      const out: SurgeSignal[] = [];
      for (let i = 0; i < 5; i += 1) {
        // 확정 직전마다 틱 폭주도 다시 만들어 rate-hot을 갱신한다(쿨다운만 검증하기 위해).
        feedBurst(d, t0 + i * 1000, 8, base + i * 0.1, 0.001);
        const res = d.onChunkClose(base + i * 0.1, t0 + (i + 1) * 1000);
        if (res) out.push(res);
      }
      return out;
    };
    expect(fire(at + 1000, 100.1)).toHaveLength(1);
    expect(fire(at + 10_000, 101)).toHaveLength(0); // 쿨다운 안.
    expect(fire(at + 70_000, 102)).toHaveLength(1); // 쿨다운 해제.
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

  it('워밍업 전이라도 틱수 정배열(1<2<3<4<5) + 연속 업틱이면 up 경보', () => {
    const d = new SurgeDetector();
    feedAccelerating(d, 0, 100, 0.01);
    // 6초째 — 직전 완결 5초(1,2,3,4,5틱)가 엄격 증가. 업틱 몇 개면 경보가 떠야 한다.
    const alerts: SurgeAlert[] = [];
    for (let j = 0; j < 4; j += 1) {
      const res = d.onTick(100.2 + j * 0.01, 5000 + j * 100);
      if (res) alerts.push(res);
    }
    expect(d.warmedUp).toBe(false); // 기준선 워밍업(60초)은 아직 멀었다.
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts[0].direction).toBe('up');
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

  it('가속 하락(다운틱 + 틱수 정배열)이면 워밍업 전에도 plunge 확정', () => {
    const d = new SurgeDetector();
    feedAccelerating(d, 0, 100, -0.01);
    for (let j = 0; j < 4; j += 1) d.onTick(99.8 - j * 0.01, 5000 + j * 100);
    const signals: SurgeSignal[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = d.onChunkClose(99.7 - i * 0.1, 6000 + i * 1000);
      if (res) signals.push(res);
    }
    expect(signals).toHaveLength(1);
    expect(signals[0].kind).toBe('plunge');
  });

  it('틱수가 늘지 않는 균일 속도(계단 없음)는 워밍업 전 무발화 — 정배열 경로의 의도된 한계', () => {
    const d = new SurgeDetector();
    // 초당 3틱 균일 — 빠르지만 가속이 아니고, 기준선도 아직 없다.
    const alerts: SurgeAlert[] = [];
    for (let sec = 0; sec < 10; sec += 1) {
      for (let j = 0; j < 3; j += 1) {
        const res = d.onTick(100 + sec * 0.03 + j * 0.01, sec * 1000 + j * 300);
        if (res) alerts.push(res);
      }
    }
    expect(alerts).toHaveLength(0);
  });
});

describe('SurgeDetector — 스냅샷·리셋', () => {
  it('reset 후 워밍업을 처음부터 다시 한다', () => {
    const d = new SurgeDetector();
    feedBaseline(d, 0, 100);
    expect(d.warmedUp).toBe(true);
    d.reset();
    expect(d.warmedUp).toBe(false);
    expect(d.getSnapshot().baselineRate).toBeNull();
  });
});
