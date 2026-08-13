// core/grid — 매도 관리 "사다리" 지정가 그리드 상태기계 (순수 TS, 실시간/KIS 의존 없음).
//
// 2026-08-13 재설계: 배율 물타기(수량 ×N — 기하급수라 몇 번이면 풀배팅)를 버리고,
// **산술급수 사다리**로 바꿨다. 상태는 (중앙값, 매수 lot 스택) 둘로 완전히 결정된다.
//
//  · 중앙값 = **마지막 체결 레벨**(평단가 아님). 매수 체결 → 한 칸 아래로, 매도 체결 → 한 칸 위로.
//  · 칸 간격 step = **진입 시점 평단 × width를 달러로 고정**(사용자 확정 2026-08-13) —
//    매번 %를 새 중앙값에 곱하면(90×1.1=99) 레벨이 어긋나는데, 고정 간격은 오르내려도
//    같은 가격 레벨로 복귀한다(80/90/100/110 격자).
//  · 수량 단위 = **진입 수량(unit)**. lot 스택으로 관리한다:
//      매수 체결 q주 → push(q). 다음 주문: 매도 = top(방금 산 q), 매수 = top + unit.
//      매도 체결     → pop().  다음 주문: 매도 = 새 top(직전 lot), 매수 = 방금 판 수량.
//      (pop 후 스택이 비면 = 진입 lot까지 팔았다 → SOLD, 오토파일럿 SCANNING 복귀.)
//    한 왕복(매수→한 칸 위 매도)마다 그 lot×step이 익절로 확정되고, n칸 하락 시 보유량은
//    unit×n(n+1)/2 — 배수 물타기의 2^n과 달리 선형으로만 는다.
//  · 한쪽 체결 → 반대편 실제 취소(OCO) 후 새 중앙값 기준으로 두 다리 재발주.
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
 *  SOLD       — 마지막 lot(진입 물량)까지 매도 체결 → 전량 정리 완료(종료). 오토파일럿이 SCANNING으로 복귀.
 *  FAULT      — 발주/취소가 오류로 신뢰 불가 → 동결. 신규 발주·취소 없음.
 */
export type GridState = 'IDLE' | 'ARMED' | 'SOLD' | 'FAULT';

export interface GridConfig {
  /**
   * 폭 w — 기본 0.03. **진입 시점**에 step = 평단×w(달러)로 한 번 굳힌다.
   * 이후 모든 다리는 중앙값 ± step(고정 간격 격자).
   */
  width: number;
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

/** 게이지 UI가 읽을 그리드 스냅샷. */
export interface GridView {
  state: GridState;
  gridActive: boolean;
  /** 중앙값 — 마지막 체결 레벨(사다리의 현재 칸). 평단가가 아니다. */
  centerPrice: number;
  buyPrice: number;
  sellPrice: number;
  holdingQty: number;
  /** 1단위 수량(진입 수량) — 사다리 한 칸의 증분. */
  unitQty: number;
  /** 다음 매도 다리 수량(마지막 매수 lot). */
  nextSellQty: number;
  /** 다음 매수 다리 수량(마지막 매수 lot + 1단위) — 현금 축소 전 목표치. */
  nextBuyQty: number;
  /** 매수 다리 현금 판정 결과 — reduced/skippedCash/rejected면 UI가 사유를 표기한다. */
  buyLegStatus: BuyLegStatus;
}

/** fetchFills 연속 실패가 이 횟수에 닿으면 FAULT(그 미만은 일시 오류로 보고 ARMED 유지). */
export const FILL_FAIL_LIMIT = 3;

/** 일괄 취소 후 재발주가 거절됐을 때(세션 간극 — 주문 API 닫힘 등) 재시도 간격(ms). */
export const REBRACKET_RETRY_MS = 60_000;

/**
 * poll 1회의 결과 — 오토파일럿이 이 값으로 SCANNING 복귀/기록/리브래킷을 판단한다.
 *  rebracket.cause='reissue'      — 매수 체결이 아니라 일괄 취소/세션 전환 재발주다(사다리 불변).
 *  rebracketDeferred              — 재발주가 거절돼 REBRACKET_RETRY_MS 후 재시도 대기(ARMED 유지).
 *  stepSold                       — 사다리 한 칸 익절(부분 매도) — 그리드는 한 칸 위에서 계속 관리.
 *  sold                           — 진입 lot까지 팔아 전량 정리(종료). costPrice = 그 lot의 매수 레벨.
 */
export type GridPollResult =
  | { kind: 'idle' }
  | { kind: 'armed' }
  | { kind: 'rebracket'; position: GridPosition; cause?: 'reissue' }
  | { kind: 'rebracketDeferred'; reason: string }
  | { kind: 'stepSold'; qty: number; costPrice: number; exitPrice: number; position: GridPosition }
  | { kind: 'sold'; qty: number; costPrice: number; exitPrice: number }
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
  private readonly availableCashUsd: number | undefined;
  private readonly positionRetries: number;
  private readonly fetchAvailableCash: ((buyPrice: number) => Promise<number | null>) | undefined;

  private _state: GridState = 'IDLE';
  /** 마지막 체결 레벨(사다리의 현재 칸). arm 시 평단으로 시작한다. */
  private centerPrice = 0;
  /** 칸 간격(달러) — arm 시 평단×width로 굳는다. */
  private stepUsd = 0;
  /** 1단위 수량 = 진입 수량. */
  private unitQty = 0;
  /**
   * 매수 lot 스택 — [진입, 1차 물타기, 2차 물타기, …]. 매도는 항상 top부터 판다(LIFO).
   * 현금 축소로 목표보다 적게 산 lot도 실제 산 수량 그대로 쌓여, 매도가 정확히 그만큼 되돌린다.
   */
  private lots: number[] = [];
  private holdingQty = 0;
  private buyPrice = 0;
  private sellPrice = 0;
  private buyLeg: Leg | null = null;
  private sellLeg: Leg | null = null;
  private faultReason: string | null = null;
  private _buyLegStatus: BuyLegStatus = 'full';
  /** SOLD 확정 시의 마지막 결과 — stateResult가 재현한다. */
  private soldResult: Extract<GridPollResult, { kind: 'sold' }> | null = null;
  /** fetchFills 연속 실패 카운터 — 성공하면 리셋, FILL_FAIL_LIMIT에 닿으면 FAULT. */
  private fillFailStreak = 0;
  /**
   * 일괄 취소 후 재발주 대기 중 — 발주가 거절돼(세션 간극 등) 아직 두 다리를 못 건 상태.
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
    this.width = deps.config.width;
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
    const top = this.lots.at(-1) ?? 0;
    return {
      state: this._state,
      gridActive: this._state === 'ARMED',
      centerPrice: this.centerPrice,
      buyPrice: this.buyPrice,
      sellPrice: this.sellPrice,
      holdingQty: this.holdingQty,
      unitQty: this.unitQty,
      nextSellQty: Math.min(top, this.holdingQty),
      nextBuyQty: top + this.unitQty,
      buyLegStatus: this._buyLegStatus,
    };
  }

  /**
   * 그리드 인계 — 포지션을 잔고에서 읽어(재시도) 사다리를 초기화하고 두 주문을 발주한다.
   * 진입 수량이 곧 1단위(unit), 평단이 첫 중앙값, step = 평단×width(달러 고정).
   * fallback: 잔고가 끝내 안 잡히면 직전 체결가·체결수량으로 사다리를 세운다(D1).
   */
  async arm(fallback?: GridPosition): Promise<void> {
    if (this._state !== 'IDLE') return;
    const position = await this.resolvePosition(fallback);
    if (!position || position.qty <= 0 || !(position.avgPrice > 0)) {
      this.enterFault('포지션을 확인할 수 없어요 — 잔고와 직전 체결을 모두 못 읽었어요');
      return;
    }
    this.holdingQty = position.qty;
    this.unitQty = position.qty;
    this.centerPrice = roundGridPrice(position.avgPrice);
    this.stepUsd = position.avgPrice * this.width;
    this.lots = [position.qty];
    const error = await this.tryPlaceLegs();
    if (error !== null) this.enterFault(`매도 발주 실패 — ${error}`);
  }

  /** 체결 폴 1회 — OCO 판정(매도 체결→한 칸 위/SOLD, 매수 체결→한 칸 아래) + 일괄 취소 방어. */
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
    // ① 두 다리가 같은 폴에서 동시에 추론 체결로 사라졌다 — ±step 양끝이 한 폴 안에 다 체결될 수는
    //    없으므로 일괄 취소로 판정하고 같은 사다리 상태로 재발주한다.
    const sellFill = this.sellLeg ? byOdno.get(this.sellLeg.odno) : undefined;
    const buyFill = this.buyLeg ? byOdno.get(this.buyLeg.odno) : undefined;
    const sellInferred =
      this.sellLeg !== null && isFilled(sellFill, this.sellLeg.qty) && filledPriceOf(sellFill) === null;
    const buyInferred =
      this.buyLeg !== null && isFilled(buyFill, this.buyLeg.qty) && filledPriceOf(buyFill) === null;
    if (sellInferred && buyInferred) return this.rebracketAfterCancel();
    // ② 매도 다리의 추론 체결은 잔고로 검증한다 — 진짜 체결이면 체결기준 수량(ccld_qty_smtl1)이
    //    매도분만큼 즉시 줄지만, 취소면 전량이 그대로 남는다. 잔고 반영이 한 폴 늦을 수 있어 연속
    //    2폴 일치할 때만 취소로 확정한다(진짜 체결을 취소로 오분류해 없는 주식을 재매도하는 사고 방지).
    //    ⚠ 사다리 매도는 부분 매도라 "잔고 0"이 아니라 "매도수량만큼 줄었나"로 판정한다.
    if (sellInferred) {
      let pos: GridPosition | null;
      try {
        pos = await this.port.fetchPosition();
      } catch {
        return { kind: 'armed' }; // 일시 오류 — 판정을 다음 폴로 미룬다(주문 상태는 변하지 않는다).
      }
      if (pos !== null && pos.qty > this.holdingQty - this.sellLeg!.qty) {
        if (!this.sellCancelSuspect) {
          this.sellCancelSuspect = true;
          return { kind: 'armed' };
        }
        return this.rebracketAfterCancel();
      }
      // 잔고가 매도분만큼 줄었다(또는 소멸) — 진짜 체결. 아래 매도 판정으로 계속 간다.
      this.sellCancelSuspect = false;
    } else {
      this.sellCancelSuspect = false;
    }

    // 매도(+step) 우선 판정 — 익절이 물타기보다 우선한다.
    const sellFilled = this.sellLeg && isFilled(byOdno.get(this.sellLeg.odno), this.sellLeg.qty);
    if (this.sellLeg && sellFilled) {
      return this.onSellFilled(filledPriceOf(byOdno.get(this.sellLeg.odno)));
    }

    // 매수(−step) 체결 → OCO로 매도 취소 → 한 칸 아래로 리브래킷.
    const buyFilled = this.buyLeg && isFilled(byOdno.get(this.buyLeg.odno), this.buyLeg.qty);
    if (this.buyLeg && buyFilled) {
      return this.onBuyFilled();
    }

    return { kind: 'armed' };
  }

  /**
   * 세션 전환(정규장↔주간거래) 등으로 두 다리를 지금 취소하고 같은 사다리 상태로 재발주한다(ARMED에서만).
   * 옛 세션 API로 접수된 주문은 세션이 끝나면 KIS가 일괄 취소하므로, 경계를 감지한 오토파일럿이
   * 선제 재발주로 새 세션 API 계열의 주문으로 갈아탄다. 재발주 대기 중이었다면 즉시 재시도한다.
   */
  async reissueBrackets(): Promise<GridPollResult> {
    if (this._state !== 'ARMED') return this.stateResult();
    if (this.pendingRebracket) return this.tryPendingRebracket();
    return this.rebracketAfterCancel();
  }

  // ---- 내부 ----

  /**
   * 매도 체결 — 사다리 한 칸 위로. 방금 판 lot을 pop하고 중앙값을 매도가로 올린다.
   * pop 후 스택이 비면(진입 lot까지 팔았다) SOLD 종료, 남았으면 새 두 다리를 건다.
   * costPrice = 그 lot을 샀던 레벨(= 옛 중앙값) — 한 칸 익절 손익은 qty×step이다.
   */
  private async onSellFilled(filledPrice: number | null): Promise<GridPollResult> {
    const leg = this.sellLeg!;
    const exitPrice = filledPrice ?? leg.price;
    const costPrice = this.centerPrice; // 이 lot을 산 레벨(마지막 매수 = 현재 중앙값).
    if (this.buyLeg) {
      const ok = await this.cancelLeg(this.buyLeg);
      if (!ok) return { kind: 'fault', reason: this.faultReason! };
    }
    this.buyLeg = null;
    this.sellLeg = null;
    this.lots.pop();
    this.holdingQty = Math.max(0, this.holdingQty - leg.qty);
    this.centerPrice = leg.price; // 매도가가 새 중앙값(사용자 규칙) — 지정가 = 격자 레벨.

    if (this.lots.length === 0 || this.holdingQty <= 0) {
      this._state = 'SOLD';
      this.soldResult = { kind: 'sold', qty: leg.qty, costPrice, exitPrice };
      return this.soldResult;
    }

    // 수량의 진실은 lot 스택(내부 계산)이다 — 잔고는 체결 반영이 한 박자 늦어 낡은 수량을
    // 돌려줄 수 있고, 그걸 믿으면 다음 매도 수량이 틀어진다. 잔고는 평단 표시용으로만 읽는다.
    const position = await this.displayPosition();
    const error = await this.tryPlaceLegs();
    if (error !== null) {
      this.enterFault(`매도 발주 실패 — ${error}`);
      return { kind: 'fault', reason: this.faultReason! };
    }
    return { kind: 'stepSold', qty: leg.qty, costPrice, exitPrice, position };
  }

  /**
   * 매수 체결 — 사다리 한 칸 아래로. 산 수량을 lot으로 push하고 중앙값을 매수가로 내린다.
   * 다음 다리: 매도 = 방금 산 수량(정확히 이 매수를 되돌린다), 매수 = 방금 산 수량 + 1단위.
   */
  private async onBuyFilled(): Promise<GridPollResult> {
    const leg = this.buyLeg!;
    if (this.sellLeg) {
      const ok = await this.cancelLeg(this.sellLeg);
      if (!ok) return { kind: 'fault', reason: this.faultReason! };
    }
    this.buyLeg = null;
    this.sellLeg = null;
    this.lots.push(leg.qty);
    this.holdingQty += leg.qty;
    this.centerPrice = leg.price; // 매수가가 새 중앙값 — 지정가 = 격자 레벨.

    // 잔고 재조회는 평단 표시용 — 사다리 상태(수량)는 잔고와 무관하게 lot 스택이 진실이다.
    const position = await this.displayPosition();
    const error = await this.tryPlaceLegs();
    if (error !== null) {
      this.enterFault(`매도 발주 실패 — ${error}`);
      return { kind: 'fault', reason: this.faultReason! };
    }
    return { kind: 'rebracket', position };
  }

  private stateResult(): GridPollResult {
    return this._state === 'FAULT'
      ? { kind: 'fault', reason: this.faultReason ?? '동결됨' }
      : this._state === 'SOLD'
        ? (this.soldResult ?? { kind: 'sold', qty: 0, costPrice: this.centerPrice, exitPrice: this.sellPrice })
        : { kind: 'idle' };
  }

  /**
   * 일괄 취소(세션 전환·장 마감) 후 재발주 — 살아 있을지 모르는 다리를 방어적으로 취소하고
   * (이미 KIS가 취소한 주문의 거절은 정상이라 무시), 같은 사다리 상태로 두 다리를 다시 건다.
   * 발주가 거절되면(주문 API가 닫힌 세션 간극 등) FAULT 대신 REBRACKET_RETRY_MS 후
   * 재시도한다 — 새 세션이 열리면 자연히 접수된다.
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
    this.pendingRebracket = await this.displayPosition();
    return this.tryPendingRebracket();
  }

  /** 대기 중인 재발주 1회 시도 — 성공하면 rebracket(cause=reissue), 거절이면 재시도 예약. */
  private async tryPendingRebracket(): Promise<GridPollResult> {
    const position = this.pendingRebracket!;
    const error = await this.tryPlaceLegs();
    if (error === null) {
      this.pendingRebracket = null;
      return { kind: 'rebracket', position, cause: 'reissue' };
    }
    this.nextRebracketAt = this.clock.now() + REBRACKET_RETRY_MS;
    return { kind: 'rebracketDeferred', reason: error };
  }

  /**
   * 이벤트·뷰 표시용 포지션 — 수량은 항상 내부 계산(lot 스택 합)이고, 평단만 잔고에서 빌린다.
   * 잔고의 수량을 믿지 않는 이유: 체결 반영이 한 박자 늦어 낡은 값이 오면 사다리 수량이 틀어진다.
   */
  private async displayPosition(): Promise<GridPosition> {
    const balance = await this.resolvePosition();
    return { qty: this.holdingQty, avgPrice: balance?.avgPrice ?? this.centerPrice };
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
   * 두 다리 발주 — **사다리 상태(중앙값·lot 스택)에서** 가격·수량을 계산한다. 실패를 문자열로 돌려준다.
   *  매도: min(top lot, 보유수량) 주 @ 중앙값+step — 실패만 FAULT 사유다(익절 다리 없는 방치가 진짜 위험).
   *  매수: top lot + unit 주 @ 중앙값−step — 현금 부족 시 축소/생략(D2), 거절은 rejected로 매도만 관리.
   */
  private async tryPlaceLegs(): Promise<string | null> {
    // KIS 주문가 자릿수 규칙($1이상 2자리·미만 4자리)에 미리 맞춰 둔다 — 뷰·발주가·실제 접수가를
    // 하나로 일치시키고 부동소수 잡음(100−10=90.0000…001)을 제거한다. kis/order가 다시 절사해도 멱등이다.
    this.buyPrice = roundGridPrice(this.centerPrice - this.stepUsd);
    this.sellPrice = roundGridPrice(this.centerPrice + this.stepUsd);

    const top = this.lots.at(-1) ?? 0;
    const sellQty = Math.min(top, this.holdingQty);
    if (sellQty < 1) return '매도 수량이 0이에요 — 사다리 상태와 잔고가 어긋났어요';
    let buyQty = top + this.unitQty;
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
    // 매수 다리는 수량이 1주 이상이고 가격이 양수일 때만(사다리가 0 밑으로 내려가면 매수 없음).
    this.buyLeg = null;
    if (buyQty >= 1 && this.buyPrice > 0) {
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
 * 부동소수 잔재(100−10=90.0000…01)가 다리 가격에 남지 않게 한다.
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
