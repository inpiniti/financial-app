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
