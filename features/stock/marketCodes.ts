// 종목 상세화면 라우트 파라미터의 시장 코드 정규화 — 2026-08-07 종목상세화면 plan §1.
// 진입점마다 들고 있는 거래소 표기가 다르다: 순위/인스턴스는 NAS·NYS·AMS, 잔고/미체결 응답은 NASD·NYSE·AMEX.
// 여기서 미국 3거래소 코드로 좁히고, 매핑이 안 되면 null — 상세화면이 에러 상태를 표시한다(조용한 오동작 금지).
import type { MinuteChartExchangeCode } from '../../kis/minuteChart';
import type { DaytimeMarketCode } from '../../kis/realtimePrice';

/** 상세화면이 다루는 시장 코드 — 분봉 차트 EXCD와 같은 값 공간(NYS/NAS/AMS). */
export type StockMarketCode = MinuteChartExchangeCode;

const RAW_TO_MARKET: Record<string, StockMarketCode> = {
  NAS: 'NAS',
  NYS: 'NYS',
  AMS: 'AMS',
  // KIS 잔고·미체결 응답의 4자리 거래소 코드.
  NASD: 'NAS',
  NYSE: 'NYS',
  AMEX: 'AMS',
};

/** 임의 표기(NAS/NASD/NYSE/…)를 미국 3거래소 코드로 정규화 — 매핑 불가면 null. */
export function toStockMarketCode(raw: string | undefined | null): StockMarketCode | null {
  if (!raw) return null;
  return RAW_TO_MARKET[raw.trim().toUpperCase()] ?? null;
}

/** 주간거래(KST 10~16시) 구독용 시장구분 — R 접두 빌더에 넣는다(kis/realtimePrice 참고). */
export const MARKET_TO_DAYTIME: Record<StockMarketCode, DaytimeMarketCode> = {
  NAS: 'BAQ',
  NYS: 'BAY',
  AMS: 'BAA',
};
