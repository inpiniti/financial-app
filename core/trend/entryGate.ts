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
 * 챱(무추세 횡보) 차단 문턱 — 신호봉 기준 볼린저 밴드폭(20봉, ±2σ)이 이 % **미만**이면 BUY를 버린다.
 * 근거(2026-08-20 지표 검증, docs/분석/2026-08-20_지표-승패-구별-검증.md §2):
 *   풀데이 시뮬 302건에서 밴드폭 <2% 신호 95건 합계 −75%(승률 ~7%), 큰 승리(>+15%) 0건 —
 *   4선이 수평으로 붙은 종목의 "4선 상승"은 노이즈다(RIVN 21전 0승, MU·SNDK 달러 출혈의 몸통).
 *   차단해도 큰 승리 9/9 보존, 달러 손익 +$8.4→+$69.8. 문턱 2%는 하루치 in-sample이라 1.5%로 보수 적용.
 * ⚠ 반대 방향(밴드폭 상한 = 과열 회피)은 금지 — 큰 승자(MRNA 12.8%·YJ 47.9%)가 전부 넓은 구간에 산다.
 */
export const TREND_MIN_BAND_WIDTH_PCT = 1.5;

/**
 * 볼린저 밴드폭(%) — (4σ ÷ ma20) × 100, 마지막 봉 기준. 봉이 period 미만이거나 비유한값이 섞이면 null.
 * ma20이 0 이하(비정상 가격)여도 null — 호출부는 null이면 판정하지 않는다(fail-open, 게이트는 보조 방어선).
 */
export function bollingerBandWidthPct(closes: readonly number[], period = 20, mult = 2): number | null {
  if (!Number.isInteger(period) || period < 2 || closes.length < period) return null;
  let sum = 0;
  for (let i = closes.length - period; i < closes.length; i += 1) {
    const v = closes[i];
    if (!Number.isFinite(v)) return null;
    sum += v;
  }
  const mean = sum / period;
  if (mean <= 0) return null;
  let sq = 0;
  for (let i = closes.length - period; i < closes.length; i += 1) {
    sq += (closes[i] - mean) ** 2;
  }
  const sd = Math.sqrt(sq / period);
  return ((2 * mult * sd) / mean) * 100;
}

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
