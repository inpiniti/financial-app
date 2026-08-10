// 해외주식 주문 [v1_해외주식-001] — docs/koreainvestment/주문.md 그대로 (지정가 기준).
// 안전장치: TR ID가 코드에서 해석되지 않으면 fetch 호출 전에 throw한다 (kis-openapi 철칙 2).
import { kisFlowFetch } from './flow';
import { REST_DOMAIN } from './domain';
import { assertRtCdOk, buildAuthHeaders, type KisRtCdResponse } from './http';
import {
  resolveDaytimeOrderTrId,
  resolveOrderTrId,
  type OrderSide,
  type OverseasExchangeCode,
} from './trId';
import type { FetchLike, KisAccount, KisCredentials, KisEnvironment } from './types';

export interface PlaceOverseasOrderParams {
  account: KisAccount;
  ovrsExcgCd: OverseasExchangeCode;
  side: OrderSide;
  /** PDNO — 종목코드 */
  pdno: string;
  /** ORD_QTY — 주문수량 */
  orderQty: number;
  /** OVRS_ORD_UNPR — 1주당 지정가 단가. 시장가 계열은 v1 범위 밖(지정가 "00" 고정)이라 0 금지. */
  orderUnitPrice: number;
  /** ORD_DVSN — 미지정 시 "00"(지정가). 문서상 모의투자는 매수/매도 모두 지정가만 허용. */
  ordDvsn?: string;
  /**
   * 미국 주간거래 주문(주간주문.txt, TTTS6036U/6037U · /trading/daytime-order) — 미국 실전 전용,
   * 지정가만 가능. 문서 Body에 SLL_TYPE이 없어 매도라도 넣지 않는다.
   */
  daytime?: boolean;
}

export interface PlaceOverseasOrderResult {
  krxFwdgOrdOrgno: string;
  odno: string;
  ordTmd: string;
}

export interface PlaceOrderDeps {
  fetchImpl?: FetchLike;
}

/**
 * 주문가 절사 방향. 공격적 지정가(반대편 호가 크로스)를 보장하려면 side마다 방향이 다르다.
 *  · 'floor' — 매도용. 절사가 매수1호가보다 **위로** 올라가지 않게 한다.
 *  · 'ceil'  — 매수용. 절사가 매도1호가보다 **아래로** 내려가지 않게 한다.
 *  · 'nearest' — 방향 무관(취소 등 단가가 의미 없는 경로의 하위호환 기본값).
 */
export type PriceRounding = 'floor' | 'ceil' | 'nearest';

/** $1 이상은 소수 2자리(×100), $1 미만은 소수 4자리(×10000). */
function priceScale(price: number): number {
  return price >= 1 ? 100 : 10_000;
}

/**
 * KIS 미국 주식 주문가 자릿수 규칙에 맞춰 **숫자로** 절사한다.
 * $1 이상은 소수점 2자리, $1 미만은 소수점 4자리까지만 허용된다
 * (실계좌 실측 2026-07-30: 리샘플 평균가를 그대로 보내 "주문 가격을 확인하시기 바랍니다.
 * 1$ 이상 소수점 2자리까지만 가능합니다" 거절 발생).
 *
 * 방향이 중요한 이유: 예전에는 반올림 고정이었고 "지정가라 ±0.005 오차는 미체결 취소→재대기 루프가
 * 흡수한다"는 근거를 달았지만, **그 루프는 이미 제거됐다**(무한 대기 전환). 반올림이 매도가를 위로
 * 올리면 매수1호가를 못 크로스해 영영 안 붙는다 → 매도는 floor, 매수는 ceil로 방향을 고정한다.
 *
 * 발주가 비교(정정 트리거)가 "실제 접수될 값" 기준이 되도록 문자열이 아니라 숫자를 반환한다.
 */
export function roundOverseasOrderPrice(price: number, rounding: PriceRounding = 'nearest'): number {
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`[kis/order] 주문가가 유효하지 않습니다: ${price}`);
  }
  const scale = priceScale(price);
  const scaled = price * scale;
  // 부동소수 보정 — 12.35*100 === 1234.9999999999998 이라 보정 없이 floor하면 12.34로 한 틱 밀린다.
  const EPSILON = 1e-9;
  const ticks =
    rounding === 'floor'
      ? Math.floor(scaled + EPSILON)
      : rounding === 'ceil'
        ? Math.ceil(scaled - EPSILON)
        : Math.round(scaled);
  if (ticks <= 0) {
    throw new Error(`[kis/order] 절사 후 주문가가 0 이하가 됩니다: ${price} (${rounding})`);
  }
  return ticks / scale;
}

/**
 * roundOverseasOrderPrice 결과를 KIS 요청 문자열(고정 소수 자릿수)로 만든다.
 * 자릿수는 **절사 결과** 기준으로 고른다 — 0.99999를 ceil하면 1.0000이 되는데,
 * 원본($1 미만) 기준으로 4자리를 쓰면 "1$ 이상 소수점 2자리" 규칙에 걸린다.
 */
export function formatOverseasOrderPrice(price: number, rounding: PriceRounding = 'nearest'): string {
  const rounded = roundOverseasOrderPrice(price, rounding);
  return priceScale(rounded) === 100 ? rounded.toFixed(2) : rounded.toFixed(4);
}

/** side별 절사 방향 — 매도는 내림, 매수는 올림(공격적 지정가 크로스 보장). */
export function roundingForSide(side: OrderSide): PriceRounding {
  return side === 'sell' ? 'floor' : 'ceil';
}

export async function placeOverseasOrder(
  environment: KisEnvironment,
  credentials: KisCredentials,
  accessToken: string,
  params: PlaceOverseasOrderParams,
  deps: PlaceOrderDeps = {},
): Promise<PlaceOverseasOrderResult> {
  const trId = params.daytime
    ? resolveDaytimeOrderTrId(params.ovrsExcgCd, params.side, environment)
    : resolveOrderTrId(params.ovrsExcgCd, params.side, environment);
  if (!trId) {
    throw new Error(
      `[kis/order] TR ID를 해석하지 못했습니다 (거래소=${params.ovrsExcgCd}, side=${params.side}, environment=${environment}` +
        `${params.daytime ? ', 주간거래' : ''}). ` +
        '주문 호출을 차단합니다 — docs/koreainvestment/주문.md·주간주문.txt TR ID 표를 확인하세요(주간거래는 미국·실전 전용).',
    );
  }

  const fetchImpl = deps.fetchImpl ?? kisFlowFetch;
  const body: Record<string, string> = {
    CANO: params.account.cano,
    ACNT_PRDT_CD: params.account.acntPrdtCd,
    OVRS_EXCG_CD: params.ovrsExcgCd,
    PDNO: params.pdno,
    ORD_QTY: String(params.orderQty),
    // 매도는 내림·매수는 올림 — 절사가 반대편 호가를 못 넘어가 공격적 지정가가 무력화되는 걸 막는다.
    OVRS_ORD_UNPR: formatOverseasOrderPrice(params.orderUnitPrice, roundingForSide(params.side)),
    ORD_SVR_DVSN_CD: '0',
    ORD_DVSN: params.ordDvsn ?? '00',
  };
  // SLL_TYPE — 문서: "제거 : 매수 / 00 : 매도" → 매수는 필드 자체를 생략한다.
  // 주간주문 문서 Body에는 SLL_TYPE 자체가 없다 — 주간거래는 매도라도 넣지 않는다.
  if (params.side === 'sell' && !params.daytime) {
    body.SLL_TYPE = '00';
  }

  const path = params.daytime
    ? '/uapi/overseas-stock/v1/trading/daytime-order'
    : '/uapi/overseas-stock/v1/trading/order';
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
