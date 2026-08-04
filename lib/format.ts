// 화면 전반(조회 탭 등)에서 재사용하는 숫자 포맷 유틸 — toss-design 청킹 규칙(금액 천단위 콤마·소수 2자리, 퍼센트 소수 1~2자리).
// features/scalper/ui/format.ts와 역할이 겹치지 않도록 분리했다: 저 파일은 단타 카드 전용 표시 규칙,
// 이 파일은 조회 탭처럼 KIS 응답 문자열(예: "-14.36000000")을 그대로 받아 쓰는 화면들이 공통으로 쓴다.

/** 문자열/숫자를 안전하게 number로 변환 — 파싱 실패 시 NaN. */
function toNumber(value: number | string): number {
  return typeof value === 'number' ? value : Number(value);
}

/**
 * 가격 표시 자릿수 — KIS 주문가 규칙(kis/order.formatOverseasOrderPrice)과 동일: $1 이상 2자리, $1 미만 4자리.
 * 표시가 2자리 고정이면 $1 미만 종목에서 매수/매도 호가가 같아 보이는 문제(실기기 제보 2026-07-31)가 생긴다.
 */
function usdDigitsFor(n: number): number {
  return Math.abs(n) >= 1 ? 2 : 4;
}

/** 부호 없는 달러 금액(단가 등) — 천단위 콤마. $1 이상 소수 2자리, $1 미만 4자리. 예: 74.3 → "$74.30", 0.438 → "$0.4380". */
export function formatUsd(value: number | string, digits?: number): string {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return typeof value === 'string' ? value : '—';
  const d = digits ?? usdDigitsFor(n);
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}

/**
 * 부호 있는 달러 금액 — 천단위 콤마 + 소수 2자리. 예: -232.08 → "-$232.08", 1234.5 → "+$1,234.50".
 * 파싱 실패 시 원본 문자열(또는 "—")을 그대로 돌려준다.
 */
export function formatSignedUsd(value: number | string, digits = 2): string {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return typeof value === 'string' ? value : '—';
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${sign}$${abs}`;
}

/**
 * 부호 있는 퍼센트 — 입력값이 이미 "퍼센트 단위"(예: KIS evlu_pfls_rt1 = "-14.36000000")라고 가정하고
 * 소수 자리만 다듬는다. 0~1 비율값(예: 0.14)을 넣으려면 formatSignedPercentFromRatio를 쓴다.
 */
export function formatSignedPercent(value: number | string, digits = 1): string {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return typeof value === 'string' ? value : '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)}%`;
}

/** 0~1 비율값(예: 0.144)을 퍼센트 문자열로 — 소수 1~2자리. */
export function formatSignedPercentFromRatio(ratio: number | null, digits = 1): string {
  if (ratio === null || !Number.isFinite(ratio)) return '—';
  return formatSignedPercent(ratio * 100, digits);
}

/** 손익 색 — PRD 관례: 이익(양수)=빨강 #f04452, 손실(음수)=파랑 #3182f6, 0/무효=중립 회색. */
export function pnlColor(value: number | string | null): string {
  if (value === null) return '#8b95a1';
  const n = toNumber(value);
  if (!Number.isFinite(n) || n === 0) return '#8b95a1';
  return n > 0 ? '#f04452' : '#3182f6';
}

/** 종목 이니셜 아바타 배경색 — 티커 첫 글자 코드로 파스텔 팔레트를 순환시킨다(결정적 — 같은 티커는 항상 같은 색). */
const AVATAR_PALETTE: readonly [bg: string, fg: string][] = [
  ['#eaf2ff', '#3182f6'],
  ['#fdecee', '#f04452'],
  ['#e6f4ea', '#03b26c'],
  ['#fff4e5', '#ff9500'],
  ['#f2ecfd', '#7c4dff'],
  ['#e5f7f6', '#00a3a3'],
];

export function avatarColorFor(ticker: string): { bg: string; fg: string } {
  const code = ticker.trim().toUpperCase().charCodeAt(0) || 0;
  const [bg, fg] = AVATAR_PALETTE[code % AVATAR_PALETTE.length];
  return { bg, fg };
}

/** 아바타에 표시할 이니셜(1글자) — 빈 문자열이면 "?". */
export function avatarInitial(ticker: string): string {
  const trimmed = ticker.trim();
  return trimmed ? trimmed[0].toUpperCase() : '?';
}
