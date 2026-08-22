// 추세 신호 — 분봉 종가 배열 하나로 BUY/SELL을 판정하는 무상태 순수 함수.
// 도메인 문서: docs/domain/추세/2026-08-18_추세-그리드-매매-조합-plan.md
//
//  up_N(t) = ma_N(t) > ma_N(t−1)  (strict — 보합은 상승도 하락도 아님)
//  BUY : allUp(t) ∧ ¬allUp(t−1)   — "상상상상으로 바뀌는 그 봉"(플립)에만. 4선 중 하나라도 null이면 신호 없음(fail-closed)
//  SELL: ¬allUp(t)                — 4선 중 하나라도 안 오르면 즉시. null이면 신호 없음(fail-closed)
//
// 2026-08-21 순수 상태기계로 전환(docs/분석/2026-08-21_4선-상태기계-검증.md, 사용자 확정):
//  · 옛 규칙은 BUY = allUp 2봉 연속 ∧ 종가>ma60 / SELL = 종가<ma5 였다.
//  · 2봉 확인은 저점→체결 지연을 4봉으로 늘려 "다리의 69% 지점(머리)" 매수를 만들었고,
//    종가<ma5 청산은 강추세 중 눌림 한 봉에도 팔아 승자를 잘랐다. 진입·청산을 같은 상태의 양 끝으로
//    대칭화하니(플립 진입 / 깨짐 청산) 3일 재현 모두 우위 — 5분봉 3일 합 +$95.53 vs 옛 규칙 +$1.12.
//  · 가짜 플립 보험은 확인봉이 아니라 "깨지면 다음 봉에 바로 나감"이 대신한다.
// aboveMa60·prevAllUp은 뷰·진단용으로 계속 계산한다(판정에는 aboveMa60을 쓰지 않는다).
// SELL은 상태 기반(조건이 참인 봉마다 매번 발화), BUY는 **엣지**(플립 봉 1회)다 — 보유/미보유 거름은 호출부(autopilot).
//  ⚠ BUY가 엣지라 그 봉에 슬롯 만석·현금 부족·쿨다운이면 진입 기회는 다음 플립까지 사라진다(옛 규칙은 매 봉 재시도).
//    재현 시뮬도 같은 의미론이었다(보유 중 신호 무시 → 청산 뒤 새 플립에서만 재진입).
// 플립 판정은 배열에서 ma[i]/ma[i−1]/ma[i−2]로 계산 — 내부 카운터가 없어 attach/detach·seed 순서에 흔들리지 않는다.

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
  // SELL 우선 — 4선 중 하나라도 상승이 아니면 즉시 청산. 판정 불가(null)면 신호 없음(fail-closed).
  if (curAll === false) {
    signal = 'SELL';
  } else if (curAll === true && prevAllUp === false) {
    // BUY는 "플립하는 그 봉"에만 — allUp이 이어지는 동안에는 재발화하지 않는다.
    signal = 'BUY';
  }
  return { signal, lines, up, prevAllUp, aboveMa60, bars: n };
}

/**
 * 진행 중(미완성) 봉을 마지막 봉으로 덧붙여 다시 잰 판정 — **SELL만** 돌려준다(BUY는 null로 지운다).
 *
 * 왜 필요한가(2026-08-22, 사용자 관찰): 차트는 아직 안 닫힌 마지막 봉까지 그려 4선을 얹는다. 그래서 눈으로는
 * "지금 꺾였다"가 보이는데, 엔진은 `evaluateTrend(닫힌 봉)`만 보므로 최대 한 봉(5분) 뒤에야 같은 사실을 안다.
 * 8-18~21 실거래에서 이 지연이 "150% → 70% → 20%에 매도"의 큰 몫이었다 — 그래프와 감지를 일치시킨다.
 *
 * 왜 SELL만인가(사용자 확정): BUY까지 진행 중 봉으로 내면 봉 중간에 잠깐 4선이 상승했다가 되돌리는
 * **가짜 플립**마다 진입해 왕복 비용을 계속 문다. 진입은 봉 마감 확정(플립 엣지) 그대로 두고,
 * 청산만 눈과 같은 속도로 앞당긴다(청산 위험 최소화 > 진입 빈도).
 *
 * closedCloses = 닫힌 봉 종가(오름차순), provisionalClose = 진행 중 봉의 현재 종가.
 * 반환값의 lines·up·bars는 "진행 중 봉 포함" 기준이다(화면에 엔진이 보는 값을 그대로 띄우는 용도).
 */
export function evaluateTrendLive(
  closedCloses: readonly number[],
  provisionalClose: number,
): TrendEval {
  if (!Number.isFinite(provisionalClose) || provisionalClose <= 0) {
    return { signal: null, lines: { ma5: null, ma20: null, ma60: null, ma120: null }, up: { ...NULL_UP }, prevAllUp: null, aboveMa60: null, bars: closedCloses.length };
  }
  const ev = evaluateTrend([...closedCloses, provisionalClose]);
  return ev.signal === 'SELL' ? ev : { ...ev, signal: null };
}

/**
 * 진행 중 봉 재판정 주기(ms) — 틱마다 130봉×4선을 다시 재면 30종목에서 낭비가 크다. 1초면
 * "사람 눈이 차트에서 알아채는 속도"보다 충분히 빠르다. 0으로 두면 매 틱(테스트용).
 */
export const TREND_LIVE_EVAL_MS = 1_000;

/** 진행 중 봉 SELL 스위치 — false로 두면 봉 마감 판정만 하던 2026-08-21 동작으로 한 줄 롤백. */
export const TREND_LIVE_SELL = true;
