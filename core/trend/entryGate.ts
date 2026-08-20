// 추세 진입 추격 게이트 — "신호가 대비 매도1호가가 이미 +1%를 넘으면 사지 않는다"의 순수 판정.
// 근거(2026-08-20 둘째날 분석, docs/분석/2026-08-20_추세-둘째날-24건-분석.md §4):
//   실거래 이틀(08-18/08-19 ET) 66건에서 체결가가 신호가보다 +1% 이상 뛴 진입 23건 합계 −89%(승 4/23).
//   프리마켓 저가주는 호가가 얇아 공격적 지정가(ask1)가 신호가보다 2~4% 위에 있을 때가 있고,
//   그 자리는 수직 급등의 끝(직후 급락)일 확률이 압도적이었다. 게이트 적용 시 이틀 합계 −88% → +1%.
// 판정 불가(비유한값·0 이하)는 false — 게이트는 보조 방어선이라, 데이터가 없으면 기존 진입 규칙 그대로 둔다.
// 실행(어디서 부르나): features/scalper/autopilot.commitBuy — 추세 모드에서 발주 직전, 신선한 호가가 있을 때만.

/** 추격 허용 상한(소수, 0.01 = 신호가 대비 +1%). */
export const TREND_ENTRY_CHASE_MAX_PCT = 0.01;

/** 게이트 판정에 쓸 호가의 신선도 상한(ms) — 이보다 낡은 호가로는 판정하지 않는다(어댑터 quoteStaleMs와 동일값). */
export const TREND_ENTRY_GATE_QUOTE_FRESH_MS = 10_000;

/**
 * 추격 초과 여부 — 매도1호가(ask1)가 신호가 × (1 + maxPct)를 **초과**하면 true(진입 금지).
 * 경계(정확히 +1%)는 허용. signalPrice·ask1이 비유한값이거나 0 이하면 false(판정 불가 → 게이트 미적용).
 */
export function entryChaseExceeded(
  signalPrice: number,
  ask1: number,
  maxPct: number = TREND_ENTRY_CHASE_MAX_PCT,
): boolean {
  if (!Number.isFinite(signalPrice) || signalPrice <= 0) return false;
  if (!Number.isFinite(ask1) || ask1 <= 0) return false;
  if (!Number.isFinite(maxPct) || maxPct < 0) return false;
  return ask1 > signalPrice * (1 + maxPct);
}
