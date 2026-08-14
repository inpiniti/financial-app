import { describe, expect, it } from 'vitest';

import { DEFAULT_SLOPE_HISTORY_MS, DEFAULT_SLOPE_WINDOW_MS, SlopeMeter } from './slopeRate';

describe('SlopeMeter v2 — 직전 봉 평균 대비 현재 봉 평균의 변화율(%, 10초 봉)', () => {
  it('빈 상태는 null — 0(평균 동일)이 아니라 판정 불가', () => {
    const m = new SlopeMeter();
    expect(m.rate(1_000_000)).toBeNull();
  });

  it('하락 — 직전 봉 평균 100 → 현재 봉 평균 98이면 −2.0', () => {
    const m = new SlopeMeter();
    m.record(2_000, 100);
    m.record(8_000, 100);
    m.record(12_000, 98);
    m.record(18_000, 98);
    expect(m.rate(20_000)).toBeCloseTo(-2.0, 5);
  });

  it('상승 — 직전 봉 평균 100 → 현재 봉 평균 101이면 +1.0', () => {
    const m = new SlopeMeter();
    m.record(5_000, 100);
    m.record(15_000, 101);
    expect(m.rate(20_000)).toBeCloseTo(1.0, 5);
  });

  it('봉 안 출렁임은 상쇄된다 — 현재 봉이 99↔101로 널뛰어도 평균이 같으면 0', () => {
    const m = new SlopeMeter();
    m.record(2_000, 100);
    m.record(12_000, 99);
    m.record(14_000, 101);
    m.record(16_000, 99);
    m.record(18_000, 101);
    expect(m.rate(20_000)).toBe(0);
  });

  it('두 봉 중 하나라도 비면 null — 현재 봉만 있거나 직전 봉만 있으면 판정 불가', () => {
    const m = new SlopeMeter();
    m.record(15_000, 100); // 현재 봉(10_000, 20_000]만 존재.
    expect(m.rate(20_000)).toBeNull();
    // 시간이 흘러 이 틱이 직전 봉으로 밀리고 현재 봉이 비어도 null.
    expect(m.rate(30_000)).toBeNull();
  });

  it('틱 끊김 — 두 봉이 모두 지나가면 null로 전이한다', () => {
    const m = new SlopeMeter();
    m.record(5_000, 100);
    m.record(15_000, 101);
    expect(m.rate(20_000)).toBeCloseTo(1.0, 5);
    expect(m.rate(45_000)).toBeNull(); // 두 봉 (25_000, 45_000] 전부 빈다.
  });

  it('역행 틱 — 큐 순서가 아니라 시각으로 봉을 가른다', () => {
    const m = new SlopeMeter();
    m.record(15_000, 102);
    m.record(5_000, 100); // 역행 — 직전 봉 몫.
    m.record(12_000, 104);
    expect(m.rate(20_000)).toBeCloseTo(3.0, 5); // 직전 100 → 현재 (102+104)/2=103.
  });

  it('봉 크기 커스텀 — 5초 봉이면 (now−5s, now] vs (now−10s, now−5s]', () => {
    const m = new SlopeMeter(5_000);
    m.record(6_000, 100);
    m.record(12_000, 100.5);
    expect(m.rate(14_000)).toBeCloseTo(0.5, 5);
  });

  it('series — 기본 간격 = 봉 크기(겹침 0), 과거 칸 조회가 이력을 파괴하지 않는다', () => {
    const m = new SlopeMeter();
    // 10초 봉마다 평균이 100 → 101 → … → 106으로 +1씩 (봉당 틱 2개, t=0~70초).
    for (let bin = 0; bin < 7; bin += 1) {
      m.record(bin * 10_000 + 3_000, 100 + bin);
      m.record(bin * 10_000 + 7_000, 100 + bin);
    }
    const now = 70_000;
    const s = m.series(now);
    expect(s).toHaveLength(5);
    // 각 칸 = 직전 봉 대비 +1 절대 상승 — 분모(직전 봉 평균)가 커질수록 %는 살짝 줄어든다.
    for (let i = 0; i < 5; i += 1) {
      const prevAvg = 101 + i; // 가장 오래된 칸(40초전)의 직전 봉 평균은 101.
      expect(s[i]).toBeCloseTo((1 / prevAvg) * 100, 5);
    }
    expect(s[4]).toBeCloseTo(m.rate(now)!, 10);
    expect(m.series(now)).toEqual(s); // 재조회 재현성.
  });

  it('series — 데이터가 없던 과거 칸은 null로 채워진다', () => {
    const m = new SlopeMeter();
    m.record(45_000, 100);
    m.record(55_000, 101);
    const s = m.series(60_000);
    expect(s[0]).toBeNull(); // 40초전(20_000) — 두 봉 다 빈다.
    expect(s[1]).toBeNull();
    expect(s[2]).toBeNull();
    expect(s[3]).toBeNull(); // 10초전(50_000) — 직전 봉(30_000~40_000)이 빈다.
    expect(s[4]).toBeCloseTo(1.0, 5); // 현재 — 직전 봉 100, 현재 봉 101.
  });

  it('유효하지 않은 가격(0·음수·NaN)은 조용히 무시한다', () => {
    const m = new SlopeMeter();
    m.record(5_000, 0);
    m.record(6_000, -5);
    m.record(15_000, Number.NaN);
    expect(m.rate(20_000)).toBeNull();
  });

  it('reset은 큐를 비운다', () => {
    const m = new SlopeMeter();
    m.record(5_000, 100);
    m.record(15_000, 101);
    m.reset();
    expect(m.rate(20_000)).toBeNull();
  });

  it('틱 폭주(수만 건)에도 프루닝이 동작한다 — head 압축 경로', () => {
    const m = new SlopeMeter();
    for (let i = 0; i < 100_000; i += 1) m.record(i, 100 + (i % 10) * 0.01);
    expect(m.rate(100_000)).not.toBeNull();
  });

  it('잘못된 파라미터는 생성자에서 거부한다', () => {
    expect(() => new SlopeMeter(0)).toThrow(/windowMs/);
    expect(() => new SlopeMeter(10_000, -1)).toThrow(/historyMs/);
    expect(DEFAULT_SLOPE_WINDOW_MS).toBe(10_000);
    expect(DEFAULT_SLOPE_HISTORY_MS).toBe(40_000);
  });
});
