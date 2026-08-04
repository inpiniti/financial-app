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

/** hh:mm(24시간, epoch ms 입력) — 시세 피드 진단 이벤트 시각 표시용. */
export function formatHHMM(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
