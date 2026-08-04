// 해외주식 주문체결내역 [v1_해외주식-007] — docs/koreainvestment/주문체결내역.md 그대로.
// 미체결 카드(CCLD_NCCS_DVSN=02)와 오늘 거래 내역(당일 ORD_STRT_DT=ORD_END_DT) 조회에 쓰인다.
import { REST_DOMAIN } from './domain';
import { appendQuery, assertRtCdOk, buildAuthHeaders, type KisRtCdResponse } from './http';
import { ORDER_HISTORY_TR, resolveTrPair } from './trId';
import { defaultClock, type ClockLike, type FetchLike, type KisAccount, type KisCredentials, type KisEnvironment } from './types';

/** CCLD_NCCS_DVSN — 00 전체 / 01 체결 / 02 미체결. */
export type CcldNccsDvsn = '00' | '01' | '02';
/** SLL_BUY_DVSN — 00 전체 / 01 매도 / 02 매수. */
export type SllBuyDvsn = '00' | '01' | '02';

export interface InquireOrderHistoryParams {
  account: KisAccount;
  /** ORD_STRT_DT — YYYYMMDD (현지시각 기준) */
  ordStrtDt: string;
  /** ORD_END_DT — YYYYMMDD (현지시각 기준) */
  ordEndDt: string;
  /** PDNO — 전종목이면 "%" (모의투자는 "" 전체 조회만 가능) */
  pdno?: string;
  sllBuyDvsn?: SllBuyDvsn;
  ccldNccsDvsn?: CcldNccsDvsn;
  /** OVRS_EXCG_CD — 전종목이면 "%" (모의투자는 "" 전체 조회만 가능) */
  ovrsExcgCd?: string;
  /** SORT_SQN — DS 정순 / AS 역순 (모의투자는 정렬 불가, Default DS) */
  sortSqn?: 'DS' | 'AS';
  ctxAreaNk200?: string;
  ctxAreaFk200?: string;
}

export interface OverseasOrderHistoryItem {
  ord_dt: string;
  ord_gno_brno: string;
  odno: string;
  orgn_odno: string;
  sll_buy_dvsn_cd: string;
  rvse_cncl_dvsn: string;
  pdno: string;
  prdt_name: string;
  ft_ord_qty: string;
  ft_ord_unpr3: string;
  ft_ccld_qty: string;
  ft_ccld_unpr3: string;
  ft_ccld_amt3: string;
  nccs_qty: string;
  prcs_stat_name: string;
  rjct_rson: string;
  ord_tmd: string;
  ovrs_excg_cd: string;
  [key: string]: unknown;
}

export interface InquireOrderHistoryResult {
  output: OverseasOrderHistoryItem[];
  ctxAreaFk200: string;
  ctxAreaNk200: string;
}

export interface InquireOrderHistoryDeps {
  fetchImpl?: FetchLike;
}

export async function inquireOverseasOrderHistory(
  environment: KisEnvironment,
  credentials: KisCredentials,
  accessToken: string,
  params: InquireOrderHistoryParams,
  deps: InquireOrderHistoryDeps = {},
): Promise<InquireOrderHistoryResult> {
  const trId = resolveTrPair(ORDER_HISTORY_TR, environment);
  const fetchImpl = deps.fetchImpl ?? fetch;

  const url = appendQuery(`${REST_DOMAIN[environment]}/uapi/overseas-stock/v1/trading/inquire-ccnl`, {
    CANO: params.account.cano,
    ACNT_PRDT_CD: params.account.acntPrdtCd,
    PDNO: params.pdno ?? '%',
    ORD_STRT_DT: params.ordStrtDt,
    ORD_END_DT: params.ordEndDt,
    SLL_BUY_DVSN: params.sllBuyDvsn ?? '00',
    CCLD_NCCS_DVSN: params.ccldNccsDvsn ?? '00',
    OVRS_EXCG_CD: params.ovrsExcgCd ?? '%',
    SORT_SQN: params.sortSqn ?? 'DS',
    ORD_DT: '',
    ORD_GNO_BRNO: '',
    ODNO: '',
    CTX_AREA_NK200: params.ctxAreaNk200 ?? '',
    CTX_AREA_FK200: params.ctxAreaFk200 ?? '',
  });

  const res = await fetchImpl(url, {
    method: 'GET',
    headers: buildAuthHeaders(accessToken, credentials, trId),
  });
  const body = (await res.json()) as KisRtCdResponse & {
    output: OverseasOrderHistoryItem[];
    ctx_area_fk200: string;
    ctx_area_nk200: string;
  };
  assertRtCdOk(body);

  return { output: body.output, ctxAreaFk200: body.ctx_area_fk200, ctxAreaNk200: body.ctx_area_nk200 };
}

/** 미체결 내역만 조회하는 편의 함수 (CCLD_NCCS_DVSN=02 고정). */
export function inquireUnfilledOrders(
  environment: KisEnvironment,
  credentials: KisCredentials,
  accessToken: string,
  params: Omit<InquireOrderHistoryParams, 'ccldNccsDvsn'>,
  deps: InquireOrderHistoryDeps = {},
): Promise<InquireOrderHistoryResult> {
  return inquireOverseasOrderHistory(environment, credentials, accessToken, { ...params, ccldNccsDvsn: '02' }, deps);
}

function todayYyyymmdd(clock: ClockLike): string {
  const d = new Date(clock.now());
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

/** 당일(ORD_STRT_DT=ORD_END_DT=오늘) 거래 내역 조회 편의 함수. clock을 주입하지 않으면 기본 시계 사용. */
export function inquireTodayOrderHistory(
  environment: KisEnvironment,
  credentials: KisCredentials,
  accessToken: string,
  params: Omit<InquireOrderHistoryParams, 'ordStrtDt' | 'ordEndDt'>,
  deps: InquireOrderHistoryDeps & { clock?: ClockLike } = {},
): Promise<InquireOrderHistoryResult> {
  const clock = deps.clock ?? defaultClock;
  const today = todayYyyymmdd(clock);
  return inquireOverseasOrderHistory(
    environment,
    credentials,
    accessToken,
    { ...params, ordStrtDt: today, ordEndDt: today },
    deps,
  );
}
