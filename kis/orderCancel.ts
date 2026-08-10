// 해외주식 정정취소주문 [v1_해외주식-003] — docs/koreainvestment/정정취소주문.md 그대로.
// 미체결 취소 정책용으로 취소(RVSE_CNCL_DVSN_CD=02)를 기본 동선으로 삼되, 정정(01)도 지원한다.
// 상해/심천/베트남은 문서상 취소만 지원 — 정정 요청 시 fetch 전에 차단한다.
import { kisFlowFetch } from './flow';
import { REST_DOMAIN } from './domain';
import { assertRtCdOk, buildAuthHeaders, type KisRtCdResponse } from './http';
import { formatOverseasOrderPrice, roundingForSide } from './order';
import {
  isAmendSupported,
  resolveCancelTrId,
  resolveDaytimeCancelTrId,
  type OrderSide,
  type OverseasExchangeCode,
} from './trId';
import type { FetchLike, KisAccount, KisCredentials, KisEnvironment } from './types';

export type RvseCnclAction = 'amend' | 'cancel';

/**
 * KIS 주문번호(ODNO)를 10자리 0패딩으로 정규화한다.
 * 문서상 ODNO/ORGN_ODNO Length는 10이고 실제 주문 응답은 "0031370465"처럼 앞자리 0을 포함한 10자리다.
 * 우리 흐름 어딘가에서 앞자리 0이 잘려 전달되면(예: 숫자 파싱) KIS가 원주문을 못 찾아 취소가 거절되고,
 * 미체결 목록 대조(odno 매칭)도 어긋나 체결 판정이 "목록 부재"로 오판된다(실계좌 실측).
 * 취소 발주와 미체결 대조 양쪽에서 이 헬퍼로 일관되게 정규화한다.
 */
export function normalizeOdno(odno: string): string {
  return String(odno ?? '').trim().padStart(10, '0');
}

export interface CancelOrAmendOrderParams {
  account: KisAccount;
  ovrsExcgCd: OverseasExchangeCode;
  /** PDNO — 종목코드 */
  pdno: string;
  /** ORGN_ODNO — 정정/취소 대상 원주문번호 (주문 API 또는 미체결내역 API의 ODNO) */
  orgnOdno: string;
  action: RvseCnclAction;
  /** ORD_QTY — 주문수량 */
  orderQty: number;
  /** OVRS_ORD_UNPR — 취소 시 문서상 "0" 입력. 정정 시에는 새 단가. */
  orderUnitPrice?: number;
  /**
   * 정정 시 단가 절사 방향 결정용(매도 내림·매수 올림). 취소에는 무의미하다.
   * 미지정 시 'nearest'(하위호환) — 정정에서는 반드시 넘겨야 공격적 지정가가 보장된다.
   */
  side?: OrderSide;
  /**
   * 미국 주간거래 주문의 정정취소(주간정정취소.txt, TTTS6038U · /trading/daytime-order-rvsecncl) —
   * 미국 실전 전용. **원주문이 주간주문(TTTS6036U/6037U)으로 나갔으면 반드시 이 경로로 취소해야 한다.**
   */
  daytime?: boolean;
}

export interface CancelOrAmendOrderResult {
  krxFwdgOrdOrgno: string;
  odno: string;
  ordTmd: string;
}

export interface CancelOrderDeps {
  fetchImpl?: FetchLike;
}

export async function cancelOrAmendOverseasOrder(
  environment: KisEnvironment,
  credentials: KisCredentials,
  accessToken: string,
  params: CancelOrAmendOrderParams,
  deps: CancelOrderDeps = {},
): Promise<CancelOrAmendOrderResult> {
  const trId = params.daytime
    ? resolveDaytimeCancelTrId(params.ovrsExcgCd, environment)
    : resolveCancelTrId(params.ovrsExcgCd, environment);
  if (!trId) {
    throw new Error(
      `[kis/orderCancel] TR ID를 해석하지 못했습니다 (거래소=${params.ovrsExcgCd}, environment=${environment}` +
        `${params.daytime ? ', 주간거래' : ''}). ` +
        '정정취소 호출을 차단합니다 — docs/koreainvestment/정정취소주문.md·주간정정취소.txt TR ID 표를 확인하세요(주간거래는 미국·실전 전용).',
    );
  }
  if (params.action === 'amend' && !isAmendSupported(params.ovrsExcgCd)) {
    throw new Error(
      `[kis/orderCancel] 거래소 ${params.ovrsExcgCd}는 문서상 정정을 지원하지 않습니다(취소만 가능). 호출을 차단합니다.`,
    );
  }

  const fetchImpl = deps.fetchImpl ?? kisFlowFetch;
  const body: Record<string, string> = {
    CANO: params.account.cano,
    ACNT_PRDT_CD: params.account.acntPrdtCd,
    OVRS_EXCG_CD: params.ovrsExcgCd,
    PDNO: params.pdno,
    // 원주문번호는 반드시 10자리 0패딩으로 — 앞자리 0이 잘리면 KIS가 원주문을 못 찾아 취소가 거절된다(실측).
    ORGN_ODNO: normalizeOdno(params.orgnOdno),
    RVSE_CNCL_DVSN_CD: params.action === 'amend' ? '01' : '02',
    ORD_QTY: String(params.orderQty),
    // 취소주문 시, 문서 규정대로 "0" 입력. 정정은 side별 절사(매도 내림·매수 올림)로 크로스를 보장한다.
    OVRS_ORD_UNPR:
      params.action === 'cancel' || !params.orderUnitPrice
        ? '0'
        : formatOverseasOrderPrice(
            params.orderUnitPrice,
            params.side ? roundingForSide(params.side) : 'nearest',
          ),
  };
  // 주간정정취소.txt Body — 정규장 정정취소와 달리 CTAC_TLNO/MGCO_APTM_ODNO/ORD_SVR_DVSN_CD가
  // Required(Y)다. 문서 규정대로 공백("")·"0"을 채워 보낸다.
  if (params.daytime) {
    body.CTAC_TLNO = '';
    body.MGCO_APTM_ODNO = '';
    body.ORD_SVR_DVSN_CD = '0';
  }

  const path = params.daytime
    ? '/uapi/overseas-stock/v1/trading/daytime-order-rvsecncl'
    : '/uapi/overseas-stock/v1/trading/order-rvsecncl';
  const res = await fetchImpl(`${REST_DOMAIN[environment]}${path}`, {
    method: 'POST',
    headers: buildAuthHeaders(accessToken, credentials, trId),
    body: JSON.stringify(body),
  });
  const responseBody = (await res.json()) as KisRtCdResponse & {
    output: { KRX_FWDG_ORD_ORGNO: string; ODNO: string; ORD_TMD: string };
  };
  assertRtCdOk(responseBody);

  return {
    krxFwdgOrdOrgno: responseBody.output.KRX_FWDG_ORD_ORGNO,
    odno: responseBody.output.ODNO,
    ordTmd: responseBody.output.ORD_TMD,
  };
}

/** 미체결 취소 전용 편의 함수 (정책상 정정취소주문의 주 사용처). */
export function cancelOverseasOrder(
  environment: KisEnvironment,
  credentials: KisCredentials,
  accessToken: string,
  params: Omit<CancelOrAmendOrderParams, 'action' | 'orderUnitPrice'>,
  deps: CancelOrderDeps = {},
): Promise<CancelOrAmendOrderResult> {
  return cancelOrAmendOverseasOrder(environment, credentials, accessToken, { ...params, action: 'cancel' }, deps);
}
