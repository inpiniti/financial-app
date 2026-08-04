// 해외주식 기간손익 [v1_해외주식-032] — docs/koreainvestment/기간손익.md 그대로. TR TTTS3039R(실전 전용).
// 문서: "모의 Domain: 모의투자 미지원" — priceDetail.ts/ranking.ts와 동일 판단으로 environment 파라미터 없이
// 항상 REST_DOMAIN.live로 호출한다.
import { REST_DOMAIN } from './domain';
import { appendQuery, assertRtCdOk, buildAuthHeaders, type KisRtCdResponse } from './http';
import type { FetchLike, KisAccount, KisCredentials } from './types';

const PERIOD_PROFIT_TR_ID = 'TTTS3039R';

export interface InquirePeriodProfitParams {
  account: KisAccount;
  /** INQR_STRT_DT — YYYYMMDD */
  startDt: string;
  /** INQR_END_DT — YYYYMMDD */
  endDt: string;
  /** OVRS_EXCG_CD — 공란(전체) 기본. NASD 미국 / SEHK 홍콩 / SHAA 중국 / TKSE 일본 / HASE 베트남(문서 Query Parameter 표). */
  ovrsExcgCd?: string;
  /** NATN_CD — 공란(전체, 문서 Default) 기본. */
  natnCd?: string;
  /** CRCY_CD — 공란(전체) 기본. USD/HKD/CNY/JPY/VND(문서 표). */
  crcyCd?: string;
  /** PDNO — 공란(전체) 기본. */
  pdno?: string;
  /**
   * WCRC_FRCR_DVSN_CD — 01 외화 / 02 원화.
   * 기본값 02(원화): 문서 output2 각 필드 주석에 "WCRC_FRCR_DVSN_CD가 01(외화)이고 OVRS_EXCG_CD가 공란(전체)인
   * 경우 출력값 무시"라고 명시돼 있다. 이 모듈의 주 용도(조회 탭 손익 세그먼트, 거래소 전체 합계)에서는
   * OVRS_EXCG_CD를 공란(전체)으로 두는 경우가 기본이므로, 합계가 항상 유효하도록 02(원화)를 기본값으로 둔다.
   */
  wcrcFrcrDvsnCd?: '01' | '02';
  /** CTX_AREA_FK200 — 연속조회검색조건200. 문서상 Required(Y)이지만 첫 페이지 조회 시 공란으로 보낸다. */
  ctxAreaFk200?: string;
  /** CTX_AREA_NK200 — 연속조회키200. 문서상 Required(Y)이지만 첫 페이지 조회 시 공란으로 보낸다. */
  ctxAreaNk200?: string;
}

/** output1 원본 행 — 기간손익.md Body 표 그대로(필드명 보존). */
export interface OverseasPeriodProfitRawItem {
  trad_day: string;
  ovrs_pdno: string;
  ovrs_item_name: string;
  slcl_qty: string;
  pchs_avg_pric: string;
  frcr_pchs_amt1: string;
  avg_sll_unpr: string;
  frcr_sll_amt_smtl1: string;
  stck_sll_tlex: string;
  ovrs_rlzt_pfls_amt: string;
  pftrt: string;
  exrt: string;
  ovrs_excg_cd: string;
  frst_bltn_exrt: string;
  [key: string]: unknown;
}

/** output2 원본 합계 — 기간손익.md Body 표 그대로(필드명 보존). */
export interface OverseasPeriodProfitRawSummary {
  stck_sll_amt_smtl: string;
  stck_buy_amt_smtl: string;
  smtl_fee1: string;
  excc_dfrm_amt: string;
  ovrs_rlzt_pfls_tot_amt: string;
  tot_pftrt: string;
  bass_dt: string;
  exrt: string;
  [key: string]: unknown;
}

/** UI 표시용으로 정리한 일별/종목별 손익 1건. */
export interface PeriodProfitItem {
  /** 매매일 (trad_day, YYYYMMDD) */
  tradeDt: string;
  /** 해외상품번호 (ovrs_pdno) */
  pdno: string;
  /** 해외종목명 (ovrs_item_name) */
  name: string;
  /** 매도청산수량 (slcl_qty) */
  sellQty: number;
  /** 매입평균가격 (pchs_avg_pric) */
  avgBuyPrice: number;
  /** 외화매입금액1 (frcr_pchs_amt1) */
  buyAmount: number;
  /** 평균매도단가 (avg_sll_unpr) */
  avgSellPrice: number;
  /** 외화매도금액합계1 (frcr_sll_amt_smtl1) */
  sellAmount: number;
  /** 주식매도제비용 (stck_sll_tlex) */
  sellFee: number;
  /** 해외실현손익금액 (ovrs_rlzt_pfls_amt) */
  realizedPnl: number;
  /** 수익률 (pftrt) */
  pnlRate: number;
  /** 환율 (exrt) */
  exchangeRate: number;
  /** 해외거래소코드 (ovrs_excg_cd) */
  exchangeCode: string;
  /** 최초고시환율 (frst_bltn_exrt) */
  firstExrt: number;
}

/** UI 표시용으로 정리한 output2 합계. */
export interface PeriodProfitSummary {
  /** 주식매도금액합계 (stck_sll_amt_smtl) */
  totalSellAmount: number;
  /** 주식매수금액합계 (stck_buy_amt_smtl) */
  totalBuyAmount: number;
  /** 합계수수료1 (smtl_fee1) */
  totalFee: number;
  /** 정산지급금액 (excc_dfrm_amt) */
  settlementAmount: number;
  /** 해외실현손익총금액 (ovrs_rlzt_pfls_tot_amt) */
  totalRealizedPnl: number;
  /** 총수익률 (tot_pftrt) */
  totalPnlRate: number;
  /** 기준일자 (bass_dt) */
  baseDt: string;
  /** 환율 (exrt) */
  exchangeRate: number;
}

export interface InquirePeriodProfitResult {
  items: PeriodProfitItem[];
  summary: PeriodProfitSummary;
}

export interface InquirePeriodProfitDeps {
  fetchImpl?: FetchLike;
}

function toNum(v: string | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function mapItem(row: OverseasPeriodProfitRawItem): PeriodProfitItem {
  return {
    tradeDt: row.trad_day,
    pdno: row.ovrs_pdno,
    name: row.ovrs_item_name,
    sellQty: toNum(row.slcl_qty),
    avgBuyPrice: toNum(row.pchs_avg_pric),
    buyAmount: toNum(row.frcr_pchs_amt1),
    avgSellPrice: toNum(row.avg_sll_unpr),
    sellAmount: toNum(row.frcr_sll_amt_smtl1),
    sellFee: toNum(row.stck_sll_tlex),
    realizedPnl: toNum(row.ovrs_rlzt_pfls_amt),
    pnlRate: toNum(row.pftrt),
    exchangeRate: toNum(row.exrt),
    exchangeCode: row.ovrs_excg_cd,
    firstExrt: toNum(row.frst_bltn_exrt),
  };
}

function mapSummary(row: OverseasPeriodProfitRawSummary | undefined): PeriodProfitSummary {
  const safe = row ?? ({} as OverseasPeriodProfitRawSummary);
  return {
    totalSellAmount: toNum(safe.stck_sll_amt_smtl),
    totalBuyAmount: toNum(safe.stck_buy_amt_smtl),
    totalFee: toNum(safe.smtl_fee1),
    settlementAmount: toNum(safe.excc_dfrm_amt),
    totalRealizedPnl: toNum(safe.ovrs_rlzt_pfls_tot_amt),
    totalPnlRate: toNum(safe.tot_pftrt),
    baseDt: safe.bass_dt ?? '',
    exchangeRate: toNum(safe.exrt),
  };
}

/**
 * 해외주식 기간손익 조회. 연속조회 파라미터(CTX_AREA_FK200/NK200)는 있으면 그대로 실어 보내지만,
 * 다음 페이지를 자동으로 순회하지는 않는다(첫 페이지만 사용 — 호출부가 필요하면 반환된 값으로 재호출).
 */
export async function inquireOverseasPeriodProfit(
  credentials: KisCredentials,
  accessToken: string,
  params: InquirePeriodProfitParams,
  deps: InquirePeriodProfitDeps = {},
): Promise<InquirePeriodProfitResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;

  const url = appendQuery(`${REST_DOMAIN.live}/uapi/overseas-stock/v1/trading/inquire-period-profit`, {
    CANO: params.account.cano,
    ACNT_PRDT_CD: params.account.acntPrdtCd,
    OVRS_EXCG_CD: params.ovrsExcgCd ?? '',
    NATN_CD: params.natnCd ?? '',
    CRCY_CD: params.crcyCd ?? '',
    PDNO: params.pdno ?? '',
    INQR_STRT_DT: params.startDt,
    INQR_END_DT: params.endDt,
    WCRC_FRCR_DVSN_CD: params.wcrcFrcrDvsnCd ?? '02',
    CTX_AREA_FK200: params.ctxAreaFk200 ?? '',
    CTX_AREA_NK200: params.ctxAreaNk200 ?? '',
  });

  const res = await fetchImpl(url, {
    method: 'GET',
    headers: buildAuthHeaders(accessToken, credentials, PERIOD_PROFIT_TR_ID),
  });
  const body = (await res.json()) as KisRtCdResponse & {
    output1: OverseasPeriodProfitRawItem[];
    output2: OverseasPeriodProfitRawSummary;
  };
  assertRtCdOk(body);

  return {
    items: (body.output1 ?? []).map(mapItem),
    summary: mapSummary(body.output2),
  };
}
