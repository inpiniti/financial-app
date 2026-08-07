// 조회 탭 손익 세그먼트 — 년/월 선택 화면의 순수 로직 모음.
// KIS 기간손익(kis/periodProfit)의 종목별 행을 "일별 합계" 리스트로 접고, 선택한 년·월을
// INQR_STRT_DT/END_DT(YYYYMMDD) 범위로 바꾼다. 날짜 기준은 ProfitLoss.tsx와 동일하게 한국시간(UTC+9).
import type { PeriodProfitItem } from '../../kis/periodProfit';

/** 한국시간(UTC+9) 오프셋 — ProfitLoss.tsx의 관례를 그대로 따른다. */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export interface YearMonth {
  year: number;
  /** 1~12 */
  month: number;
}

/** epoch ms → 한국시간 기준 년/월. */
export function currentYearMonthKst(nowMs: number): YearMonth {
  const kst = new Date(nowMs + KST_OFFSET_MS);
  return { year: kst.getUTCFullYear(), month: kst.getUTCMonth() + 1 };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * 선택한 년·월 → { startDt, endDt }(YYYYMMDD).
 * 미래 날짜를 END_DT로 보내지 않도록, 선택한 달이 현재(한국시간) 달이면 오늘까지로 자른다.
 */
export function monthRange(ym: YearMonth, nowMs: number): { startDt: string; endDt: string } {
  const startDt = `${ym.year}${pad2(ym.month)}01`;
  const lastDay = new Date(Date.UTC(ym.year, ym.month, 0)).getUTCDate();
  const now = currentYearMonthKst(nowMs);
  if (ym.year === now.year && ym.month === now.month) {
    const kst = new Date(nowMs + KST_OFFSET_MS);
    return { startDt, endDt: `${ym.year}${pad2(ym.month)}${pad2(kst.getUTCDate())}` };
  }
  return { startDt, endDt: `${ym.year}${pad2(ym.month)}${pad2(lastDay)}` };
}

/** 일별 합계 1건 — 종목별 행(PeriodProfitItem)을 매매일 기준으로 접은 결과. */
export interface DailyProfit {
  /** 매매일 (YYYYMMDD) */
  tradeDt: string;
  /** 해당 일 실현손익 합계 */
  totalPnl: number;
  /** 해당 일 매입금액 합계 — 수익률 분모 */
  totalBuyAmount: number;
  /** 합산 수익률(%) = totalPnl / totalBuyAmount * 100. 분모 0이면 null. */
  pnlRate: number | null;
  /** 해당 일 종목별 원본 행들(시간 정보 없음 — 응답 순서 유지) */
  items: PeriodProfitItem[];
}

/** 종목별 행 → 일별 합계 리스트(최신일 먼저). 수익률은 종목별 %를 평균 내지 않고 금액으로 다시 계산한다. */
export function aggregateDaily(items: PeriodProfitItem[]): DailyProfit[] {
  const byDay = new Map<string, DailyProfit>();
  for (const item of items) {
    let day = byDay.get(item.tradeDt);
    if (!day) {
      day = { tradeDt: item.tradeDt, totalPnl: 0, totalBuyAmount: 0, pnlRate: null, items: [] };
      byDay.set(item.tradeDt, day);
    }
    day.totalPnl += item.realizedPnl;
    day.totalBuyAmount += item.buyAmount;
    day.items.push(item);
  }
  const days = [...byDay.values()];
  for (const day of days) {
    day.pnlRate = day.totalBuyAmount > 0 ? (day.totalPnl / day.totalBuyAmount) * 100 : null;
  }
  return days.sort((a, b) => (a.tradeDt < b.tradeDt ? 1 : -1));
}

/** epoch ms → 한국시간 기준 'YYYYMMDD' — KIS 일별 행(tradeDt)과 같은 형식. */
export function todayKstDt(nowMs: number): string {
  const kst = new Date(nowMs + KST_OFFSET_MS);
  return `${kst.getUTCFullYear()}${pad2(kst.getUTCMonth() + 1)}${pad2(kst.getUTCDate())}`;
}

/**
 * 앱 자체 기록으로 합산한 "오늘예상" 손익 — KIS 기간손익(TTTS3039R)이 당일 분을 제공하지 않아,
 * features/scalper/tradeStore의 오늘 사이클 기록(USD)으로 일별 리스트의 오늘 행을 대신 만든다.
 */
export interface TodayEstimate {
  /** 순손익 합계(USD) — TradeRecord.pnl(수수료 차감 후) 합. */
  pnlUsd: number;
  /** 매입금액 합계(USD) = Σ entryPrice × qty — 수익률 분모(aggregateDaily와 같은 방식). */
  buyAmountUsd: number;
  /** 합산 수익률(%) — 분모 0이면 null. 통화 무관이라 환율 없이도 유효하다. */
  pnlRate: number | null;
  /** 환율이 있으면 원화 환산 손익, 없으면 null(그때는 USD로 표시한다). */
  pnlKrw: number | null;
}

/** 오늘 기록이 없으면 null — 행 자체를 그리지 않는다. */
export function estimateToday(
  trades: readonly { pnl: number; entryPrice: number; qty: number }[],
  exchangeRate: number | null,
): TodayEstimate | null {
  if (trades.length === 0) return null;
  let pnlUsd = 0;
  let buyAmountUsd = 0;
  for (const t of trades) {
    pnlUsd += t.pnl;
    buyAmountUsd += t.entryPrice * t.qty;
  }
  return {
    pnlUsd,
    buyAmountUsd,
    pnlRate: buyAmountUsd > 0 ? (pnlUsd / buyAmountUsd) * 100 : null,
    pnlKrw: exchangeRate !== null && exchangeRate > 0 ? pnlUsd * exchangeRate : null,
  };
}

const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'] as const;

/** 'YYYYMMDD' → '08월 06일 (목)'. 파싱 불가 문자열은 그대로 돌려준다. */
export function formatDayLabel(tradeDt: string): string {
  if (!/^\d{8}$/.test(tradeDt)) return tradeDt;
  const y = Number(tradeDt.slice(0, 4));
  const m = Number(tradeDt.slice(4, 6));
  const d = Number(tradeDt.slice(6, 8));
  const weekday = WEEKDAY_KO[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${pad2(m)}월 ${pad2(d)}일 (${weekday})`;
}
