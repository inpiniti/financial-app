// core/conditional — 조건부 그리드(변곡점+그리드 조합의 "그리드" 몫) 판정기 (순수 TS, 의존 0).
//
// 도메인 문서: docs/domain/변곡점/2026-08-15_변곡점-그리드-조합-plan.md
// 역할 분담(문서 §7): 변곡점=타이밍 신호, **그리드=조건·포지션 판정(이 클래스)**, 매매=체결 실행.
//
// 기존 core/grid(OCO 지정가)와 달리 **주문을 미리 걸지 않는다** — 평단·수량을 들고 있다가
// 변곡점 신호가 왔을 때만 문턱을 판정해 매매 지시를 낸다:
//  · 고점 변곡점(SELL) & 평단 대비 ≥ +sellProfitPct → 전량 매도 (미만이면 홀딩)
//  · 상승 변곡점(BUY)  & 평단 대비 ≤ −buyDropPct   → 최초 진입 수량만큼 매수 (그 외 무시)
// 물타기 수량은 **최초 진입 수량 고정**(2026-08-15 — 배수 물타기는 올인 경험으로 배제)이고
// 횟수 상한은 없다(고정 수량이라 자금 소모가 선형).

/** 포지션(평단·수량) — KIS 잔고 또는 체결 합산에서 온다. */
export interface ConditionalPosition {
  qty: number;
  avgPrice: number;
}

export interface ConditionalGridConfig {
  /** 매도 수익 문턱(소수, 0.02=+2%). 고점 변곡점에서 평단 대비 이 이상 이득일 때만 전량 매도. */
  sellProfitPct: number;
  /** 물타기 낙폭 문턱(소수, 0.03=-3%). 상승 변곡점에서 평단 대비 이 이하로 떨어졌을 때만 매수. */
  buyDropPct: number;
}

export interface ConditionalGridDeps {
  position: ConditionalPosition;
  /** 최초 진입 수량 — 모든 물타기의 고정 수량. */
  entryQty: number;
  config: ConditionalGridConfig;
}

/** 매매 지시 — side와 수량만. 실행(체결까지)은 core/execution 몫이다. */
export type ConditionalDecision = { side: 'sell'; qty: number } | { side: 'buy'; qty: number };

export interface ConditionalGridView {
  qty: number;
  avgPrice: number;
  entryQty: number;
  /** 매도 조건선 = 평단 × (1+sellProfitPct). 이 이상에서 고점 변곡점이 와야 판다. */
  sellLine: number;
  /** 매수 조건선 = 평단 × (1−buyDropPct). 이 이하에서 상승 변곡점이 와야 산다. */
  buyLine: number;
}

export class ConditionalGrid {
  private qty: number;
  private avgPrice: number;
  private readonly entryQty: number;
  private readonly sellProfitPct: number;
  private readonly buyDropPct: number;

  constructor(deps: ConditionalGridDeps) {
    this.qty = deps.position.qty;
    this.avgPrice = deps.position.avgPrice;
    this.entryQty = deps.entryQty;
    this.sellProfitPct = deps.config.sellProfitPct;
    this.buyDropPct = deps.config.buyDropPct;
  }

  get view(): ConditionalGridView {
    return {
      qty: this.qty,
      avgPrice: this.avgPrice,
      entryQty: this.entryQty,
      sellLine: this.sellLine(),
      buyLine: this.buyLine(),
    };
  }

  private sellLine(): number {
    return this.avgPrice * (1 + this.sellProfitPct);
  }

  private buyLine(): number {
    return this.avgPrice * (1 - this.buyDropPct);
  }

  /**
   * 변곡점 신호 1개 판정 — 문턱을 넘겼을 때만 매매 지시를 돌려준다(그 외 null = 계속 지켜본다).
   * 판정만 한다 — 지시를 냈다고 포지션이 바뀌는 게 아니다. 체결 후 setPosition으로 반영한다.
   */
  decide(signal: 'BUY' | 'SELL', price: number): ConditionalDecision | null {
    if (!Number.isFinite(price) || price <= 0 || this.qty <= 0 || !(this.avgPrice > 0)) return null;
    if (signal === 'SELL') {
      // 고점 변곡점 — 수익 문턱(+2%)을 넘긴 천장에서만 전량 청산("시작하자마자 파는" 문제 제거).
      return price >= this.sellLine() ? { side: 'sell', qty: this.qty } : null;
    }
    // 상승 변곡점 — 낙폭 문턱(−3%)에 못 미치면 잔파동 물타기라 무시.
    return price <= this.buyLine() ? { side: 'buy', qty: this.entryQty } : null;
  }

  /**
   * 매매 추격 중 취소선(매매 도메인 문서 §2-1) — 진입 조건의 부정을 그대로 재사용한다.
   * 매매(Execution)에 shouldAbort로 주입한다 — 문턱 %값은 판단 쪽 소유고 매매는 판단하지 않는다.
   */
  shouldAbort(side: 'buy' | 'sell', price: number): boolean {
    if (!Number.isFinite(price) || price <= 0) return false; // 판정 불가 — 추격 유지(가격이 오면 다시 본다).
    return side === 'sell' ? price < this.sellLine() : price > this.buyLine();
  }

  /** 체결/취소 후 포지션 반영 — 정본은 KIS 잔고, 폴백은 체결 합산(호출부가 정해 넘긴다). */
  setPosition(position: ConditionalPosition): void {
    this.qty = position.qty;
    this.avgPrice = position.avgPrice;
  }
}
