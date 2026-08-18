// 추세 청산 규칙 — 추세 도메인이 소유하는 포지션 규칙(autopilot의 PositionRule 계약을 구조적으로 만족).
// 도메인 문서: docs/domain/추세/2026-08-18_추세-그리드-매매-조합-plan.md
//
//  · SELL(분봉5선 꺾임) → 전량 매도. 수익 문턱 없음, 추격 취소선 없음(shouldAbort=false — 무조건 판다).
//  · BUY(보유 중) → null. 물타기 없음(사용자 확정 2026-08-18).
// view는 기존 게이지 필드 계약(sellLine/buyLine)을 평단으로 채워 UI 무변경으로 호환한다.

import type { ConditionalDecision, ConditionalGridView, ConditionalPosition } from '../conditional';

export class TrendExitRule {
  private qty: number;
  private avgPrice: number;
  private readonly entryQty: number;

  constructor(position: ConditionalPosition) {
    this.qty = position.qty;
    this.avgPrice = position.avgPrice;
    this.entryQty = position.qty;
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
