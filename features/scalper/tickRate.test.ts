import { describe, expect, it } from 'vitest';

import { DEFAULT_TICK_RATE_WINDOW_MS, TickRateMeter } from './tickRate';

describe('TickRateMeter — 순간 틱/초 (10초 슬라이딩 윈도우)', () => {
  it('빈 상태의 rate는 0', () => {
    const m = new TickRateMeter();
    expect(m.rate(1_000_000)).toBe(0);
  });

  it('10초 윈도우 안 틱 수 ÷ 10 = 틱/초', () => {
    const m = new TickRateMeter();
    const t0 = 1_000_000;
    for (let i = 0; i < 30; i += 1) m.record(t0 + i * 100); // 3초간 30틱
    expect(m.rate(t0 + 3_000)).toBeCloseTo(3.0, 5); // 30틱/10초
  });

  it('윈도우 이동 — 오래된 틱은 경계(cutoff 이하)에서 빠진다', () => {
    const m = new TickRateMeter();
    m.record(0);
    m.record(5_000);
    // now=10_000: cutoff=0 → ts=0 틱은 경계라서 제외, 5_000만 남는다.
    expect(m.count(10_000)).toBe(1);
    expect(m.rate(10_000)).toBeCloseTo(0.1, 5);
  });

  it('무틱 감쇠 — 틱이 끊기면 시간 경과만으로 0까지 내려간다', () => {
    const m = new TickRateMeter();
    for (let i = 0; i < 20; i += 1) m.record(i * 100);
    expect(m.rate(2_000)).toBeCloseTo(2.0, 5);
    expect(m.rate(11_000)).toBeCloseTo(0.9, 5); // cutoff=1_000 → 1_100~1_900의 9틱만 잔존
    expect(m.rate(12_000)).toBe(0); // 마지막 틱(1_900)도 윈도우 밖
  });

  it('윈도우 크기 커스텀 — 5초 윈도우면 분모도 5초', () => {
    const m = new TickRateMeter(5_000);
    m.record(0);
    m.record(1_000);
    expect(m.rate(1_000)).toBeCloseTo(0.4, 5);
  });

  it('reset은 큐를 비운다', () => {
    const m = new TickRateMeter();
    m.record(100);
    m.reset();
    expect(m.rate(200)).toBe(0);
  });

  it('틱 폭주(수만 건)에도 프루닝이 동작한다 — head 압축 경로', () => {
    const m = new TickRateMeter();
    for (let i = 0; i < 50_000; i += 1) m.record(i); // 1ms 간격 50초
    // now=50_000: cutoff=40_000 → 40_001~49_999의 9_999틱만 유효 → 999.9틱/초
    expect(m.rate(50_000)).toBeCloseTo(999.9, 5);
  });

  it('잘못된 windowMs는 생성자에서 거부한다', () => {
    expect(() => new TickRateMeter(0)).toThrow(/windowMs/);
    expect(() => new TickRateMeter(-1)).toThrow(/windowMs/);
    expect(new TickRateMeter().rate(0)).toBe(0);
    expect(DEFAULT_TICK_RATE_WINDOW_MS).toBe(10_000);
  });
});
