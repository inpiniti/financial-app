// 매도 리프라이스 정책 — "지금 정정을 낼 것인가, 낸다면 얼마에 몇 주를" 판정하는 순수 함수.
// 플랫폼·네트워크·시각을 모른다(core/detector·core/resample과 같은 격). 실행은 features/scalper의
// OrderPortAdapter.repriceSell()이 담당한다.
//
// 배경(2026-08-04): 매도 지정가를 한 번 내고 무한 대기하는 구조라, 가격이 흘러내리면 그 지정가가
// 영영 안 붙어 매도가 씹혔다. 매수1호가가 바뀔 때마다 그 가격으로 정정해 따라간다.
//
// ★ 이 모듈에는 "경과 시간"이 입력으로 없다 — 의도적이다.
//   사용자 확정 정책은 "매수1호가만 추종, 시간이 지나도 더 낮게 내리지 않는다"이다.
//   시간 인자가 없으면 에스컬레이션(시간 경과에 따른 가격 양보)을 **타입 수준에서 짤 수 없다**.
//   나중에 그 정책을 도입하려면 시그니처를 바꿔야 하고, 그 순간 리뷰에 걸린다.

/** 정정을 보류하는 이유 — 진단·테스트용. */
export type RepriceHoldReason =
  /** 리프라이스가 자진 중단된 상태(연속 실패 상한 초과). */
  | 'disabled'
  /** 취소가 얽힌 주문 — 취소와 정정이 겹치는 순간을 원천 차단한다. */
  | 'cancel-involved'
  /** 직전 정정이 아직 왕복 중. */
  | 'in-flight'
  /** 접수된 주문이 없다. */
  | 'no-order'
  /** 남은 미체결 잔량이 없다(전량 체결). */
  | 'no-remaining'
  /** 호가가 낡아 발주가가 폴백(마지막 체결가)인 상태 — 확실할 때만 정정한다. */
  | 'stale-quote'
  /** 유효한 매수1호가가 없다. */
  | 'no-quote'
  /** 최신 매수1호가가 이미 접수가와 같다 — 호출을 아낀다(유량 절감의 핵심). */
  | 'same-price';

export type RepriceDecision =
  | { action: 'hold'; reason: RepriceHoldReason }
  | { action: 'amend'; price: number; qty: number };

export interface RepriceInput {
  /**
   * 지금 KIS에 접수돼 있는 매도 주문의 지정가. 주문이 없으면 0.
   * ⚠ 반드시 **절사 후(실제 접수된) 값**이어야 한다 — raw 호가와 비교하면 매초 "다르다"가 나와
   * 무의미한 정정이 폭주하고 대부분 거절된다.
   */
  currentPrice: number;
  /** 최신 매수1호가. 절사 후 값. 0이면 유효 호가 없음. */
  bid1: number;
  /** 호가가 신선한가(어댑터의 quoteStaleMs 이내). 낡았으면 정정하지 않는다. */
  quoteFresh: boolean;
  /** 미체결 잔량 = 원 주문수량 - 누적 체결수량. 정정 주문의 ORD_QTY가 된다. */
  remainingQty: number;
  /** 직전 정정 요청이 아직 왕복 중인가. */
  amendInFlight: boolean;
  /** 이 주문에 취소가 얽혀 있는가. */
  cancelInvolved: boolean;
  /** 연속 실패로 리프라이스를 자진 중단했는가. */
  disabled: boolean;
}

const hold = (reason: RepriceHoldReason): RepriceDecision => ({ action: 'hold', reason });

/**
 * 매도 정정 판정. 순수 — 같은 입력이면 항상 같은 출력이다.
 *
 * 정정하는 조건은 하나뿐이다: **살아있는 주문이 있고, 신선한 매수1호가가 접수가와 다를 때.**
 * 그 외에는 전부 보류하며, 보류는 안전하다 — 원주문이 그대로 살아 무한 대기가 이어질 뿐이다.
 */
export function decideReprice(input: RepriceInput): RepriceDecision {
  return decideRepriceCore(input);
}

/**
 * 매수 정정 판정(2026-08-28, 물타기 시험 모드) — 매도의 거울: **매도1호가만 추종**하고 시간 양보는 없다(ADR 0003 대칭).
 * "매수를 맘먹었으면 체결돼야 한다"(사용자) — 가격이 위로 달아나면 매도1호가로 정정해 따라간다.
 * bid1 자리에 매도1호가(ask1, 절사 후)를 넣는다. 보류 규칙은 매도와 같다.
 */
export function decideBuyReprice(input: Omit<RepriceInput, 'bid1'> & { ask1: number }): RepriceDecision {
  const { ask1, ...rest } = input;
  return decideRepriceCore({ ...rest, bid1: ask1 });
}

function decideRepriceCore(input: RepriceInput): RepriceDecision {
  if (input.disabled) return hold('disabled');
  if (input.cancelInvolved) return hold('cancel-involved');
  if (input.amendInFlight) return hold('in-flight');
  if (!(input.currentPrice > 0)) return hold('no-order');
  if (!(input.remainingQty > 0)) return hold('no-remaining');
  // 폴백(마지막 체결가) 발주 중에는 정정하지 않는다. 최초 발주는 폴백이 필요하지만, 정정은
  // 이미 살아있는 주문을 더 낫게 만드는 선택적 행위라 확실할 때만 한다. 호가가 돌아오면 자동 재개된다.
  if (!input.quoteFresh) return hold('stale-quote');
  if (!(input.bid1 > 0)) return hold('no-quote');
  if (input.bid1 === input.currentPrice) return hold('same-price');
  return { action: 'amend', price: input.bid1, qty: input.remainingQty };
}
