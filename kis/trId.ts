// TR ID 표 — docs/koreainvestment/주문.md, 정정취소주문.md의 "TR ID 표" 그대로 옮김.
// kis-openapi 철칙 2: "TR ID가 비어 있으면 주문이 나가면 안 된다." resolve* 함수는 없으면 undefined를 반환하고,
// 호출부(order.ts/orderCancel.ts)가 fetch 전에 반드시 throw한다.
import type { KisEnvironment } from './types';

export type OrderSide = 'buy' | 'sell';

/** 해외거래소코드 (OVRS_EXCG_CD) — 주문.md/정정취소주문.md Body 표. */
export type OverseasExchangeCode =
  | 'NASD' // 나스닥
  | 'NYSE' // 뉴욕
  | 'AMEX' // 아멕스
  | 'SEHK' // 홍콩
  | 'SHAA' // 중국상해
  | 'SZAA' // 중국심천
  | 'TKSE' // 일본
  | 'HASE' // 베트남 하노이
  | 'VNSE'; // 베트남 호치민

type Country = 'US' | 'JP' | 'SH' | 'HK' | 'SZ' | 'VN';

/** OVRS_EXCG_CD → TR ID 표의 "국가" 행. 미국은 거래소 3종이 전부 같은 TR ID를 쓴다(문서 표). */
export const EXCHANGE_TO_COUNTRY: Record<OverseasExchangeCode, Country> = {
  NASD: 'US',
  NYSE: 'US',
  AMEX: 'US',
  SEHK: 'HK',
  SHAA: 'SH',
  SZAA: 'SZ',
  TKSE: 'JP',
  HASE: 'VN',
  VNSE: 'VN',
};

interface TrPair {
  live: string;
  paper: string;
}

// 주문.md "TR ID 표 (실전/모의 · 매수/매도)" 그대로.
const ORDER_TR_TABLE: Record<Country, { buy: TrPair; sell: TrPair }> = {
  US: { buy: { live: 'TTTT1002U', paper: 'VTTT1002U' }, sell: { live: 'TTTT1006U', paper: 'VTTT1001U' } },
  JP: { buy: { live: 'TTTS0308U', paper: 'VTTS0308U' }, sell: { live: 'TTTS0307U', paper: 'VTTS0307U' } },
  SH: { buy: { live: 'TTTS0202U', paper: 'VTTS0202U' }, sell: { live: 'TTTS1005U', paper: 'VTTS1005U' } },
  HK: { buy: { live: 'TTTS1002U', paper: 'VTTS1002U' }, sell: { live: 'TTTS1001U', paper: 'VTTS1001U' } },
  SZ: { buy: { live: 'TTTS0305U', paper: 'VTTS0305U' }, sell: { live: 'TTTS0304U', paper: 'VTTS0304U' } },
  VN: { buy: { live: 'TTTS0311U', paper: 'VTTS0311U' }, sell: { live: 'TTTS0310U', paper: 'VTTS0310U' } },
};

/** 주문 TR ID 해석. 없으면 undefined — 호출부가 fetch 전에 throw해야 한다. */
export function resolveOrderTrId(
  exchange: OverseasExchangeCode,
  side: OrderSide,
  environment: KisEnvironment,
): string | undefined {
  const country = EXCHANGE_TO_COUNTRY[exchange];
  return ORDER_TR_TABLE[country]?.[side]?.[environment];
}

// 정정취소주문.md "TR ID 표" — 상해/심천/베트남은 "취소"만 지원(정정 불가, 문서 표 구분란 그대로).
const CANCEL_TR_TABLE: Record<Country, TrPair | undefined> = {
  US: { live: 'TTTT1004U', paper: 'VTTT1004U' },
  HK: { live: 'TTTS1003U', paper: 'VTTS1003U' },
  JP: { live: 'TTTS0309U', paper: 'VTTS0309U' },
  SH: { live: 'TTTS0302U', paper: 'VTTS0302U' },
  SZ: { live: 'TTTS0306U', paper: 'VTTS0306U' },
  VN: { live: 'TTTS0312U', paper: 'VTTS0312U' },
};

/** 정정취소 TR ID 해석. 없으면 undefined — 호출부가 fetch 전에 throw해야 한다. */
export function resolveCancelTrId(exchange: OverseasExchangeCode, environment: KisEnvironment): string | undefined {
  const country = EXCHANGE_TO_COUNTRY[exchange];
  return CANCEL_TR_TABLE[country]?.[environment];
}

/** 정정(RVSE_CNCL_DVSN_CD=01)이 문서상 지원되지 않는 국가 — 상해/심천/베트남은 취소(02)만 가능. */
const AMEND_UNSUPPORTED_COUNTRIES: ReadonlySet<Country> = new Set(['SH', 'SZ', 'VN']);

export function isAmendSupported(exchange: OverseasExchangeCode): boolean {
  return !AMEND_UNSUPPORTED_COUNTRIES.has(EXCHANGE_TO_COUNTRY[exchange]);
}

// 주간주문.txt / 주간정정취소.txt — 미국 주간거래(KST 10~16시 시세 창, 주문은 10~18시) 전용 TR.
// 미국 3거래소(NASD/NYSE/AMEX)만 지원, **모의투자 미지원**(실전 전용), 지정가("00")만 가능.
const DAYTIME_ORDER_TR: Record<OrderSide, string> = { buy: 'TTTS6036U', sell: 'TTTS6037U' };
const DAYTIME_CANCEL_TR = 'TTTS6038U';

/** 미국주간주문 TR ID — 미국 외 거래소·모의투자는 undefined(호출부가 fetch 전에 throw). */
export function resolveDaytimeOrderTrId(
  exchange: OverseasExchangeCode,
  side: OrderSide,
  environment: KisEnvironment,
): string | undefined {
  if (EXCHANGE_TO_COUNTRY[exchange] !== 'US' || environment !== 'live') return undefined;
  return DAYTIME_ORDER_TR[side];
}

/** 미국주간정정취소 TR ID — 미국 외 거래소·모의투자는 undefined(호출부가 fetch 전에 throw). */
export function resolveDaytimeCancelTrId(
  exchange: OverseasExchangeCode,
  environment: KisEnvironment,
): string | undefined {
  if (EXCHANGE_TO_COUNTRY[exchange] !== 'US' || environment !== 'live') return undefined;
  return DAYTIME_CANCEL_TR;
}

// balance.md / 주문체결내역.md — 조회 계열 TR ID는 국가 분기가 없다.
export const BALANCE_TR: TrPair = { live: 'CTRP6504R', paper: 'VTRP6504R' };
export const ORDER_HISTORY_TR: TrPair = { live: 'TTTS3035R', paper: 'VTTS3035R' };
// 매수가능금액조회.md "TR ID 표" — 매수/매도 구분 없음.
export const PSAMOUNT_TR: TrPair = { live: 'TTTS3007R', paper: 'VTTS3007R' };

export function resolveTrPair(pair: TrPair, environment: KisEnvironment): string {
  return pair[environment];
}
