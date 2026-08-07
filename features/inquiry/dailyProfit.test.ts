import { describe, expect, it } from 'vitest';
import type { PeriodProfitItem } from '../../kis/periodProfit';
import { aggregateDaily, currentYearMonthKst, estimateToday, formatDayLabel, monthRange, todayKstDt } from './dailyProfit';

function item(partial: Partial<PeriodProfitItem>): PeriodProfitItem {
  return {
    tradeDt: '20260801',
    pdno: 'AAPL',
    name: 'Apple',
    sellQty: 1,
    avgBuyPrice: 0,
    buyAmount: 0,
    avgSellPrice: 0,
    sellAmount: 0,
    sellFee: 0,
    realizedPnl: 0,
    pnlRate: 0,
    exchangeRate: 0,
    exchangeCode: 'NASD',
    firstExrt: 0,
    ...partial,
  };
}

/** 2026-08-08 12:00 KST = 2026-08-08 03:00 UTC */
const NOW = Date.UTC(2026, 7, 8, 3, 0, 0);

describe('currentYearMonthKst', () => {
  it('한국시간 기준으로 년/월을 돌려준다', () => {
    expect(currentYearMonthKst(NOW)).toEqual({ year: 2026, month: 8 });
  });

  it('UTC 자정 직전(한국은 이미 다음 달)도 한국 날짜를 따른다', () => {
    // 2026-07-31 16:00 UTC = 2026-08-01 01:00 KST
    expect(currentYearMonthKst(Date.UTC(2026, 6, 31, 16, 0, 0))).toEqual({ year: 2026, month: 8 });
  });
});

describe('monthRange', () => {
  it('과거 달은 1일~말일', () => {
    expect(monthRange({ year: 2026, month: 6 }, NOW)).toEqual({ startDt: '20260601', endDt: '20260630' });
  });

  it('윤년 2월 말일을 정확히 계산한다', () => {
    expect(monthRange({ year: 2024, month: 2 }, NOW)).toEqual({ startDt: '20240201', endDt: '20240229' });
  });

  it('현재 달은 오늘(한국시간)까지로 자른다', () => {
    expect(monthRange({ year: 2026, month: 8 }, NOW)).toEqual({ startDt: '20260801', endDt: '20260808' });
  });
});

describe('aggregateDaily', () => {
  it('같은 날 종목들을 합산하고 수익률은 금액으로 다시 계산한다', () => {
    const days = aggregateDaily([
      item({ tradeDt: '20260806', realizedPnl: 100, buyAmount: 1000 }),
      item({ tradeDt: '20260806', pdno: 'TSLA', realizedPnl: -40, buyAmount: 2000 }),
      item({ tradeDt: '20260804', realizedPnl: -50, buyAmount: 500 }),
    ]);
    expect(days).toHaveLength(2);
    expect(days[0].tradeDt).toBe('20260806'); // 최신일 먼저
    expect(days[0].totalPnl).toBe(60);
    expect(days[0].pnlRate).toBeCloseTo(2, 5); // 60 / 3000 * 100
    expect(days[0].items).toHaveLength(2);
    expect(days[1].totalPnl).toBe(-50);
    expect(days[1].pnlRate).toBeCloseTo(-10, 5);
  });

  it('매입금액이 0이면 수익률은 null', () => {
    const days = aggregateDaily([item({ realizedPnl: 10, buyAmount: 0 })]);
    expect(days[0].pnlRate).toBeNull();
  });

  it('빈 입력은 빈 배열', () => {
    expect(aggregateDaily([])).toEqual([]);
  });
});

describe('todayKstDt', () => {
  it('한국시간 기준 YYYYMMDD를 돌려준다', () => {
    expect(todayKstDt(NOW)).toBe('20260808');
    // 2026-07-31 16:00 UTC = 2026-08-01 01:00 KST
    expect(todayKstDt(Date.UTC(2026, 6, 31, 16, 0, 0))).toBe('20260801');
  });
});

describe('estimateToday', () => {
  const trades = [
    { pnl: 12, entryPrice: 100, qty: 5 }, // 매입 500
    { pnl: -2, entryPrice: 50, qty: 10 }, // 매입 500
  ];

  it('손익 합계·매입금액 기반 수익률·원화 환산을 계산한다', () => {
    const est = estimateToday(trades, 1350);
    expect(est).not.toBeNull();
    expect(est!.pnlUsd).toBe(10);
    expect(est!.buyAmountUsd).toBe(1000);
    expect(est!.pnlRate).toBeCloseTo(1, 5); // 10 / 1000 * 100
    expect(est!.pnlKrw).toBeCloseTo(13500, 5);
  });

  it('환율이 없으면 pnlKrw는 null(수익률은 통화 무관이라 유지)', () => {
    const est = estimateToday(trades, null);
    expect(est!.pnlKrw).toBeNull();
    expect(est!.pnlRate).toBeCloseTo(1, 5);
  });

  it('환율 0(파싱 실패값)도 null 취급한다', () => {
    expect(estimateToday(trades, 0)!.pnlKrw).toBeNull();
  });

  it('기록이 없으면 null — 행을 그리지 않는다', () => {
    expect(estimateToday([], 1350)).toBeNull();
  });

  it('매입금액이 0이면 수익률은 null', () => {
    expect(estimateToday([{ pnl: 1, entryPrice: 0, qty: 0 }], 1350)!.pnlRate).toBeNull();
  });
});

describe('formatDayLabel', () => {
  it('요일 포함 라벨을 만든다', () => {
    expect(formatDayLabel('20260806')).toBe('08월 06일 (목)');
    expect(formatDayLabel('20260804')).toBe('08월 04일 (화)');
  });

  it('파싱 불가 문자열은 그대로', () => {
    expect(formatDayLabel('')).toBe('');
    expect(formatDayLabel('2026-08')).toBe('2026-08');
  });
});
