// core/grid — 매도 관리 ±w OCO 지정가 그리드 상태기계 (순수 TS, 실시간/KIS 의존 없음).
//
// 변곡점 진입으로 포지션(보유수량 N·평단가 P)이 생기면, 그 뒤 관리를 이 그리드가 인계한다.
//  · 매수 지정가: N×buyMultiplier 주 @ P×(1−w)  (평단 −10%, 현재가 아래 → 정상 지정가 대기)
//  · 매도 지정가: N 주            @ P×(1+w)      (평단 +10%, 현재가 위   → 정상 지정가 대기)
//  · 한쪽 체결 → 반대편 실제 취소(OCO):
//      매도(+w) 체결 → 전량 정리(SOLD) → 오토파일럿 SCANNING 복귀(변곡점 재개)
//      매수(−w) 체결 → 잔고 재조회(수량↑·평단↓) → 두 주문 재설정(REBRACKET→ARMED)
//
// 주문 발주/취소/체결확인/잔고조회는 전부 포트로 주입받아 vitest로 전 분기를 재생 검증한다
// (RunCycle의 OrderPort 패턴과 같은 원칙 — 코어는 결정적).

/** 시각 주입 — core.Clock / kis.ClockLike와 동일 계약. */
export interface ClockLike {
  now(): number;
}

/** KIS 잔고에서 읽은 포지션(해당 티커). */
export interface GridPosition {
  /** 보유수량 N (cblc_qty13). */
  qty: number;
  /** 평단가 P (avg_unpr3). */
  avgPrice: number;
}

/** 그리드가 발주한 주문 1건의 체결 스냅샷(odno 기준) — 브로커 fetchFills와 같은 모양. */
export interface GridOrderFill {
  odno: string;
  orderQty: number;
  filledQty: number;
  /** 평균 체결단가 — 미확정이면 null(전량체결을 "목록 부재"로 추론한 경우). */
  filledPrice: number | null;
}

/**
 * 그리드가 의존하는 주문 게이트웨이 — 정확 지정가 발주 전용.
 * 실서비스는 ScalperBroker(placeOrder/cancelOrder/fetchFills) + 잔고조회로 구현하고,
 * 테스트는 가짜 심으로 구현한다.
 */
export interface GridOrderPort {
  /** 정확 지정가 발주(ORD_DVSN=00, OVRS_ORD_UNPR=price) → 주문번호(odno). */
  placeOrder(side: 'buy' | 'sell', qty: number, price: number): Promise<{ odno: string }>;
  /** 주문 취소(OCO). KIS가 거절하면 throw. */
  cancelOrder(odno: string, qty: number): Promise<void>;
  /** 추적 중인 주문들의 체결 상태 스냅샷. */
  fetchFills(): Promise<GridOrderFill[]>;
  /** KIS 잔고에서 이 티커의 포지션 재조회 — 없으면 null(잔고 반영 지연/미보유). */
  fetchPosition(): Promise<GridPosition | null>;
}

/**
 * 상태:
 *  IDLE       — 그리드 인계 전(arm 전).
 *  ARMED      — 두 주문(또는 매도 다리만) 발주 완료, 체결 대기.
 *  SOLD       — 매도(+w) 체결 → 전량 정리 완료(종료). 오토파일럿이 SCANNING으로 복귀.
 *  FAULT      — 발주/취소가 오류로 신뢰 불가 → 동결. 신규 발주·취소 없음.
 */
export type GridState = 'IDLE' | 'ARMED' | 'SOLD' | 'FAULT';

export interface GridConfig {
  /** 폭 w — 기본 0.10. buyPrice=P×(1−w), sellPrice=P×(1+w). */
  width: number;
  /** 매수 배율 — 기본 1. 매수수량 = floor(N×배율). 매도는 항상 N 전량. */
  buyMultiplier: number;
  /**
   * 가용 현금(USD) — 매수 다리 축소/생략 판정용(D2). undefined면 판정 없이 전량 매수.
   * 매수 필요금액 > 가용현금이면 살 수 있는 최대로 축소, 0이면 매수 다리 생략(매도만).
   */
  availableCashUsd?: number;
}

export interface GridDeps {
  port: GridOrderPort;
  clock: ClockLike;
  config: GridConfig;
  /** 잔고 반영 지연 대비 fetchPosition 재시도 횟수(기본 3). */
  positionRetries?: number;
}

/** 게이지 UI(다음 단계)가 읽을 그리드 스냅샷. */
export interface GridView {
  state: GridState;
  gridActive: boolean;
  avgPrice: number;
  buyPrice: number;
  sellPrice: number;
  holdingQty: number;
  buyMultiplier: number;
}

/** poll 1회의 결과 — 오토파일럿이 이 값으로 SCANNING 복귀/기록/리브래킷을 판단한다. */
export type GridPollResult =
  | { kind: 'idle' }
  | { kind: 'armed' }
  | { kind: 'rebracket'; position: GridPosition }
  | { kind: 'sold'; qty: number; avgPrice: number; exitPrice: number }
  | { kind: 'fault'; reason: string };

interface Leg {
  odno: string;
  qty: number;
  price: number;
}

export class Grid {
  private readonly port: GridOrderPort;
  private readonly clock: ClockLike;
  private readonly width: number;
  private readonly buyMultiplier: number;
  private readonly availableCashUsd: number | undefined;
  private readonly positionRetries: number;

  private _state: GridState = 'IDLE';
  private avgPrice = 0;
  private holdingQty = 0;
  private buyPrice = 0;
  private sellPrice = 0;
  private buyLeg: Leg | null = null;
  private sellLeg: Leg | null = null;
  private faultReason: string | null = null;

  constructor(deps: GridDeps) {
    this.port = deps.port;
    this.clock = deps.clock;
    this.width = deps.config.width;
    this.buyMultiplier = deps.config.buyMultiplier;
    this.availableCashUsd = deps.config.availableCashUsd;
    this.positionRetries = deps.positionRetries ?? 3;
  }

  get state(): GridState {
    return this._state;
  }

  get faultText(): string | null {
    return this.faultReason;
  }

  get view(): GridView {
    return {
      state: this._state,
      gridActive: this._state === 'ARMED',
      avgPrice: this.avgPrice,
      buyPrice: this.buyPrice,
      sellPrice: this.sellPrice,
      holdingQty: this.holdingQty,
      buyMultiplier: this.buyMultiplier,
    };
  }

  /**
   * 그리드 인계 — 포지션을 잔고에서 읽어(재시도) 두 주문을 발주한다.
   * fallback: 잔고가 끝내 안 잡히면 직전 체결가·체결수량으로 브래킷을 세운다(D1).
   */
  async arm(fallback?: GridPosition): Promise<void> {
    if (this._state !== 'IDLE') return;
    const position = await this.resolvePosition(fallback);
    if (!position || position.qty <= 0 || !(position.avgPrice > 0)) {
      this.enterFault('포지션을 확인할 수 없어요 — 잔고와 직전 체결을 모두 못 읽었어요');
      return;
    }
    await this.placeBrackets(position);
  }

  /** 체결 폴 1회 — OCO 판정(매도 체결→SOLD, 매수 체결→리브래킷). */
  async poll(): Promise<GridPollResult> {
    if (this._state !== 'ARMED') {
      return this._state === 'FAULT'
        ? { kind: 'fault', reason: this.faultReason ?? '동결됨' }
        : this._state === 'SOLD'
          ? { kind: 'sold', qty: this.holdingQty, avgPrice: this.avgPrice, exitPrice: this.sellPrice }
          : { kind: 'idle' };
    }

    let fills: GridOrderFill[];
    try {
      fills = await this.port.fetchFills();
    } catch (err) {
      this.enterFault(`체결 확인 실패 — ${summarize(err)}`);
      return { kind: 'fault', reason: this.faultReason! };
    }
    const byOdno = new Map(fills.map((f) => [f.odno, f]));

    // 매도(+w) 우선 판정 — 정리(SOLD)가 리브래킷보다 우선한다.
    const sellFilled = this.sellLeg && isFilled(byOdno.get(this.sellLeg.odno), this.sellLeg.qty);
    if (this.sellLeg && sellFilled) {
      const exitPrice = filledPriceOf(byOdno.get(this.sellLeg.odno)) ?? this.sellLeg.price;
      const soldQty = this.sellLeg.qty;
      const avg = this.avgPrice;
      if (this.buyLeg) {
        const ok = await this.cancelLeg(this.buyLeg);
        if (!ok) return { kind: 'fault', reason: this.faultReason! };
      }
      this.buyLeg = null;
      this.sellLeg = null;
      this._state = 'SOLD';
      return { kind: 'sold', qty: soldQty, avgPrice: avg, exitPrice };
    }

    // 매수(−w) 체결 → OCO로 매도 취소 → 잔고 재조회 → 리브래킷.
    const buyFilled = this.buyLeg && isFilled(byOdno.get(this.buyLeg.odno), this.buyLeg.qty);
    if (this.buyLeg && buyFilled) {
      const buyFillPrice = filledPriceOf(byOdno.get(this.buyLeg.odno)) ?? this.buyLeg.price;
      const buyQty = this.buyLeg.qty;
      if (this.sellLeg) {
        const ok = await this.cancelLeg(this.sellLeg);
        if (!ok) return { kind: 'fault', reason: this.faultReason! };
      }
      const prevQty = this.holdingQty;
      const prevAvg = this.avgPrice;
      this.buyLeg = null;
      this.sellLeg = null;
      // 잔고 재조회 폴백: 매수분을 옛 포지션에 합산(수량 가중평균).
      const merged: GridPosition = {
        qty: prevQty + buyQty,
        avgPrice: (prevQty * prevAvg + buyQty * buyFillPrice) / (prevQty + buyQty),
      };
      const position = await this.resolvePosition(merged);
      const next = position && position.qty > 0 && position.avgPrice > 0 ? position : merged;
      const armed = await this.placeBrackets(next);
      if (!armed) return { kind: 'fault', reason: this.faultReason! };
      return { kind: 'rebracket', position: next };
    }

    return { kind: 'armed' };
  }

  // ---- 내부 ----

  private async resolvePosition(fallback?: GridPosition): Promise<GridPosition | null> {
    for (let i = 0; i < Math.max(1, this.positionRetries); i++) {
      let pos: GridPosition | null = null;
      try {
        pos = await this.port.fetchPosition();
      } catch {
        pos = null;
      }
      if (pos && pos.qty > 0 && pos.avgPrice > 0) return pos;
    }
    return fallback ?? null;
  }

  /** 두 다리 발주 — 현금 부족 시 매수 축소/생략(D2). 발주 오류는 FAULT. 성공하면 true. */
  private async placeBrackets(position: GridPosition): Promise<boolean> {
    this.avgPrice = position.avgPrice;
    this.holdingQty = position.qty;
    // KIS 주문가 자릿수 규칙($1이상 2자리·미만 4자리)에 미리 맞춰 둔다 — 뷰·발주가·실제 접수가를
    // 하나로 일치시키고 부동소수 잡음(100×1.1=110.0000…001)을 제거한다. kis/order가 다시 절사해도 멱등이다.
    this.buyPrice = roundGridPrice(position.avgPrice * (1 - this.width));
    this.sellPrice = roundGridPrice(position.avgPrice * (1 + this.width));

    const sellQty = position.qty;
    let buyQty = Math.floor(position.qty * this.buyMultiplier);
    if (this.availableCashUsd !== undefined && this.buyPrice > 0) {
      const affordable = Math.floor(this.availableCashUsd / this.buyPrice);
      if (affordable < buyQty) buyQty = Math.max(0, affordable);
    }

    try {
      // 매도 다리(익절)는 항상 발주한다.
      const sell = await this.port.placeOrder('sell', sellQty, this.sellPrice);
      this.sellLeg = { odno: sell.odno, qty: sellQty, price: this.sellPrice };
      // 매수 다리는 수량이 1주 이상일 때만.
      if (buyQty >= 1) {
        const buy = await this.port.placeOrder('buy', buyQty, this.buyPrice);
        this.buyLeg = { odno: buy.odno, qty: buyQty, price: this.buyPrice };
      } else {
        this.buyLeg = null;
      }
    } catch (err) {
      this.enterFault(`발주 실패 — ${summarize(err)}`);
      return false;
    }
    this._state = 'ARMED';
    return true;
  }

  /** OCO 취소 1회 — 거절되면 FAULT. */
  private async cancelLeg(leg: Leg): Promise<boolean> {
    try {
      await this.port.cancelOrder(leg.odno, leg.qty);
      return true;
    } catch (err) {
      this.enterFault(`반대편 취소 실패 — ${summarize(err)}`);
      return false;
    }
  }

  private enterFault(reason: string): void {
    this.faultReason = reason;
    this._state = 'FAULT';
  }
}

/**
 * 그리드 목표가를 KIS 자릿수 규칙으로 반올림한다($1이상 2자리·미만 4자리). formatOverseasOrderPrice와 같은 스케일.
 * 부동소수 잔재(100×1.1=110.0000…01)가 다리 가격에 남지 않게 한다.
 */
export function roundGridPrice(price: number): number {
  const scale = price >= 1 ? 100 : 10_000;
  return Math.round(price * scale + 1e-9) / scale;
}

function isFilled(fill: GridOrderFill | undefined, qty: number): boolean {
  return fill !== undefined && fill.filledQty >= qty;
}

function filledPriceOf(fill: GridOrderFill | undefined): number | null {
  return fill && fill.filledPrice !== null && fill.filledPrice > 0 ? fill.filledPrice : null;
}

function summarize(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
