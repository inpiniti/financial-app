import type { TickDirection } from './animatedPriceMath';

export const WAVE_POOL_SIZE = 3;
export const DEFAULT_THROTTLE_MS = 80;
export const DEFAULT_WAVE_DURATION_MS = 700;
export const DEFAULT_WAVE_WIDTH = 140;

export interface WaveColorScheme {
  primary: string;
  accent: string;
  hex: string;
}

export const WAVE_COLORS: Record<TickDirection, WaveColorScheme> = {
  up: {
    primary: 'rgba(240, 68, 82, 0.16)',
    accent: 'rgba(240, 68, 82, 0.38)',
    hex: '#f04452',
  },
  down: {
    primary: 'rgba(49, 130, 246, 0.16)',
    accent: 'rgba(49, 130, 246, 0.38)',
    hex: '#3182f6',
  },
  same: {
    primary: 'rgba(139, 149, 161, 0.10)',
    accent: 'rgba(139, 149, 161, 0.25)',
    hex: '#8b95a1',
  },
};

/**
 * 틱 방향에 대응하는 웨이브 색상 정의를 반환한다.
 */
export function getWaveColors(direction: TickDirection): WaveColorScheme {
  return WAVE_COLORS[direction] ?? WAVE_COLORS.same;
}

/**
 * 고정 인스턴스 풀(Pool)의 다음 라운드로빈 인덱스를 계산한다.
 */
export function getNextPoolIndex(currentIndex: number, poolSize: number = WAVE_POOL_SIZE): number {
  if (poolSize <= 0) return 0;
  return (currentIndex + 1) % poolSize;
}

/**
 * 틱 폭주 방지 스로틀링 여부를 판정한다 (최소 간격 이내의 연타는 무시).
 */
export function shouldThrottleTick(
  currentTs: number,
  lastTriggerTs: number,
  throttleMs: number = DEFAULT_THROTTLE_MS,
): boolean {
  if (lastTriggerTs <= 0) return false;
  return currentTs - lastTriggerTs < throttleMs;
}

/**
 * 행 너비와 웨이브 너비를 기준으로 좌→우 이동 시작 및 종료 좌표를 계산한다.
 */
export function calculateWaveTranslateRange(
  rowWidth: number,
  waveWidth: number = DEFAULT_WAVE_WIDTH,
): { fromX: number; toX: number } {
  const safeWidth = Math.max(0, rowWidth);
  return {
    fromX: -waveWidth,
    toX: safeWidth + waveWidth * 0.5,
  };
}
