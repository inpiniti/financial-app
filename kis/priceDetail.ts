// 해외주식 현재가상세 [v1_해외주식-029] — docs/koreainvestment/현재가상세.md 그대로.
// 판단(문서: "모의 Domain: 모의투자 미지원"): environment와 무관하게 항상 실전 도메인을 쓴다.
// (kis-openapi 함정 목록의 "웹소켓 시세는 모의 미지원 → 실전 도메인 우회"와 동일한 취급.)
import { kisFlowFetch } from './flow';
import { REST_DOMAIN } from './domain';
import { appendQuery, assertRtCdOk, buildAuthHeaders, type KisRtCdResponse } from './http';
import type { FetchLike, KisCredentials } from './types';

const PRICE_DETAIL_TR_ID = 'HHDFS76200200';

/** EXCD — 현재가상세.md Query Parameter 표. */
export type PriceDetailExchangeCode =
  | 'HKS' // 홍콩
  | 'NYS' // 뉴욕
  | 'NAS' // 나스닥
  | 'AMS' // 아멕스
  | 'TSE' // 도쿄
  | 'SHS' // 상해
  | 'SZS' // 심천
  | 'SHI' // 상해지수
  | 'SZI' // 심천지수
  | 'HSX' // 호치민
  | 'HNX' // 하노이
  | 'BAY' // 뉴욕(주간)
  | 'BAQ' // 나스닥(주간)
  | 'BAA'; // 아멕스(주간)

export interface InquirePriceDetailParams {
  excd: PriceDetailExchangeCode;
  /** SYMB — 종목코드 */
  symb: string;
  /** AUTH — 사용자권한정보. 문서상 개인 고객은 공란으로 호출. */
  auth?: string;
}

// output — 현재가상세.md Body 표 그대로.
export interface OverseasPriceDetail {
  rsym: string;
  pvol: string;
  open: string;
  high: string;
  low: string;
  last: string;
  base: string;
  tomv: string;
  pamt: string;
  uplp: string;
  dnlp: string;
  h52p: string;
  h52d: string;
  l52p: string;
  l52d: string;
  perx: string;
  pbrx: string;
  epsx: string;
  bpsx: string;
  shar: string;
  mcap: string;
  curr: string;
  zdiv: string;
  vnit: string;
  t_xprc: string;
  t_xdif: string;
  t_xrat: string;
  p_xprc: string;
  p_xdif: string;
  p_xrat: string;
  t_rate: string;
  p_rate: string;
  t_xsgn: string;
  p_xsng: string;
  e_ordyn: string;
  e_hogau: string;
  e_icod: string;
  e_parp: string;
  tvol: string;
  tamt: string;
  etyp_nm: string;
}

export interface InquirePriceDetailDeps {
  fetchImpl?: FetchLike;
}

export async function inquireOverseasPriceDetail(
  credentials: KisCredentials,
  accessToken: string,
  params: InquirePriceDetailParams,
  deps: InquirePriceDetailDeps = {},
): Promise<OverseasPriceDetail> {
  const fetchImpl = deps.fetchImpl ?? kisFlowFetch;
  // 모의투자 미지원 — 항상 실전 도메인.
  const url = appendQuery(`${REST_DOMAIN.live}/uapi/overseas-price/v1/quotations/price-detail`, {
    AUTH: params.auth ?? '',
    EXCD: params.excd,
    SYMB: params.symb,
  });

  const res = await fetchImpl(url, {
    method: 'GET',
    headers: buildAuthHeaders(accessToken, credentials, PRICE_DETAIL_TR_ID),
  });
  const body = (await res.json()) as KisRtCdResponse & { output: OverseasPriceDetail };
  assertRtCdOk(body);
  return body.output;
}
