// core/grid — 매도 관리 OCO 지정가 그리드 상태기계 (순수 TS, 실시간/KIS 의존 없음).
//
// 변곡점 진입으로 포지션(보유수량 N·평단가 P)이 생기면, 그 뒤 관리를 이 그리드가 인계한다.
//  · 매수 지정가: N×buyMultiplier 주 @ P×(1−buyWidth)   (평단 아래 → 정상 지정가 대기)
//  · 매도 지정가: N 주            @ P×(1+sellWidth)     (평단 위   → 정상 지정가 대기)
//  · 매수폭·매도폭은 **따로 설정한다**(2026-08-14) — 물타기 간격(buyWidth)은 넓게 잡아 올인을
//    늦추고, 익절 목표(sellWidth)는 좁게 잡아 반등 요구폭을 줄이는 비대칭 운용이 목적이다.
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
  /** 보유수량 N (ccld_qty_smtl1 — 체결기준). */
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
  /** 매수폭(물타기 간격) — 소수(0.05=5%). buyPrice=P×(1−buyWidth). */
  buyWidth: number;
  /** 매도폭(익절 목표) — 소수(0.02=2%). sellPrice=P×(1+sellWidth). */
  sellWidth: number;
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
  /**
   * 발주 직전 최신 매수가능금액(USD) 조회 — 리브래킷마다 다시 부른다.
   * config.availableCashUsd는 생성 시 1회 캡처라 물타기 후엔 낡은 값이 되는데,
   * 이 콜백이 있으면 매수 다리 수량 판정마다 최신 현금으로 갱신한다.
   * null 반환/throw면 config.availableCashUsd로 폴백한다(그것도 없으면 판정 생략).
   */
  fetchAvailableCash?: (buyPrice: number) => Promise<number | null>;
}

/**
 * 매수 다리의 현금 판정 결과 — UI가 "매수 생략/축소"를 표기하는 근거.
 *  full        — 전량 발주(현금 제약 없음).
 *  reduced     — 현금에 맞춰 수량 축소 발주.
 *  skippedCash — 현금이 1주 값도 안 돼 매수 다리 생략(매도만).
 *  rejected    — 발주가 거절됐지만 매도 다리는 살아 있어 ARMED 유지.
 */
export type BuyLegStatus = 'full' | 'reduced' | 'skippedCash' | 'rejected';

/** 게이지 UI(다음 단계)가 읽을 그리드 스냅샷. */
export interface GridView {
  state: GridState;
  gridActive: boolean;
  avgPrice: number;
  buyPrice: number;
  sellPrice: number;
  holdingQty: number;
  buyMultiplier: number;
  /** 매수 다리 현금 판정 결과 — reduced/skippedCash/rejected면 UI가 사유를 표기한다. */
  buyLegStatus: BuyLegStatus;
}

/** fetchFills 연속 실패가 이 횟수에 닿으면 FAULT(그 미만은 일시 오류로 보고 ARMED 유지). */
export const FILL_FAIL_LIMIT = 3;

/** 일괄 취소 후 재발주가 거절됐을 때(세션 간극 — 주문 API 닫힘 등) 재시도 간격(ms). */
export const REBRACKET_RETRY_MS = 60_000;

/**
 * poll 1회의 결과 — 오토파일럿이 이 값으로 SCANNING 복귀/기록/리브래킷을 판단한다.
 *  rebracket.cause='reissue'      — 매수 체결이 아니라 일괄 취소/세션 전환 재발주다(포지션 불변).
 *  rebracketDeferred              — 재발주가 거절돼 REBRACKET_RETRY_MS 후 재시도 대기(ARMED 유지).
 */
export type GridPollResult =
  | { kind: 'idle' }
  | { kind: 'armed' }
  | { kind: 'rebracket'; position: GridPosition; cause?: 'reissue' }
  | { kind: 'rebracketDeferred'; reason: string }
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
  private readonly buyWidth: number;
  private readonly sellWidth: number;
  private readonly buyMultiplier: number;
  private readonly availableCashUsd: number | undefined;
  private readonly positionRetries: number;
  private readonly fetchAvailableCash: ((buyPrice: number) => Promise<number | null>) | undefined;

  private _state: GridState = 'IDLE';
  private avgPrice = 0;
  private holdingQty = 0;
  private buyPrice = 0;
  private sellPrice = 0;
  private buyLeg: Leg | null = null;
  private sellLeg: Leg | null = null;
  private faultReason: string | null = null;
  private _buyLegStatus: BuyLegStatus = 'full';
  /** fetchFills 연속 실패 카운터 — 성공하면 리셋, FILL_FAIL_LIMIT에 닿으면 FAULT. */
  private fillFailStreak = 0;
  /**
   * 일괄 취소 후 재발주 대기 중인 포지션 — 발주가 거절돼(세션 간극 등) 아직 두 다리를 못 건 상태.
   * null이 아니면 ARMED지만 다리가 없다 — poll이 nextRebracketAt마다 재시도한다.
   */
  private pendingRebracket: GridPosition | null = null;
  private nextRebracketAt = 0;
  /**
   * 매도 다리 "취소 추정" 유예 플래그 — 추론 체결(목록 부재)인데 잔고가 그대로면 취소가 의심되지만,
   * 잔고 반영이 한 폴 늦을 수 있어 연속 2폴 일치할 때만 취소로 확정한다(진짜 체결의 오분류 방지).
   */
  private sellCancelSuspect = false;

  constructor(deps: GridDeps) {
    this.port = deps.port;
    this.clock = deps.clock;
    this.buyWidth = deps.config.buyWidth;
    this.sellWidth = deps.config.sellWidth;
    this.buyMultiplier = deps.config.buyMultiplier;
    this.availableCashUsd = deps.config.availableCashUsd;
    this.positionRetries = deps.positionRetries ?? 3;
    this.fetchAvailableCash = deps.fetchAvailableCash;
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
      buyLegStatus: this._buyLegStatus,
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

  /** 체결 폴 1회 — OCO 판정(매도 체결→SOLD, 매수 체결→리브래킷) + 일괄 취소 방어. */
  async poll(): Promise<GridPollResult> {
    if (this._state !== 'ARMED') return this.stateResult();

    // 일괄 취소 후 재발주가 거절돼 대기 중 — 재시도 시각 전에는 armed로만 응답한다(다리가 없어 볼 체결도 없다).
    if (this.pendingRebracket) {
      if (this.clock.now() < this.nextRebracketAt) return { kind: 'armed' };
      return this.tryPendingRebracket();
    }

    let fills: GridOrderFill[];
    try {
      fills = await this.port.fetchFills();
      this.fillFailStreak = 0;
    } catch (err) {
      // 일시적 네트워크/유량 오류로 즉시 동결하지 않는다 — 주문은 살아 있으니 다음 폴에서 다시 본다.
      this.fillFailStreak += 1;
      if (this.fillFailStreak < FILL_FAIL_LIMIT) return { kind: 'armed' };
      this.enterFault(`체결 확인 ${this.fillFailStreak}회 연속 실패 — ${summarize(err)}`);
      return { kind: 'fault', reason: this.faultReason! };
    }
    const byOdno = new Map(fills.map((f) => [f.odno, f]));

    // ── 거래소/KIS 일괄 취소 방어(세션 전환·장 마감) ──
    // "목록 부재→전량체결" 추론(filledPrice=null)은 취소로 사라진 주문과 구분이 안 된다.
    // ① 두 다리가 같은 폴에서 동시에 추론 체결로 사라졌다 — ±w 양끝이 한 폴 안에 다 체결될 수는
    //    없으므로 일괄 취소로 판정하고 같은 포지션으로 재발주한다.
    const sellFill = this.sellLeg ? byOdno.get(this.sellLeg.odno) : undefined;
    const buyFill = this.buyLeg ? byOdno.get(this.buyLeg.odno) : undefined;
    const sellInferred =
      this.sellLeg !== null && isFilled(sellFill, this.sellLeg.qty) && filledPriceOf(sellFill) === null;
    const buyInferred =
      this.buyLeg !== null && isFilled(buyFill, this.buyLeg.qty) && filledPriceOf(buyFill) === null;
    if (sellInferred && buyInferred) return this.rebracketAfterCancel();
    // ② 매도 다리의 추론 체결은 잔고로 검증한다 — 진짜 체결이면 체결기준 수량(ccld_qty_smtl1)이
    //    즉시 줄지만, 취소면 전량이 그대로 남는다. 잔고 반영이 한 폴 늦을 수 있어 연속 2폴 일치
    //    할 때만 취소로 확정한다(진짜 체결을 취소로 오분류해 없는 주식을 재매도하는 사고 방지).
    if (sellInferred) {
      let pos: GridPosition | null;
      try {
        pos = await this.port.fetchPosition();
      } catch {
        return { kind: 'armed' }; // 일시 오류 — 판정을 다음 폴로 미룬다(주문 상태는 변하지 않는다).
      }
      if (pos !== null && pos.qty >= this.sellLeg!.qty) {
        if (!this.sellCancelSuspect) {
          this.sellCancelSuspect = true;
          return { kind: 'armed' };
        }
        return this.rebracketAfterCancel();
      }
      // 잔고가 줄었다 — 진짜 체결. 아래 기존 SOLD 판정으로 계속 간다.
      this.sellCancelSuspect = false;
    } else {
      this.sellCancelSuspect = false;
    }

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

  /**
   * 세션 전환(정규장↔주간거래) 등으로 두 다리를 지금 취소하고 같은 포지션으로 재발주한다(ARMED에서만).
   * 옛 세션 API로 접수된 주문은 세션이 끝나면 KIS가 일괄 취소하므로, 경계를 감지한 오토파일럿이
   * 선제 재발주로 새 세션 API 계열의 주문으로 갈아탄다. 재발주 대기 중이었다면 즉시 재시도한다.
   */
  async reissueBrackets(): Promise<GridPollResult> {
    if (this._state !== 'ARMED') return this.stateResult();
    if (this.pendingRebracket) return this.tryPendingRebracket();
    return this.rebracketAfterCancel();
  }

  // ---- 내부 ----

  private stateResult(): GridPollResult {
    return this._state === 'FAULT'
      ? { kind: 'fault', reason: this.faultReason ?? '동결됨' }
      : this._state === 'SOLD'
        ? { kind: 'sold', qty: this.holdingQty, avgPrice: this.avgPrice, exitPrice: this.sellPrice }
        : { kind: 'idle' };
  }

  /**
   * 일괄 취소(세션 전환·장 마감) 후 재발주 — 살아 있을지 모르는 다리를 방어적으로 취소하고
   * (이미 KIS가 취소한 주문의 거절은 정상이라 무시), 같은 포지션(잔고 재조회, 폴백=현재 값)으로
   * 두 다리를 다시 건다. 발주가 거절되면(주문 API가 닫힌 세션 간극 등) FAULT 대신
   * REBRACKET_RETRY_MS 후 재시도한다 — 새 세션이 열리면 자연히 접수된다.
   */
  private async rebracketAfterCancel(): Promise<GridPollResult> {
    this.sellCancelSuspect = false;
    for (const leg of [this.buyLeg, this.sellLeg]) {
      if (!leg) continue;
      try {
        await this.port.cancelOrder(leg.odno, leg.qty);
      } catch {
        // 이미 취소된 주문 — 거절이 정상이다.
      }
    }
    this.buyLeg = null;
    this.sellLeg = null;
    const fallback: GridPosition = { qty: this.holdingQty, avgPrice: this.avgPrice };
    this.pendingRebracket = (await this.resolvePosition(fallback)) ?? fallback;
    return this.tryPendingRebracket();
  }

  /** 대기 중인 재발주 1회 시도 — 성공하면 rebracket(cause=reissue), 거절이면 재시도 예약. */
  private async tryPendingRebracket(): Promise<GridPollResult> {
    const position = this.pendingRebracket!;
    const error = await this.tryPlaceBrackets(position);
    if (error === null) {
      this.pendingRebracket = null;
      return { kind: 'rebracket', position, cause: 'reissue' };
    }
    this.nextRebracketAt = this.clock.now() + REBRACKET_RETRY_MS;
    return { kind: 'rebracketDeferred', reason: error };
  }

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

  /**
   * 두 다리 발주 — 현금 부족 시 매수 축소/생략(D2).
   * 매도 다리(익절) 실패만 FAULT다 — 익절 다리 없는 포지션 방치가 진짜 위험이라서.
   * 매수 다리 실패는 rejected로 표기하고 매도만 ARMED로 계속 간다(현금 부족 거절이 대부분).
   */
  private async placeBrackets(position: GridPosition): Promise<boolean> {
    const error = await this.tryPlaceBrackets(position);
    if (error !== null) {
      this.enterFault(`매도 발주 실패 — ${error}`);
      return false;
    }
    return true;
  }

  /** placeBrackets의 비-FAULT 본체 — 매도 발주 실패를 문자열로 돌려준다(재시도 경로가 쓴다). */
  private async tryPlaceBrackets(position: GridPosition): Promise<string | null> {
    this.avgPrice = position.avgPrice;
    this.holdingQty = position.qty;
    // KIS 주문가 자릿수 규칙($1이상 2자리·미만 4자리)에 미리 맞춰 둔다 — 뷰·발주가·실제 접수가를
    // 하나로 일치시키고 부동소수 잡음(100×1.1=110.0000…001)을 제거한다. kis/order가 다시 절사해도 멱등이다.
    this.buyPrice = roundGridPrice(position.avgPrice * (1 - this.buyWidth));
    this.sellPrice = roundGridPrice(position.avgPrice * (1 + this.sellWidth));

    const sellQty = position.qty;
    let buyQty = Math.floor(position.qty * this.buyMultiplier);
    this._buyLegStatus = 'full';
    // 최신 현금 조회(리브래킷마다) — 실패하면 생성 시 캡처값으로 폴백.
    let cash = this.availableCashUsd;
    if (this.fetchAvailableCash && this.buyPrice > 0) {
      try {
        const latest = await this.fetchAvailableCash(this.buyPrice);
        if (typeof latest === 'number' && Number.isFinite(latest)) cash = latest;
      } catch {
        // 폴백 유지.
      }
    }
    if (cash !== undefined && this.buyPrice > 0) {
      const affordable = Math.floor(cash / this.buyPrice);
      if (affordable < buyQty) {
        buyQty = Math.max(0, affordable);
        this._buyLegStatus = buyQty >= 1 ? 'reduced' : 'skippedCash';
      }
    }

    try {
      // 매도 다리(익절)는 항상 발주한다.
      const sell = await this.port.placeOrder('sell', sellQty, this.sellPrice);
      this.sellLeg = { odno: sell.odno, qty: sellQty, price: this.sellPrice };
    } catch (err) {
      return summarize(err);
    }
    // 매수 다리는 수량이 1주 이상일 때만.
    this.buyLeg = null;
    if (buyQty >= 1) {
      try {
        const buy = await this.port.placeOrder('buy', buyQty, this.buyPrice);
        this.buyLeg = { odno: buy.odno, qty: buyQty, price: this.buyPrice };
      } catch {
        // 매도는 이미 접수됐다 — 매수 거절만으로 동결하지 않고 매도만 관리한다.
        this._buyLegStatus = 'rejected';
      }
    }
    this._state = 'ARMED';
    return null;
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
