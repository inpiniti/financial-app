// 주문 전략(2026-09-03 ADR 0013, 사용자 확정) — 매수·매도 각각 "어떤 가격에 걸고, 안 붙으면 어떻게 하나"의 단일 정의.
//
//   quote      : 1호가 크로스 — 매수는 매도1호가, 매도는 매수1호가에 걸고, 호가가 바뀌면 그 호가로 정정해 따라간다(빠른 체결 우선).
//   lastChase  : 현재가 지정 — 마지막 체결가에 걸고, 틱마다 현재가가 바뀌면 그 가격으로 정정해 따라간다.
//   lastCancel : 현재가 지정 + 시간 취소 — 마지막 체결가에 걸고 정정하지 않는다. cancelAfterMs 안에 안 붙으면 취소한다
//                (매수는 다음 신호를 기다리고, 매도는 다음 틱 판정이 새 현재가로 다시 낸다).
//
// 값의 정본은 설정(lib/appSettings: buyStrategy·sellStrategy·buyCancelAfterSec·sellCancelAfterSec). 실행 중에도 즉시 반영된다
// (AutoPilot.applySettings — 이미 걸린 주문은 다음 틱부터 새 전략으로 다룬다).

export type OrderPricing = 'quote' | 'lastChase' | 'lastCancel';

export interface OrderStrategy {
  buy: OrderPricing;
  sell: OrderPricing;
  /** lastCancel일 때만 의미 — 0이면 취소 안 함(체결까지 대기). */
  buyCancelAfterMs: number;
  sellCancelAfterMs: number;
}

/** 기본 = 1호가 크로스(2026-09-03 이전의 물타기 모드 매수·모든 모드 매도 동작). */
export const DEFAULT_ORDER_STRATEGY: OrderStrategy = { buy: 'quote', sell: 'quote', buyCancelAfterMs: 0, sellCancelAfterMs: 0 };

export const ORDER_PRICING_LABEL: Record<OrderPricing, string> = {
  quote: '1호가로 빠르게',
  lastChase: '현재가 지정 · 틱마다 정정',
  lastCancel: '현재가 지정 · 시간 지나면 취소',
};

export function isOrderPricing(v: unknown): v is OrderPricing {
  return v === 'quote' || v === 'lastChase' || v === 'lastCancel';
}
