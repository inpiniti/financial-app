/**
 * 오토파일럿 실시간 레이스 트랙 좌표 및 긴장도 산출 순수 수학 함수.
 */

export type TensionZone = 'idle' | 'danger' | 'cruise' | 'nitro' | 'reach' | 'goal';

export interface RaceProgress {
  /** 0.0 (물타기선) ~ 0.25 (출발선/평단가) ~ 1.0 (결승선/+3%) */
  trackPos: number;
  /** 현재 긴장도 구간 */
  zone: TensionZone;
  /** 수익률 비율 (-0.03 ~ +0.03 등) */
  pnlRatio: number;
  /** 목표선까지 남은 퍼센트포인트 (예: +3% 목표인데 현재 +2%면 1.0%) */
  remainingPct: number;
  /** 결승선 돌파 여부 */
  isGoal: boolean;
  /** 물타기선 도달 여부 */
  isScaleInZone: boolean;
}

export const START_LINE_POS = 0.25; // 출발선(평단가 0%) 위치
export const SCALE_IN_POS = 0.0;   // 물타기선(-3%) 위치
export const FINISH_LINE_POS = 1.0; // 결승선(+3%) 위치

export const DEFAULT_TP_RATIO = 0.03;       // +3% 익절 목표
export const DEFAULT_SCALE_IN_RATIO = 0.03; // -3% 물타기 목표

/**
 * 평단 대비 현재가의 수익률 구간에 따른 긴장도 판정.
 */
export function getTensionZone(pnlRatio: number | null, tpRatio: number = DEFAULT_TP_RATIO): TensionZone {
  if (pnlRatio === null) return 'idle';
  if (pnlRatio >= tpRatio) return 'goal';
  if (pnlRatio >= tpRatio * (2 / 3)) return 'reach'; // 예: +2% 이상 (골인 임박/리치)
  if (pnlRatio >= tpRatio * (1 / 3)) return 'nitro'; // 예: +1% 이상 (가속/니트로)
  if (pnlRatio >= -0.01) return 'cruise';            // -1% ~ +1% (순항)
  return 'danger';                                    // -1% 미만 (후진/물타기 위기 구역)
}

/**
 * 실시간 가격에 따른 트랙 진행도(0.0 ~ 1.0) 및 레이스 정보 계산.
 */
export function calcRaceProgress(
  currentPrice: number | null,
  avgPrice: number | null,
  tpRatio: number = DEFAULT_TP_RATIO,
  scaleInRatio: number = DEFAULT_SCALE_IN_RATIO,
): RaceProgress {
  if (currentPrice === null || avgPrice === null || !(avgPrice > 0)) {
    return {
      trackPos: START_LINE_POS,
      zone: 'idle',
      pnlRatio: 0,
      remainingPct: tpRatio * 100,
      isGoal: false,
      isScaleInZone: false,
    };
  }

  const pnlRatio = (currentPrice - avgPrice) / avgPrice;
  const zone = getTensionZone(pnlRatio, tpRatio);
  const remainingPct = Math.max(0, (tpRatio - pnlRatio) * 100);
  const isGoal = pnlRatio >= tpRatio;
  const isScaleInZone = pnlRatio <= -scaleInRatio;

  let trackPos: number;
  if (pnlRatio >= 0) {
    // 0.0 ~ +tpRatio -> START_LINE_POS (0.25) ~ FINISH_LINE_POS (1.0)
    const ratioToTarget = Math.min(1.0, pnlRatio / tpRatio);
    trackPos = START_LINE_POS + ratioToTarget * (FINISH_LINE_POS - START_LINE_POS);
  } else {
    // 0.0 ~ -scaleInRatio -> START_LINE_POS (0.25) ~ SCALE_IN_POS (0.0)
    const ratioToScaleIn = Math.min(1.0, Math.abs(pnlRatio) / scaleInRatio);
    trackPos = START_LINE_POS - ratioToScaleIn * (START_LINE_POS - SCALE_IN_POS);
  }

  // 트랙 좌표를 0.0 ~ 1.0 범위로 클램프
  trackPos = Math.max(0.0, Math.min(1.0, trackPos));

  return {
    trackPos,
    zone,
    pnlRatio,
    remainingPct: +remainingPct.toFixed(2),
    isGoal,
    isScaleInZone,
  };
}

/**
 * 대기(스캐닝) 중인 후보 종목의 출발대(Starting Gate) RPM 예열 게이지 계산 (0 ~ 100).
 * 틱 속도, 기울기 및 5선과의 근접도를 결합하여 엔진 예열 RPM을 산출.
 */
export function calcStartingGateRpm(
  currentPrice: number | null,
  ma5Price: number | null,
  tickRate: number = 0,
  slopeRate: number | null = null,
): number {
  let score = 20; // 기본 아이들링 RPM (20%)

  // 1. 틱 속도 기여 (최대 +30%)
  if (tickRate > 0) {
    score += Math.min(30, (tickRate / 5) * 30);
  }

  // 2. 기울기 기여 (최대 +20%)
  if (slopeRate !== null && slopeRate > 0) {
    score += Math.min(20, (slopeRate / 2) * 20);
  }

  // 3. 5선 돌파 근접도 기여 (최대 +30%)
  if (currentPrice !== null && ma5Price !== null && ma5Price > 0) {
    const diffPct = (currentPrice - ma5Price) / ma5Price;
    if (diffPct >= 0) {
      // 이미 돌파 상태: 레드라인 돌파 직전!
      score += 30;
    } else if (diffPct >= -0.01) {
      // 5선 바로 아래 1% 이내: 돌파 임박
      score += 25;
    } else if (diffPct >= -0.02) {
      score += 15;
    }
  }

  return Math.min(100, Math.max(10, Math.round(score)));
}
