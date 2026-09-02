// GridGauge(게이지 UI)가 쓰는 순수 계산 — RN을 몰라도 되는 부분만 분리해 vitest로 검증한다
// (컴포넌트 렌더 자체는 vitest.config.ts가 .tsx를 수집하지 않는다 — 이 저장소의 기존 관례).

/**
 * 현재가를 [buyPrice, sellPrice] 구간에서 0~1 위치로 정규화한다 — 게이지 화살표 위치 계산용.
 * 0=매수가(왼쪽 끝), 1=매도가(오른쪽 끝). 범위 밖 값은 끝에 고정(clamp)한다.
 * buyPrice가 매수가·sellPrice가 매도가라는 전제(buyPrice < sellPrice)가 깨졌거나 값이 비정상이면
 * 중앙(0.5)을 반환해 화살표가 평단 위치로 안전하게 폴백한다.
 */
export function normalizeGridPosition(value: number, buyPrice: number, sellPrice: number): number {
  if (
    !Number.isFinite(value) ||
    !Number.isFinite(buyPrice) ||
    !Number.isFinite(sellPrice) ||
    sellPrice <= buyPrice
  ) {
    return 0.5;
  }
  const t = (value - buyPrice) / (sellPrice - buyPrice);
  return Math.min(1, Math.max(0, t));
}

/**
 * 게이지 축 범위(2026-09-02 리디자인) — 오늘 고저를 기본 축으로 하되, 그려야 할 모든 마커
 * (±3% 밴드·평단·5선·진입 후 고저·현재가)가 축 안에 들어오게 넓힌다. 유효값이 하나도 없으면
 * 폴백(밴드 양끝)을 쓰고, 폭이 0으로 접히면 ±0.5%를 벌려 눈금이 겹치지 않게 한다.
 * 여유 패딩 3% — 끝 마커가 트랙 모서리에 딱 붙지 않게.
 */
export function gaugeScaleOf(
  values: readonly (number | null | undefined)[],
  fallbackLo: number,
  fallbackHi: number,
): { lo: number; hi: number } {
  const xs = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
  let lo = xs.length > 0 ? Math.min(...xs) : Math.min(fallbackLo, fallbackHi);
  let hi = xs.length > 0 ? Math.max(...xs) : Math.max(fallbackLo, fallbackHi);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { lo: 0, hi: 1 };
  if (hi <= lo) {
    const mid = lo;
    lo = mid * 0.995;
    hi = mid * 1.005;
  }
  const pad = (hi - lo) * 0.03;
  return { lo: lo - pad, hi: hi + pad };
}
