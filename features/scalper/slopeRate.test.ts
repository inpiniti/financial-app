import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SLOPE_HISTORY_MS,
  DEFAULT_SLOPE_MIN_SPAN_MS,
  DEFAULT_SLOPE_WINDOW_MS,
  SlopeMeter,
} from './slopeRate';

describe('SlopeMeter — 기울기/초(%/초, 10초 슬라이딩 윈도우 양끝점)', () => {
  it('빈 상태는 null — 0(횡보)이 아니라 판정 불가', () => {
    const m = new SlopeMeter();
    expect(m.rate(1_000_000)).toBeNull();
  });

  it('하락 — 5초에 −2%면 −0.4 %/초 (도메인 문서 예시)', () => {
    const m = new SlopeMeter();
    m.record(1_000, 100);
    m.record(6_000, 98);
    expect(m.rate(6_000)).toBeCloseTo(-0.4, 5);
  });

  it('상승 — 9초에 +1%면 +1/9 %/초', () => {
    const m = new SlopeMeter();
    m.record(1_000, 100);
    m.record(10_000, 101);
    expect(m.rate(10_000)).toBeCloseTo(1 / 9, 5);
  });

  it('횡보 — 가격이 같으면 0 (null과 구분)', () => {
    const m = new SlopeMeter();
    m.record(1_000, 50);
    m.record(4_000, 50);
    expect(m.rate(4_000)).toBe(0);
  });

  it('스팬 미달 — 양끝 간격 < minSpanMs(1초)면 null (순간 점프 환산 폭주 방지)', () => {
    const m = new SlopeMeter();
    m.record(1_000, 100);
    m.record(1_500, 103);
    expect(m.rate(1_600)).toBeNull();
  });

  it('틱 끊김 — 윈도우가 지나가면 값 → null로 전이한다', () => {
    const m = new SlopeMeter();
    m.record(1_000, 100);
    m.record(6_000, 98);
    expect(m.rate(6_000)).toBeCloseTo(-0.4, 5);
    // now=12_000: 윈도우 (2_000, 12_000] 안에 6_000 하나뿐 → 스팬 0 → null.
    expect(m.rate(12_000)).toBeNull();
    // now=17_000: 전부 윈도우 밖.
    expect(m.rate(17_000)).toBeNull();
  });

  it('역행 틱 — 큐 순서가 아니라 시각으로 양끝을 고른다', () => {
    const m = new SlopeMeter();
    m.record(3_000, 100);
    m.record(1_000, 99); // 역행 — 시각상으로는 이쪽이 first.
    expect(m.rate(3_000)).toBeCloseTo(((100 - 99) / 99) * 100 / 2, 5);
  });

  it('윈도우 커스텀 — 5초 윈도우면 그보다 오래된 틱은 양끝 후보에서 빠진다', () => {
    const m = new SlopeMeter(5_000);
    m.record(1_000, 100); // now=7_000이면 윈도우 (2_000, 7_000] 밖.
    m.record(3_000, 102);
    m.record(7_000, 103);
    expect(m.rate(7_000)).toBeCloseTo(((103 - 102) / 102) * 100 / 4, 5);
  });

  it('series — 4초전~현재 5칸, 과거 시점 조회가 이력을 파괴하지 않는다', () => {
    const m = new SlopeMeter();
    // 1초 간격 균일 상승: t=1_000..11_000에 100→101 (+0.1/틱).
    for (let i = 0; i <= 10; i += 1) m.record(1_000 + i * 1_000, 100 + i * 0.1);
    const s = m.series(11_000);
    expect(s).toHaveLength(5);
    // 각 시점 t의 윈도우 (t−10s, t] 양끝으로 계산 — 전부 상승(양수)이어야 한다.
    for (const v of s) {
      expect(v).not.toBeNull();
      expect(v!).toBeGreaterThan(0);
    }
    // 현재 시점 값 = rate()와 동일.
    expect(s[4]).toBeCloseTo(m.rate(11_000)!, 10);
    // series 호출(내부 프루닝은 now 기준) 후에도 과거 시점 값이 재현된다.
    expect(m.series(11_000)).toEqual(s);
  });

  it('series — 아직 데이터가 없던 과거 시점은 null로 채워진다', () => {
    const m = new SlopeMeter();
    m.record(10_000, 100);
    m.record(12_000, 101);
    const s = m.series(12_000);
    // t=8_000·9_000에는 틱 0~1개 → null, t=10_000도 틱 1개 → null.
    expect(s[0]).toBeNull();
    expect(s[1]).toBeNull();
    expect(s[2]).toBeNull();
    // t=11_000·12_000은 양끝(10_000, 12_000 중 윈도우 안) 스팬 충족 시 값.
    expect(s[4]).toBeCloseTo(0.5, 5); // 2초에 +1% → +0.5 %/초
  });

  it('유효하지 않은 가격(0·음수·NaN)은 조용히 무시한다', () => {
    const m = new SlopeMeter();
    m.record(1_000, 0);
    m.record(2_000, -5);
    m.record(3_000, Number.NaN);
    expect(m.rate(3_000)).toBeNull();
  });

  it('reset은 큐를 비운다', () => {
    const m = new SlopeMeter();
    m.record(1_000, 100);
    m.record(3_000, 101);
    m.reset();
    expect(m.rate(3_000)).toBeNull();
  });

  it('틱 폭주(수만 건)에도 프루닝이 동작한다 — head 압축 경로', () => {
    const m = new SlopeMeter();
    for (let i = 0; i < 50_000; i += 1) m.record(i, 100 + (i % 10) * 0.01);
    expect(m.rate(50_000)).not.toBeNull();
  });

  it('잘못된 파라미터는 생성자에서 거부한다', () => {
    expect(() => new SlopeMeter(0)).toThrow(/windowMs/);
    expect(() => new SlopeMeter(10_000, 0)).toThrow(/minSpanMs/);
    expect(() => new SlopeMeter(10_000, 1_000, -1)).toThrow(/historyMs/);
    expect(DEFAULT_SLOPE_WINDOW_MS).toBe(10_000);
    expect(DEFAULT_SLOPE_MIN_SPAN_MS).toBe(1_000);
    expect(DEFAULT_SLOPE_HISTORY_MS).toBe(4_000);
  });
});
