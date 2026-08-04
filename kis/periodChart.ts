// 해외주식 기간별시세 [v1_해외주식-010] — docs/koreainvestment/기간별시세.md 그대로.
// minuteChart.ts(분봉)와 짝을 이루는 일/주/월봉 소스. 문서상 유일하게 "실전/모의 동일 TR"이며
// 실전·모의 도메인이 모두 존재하므로(REST_DOMAIN[environment]) minuteChart와 달리 environment를 받는다.
import { REST_DOMAIN } from './domain';
import { appendQuery, assertRtCdOk, buildAuthHeaders, type KisRtCdResponse } from './http';
import type { FetchLike, KisCredentials, KisEnvironment } from './types';

export const PERIOD_CHART_TR_ID = 'HHDFS76240000';

/** EXCD — 기간별시세.md Query Parameter 표(분봉조회.md보다 넓다: 지수 EXCD 2종 포함). */
export type PeriodChartExchangeCode =
  | 'HKS'
  | 'NYS'
  | 'NAS'
  | 'AMS'
  | 'TSE'
  | 'SHS'
  | 'SZS'
  | 'SHI'
  | 'SZI'
  | 'HSX'
  | 'HNX';

/** GUBN — 일/주/월구분(문서: 0=일, 1=주, 2=월). 코드에서는 의미가 드러나는 문자로 다룬다. */
export type PeriodChartPeriod = 'D' | 'W' | 'M';

const GUBN_BY_PERIOD: Record<PeriodChartPeriod, string> = {
  D: '0',
  W: '1',
  M: '2',
};

export interface InquireOverseasPeriodChartParams {
  excd: PeriodChartExchangeCode;
  /** SYMB — 종목코드(ex. TSLA) */
  symb: string;
  /** GUBN — 일/주/월구분. */
  period: PeriodChartPeriod;
  /** BYMD — 조회기준일자(YYYYMMDD). 미지정 시 공란(문서: "공란 설정 시, 기준일 오늘 날짜로 설정"). */
  bymd?: string;
  /** MODP — 수정주가반영여부(0:미반영, 1:반영). 미지정 시 '1'(반영) — 분할·배당 반영된 값이 차트 기본값으로 맞다. */
  modp?: '0' | '1';
}

/** output2 배열 원소 하나를 숫자로 변환한 캔들. */
export interface PeriodCandle {
  /** 일자(xymd, YYYYMMDD). */
  ymd: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** 거래량(tvol). */
  volume: number;
}

export interface InquireOverseasPeriodChartResult {
  candles: PeriodCandle[];
}

export interface InquireOverseasPeriodChartDeps {
  fetchImpl?: FetchLike;
}

// 기간별시세.md output2 표 필드명 그대로(전부 String).
interface RawPeriodCandle {
  xymd: string;
  clos: string;
  sign: string;
  diff: string;
  rate: string;
  open: string;
  high: string;
  low: string;
  tvol: string;
  tamt: string;
  pbid?: string;
  vbid?: string;
  pask?: string;
  vask?: string;
}

export async function inquireOverseasPeriodChart(
  environment: KisEnvironment,
  credentials: KisCredentials,
  accessToken: string,
  params: InquireOverseasPeriodChartParams,
  deps: InquireOverseasPeriodChartDeps = {},
): Promise<InquireOverseasPeriodChartResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = appendQuery(`${REST_DOMAIN[environment]}/uapi/overseas-price/v1/quotations/dailyprice`, {
    AUTH: '',
    EXCD: params.excd,
    SYMB: params.symb,
    GUBN: GUBN_BY_PERIOD[params.period],
    BYMD: params.bymd ?? '',
    MODP: params.modp ?? '1',
    KEYB: '',
  });

  const res = await fetchImpl(url, {
    method: 'GET',
    headers: buildAuthHeaders(accessToken, credentials, PERIOD_CHART_TR_ID),
  });
  const body = (await res.json()) as KisRtCdResponse & {
    output1: unknown;
    output2: RawPeriodCandle[];
  };
  assertRtCdOk(body);

  const raw = Array.isArray(body.output2) ? body.output2 : [];
  const candles: PeriodCandle[] = raw.map((item) => ({
    ymd: item.xymd,
    open: Number(item.open),
    high: Number(item.high),
    low: Number(item.low),
    close: Number(item.clos),
    volume: Number(item.tvol),
  }));

  // 문서/분봉조회와 동일하게 최신순(내림차순)으로 내려온다 — 차트는 시간 오름차순이 필요하므로 정렬한다.
  candles.sort((a, b) => (a.ymd < b.ymd ? -1 : a.ymd > b.ymd ? 1 : 0));

  return { candles };
}
