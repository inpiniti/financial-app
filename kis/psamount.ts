// 해외주식 매수가능금액조회 [v1_해외주식-014] — docs/koreainvestment/매수가능금액조회.md 그대로.
// 자동 단타의 현금 부족 일시정지(PAUSED) 사전 판정에 쓴다.
import { kisFlowFetch } from './flow';
import { REST_DOMAIN } from './domain';
import { appendQuery, assertRtCdOk, buildAuthHeaders, type KisRtCdResponse } from './http';
import { PSAMOUNT_TR, resolveTrPair, type OverseasExchangeCode } from './trId';
import type { FetchLike, KisAccount, KisCredentials, KisEnvironment } from './types';

export interface InquirePsAmountParams {
  account: KisAccount;
  /** OVRS_EXCG_CD — NASD/NYSE/AMEX 등(문서 표 그대로). */
  ovrsExcgCd: OverseasExchangeCode;
  /** OVRS_ORD_UNPR — 해외주문단가(23.8). 예상 매수가를 넣는다. */
  ordUnpr: number;
  /** ITEM_CD — 종목코드(티커). */
  itemCd: string;
}

/** output — 매수가능금액조회.md 필드명 그대로(전부 문자열). */
export interface PsAmountOutput {
  tr_crcy_cd?: string;
  ord_psbl_frcr_amt?: string;
  sll_ruse_psbl_amt?: string;
  /** 해외주문가능금액 — 한투 앱 "외화" 기준 주문가능금액. 현금 부족 판정에 이 값을 쓴다. */
  ovrs_ord_psbl_amt?: string;
  max_ord_psbl_qty?: string;
  echm_af_ord_psbl_amt?: string;
  echm_af_ord_psbl_qty?: string;
  ord_psbl_qty?: string;
  exrt?: string;
  frcr_ord_psbl_amt1?: string;
  ovrs_max_ord_psbl_qty?: string;
  [key: string]: unknown;
}

export interface InquirePsAmountDeps {
  fetchImpl?: FetchLike;
}

export async function inquirePsAmount(
  environment: KisEnvironment,
  credentials: KisCredentials,
  accessToken: string,
  params: InquirePsAmountParams,
  deps: InquirePsAmountDeps = {},
): Promise<PsAmountOutput> {
  const trId = resolveTrPair(PSAMOUNT_TR, environment);
  const fetchImpl = deps.fetchImpl ?? kisFlowFetch;

  const url = appendQuery(`${REST_DOMAIN[environment]}/uapi/overseas-stock/v1/trading/inquire-psamount`, {
    CANO: params.account.cano,
    ACNT_PRDT_CD: params.account.acntPrdtCd,
    OVRS_EXCG_CD: params.ovrsExcgCd,
    OVRS_ORD_UNPR: String(params.ordUnpr),
    ITEM_CD: params.itemCd,
  });

  const res = await fetchImpl(url, {
    method: 'GET',
    headers: buildAuthHeaders(accessToken, credentials, trId),
  });
  const body = (await res.json()) as KisRtCdResponse & { output?: PsAmountOutput };
  assertRtCdOk(body);
  return body.output ?? {};
}

/** 주문가능 외화(USD) 금액 — ovrs_ord_psbl_amt 숫자 변환(파싱 불가면 null → 호출부가 "판정 불가"로 폴백). */
export function buyableUsdOf(output: PsAmountOutput): number | null {
  const n = Number.parseFloat(output.ovrs_ord_psbl_amt ?? '');
  return Number.isFinite(n) ? n : null;
}
