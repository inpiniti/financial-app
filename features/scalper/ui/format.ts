// 단타 탭 UI 표시 규칙 — 상태 배지 문구·색상, 숫자 포맷 (toss-design: 해요체·청킹).
import type { CycleState, Signal } from '../types';

/**
 * 상태 배지 문구 — 전부 해요체(토스 라이팅 규칙). 흐름: 감지 중(WATCH_BUY/HOLDING) → 체결 대기 중(BUYING/SELLING)
 * → 중지(IDLE)/완료(DONE). "체결 취소가 아닌 이상 상태가 뒤로 가면 안 된다"는 요구는 core/cycle의 상태기계가 이미
 * 보장한다(미체결 타임아웃 취소 시에만 감지 중으로 복귀) — 여기서는 문구만 그 흐름에 맞게 바꾼다.
 */
export const STATE_LABEL: Record<CycleState, string> = {
  IDLE: '중지',
  WATCH_BUY: '매수 변곡점 감지 중',
  BUYING: '매수 체결 대기 중',
  HOLDING: '매도 변곡점 감지 중',
  SELLING: '매도 체결 대기 중',
  DONE: '중지 · 사이클 완료',
  FAULT: '멈췄어요 · 확인 필요',
};

/** 배지 색(토스 토큰) — 감지 중=파랑, 체결 대기 중=주황, 중지=회색, 완료=회색(성공 뉘앙스), FAULT=빨강. */
export const STATE_BADGE_COLOR: Record<CycleState, { bg: string; fg: string }> = {
  IDLE: { bg: '#f7f9fc', fg: '#8b95a1' },
  WATCH_BUY: { bg: '#eaf2ff', fg: '#3182f6' },
  BUYING: { bg: '#fff4e5', fg: '#ff9500' },
  HOLDING: { bg: '#eaf2ff', fg: '#3182f6' },
  SELLING: { bg: '#fff4e5', fg: '#ff9500' },
  DONE: { bg: '#f2f4f6', fg: '#4e5968' },
  FAULT: { bg: '#feeaea', fg: '#f04452' },
};

const RUNNING_STATES = new Set<CycleState>(['WATCH_BUY', 'BUYING', 'HOLDING', 'SELLING']);

export function isRunningState(state: CycleState): boolean {
  return RUNNING_STATES.has(state);
}

/** Run 버튼 활성 조건 — IDLE/DONE(사이클 종료 후 재실행)에서만 새 Run 가능. */
export function canRun(state: CycleState): boolean {
  return state === 'IDLE' || state === 'DONE';
}

/** Stop 버튼 활성 조건 — 감시~매도 진행 중, 또는 FAULT(사용자만 인터록을 풀 수 있다). */
export function canStop(state: CycleState): boolean {
  return isRunningState(state) || state === 'FAULT';
}

export const SIGNAL_LABEL: Record<Signal, string> = {
  BUY: '매수 변곡점',
  SELL: '매도 변곡점',
};

/** PRD 색 규칙: 이익=빨강, 손실=파랑 (조회 탭 순위 색과 동일 관례). */
export function pnlColor(pnlRate: number | null): string {
  if (pnlRate === null || pnlRate === 0) return '#8b95a1';
  return pnlRate > 0 ? '#f04452' : '#3182f6';
}

/**
 * 가격 청킹 포맷 — $74.33. KIS 주문가 규칙과 동일하게 **$1 미만은 소수 4자리**로 표시한다
 * (2자리 고정이면 저가 종목에서 매수/매도 호가가 같아 보이는 문제 — 실기기 제보 2026-07-31).
 */
export function formatPrice(price: number | null): string {
  if (price === null) return '—';
  const digits = Math.abs(price) >= 1 ? 2 : 4;
  return `$${price.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** 비율 포맷 — 82.00% 형태(부호 포함). */
export function formatRate(rate: number | null, digits = 2): string {
  if (rate === null) return '—';
  const pct = rate * 100;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(digits)}%`;
}

/** 기울기·가속도 — 부호 있는 소수 4자리(작은 값이라 % 대신 그대로). */
export function formatSigned(value: number | null, digits = 4): string {
  if (value === null) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}`;
}

/**
 * 속도·기울기 표기 단위 — 측정 정본은 틱/초·%/초지만 표기는 15초당으로 환산한다(×15).
 * 초당 %는 소수 1자리에서 거의 다 0.0으로 뭉개졌고(→ 5초), 5초도 짧다는 관찰 피드백(2026-08-14)으로
 * 15초 확정. 측정 윈도우(feedSlot.FEED_RATE_WINDOW_MS)도 15초라 표기값 = 실제 "지난 15초" 관찰값이다.
 */
export const RATE_DISPLAY_UNIT_SECONDS = 15;

/**
 * 기울기 표기 — 입력은 정본 %/초, 출력은 %/15초(×15). 부호 필수·소수 1자리,
 * 판정 불가(null)는 '—'(0=횡보와 구분). 도메인 문서 §5 표기 규칙.
 */
export function formatSlopeRate(value: number | null): string {
  if (value === null) return '—';
  const scaled = value * RATE_DISPLAY_UNIT_SECONDS;
  const sign = scaled > 0 ? '+' : '';
  return `${sign}${scaled.toFixed(1)}`;
}

/** 속도 시계열 나열 — 입력은 정본 틱/초, 출력은 틱/15초(×15, 정수) "12 18 30 23 27". */
export function formatTickRateSeries(series: readonly number[]): string {
  return series.map((v) => (v * RATE_DISPLAY_UNIT_SECONDS).toFixed(0)).join(' ');
}

/** 기울기 시계열 나열(%/15초 표기) — "+0.1 -0.2 — +0.2 +0.3". */
export function formatSlopeRateSeries(series: readonly (number | null)[]): string {
  return series.map(formatSlopeRate).join(' ');
}

/** hh:mm(24시간, epoch ms 입력) — 시세 피드 진단 이벤트 시각 표시용. */
export function formatHHMM(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
