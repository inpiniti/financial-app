// 추세 청산 규칙 — 추세 도메인이 소유하는 포지션 규칙(autopilot의 PositionRule 계약을 구조적으로 만족).
// 도메인 문서: docs/domain/추세/2026-08-18_추세-그리드-매매-조합-plan.md
//
//  · SELL(분봉5선 꺾임) → 전량 매도. 수익 문턱 없음, 추격 취소선 없음(shouldAbort=false — 무조건 판다).
//  · BUY(보유 중) → null. 물타기 없음(사용자 확정 2026-08-18).
//  · 손절선(stopLossPct, 2026-08-18 저녁 확정): 현재가 ≤ 평단×(1−p)면 봉 마감을 기다리지 않고 즉시 전량 매도(onPrice).
//    ma5 청산은 봉 마감 판정이라 봉 안 급락(EJH −13%/3분, 프리마켓 개장 직후)을 못 받는다 — 그 바닥.
//    ma5 청산이 평소 훨씬 먼저 걸리므로 거의 안 울리는 보험이다. 0/미지정이면 끔.
// view는 기존 게이지 필드 계약(sellLine/buyLine)을 평단으로 채워 UI 무변경으로 호환한다.

import type { ConditionalDecision, ConditionalGridView, ConditionalPosition } from '../conditional';

export interface TrendExitRuleOptions {
  /** 손절 낙폭(소수, 0.05=−5%). 0/미지정이면 손절선 없음. */
  stopLossPct?: number;
}

export class TrendExitRule {
  private qty: number;
  private avgPrice: number;
  private readonly entryQty: number;
  private readonly stopLossPct: number;

  constructor(position: ConditionalPosition, options: TrendExitRuleOptions = {}) {
    this.qty = position.qty;
    this.avgPrice = position.avgPrice;
    this.entryQty = position.qty;
    const p = options.stopLossPct ?? 0;
    this.stopLossPct = Number.isFinite(p) && p > 0 ? p : 0;
  }

  /** 손절선 가격(평단×(1−p)) — 손절선이 없으면 null. */
  get stopLossPrice(): number | null {
    return this.stopLossPct > 0 ? this.avgPrice * (1 - this.stopLossPct) : null;
  }

  /**
   * 틱(현재가) 판정 — 손절선 이하면 전량 매도. 봉 마감과 무관하게 호출부가 현재가마다 부른다.
   * 손절선이 없거나 미달이면 null.
   */
  onPrice(price: number): ConditionalDecision | null {
    if (!Number.isFinite(price) || price <= 0 || this.qty <= 0) return null;
    const stop = this.stopLossPrice;
    if (stop === null || price > stop) return null;
    return { side: 'sell', qty: this.qty };
  }

  get view(): ConditionalGridView {
    return {
      qty: this.qty,
      avgPrice: this.avgPrice,
      entryQty: this.entryQty,
      sellLine: this.avgPrice,
      buyLine: this.avgPrice,
    };
  }

  decide(signal: 'BUY' | 'SELL', price: number): ConditionalDecision | null {
    if (!Number.isFinite(price) || price <= 0 || this.qty <= 0) return null;
    if (signal === 'SELL') return { side: 'sell', qty: this.qty };
    return null;
  }

  /** 취소선 없음 — 어떤 가격이든 추격을 이어간다. */
  shouldAbort(_side: 'buy' | 'sell', _price: number): boolean {
    return false;
  }

  setPosition(position: ConditionalPosition): void {
    this.qty = position.qty;
    this.avgPrice = position.avgPrice;
  }
}
