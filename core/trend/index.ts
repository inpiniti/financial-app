// 추세: 분봉 종가의 단순이동평균(SMA) 4선 — 분봉5선·분봉20선·분봉60선·분봉120선.
// 사용자는 "5일선"처럼 부르지만 실제로는 최근 N개 분봉 종가 평균이므로 정본 용어는 "분봉N선"이다.
// 데이터 소스는 분봉조회(kis/minuteChart, 첫 페이지 최대 120건) — 120건이면 분봉120선 최신값 1개가 정확히 나온다.
// 플랫폼 무관 순수 TS — RN/KIS를 모른다. 입력은 시간 오름차순(과거→최신) 종가 배열.

/** 추세를 구성하는 4개 이동평균 기간(분봉 개수). */
export const TREND_PERIODS = [5, 20, 60, 120] as const;

export type TrendPeriod = (typeof TREND_PERIODS)[number];

/**
 * 시점별 4선 값. 봉이 기간만큼 쌓이지 않았거나 창 안에 비유한값이 있으면 null.
 * null ≠ 0 — "모름"과 "평균이 0"을 혼용하지 않는다(기울기 도메인과 동일 원칙).
 */
export interface TrendLines {
  ma5: number | null;
  ma20: number | null;
  ma60: number | null;
  ma120: number | null;
}

/**
 * 단순이동평균 시계열. 입력과 같은 길이의 배열을 돌려주며,
 * i번째 값 = closes[i−period+1..i]의 평균(창이 덜 찼거나 비유한값 포함 시 null).
 */
export function smaSeries(closes: readonly number[], period: number): (number | null)[] {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError(`period는 1 이상의 정수여야 합니다 (요청: ${period}).`);
  }
  const out: (number | null)[] = new Array(closes.length).fill(null);
  let sum = 0;
  let badCount = 0; // 현재 창 안의 비유한값 개수 — 있으면 그 시점은 null
  for (let i = 0; i < closes.length; i += 1) {
    const incoming = closes[i];
    if (Number.isFinite(incoming)) sum += incoming;
    else badCount += 1;
    if (i >= period) {
      const outgoing = closes[i - period];
      if (Number.isFinite(outgoing)) sum -= outgoing;
      else badCount -= 1;
    }
    if (i >= period - 1 && badCount === 0) out[i] = sum / period;
  }
  return out;
}

/** 마지막 시점의 단순이동평균 하나만 필요할 때. */
export function latestSma(closes: readonly number[], period: number): number | null {
  const series = smaSeries(closes, period);
  return series.length > 0 ? series[series.length - 1] : null;
}

/** 마지막 시점의 추세 4선 스냅샷. */
export function computeTrend(closes: readonly number[]): TrendLines {
  return {
    ma5: latestSma(closes, 5),
    ma20: latestSma(closes, 20),
    ma60: latestSma(closes, 60),
    ma120: latestSma(closes, 120),
  };
}

/** 차트용 — 4선 각각의 시계열(입력과 같은 길이). */
export function computeTrendSeries(closes: readonly number[]): {
  ma5: (number | null)[];
  ma20: (number | null)[];
  ma60: (number | null)[];
  ma120: (number | null)[];
} {
  return {
    ma5: smaSeries(closes, 5),
    ma20: smaSeries(closes, 20),
    ma60: smaSeries(closes, 60),
    ma120: smaSeries(closes, 120),
  };
}
