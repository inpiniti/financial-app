// 추세 신호 — 분봉 종가 배열 하나로 BUY/SELL을 판정하는 무상태 순수 함수.
// 도메인 문서: docs/domain/추세/2026-08-18_추세-그리드-매매-조합-plan.md
//
//  up_N(t) = ma_N(t) > ma_N(t−1)  (strict — 보합은 상승도 하락도 아님)
//  BUY : allUp(t) ∧ allUp(t−1) AND close(t) > ma60(t)   — 4선 중 하나라도 null이면 신호 없음(fail-closed)
//  SELL: close(t) < ma5(t)                                — ma5 null이면 신호 없음
//        (2026-08-19 변경: 옛 규칙 "ma5(t) < ma5(t−1)"(기울기)는 가격이 이미 밀린 뒤 1~2봉 늦게 울렸다 —
//         첫날 42건 재현에서 "종가<ma5"(위치)가 1·3·5분봉 모두 승률·합계 우위. up.ma5는 뷰용으로 계속 계산한다.)
// 상태 기반: 봉 마감마다 조건이 참이면 매번 발화한다(엣지 아님). 보유/미보유 거름은 호출부(autopilot).
// "2봉 연속"은 배열에서 ma[i]/ma[i−1]/ma[i−2]로 계산 — 내부 카운터가 없어 attach/detach·seed 순서에 흔들리지 않는다.

import { smaSeries, type TrendLines, TREND_PERIODS } from './index';

export type TrendSignal = 'BUY' | 'SELL';

export interface TrendUpFlags {
  ma5: boolean | null;
  ma20: boolean | null;
  ma60: boolean | null;
  ma120: boolean | null;
}

export interface TrendEval {
  signal: TrendSignal | null;
  /** 마지막 봉 시점 4선 값. */
  lines: TrendLines;
  /** 마지막 봉 시점 각 선의 상승 여부(직전 봉 대비 strict). 판정 불가 null. */
  up: TrendUpFlags;
  /** 직전 봉 시점의 4선 모두 상승 여부(2봉 연속 조건의 앞쪽). 판정 불가 null. */
  prevAllUp: boolean | null;
  /** 마지막 봉 종가 > ma60. 판정 불가 null. */
  aboveMa60: boolean | null;
  /** 입력 봉 수. */
  bars: number;
}

const NULL_UP: TrendUpFlags = { ma5: null, ma20: null, ma60: null, ma120: null };

function upAt(series: readonly (number | null)[], i: number): boolean | null {
  if (i < 1) return null;
  const cur = series[i];
  const prev = series[i - 1];
  if (cur === null || cur === undefined || prev === null || prev === undefined) return null;
  return cur > prev;
}

function allUp(flags: readonly (boolean | null)[]): boolean | null {
  if (flags.some((f) => f === null)) return null;
  return flags.every((f) => f === true);
}

export function evaluateTrend(closes: readonly number[]): TrendEval {
  const n = closes.length;
  const last = n - 1;
  const [s5, s20, s60, s120] = TREND_PERIODS.map((p) => smaSeries(closes, p));
  const lines: TrendLines = {
    ma5: n > 0 ? s5[last] : null,
    ma20: n > 0 ? s20[last] : null,
    ma60: n > 0 ? s60[last] : null,
    ma120: n > 0 ? s120[last] : null,
  };
  if (n < 2) return { signal: null, lines, up: { ...NULL_UP }, prevAllUp: null, aboveMa60: null, bars: n };

  const up: TrendUpFlags = {
    ma5: upAt(s5, last),
    ma20: upAt(s20, last),
    ma60: upAt(s60, last),
    ma120: upAt(s120, last),
  };
  const curAll = allUp([up.ma5, up.ma20, up.ma60, up.ma120]);
  const prevAllUp = allUp([upAt(s5, last - 1), upAt(s20, last - 1), upAt(s60, last - 1), upAt(s120, last - 1)]);
  const close = closes[last];
  const aboveMa60 = lines.ma60 === null || !Number.isFinite(close) ? null : close > lines.ma60;

  let signal: TrendSignal | null = null;
  // SELL 우선 — 종가가 ma5 아래(strict). 다른 선이 상승 중이어도 판다.
  if (lines.ma5 !== null && Number.isFinite(close) && close < lines.ma5) {
    signal = 'SELL';
  } else if (curAll === true && prevAllUp === true && aboveMa60 === true) {
    signal = 'BUY';
  }
  return { signal, lines, up, prevAllUp, aboveMa60, bars: n };
}
