// 해외주식 체결기준현재잔고 [v1_해외주식-008] — docs/koreainvestment/balance.md 그대로.
// 주의(문서): 모의계좌는 output3(외화평가총액 등)만 정상 출력된다.
import { kisFlowFetch } from './flow';
import { REST_DOMAIN } from './domain';
import { appendQuery, assertRtCdOk, buildAuthHeaders, type KisRtCdResponse } from './http';
import { BALANCE_TR, resolveTrPair } from './trId';
import type { FetchLike, KisAccount, KisCredentials, KisEnvironment } from './types';

export interface InquireBalanceParams {
  account: KisAccount;
  /** WCRC_FRCR_DVSN_CD — 01 원화 / 02 외화. 기본값 02(외화). */
  wcrcFrcrDvsnCd?: '01' | '02';
  /** NATN_CD — 000 전체, 840 미국 등. 기본값 000(전체). */
  natnCd?: string;
  /** TR_MKET_CD — NATN_CD에 종속된 거래시장코드. 기본값 00(전체). */
  trMketCd?: string;
  /** INQR_DVSN_CD — 00 전체 / 01 일반해외주식 / 02 미니스탁. 기본값 00. */
  inqrDvsnCd?: '00' | '01' | '02';
}

// output1 배열 원소 — balance.md 필드명 그대로 (evlu_pfls_amt2 등 원문 오탈자·중복도 그대로 보존).
export interface OverseasBalancePosition {
  prdt_name: string;
  cblc_qty13: string;
  thdt_buy_ccld_qty1: string;
  thdt_sll_ccld_qty1: string;
  ccld_qty_smtl1: string;
  ord_psbl_qty1: string;
  frcr_pchs_amt: string;
  frcr_evlu_amt2: string;
  evlu_pfls_amt2: string;
  evlu_pfls_rt1: string;
  pdno: string;
  bass_exrt: string;
  buy_crcy_cd: string;
  ovrs_now_pric1: string;
  avg_unpr3: string;
  tr_mket_name: string;
  natn_kor_name: string;
  ovrs_excg_cd: string;
  [key: string]: unknown;
}

export interface OverseasBalanceSummary {
  pchs_amt_smtl: string;
  evlu_amt_smtl: string;
  evlu_pfls_amt_smtl: string;
  tot_asst_amt: string;
  [key: string]: unknown;
}

export interface InquireBalanceResult {
  output1: OverseasBalancePosition[];
  output2: Array<Record<string, unknown>>;
  output3: OverseasBalanceSummary;
}

export interface InquireBalanceDeps {
  fetchImpl?: FetchLike;
}

export async function inquireOverseasBalance(
  environment: KisEnvironment,
  credentials: KisCredentials,
  accessToken: string,
  params: InquireBalanceParams,
  deps: InquireBalanceDeps = {},
): Promise<InquireBalanceResult> {
  const trId = resolveTrPair(BALANCE_TR, environment);
  const fetchImpl = deps.fetchImpl ?? kisFlowFetch;

  const url = appendQuery(`${REST_DOMAIN[environment]}/uapi/overseas-stock/v1/trading/inquire-present-balance`, {
    CANO: params.account.cano,
    ACNT_PRDT_CD: params.account.acntPrdtCd,
    WCRC_FRCR_DVSN_CD: params.wcrcFrcrDvsnCd ?? '02',
    NATN_CD: params.natnCd ?? '000',
    TR_MKET_CD: params.trMketCd ?? '00',
    INQR_DVSN_CD: params.inqrDvsnCd ?? '00',
  });

  const res = await fetchImpl(url, {
    method: 'GET',
    headers: buildAuthHeaders(accessToken, credentials, trId),
  });
  const body = (await res.json()) as KisRtCdResponse & {
    output1: OverseasBalancePosition[];
    output2: Array<Record<string, unknown>>;
    output3: OverseasBalanceSummary;
  };
  assertRtCdOk(body);

  return { output1: body.output1, output2: body.output2, output3: body.output3 };
}
