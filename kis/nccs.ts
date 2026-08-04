// 해외주식 미체결내역 [v1_해외주식-005] — docs/koreainvestment/미체결내역.md 그대로.
// 주문체결내역(TTTS3035R)이 일부 계좌에서 APTR0058("처리계좌의 ID와 사용자정보가 상이")로 거절되어
// 미체결 조회는 이 TR(TTTS3018R)로 대체한다 (README.md 주문체결내역 행 비고 참조).
// 모의투자 완전 미지원 — 문서 "모의 TR ID: 모의투자 미지원" 그대로.
import { REST_DOMAIN } from './domain';
import { appendQuery, assertRtCdOk, buildAuthHeaders, type KisRtCdResponse } from './http';
import type { FetchLike, KisAccount, KisCredentials, KisEnvironment } from './types';

/** 미체결내역.md 실전 TR ID — 모의투자 미지원이므로 environment 분기가 없다. */
export const NCCS_TR_ID = 'TTTS3018R';

export interface InquireOverseasUnfilledParams {
  account: KisAccount;
  /** OVRS_EXCG_CD — NASD면 미국 전체, 그 외는 해당 거래소만(공백 입력 시 다음조회 불가하므로 필수). */
  ovrsExcgCd: string;
  /** SORT_SQN — DS 정순 / 그 외 역순. */
  sortSqn?: string;
  /** CTX_AREA_FK200 — 공란: 최초 조회, 이전 응답 값: 다음 페이지. */
  ctxAreaFk200?: string;
  /** CTX_AREA_NK200 — 공란: 최초 조회, 이전 응답 값: 다음 페이지. */
  ctxAreaNk200?: string;
}

/** 미체결내역.md "output (배열 원소)" 표 필드명 그대로. */
export interface OverseasUnfilledItem {
  ord_dt: string;
  ord_gno_brno: string;
  odno: string;
  orgn_odno: string;
  pdno: string;
  prdt_name: string;
  sll_buy_dvsn_cd: string;
  sll_buy_dvsn_cd_name: string;
  rvse_cncl_dvsn_cd: string;
  rvse_cncl_dvsn_cd_name: string;
  rjct_rson: string;
  rjct_rson_name: string;
  ord_tmd: string;
  tr_mket_name: string;
  tr_crcy_cd: string;
  natn_cd: string;
  natn_kor_name: string;
  ft_ord_qty: string;
  ft_ccld_qty: string;
  nccs_qty: string;
  ft_ord_unpr3: string;
  ft_ccld_unpr3: string;
  ft_ccld_amt3: string;
  ovrs_excg_cd: string;
  prcs_stat_name: string;
  loan_type_cd: string;
  loan_dt: string;
  usa_amk_exts_rqst_yn: string;
  splt_buy_attr_name: string;
  [key: string]: unknown;
}

export interface InquireOverseasUnfilledResult {
  output: OverseasUnfilledItem[];
  ctxAreaFk200: string;
  ctxAreaNk200: string;
}

export interface InquireOverseasUnfilledDeps {
  fetchImpl?: FetchLike;
}

/**
 * 해외주식 미체결내역 조회 (TTTS3018R). 모의투자 미지원 — 문서 규정대로 environment='paper'에서도
 * fetch 자체는 막지 않지만(도메인은 REST_DOMAIN 그대로 사용), 실서비스에서는 실전 계좌에서만 호출해야 한다.
 */
export async function inquireOverseasUnfilled(
  environment: KisEnvironment,
  credentials: KisCredentials,
  accessToken: string,
  params: InquireOverseasUnfilledParams,
  deps: InquireOverseasUnfilledDeps = {},
): Promise<InquireOverseasUnfilledResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;

  const url = appendQuery(`${REST_DOMAIN[environment]}/uapi/overseas-stock/v1/trading/inquire-nccs`, {
    CANO: params.account.cano,
    ACNT_PRDT_CD: params.account.acntPrdtCd,
    OVRS_EXCG_CD: params.ovrsExcgCd,
    SORT_SQN: params.sortSqn ?? 'DS',
    CTX_AREA_FK200: params.ctxAreaFk200 ?? '',
    CTX_AREA_NK200: params.ctxAreaNk200 ?? '',
  });

  const res = await fetchImpl(url, {
    method: 'GET',
    headers: buildAuthHeaders(accessToken, credentials, NCCS_TR_ID),
  });
  const body = (await res.json()) as KisRtCdResponse & {
    output: OverseasUnfilledItem[];
    ctx_area_fk200: string;
    ctx_area_nk200: string;
  };
  assertRtCdOk(body);

  return { output: body.output, ctxAreaFk200: body.ctx_area_fk200, ctxAreaNk200: body.ctx_area_nk200 };
}
