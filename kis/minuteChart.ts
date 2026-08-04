// 해외주식분봉조회 [v1_해외주식-030] — docs/koreainvestment/분봉조회.md 그대로.
// 판단(문서: "모의 Domain: 모의투자 미지원"): priceDetail.ts·nccs.ts와 동일 취급 — environment와 무관하게 항상 실전 도메인.
// v1 범위: 첫 페이지(최대 120건)만 사용한다 — NEXT/KEYB 다음조회는 구현하지 않는다(문서상 tr_cont 방식이 아니라
// NEXT="1"+KEYB(마지막 분봉 시각)로 재요청하는 방식이며, 이번 바텀시트는 최근 80봉만 보여주면 충분하다).
import { REST_DOMAIN } from './domain';
import { appendQuery, assertRtCdOk, buildAuthHeaders, type KisRtCdResponse } from './http';
import type { FetchLike, KisCredentials } from './types';

export const MINUTE_CHART_TR_ID = 'HHDFS76950200';

/** EXCD — 분봉조회.md Query Parameter 표. 단타 카드는 미국 3거래소만 쓰므로 그 범위로 좁힌다. */
export type MinuteChartExchangeCode = 'NYS' | 'NAS' | 'AMS';

export interface InquireOverseasMinuteChartParams {
  excd: MinuteChartExchangeCode;
  /** SYMB — 종목코드(ex. TSLA) */
  symb: string;
  /** NMIN — 분갭(1: 1분봉, 2: 2분봉, ...). */
  nmin: number;
  /** PINC — 전일포함여부. true면 "1"(전일포함), false/미지정이면 "0"(당일만). */
  includePrev?: boolean;
}

/** output2 배열 원소 하나를 숫자로 변환한 캔들. */
export interface MinuteCandle {
  /** 현지기준일자(xymd, YYYYMMDD). */
  ymd: string;
  /** 현지기준시간(xhms, HHMMSS). */
  hms: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** 체결량(evol). */
  volume: number;
}

export interface InquireOverseasMinuteChartResult {
  candles: MinuteCandle[];
}

export interface InquireOverseasMinuteChartDeps {
  fetchImpl?: FetchLike;
}

// 분봉조회.md output2 표 필드명 그대로(전부 String).
interface RawMinuteCandle {
  tymd: string;
  xymd: string;
  xhms: string;
  kymd: string;
  khms: string;
  open: string;
  high: string;
  low: string;
  last: string;
  evol: string;
  eamt: string;
}

export async function inquireOverseasMinuteChart(
  credentials: KisCredentials,
  accessToken: string,
  params: InquireOverseasMinuteChartParams,
  deps: InquireOverseasMinuteChartDeps = {},
): Promise<InquireOverseasMinuteChartResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  // 모의투자 미지원 — 항상 실전 도메인(priceDetail.ts·nccs.ts와 동일 판단).
  const url = appendQuery(`${REST_DOMAIN.live}/uapi/overseas-price/v1/quotations/inquire-time-itemchartprice`, {
    AUTH: '',
    EXCD: params.excd,
    SYMB: params.symb,
    NMIN: String(params.nmin),
    PINC: params.includePrev ? '1' : '0',
    // 초기 조회 — NEXT/KEYB는 처음 조회 시 공백 입력(문서 "초기 조회" 절차).
    NEXT: '',
    NREC: '120',
    FILL: '',
    KEYB: '',
  });

  const res = await fetchImpl(url, {
    method: 'GET',
    headers: buildAuthHeaders(accessToken, credentials, MINUTE_CHART_TR_ID),
  });
  const body = (await res.json()) as KisRtCdResponse & {
    output1: unknown;
    output2: RawMinuteCandle[];
  };
  assertRtCdOk(body);

  const raw = Array.isArray(body.output2) ? body.output2 : [];
  const candles: MinuteCandle[] = raw.map((item) => ({
    ymd: item.xymd,
    hms: item.xhms,
    open: Number(item.open),
    high: Number(item.high),
    low: Number(item.low),
    close: Number(item.last),
    volume: Number(item.evol),
  }));

  // 문서/공식 샘플은 최신순(내림차순)으로 내려온다 — 차트는 시간 오름차순이 필요하므로 정렬한다.
  candles.sort((a, b) => {
    const aKey = `${a.ymd}${a.hms}`;
    const bKey = `${b.ymd}${b.hms}`;
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });

  return { candles };
}
