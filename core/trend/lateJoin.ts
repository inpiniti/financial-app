// 늦은 합류(late join) — "리스트에 들어왔을 때 이미 4선이 상승 중"인 종목을 딱 한 번 사는 예외.
// 도메인 문서: docs/domain/추세/2026-08-18_추세-그리드-매매-조합-plan.md
//
// 왜 필요한가: 진입은 플립 엣지(allUp(t) ∧ ¬allUp(t−1))라 "이미 상승 중"인 종목은 영원히 못 산다.
// 그런데 급등해서 순위 리스트에 새로 뜨는 종목은 **뜬 시점에 이미 상승 중**인 경우가 많다 — 버스를 놓친 게 아니라
// 버스가 우리 눈앞에 늦게 나타난 것이다. 이 예외는 그 한 번의 승차만 허용한다.
//
// 왜 나이 제한이 있나(2026-08-21 실측, 38종 3일 157샘플 · t0~마감 총수익률 비교):
//   allUp 지속  1봉: 즉시진입 −2.57% vs 대기 −4.83%  → **+2.25%p (유리)**
//               2봉: −8.99% vs −9.98%               → +0.99%p (유리)
//               3봉: −13.53% vs −10.48%             → −3.05%p (불리)
//             4~6봉: −12.01% vs −8.50%              → −3.51%p (불리)
//             7봉+ : −13.03% vs −11.35%             → −1.67%p (불리)
// 즉 "살짝 놓친 것"은 타도 되지만 "한참 달린 것"에 올라타면 진다(= 머리 매수). 경계는 2봉.
// ⚠ 하루 3일 in-sample · 표본 작음(1~2봉 합계 59) · 평균은 소수의 큰 승자가 끈다(B 우세 비율 28%/21%).
//   869일 백테스트로 재검증 대상. 끄려면 TREND_LATE_JOIN_MAX_AGE = 0.

import { evaluateTrend } from './signal';
import { smaSeries, TREND_PERIODS } from './index';

/**
 * 늦은 합류를 허용하는 최대 allUp 지속 봉 수. 0이면 예외를 끈다(플립만 진입).
 * 2 = "직전 봉 또는 그 전 봉이 플립" — 5분봉 기준 최대 10분 늦은 합류까지.
 */
export const TREND_LATE_JOIN_MAX_AGE = 2;

/**
 * 마지막 봉 기준 allUp이 몇 봉 연속인가. 마지막 봉이 allUp이 아니면 0, 판정 불가면 null.
 * (1 = 마지막 봉에서 막 플립했다 = 직전 봉은 allUp이 아니었다.)
 */
export function allUpAge(closes: readonly number[]): number | null {
  const series = TREND_PERIODS.map((p) => smaSeries(closes, p));
  const allUpAt = (i: number): boolean | null => {
    if (i < 1) return null;
    for (const s of series) {
      const cur = s[i];
      const prev = s[i - 1];
      if (cur === null || cur === undefined || prev === null || prev === undefined) return null;
      if (!(cur > prev)) return false;
    }
    return true;
  };
  const last = closes.length - 1;
  const at = allUpAt(last);
  if (at === null) return null;
  if (at === false) return 0;
  let age = 1;
  while (allUpAt(last - age) === true) age += 1;
  return age;
}

/**
 * 이 종목을 "늦은 합류"로 지금 사도 되는가 — 리스트 진입(시드) 직후 딱 한 번 묻는다.
 * 조건: 마지막 봉이 allUp이고, 그 지속이 TREND_LATE_JOIN_MAX_AGE 이하.
 * 판정 불가(봉 부족)면 false — fail-closed(진입은 트리거이므로 모르면 안 산다).
 */
export function lateJoinEligible(closes: readonly number[]): boolean {
  if (TREND_LATE_JOIN_MAX_AGE <= 0) return false;
  // 플립 자체(age=1)는 정규 경로로도 잡히지만, 시드 시점엔 봉 마감 이벤트가 없으므로 여기서 함께 본다.
  const age = allUpAge(closes);
  if (age === null || age === 0) return false;
  if (age > TREND_LATE_JOIN_MAX_AGE) return false;
  // 4선이 전부 계산 가능한지 재확인(evaluateTrend의 fail-closed와 같은 기준).
  const ev = evaluateTrend(closes);
  return ev.up.ma5 !== null && ev.up.ma20 !== null && ev.up.ma60 !== null && ev.up.ma120 !== null;
}
