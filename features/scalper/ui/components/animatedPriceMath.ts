/**
 * 실시간 가격 카운트업/다운 보간 및 틱 방향 판정 순수 헬퍼.
 */

export type TickDirection = 'up' | 'down' | 'same';

/**
 * 2차 감속 이징(Ease Out Quad) 함수.
 */
export function easeOutQuad(t: number): number {
  return t * (2 - t);
}

/**
 * 직전 가격과 신규 가격 사이의 선형/이징 보간값 산출.
 */
export function interpolatePrice(
  fromPrice: number,
  toPrice: number,
  progress: number,
): number {
  if (fromPrice === toPrice || progress >= 1) return toPrice;
  if (progress <= 0) return fromPrice;

  const eased = easeOutQuad(progress);
  const val = fromPrice + (toPrice - fromPrice) * eased;
  return +val.toFixed(4);
}

/**
 * 가격 변동 방향 판정 ('up' | 'down' | 'same').
 */
export function getTickDirection(
  fromPrice: number | null,
  toPrice: number | null,
): TickDirection {
  if (fromPrice === null || toPrice === null || fromPrice === toPrice) {
    return 'same';
  }
  return toPrice > fromPrice ? 'up' : 'down';
}

/**
 * 카운트업 애니메이션용 이산 스텝 배열 생성 (테스트 및 프레임 보간용).
 */
export function generatePriceSteps(
  fromPrice: number,
  toPrice: number,
  steps: number = 5,
): number[] {
  if (steps <= 1 || fromPrice === toPrice) return [toPrice];

  const result: number[] = [];
  for (let i = 1; i <= steps; i++) {
    const p = i / steps;
    result.push(interpolatePrice(fromPrice, toPrice, p));
  }
  return result;
}
