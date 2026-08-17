import { describe, expect, it } from 'vitest';
import { computeTrend, computeTrendSeries, latestSma, smaSeries, TREND_PERIODS } from './index';

/** 1부터 n까지 오름차순 종가 — SMA 기대값을 손으로 검산하기 쉬운 수열. */
function ascending(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i + 1);
}

describe('smaSeries', () => {
  it('창이 차기 전(period−1개까지)은 null, 그 뒤는 창 평균', () => {
    const series = smaSeries([1, 2, 3, 4, 5], 3);
    expect(series).toEqual([null, null, 2, 3, 4]);
  });

  it('period=1이면 종가 그대로', () => {
    expect(smaSeries([10, 20, 30], 1)).toEqual([10, 20, 30]);
  });

  it('창 안에 비유한값(NaN)이 있는 시점만 null이고, 창을 벗어나면 복구된다', () => {
    const series = smaSeries([1, 2, Number.NaN, 4, 5, 6], 2);
    expect(series).toEqual([null, 1.5, null, null, 4.5, 5.5]);
  });

  it('period가 1 미만이거나 정수가 아니면 RangeError', () => {
    expect(() => smaSeries([1, 2, 3], 0)).toThrow(RangeError);
    expect(() => smaSeries([1, 2, 3], 2.5)).toThrow(RangeError);
  });
});

describe('latestSma', () => {
  it('마지막 시점의 SMA를 돌려준다', () => {
    expect(latestSma([1, 2, 3, 4, 5], 5)).toBe(3);
  });

  it('봉이 모자라면 null (null ≠ 0)', () => {
    expect(latestSma([1, 2, 3], 5)).toBeNull();
    expect(latestSma([], 5)).toBeNull();
  });
});

describe('computeTrend — 분봉 4선 스냅샷', () => {
  it('기간은 5/20/60/120으로 고정', () => {
    expect(TREND_PERIODS).toEqual([5, 20, 60, 120]);
  });

  it('분봉조회 첫 페이지 최대치(120봉)면 4선이 전부 나온다', () => {
    const closes = ascending(120);
    // 1..120 수열의 마지막 N개 평균 = 120 − (N−1)/2
    expect(computeTrend(closes)).toEqual({
      ma5: 118,
      ma20: 110.5,
      ma60: 90.5,
      ma120: 60.5,
    });
  });

  it('봉이 모자란 선만 null — 60봉이면 분봉120선만 판정 불가', () => {
    const trend = computeTrend(ascending(60));
    expect(trend.ma5).toBe(58);
    expect(trend.ma20).toBe(50.5);
    expect(trend.ma60).toBe(30.5);
    expect(trend.ma120).toBeNull();
  });
});

describe('computeTrendSeries', () => {
  it('4선 시계열은 전부 입력과 같은 길이', () => {
    const closes = ascending(30);
    const series = computeTrendSeries(closes);
    expect(series.ma5).toHaveLength(30);
    expect(series.ma20).toHaveLength(30);
    expect(series.ma60).toHaveLength(30);
    expect(series.ma120).toHaveLength(30);
    // 분봉5선은 5번째 봉부터, 분봉60선·120선은 30봉으론 전부 null
    expect(series.ma5[3]).toBeNull();
    expect(series.ma5[4]).toBe(3);
    expect(series.ma60.every((v) => v === null)).toBe(true);
    expect(series.ma120.every((v) => v === null)).toBe(true);
  });
});
