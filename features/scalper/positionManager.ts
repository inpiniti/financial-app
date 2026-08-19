/**
 * 포지션 관리자 — 종목 1개의 진입 후 관리(보유 → 신호/손절/서킷 판정 → 매매 → 부분체결 반영 → 수동청산 인지 → 정산)를
 * 하나의 깊은 모듈로 든다. 오토파일럿은 이 모듈에 신호·틱·폴·해제만 넘기고, 돌아오는 결과값으로 정산·격리·해제만 한다.
 *
 * 인터페이스(오토파일럿이 알아야 하는 전부):
 *   onSignal(signal, price)         — 봉 마감 신호 1개 판정 → 문턱을 넘기면 매매 시작(비동기)
 *   tick({ canStart })              — 매초: 서킷 heartbeat · 진행 중 매매 추격(onPrice) · 손절 틱 판정(canStart일 때만)
 *   poll()                          — 주기 폴: 진행 중 매매 체결/취소 확정, 매매가 없으면 수동청산 재확인
 *                                       → { kind: 'holding' } | { kind: 'sold', record } | { kind: 'isolated', reason }
 *   release()                       — 관리를 놓는다(추격 중 매매 최선껏 취소, 이후 새 매매 없음)
 *   view / busy / isolated / faultText — 화면·Stop 문구용 읽기
 *
 * 청산 사유(SELL_SIGNAL/STOP_LOSS/CIRCUIT/MANUAL)는 매도를 **시작한 자리**에서 한 번 정하고 정산까지 그대로 든다(pendingExitReason).
 * 규칙(PositionRule: 추세 청산·조건부 그리드·서킷 데코레이터)은 core 모듈이 그대로이고, 이 모듈은 그것들을 엮는 배선이다.
 */
import { makeTradeRecord, type ExitReason, type SignalSnapshot, type TradeRecord } from '../../core/cycle';
import type { CircuitEvent, CircuitExitRule } from '../../core/circuit';
import type { ConditionalDecision, ConditionalGridView, ConditionalPosition } from '../../core/conditional';
import type { Signal } from '../../core/detector';
import { Execution, type ClockLike, type ExecutionResult } from '../../core/execution';
import { createExecutionPort } from './executionPort';
import type { ScalperBroker } from './types';

/**
 * 진입 후 포지션 규칙 계약 — 조건부 그리드(변곡점 조합)와 추세 청산 규칙(서킷 데코레이터 포함)이 구조적으로 만족한다.
 * 포지션 관리자의 배선(신호 판정 → 매매 → 폴 → 정산)은 이 계약만 본다.
 */
export interface PositionRule {
  readonly view: ConditionalGridView;
  decide(signal: Signal, price: number): ConditionalDecision | null;
  /** 틱(현재가) 판정 — 봉·신호 없이 가격만으로 나가는 결정(추세 손절선). 미구현이면 틱 판정 없음. */
  onPrice?(price: number): ConditionalDecision | null;
  shouldAbort(side: 'buy' | 'sell', price: number): boolean;
  setPosition(position: ConditionalPosition): void;
}

/** 현재가 읽기 — 슬롯이 없으면(입양 포지션) null. */
export interface PriceView {
  price: number | null;
  lastTradeAt: number | null;
}

export interface PositionManagerDeps {
  ticker: string;
  rule: PositionRule;
  /** 서킷 데코레이터(추세 모드) — heartbeat 구동용. 변곡점 모드면 미지정. */
  circuit?: CircuitExitRule;
  broker: ScalperBroker;
  clock: ClockLike;
  /** 최신 현재가·마지막 체결 시각 — 슬롯이 없으면 null을 돌려준다. */
  price: () => PriceView | null;
  /** 정규장 판정(서킷 heartbeat 입력). */
  regularSession: (nowMs: number) => boolean;
  /** 매수가능금액 사전 조회(물타기 매수) — null/미지정/throw면 판정 없이 진행(fail-open). */
  fetchBuyableUsd?: (price: number) => Promise<number | null>;
  /** 진입 실측(우리가 산 포지션) — 입양이면 null. 정산 기록의 entryTs·entrySnapshot. */
  entry: { entryTs: number; entrySnapshot: SignalSnapshot } | null;
  feeRate?: number;
  /** 수동청산(앱 밖 매도) 재확인 주기(ms) — 미지정이면 수동청산 감지를 하지 않는다(변곡점 모드). */
  manualExitCheckMs?: number;
  /** 손절 % — 손절 틱 이벤트 문구용(없으면 0). */
  stopLossPct?: number;
  /** 비동기 발주 직전 최종 게이트 — false면 이번 매매를 시작하지 않는다(오토파일럿 Stop/FAULT/정산 완료). */
  mayStart?: () => boolean;
  onEvent?: (text: string) => void;
}

export type PositionPollResult =
  | { kind: 'holding' }
  | { kind: 'sold'; record: TradeRecord }
  | { kind: 'isolated'; reason: string };

export class PositionManager {
  readonly ticker: string;
  private readonly deps: PositionManagerDeps;
  private readonly rule: PositionRule;

  private exec: Execution | null = null;
  private execSide: 'buy' | 'sell' | null = null;
  /** 매매 시작(비동기 발주)이 진행 중 — 같은 종목에 두 번 걸지 않기 위한 가드. */
  private starting = false;
  /** 진행 중 매도를 시작한 사유 — 정산 기록의 exitReason. 매도가 끝나거나 취소되면 null. */
  private pendingExitReason: ExitReason | null = null;
  private _isolated: string | null = null;
  private released = false;
  /** 다음 잔고 재확인 시각(ms)과 연속 "잔고 없음" 관측 수(2회 연속이어야 MANUAL). undefined면 감지 안 함. */
  private manualCheckAt: number | undefined;
  private manualMisses = 0;

  constructor(deps: PositionManagerDeps) {
    this.deps = deps;
    this.ticker = deps.ticker;
    this.rule = deps.rule;
    this.manualCheckAt = deps.manualExitCheckMs === undefined ? undefined : deps.clock.now() + deps.manualExitCheckMs;
  }

  // ---- 읽기 ----

  get view(): ConditionalGridView {
    return this.rule.view;
  }

  /** 진행 중 매매가 있거나 발주 중 — Stop 문구("주문이 계좌에 남아 있어요")·신호 거절 판단용. */
  get busy(): boolean {
    return this.exec !== null || this.starting;
  }

  get isolated(): boolean {
    return this._isolated !== null;
  }

  get faultText(): string | null {
    return this._isolated;
  }

  // ---- 입력 ----

  /**
   * 봉 마감 신호 1개 판정 — 문턱을 넘긴 신호만 매매로 넘어간다.
   * 매매가 진행 중이면 새 판단을 받지 않는다(주문은 항상 1개 — 매매 도메인 문서 §3).
   */
  onSignal(signal: Signal, price: number): void {
    if (this.isolated || this.released || this.busy) return;
    const decision = this.rule.decide(signal, price);
    if (!decision) return;
    this.begin(decision, price, decision.side === 'sell' ? 'SELL_SIGNAL' : null);
  }

  /**
   * 매초 틱 — 서킷 heartbeat(매매 유무와 무관) → 진행 중 매매 추격 → (매매가 없고 canStart면) 손절 틱 판정.
   * canStart=false(오토파일럿이 RUNNING이 아님)면 새 매매는 시작하지 않고 진행 중 매매 추격만 한다.
   */
  async tick(opts: { canStart: boolean }): Promise<void> {
    if (this.isolated) return;
    const view = this.deps.price();
    const price = view?.price ?? null;
    const canStart = opts.canStart && !this.released;
    if (this.deps.circuit && view) {
      const nowMs = this.deps.clock.now();
      const hb = this.deps.circuit.heartbeat({
        nowMs,
        price: view.price,
        lastTradeAt: view.lastTradeAt,
        regularSession: this.deps.regularSession(nowMs),
      });
      for (const ev of hb.events) this.event(circuitEventText(ev));
      if (hb.events.some((ev) => ev.kind === 'HALT') && this.manualCheckAt !== undefined) this.manualCheckAt = 0; // 정지 감지 → 잔고 재확인 앞당김(수동 매도 인지).
      if (hb.decision && price !== null && !this.busy && canStart) {
        this.begin(hb.decision, price, hb.reason === 'CIRCUIT' ? 'CIRCUIT' : 'STOP_LOSS');
        return;
      }
    }
    if (this.exec !== null) {
      if (price !== null) await this.exec.onPrice(price);
      return;
    }
    // 틱 판정(추세 손절선) — 매매가 없을 때만. 신호 경로(onSignal)와 같은 게이트·점유 규칙.
    if (!this.busy && canStart && price !== null) {
      const decision = this.rule.onPrice?.(price) ?? null;
      if (decision) {
        this.event(
          `손절선 도달 · 현재가 ${price.toFixed(2)} ≤ 평단 대비 −${((this.deps.stopLossPct ?? 0) * 100).toFixed(0)}% — 봉 마감을 기다리지 않고 전량 매도해요`,
        );
        this.begin(decision, price, 'STOP_LOSS');
      }
    }
  }

  /** 주기 폴 — 진행 중 매매의 체결/취소를 확정한다. 매매가 없으면 수동청산 재확인만. */
  async poll(): Promise<PositionPollResult> {
    if (this.isolated) return { kind: 'isolated', reason: this._isolated! };
    const exec = this.exec;
    if (!exec) return this.checkManualExit();
    const r = await exec.poll();
    switch (r.kind) {
      case 'fault':
        return this.isolate(r.reason);
      case 'cancelled': {
        const side = this.execSide ?? exec.side;
        this.clearExec();
        this.event(
          `${side === 'sell' ? '매도' : '매수'} 추격 취소 · 평단 대비 문턱이 깨져 다음 변곡점을 기다려요${
            r.result.filledQty > 0 ? ` (부분 체결 ${r.result.filledQty}주 반영)` : ''
          }`,
        );
        if (r.result.filledQty > 0) return this.refreshPosition(side, r.result, side === 'sell' ? 'SELL_SIGNAL' : null);
        return { kind: 'holding' };
      }
      case 'done': {
        const side = this.execSide ?? exec.side;
        const reason = this.pendingExitReason ?? 'SELL_SIGNAL';
        this.clearExec();
        if (side === 'sell') return this.settleSell(r.result, reason);
        const refreshed = await this.refreshPosition(side, r.result, null);
        if (refreshed.kind !== 'holding') return refreshed;
        const v = this.rule.view;
        this.event(`물타기 체결 · ${r.result.filledQty}주 · 평단 $${v.avgPrice.toFixed(2)} · ${v.qty}주 보유`);
        return { kind: 'holding' };
      }
      default:
        return { kind: 'holding' };
    }
  }

  /** 관리를 놓는다 — 추격 중이던 매매 주문은 최선껏 취소(결과는 기다리지 않는다), 이후 새 매매는 시작하지 않는다. */
  release(): void {
    this.released = true;
    void this.exec?.release();
  }

  // ---- 내부 ----

  /** 슬롯 점유(starting)를 동기로 먼저 확정하고 발주는 비동기로 — 발주 중 겹친 신호가 이중 매매가 되지 않게. */
  private begin(decision: ConditionalDecision, price: number, exitReason: ExitReason | null): void {
    this.starting = true;
    this.pendingExitReason = decision.side === 'sell' ? exitReason : null;
    void this.startExec(decision, price);
  }

  /** 매매 개시 — 물타기 매수는 현금 사전 판정을 거친다(조회 실패는 통과 — fail-open, 기존 원칙). */
  private async startExec(decision: ConditionalDecision, price: number): Promise<void> {
    try {
      if (decision.side === 'buy') {
        const needed = decision.qty * price;
        let buyable: number | null = null;
        try {
          buyable = (await this.deps.fetchBuyableUsd?.(price)) ?? null;
        } catch {
          buyable = null;
        }
        if (buyable !== null && buyable < needed) {
          this.event(`물타기 생략 · 현금 부족(필요 $${needed.toFixed(2)} > 주문가능 $${buyable.toFixed(2)}) — 다음 변곡점을 기다려요`);
          return;
        }
      }
      if (this.isolated || this.released || (this.deps.mayStart && !this.deps.mayStart())) return;
      // 서킷 매도(정지 중 지정가): 시작가는 결정의 limitPrice, 추격은 정지 뒤 첫 체결이 관측된 뒤에만(chaseGate).
      const limit = decision.side === 'sell' && decision.limitPrice !== undefined ? decision.limitPrice : null;
      const chaseAfter = decision.side === 'sell' ? (decision.chaseAfterTradeAt ?? null) : null;
      const exec = new Execution({
        port: createExecutionPort(this.deps.broker, this.ticker),
        clock: this.deps.clock,
        side: decision.side,
        qty: decision.qty,
        // 취소선 — 규칙의 문턱 부정을 술어로 주입한다(매매는 판단하지 않는다).
        shouldAbort: (p) => this.rule.shouldAbort(decision.side, p),
        chaseGate: chaseAfter === null ? undefined : () => (this.deps.price()?.lastTradeAt ?? 0) > chaseAfter,
      });
      await exec.start(limit ?? price);
      if (exec.state === 'FAULT') {
        // 발주 거절은 세션 간극·일시 오류가 흔하다 — 종목을 동결하지 않고 다음 신호에서 다시 시도한다.
        this.event(`매매 발주 실패 · ${exec.faultText ?? '주문 거절'} — 다음 변곡점에서 다시 시도해요`);
        this.pendingExitReason = null; // 손절·서킷 매도가 발주에 실패하면 다음 틱이 다시 판정한다.
        return;
      }
      this.exec = exec;
      this.execSide = decision.side;
      this.event(
        `${decision.side === 'sell' ? '전량 매도' : '물타기 매수'} 매매 시작 · ${decision.qty}주 @ ${(exec.orderPrice ?? price).toFixed(2)} ${
          limit !== null ? '(정지 중 지정가 · 재개 단일가에 소화, 미체결이면 재개 뒤 추격)' : '(현재가 추격)'
        }`,
      );
    } finally {
      this.starting = false;
    }
  }

  private clearExec(): void {
    this.exec = null;
    this.execSide = null;
    this.pendingExitReason = null;
  }

  /**
   * 체결/부분 체결 후 포지션 갱신 — 정본은 KIS 잔고(fetchPosition), 폴백은 체결 합산(가중평균).
   * 잔고가 0이면(취소 전 부분 매도가 사실상 전량) 정산 경로로 넘긴다.
   */
  private async refreshPosition(
    side: 'buy' | 'sell',
    result: ExecutionResult,
    exitReason: ExitReason | null,
  ): Promise<PositionPollResult> {
    const prev = this.rule.view;
    // 체결가 미실측 폴백 — 현재가(슬롯) 우선, 없으면 조건선. 추세 규칙은 조건선=평단이라 현재가가 없으면 손익 0으로 남는다.
    const fillPrice = result.fillPrice ?? this.deps.price()?.price ?? (side === 'buy' ? prev.buyLine : prev.sellLine);
    const merged: ConditionalPosition =
      side === 'buy'
        ? {
            qty: prev.qty + result.filledQty,
            avgPrice: (prev.qty * prev.avgPrice + result.filledQty * fillPrice) / (prev.qty + result.filledQty),
          }
        : { qty: prev.qty - result.filledQty, avgPrice: prev.avgPrice };
    const pos = await this.fetchPosition();
    const next = pos && pos.qty > 0 && pos.avgPrice > 0 ? pos : merged;
    if (next.qty <= 0) return this.settleSell(result, exitReason ?? 'SELL_SIGNAL');
    this.rule.setPosition(next);
    return { kind: 'holding' };
  }

  /**
   * 매도 정산 — 평단→체결가 손익으로 TradeRecord를 합성한다.
   * 추론 체결(체결가 미실측)은 잔고로 먼저 검증한다 — 세션 일괄 취소가 "목록 부재→전량체결"로
   * 오판되면 없는 매도를 정산하고 관리를 놓게 되므로(Grid의 일괄 취소 방어와 같은 이유).
   */
  private async settleSell(result: ExecutionResult, exitReason: ExitReason): Promise<PositionPollResult> {
    const v = this.rule.view;
    if (!result.priceConfirmed) {
      const pos = await this.fetchPosition();
      if (pos !== null && pos.qty >= v.qty) {
        return this.isolate('매도 체결로 추론됐지만 잔고가 그대로예요 — 일괄 취소 의심, 계좌를 확인해 주세요');
      }
    }
    const record = makeTradeRecord({
      ticker: this.ticker,
      qty: result.filledQty > 0 ? result.filledQty : v.qty,
      entryPrice: v.avgPrice,
      exitPrice: result.fillPrice ?? this.deps.price()?.price ?? v.sellLine,
      entry: this.deps.entry,
      exitReason,
      feeRate: this.deps.feeRate,
      now: this.deps.clock.now(),
    });
    return { kind: 'sold', record };
  }

  /**
   * 외부(수동·한투앱) 청산 인지 — 매매가 없을 때 주기적으로 잔고를 재확인해, 2회 연속 "보유 없음"이면
   * MANUAL 사유로 정산한다(서킷 도메인 문서 §6). 1회로 끊지 않는 이유: 진입 직후 잔고 반영 지연·조회 일시 실패.
   * 체결가는 주문체결내역(TTTS3035R)이 일부 계좌에서 APTR0058로 거절되므로(kis/nccs.ts) 마지막 현재가로 기록한다.
   */
  private async checkManualExit(): Promise<PositionPollResult> {
    if (this.manualCheckAt === undefined || this.starting || this.released) return { kind: 'holding' };
    const now = this.deps.clock.now();
    if (now < this.manualCheckAt) return { kind: 'holding' };
    this.manualCheckAt = now + (this.deps.manualExitCheckMs ?? 0);
    let pos: ConditionalPosition | null;
    try {
      pos = await this.deps.broker.fetchPosition();
    } catch {
      return { kind: 'holding' }; // 조회 실패는 판단하지 않는다(다음 주기).
    }
    if (pos !== null && pos.qty > 0) {
      this.manualMisses = 0;
      if (pos.avgPrice > 0 && pos.qty !== this.rule.view.qty) this.rule.setPosition(pos); // 외부 부분 매도·추가 매수 반영.
      return { kind: 'holding' };
    }
    this.manualMisses += 1;
    if (this.manualMisses < 2) return { kind: 'holding' };
    if (this.busy || this.released) return { kind: 'holding' };
    const v = this.rule.view;
    const exitPrice = this.deps.price()?.price ?? v.avgPrice;
    const record = makeTradeRecord({
      ticker: this.ticker,
      qty: v.qty,
      entryPrice: v.avgPrice,
      exitPrice,
      entry: this.deps.entry,
      exitReason: 'MANUAL',
      feeRate: this.deps.feeRate,
      now: this.deps.clock.now(),
    });
    this.event(`잔고에서 사라졌어요 — 앱 밖(수동) 매도로 보고 정산해요 · 체결가 미확인(현재가 ${exitPrice.toFixed(2)} 기준 기록)`);
    return { kind: 'sold', record };
  }

  private async fetchPosition(): Promise<ConditionalPosition | null> {
    try {
      return await this.deps.broker.fetchPosition();
    } catch {
      return null;
    }
  }

  private isolate(reason: string): PositionPollResult {
    this._isolated = reason;
    return { kind: 'isolated', reason };
  }

  private event(text: string): void {
    this.deps.onEvent?.(`${this.ticker} ${text}`);
  }
}

/** 서킷 관측 이벤트 문구 — 관측 단계(CIRCUIT_MODE=false)의 핵심 산출물이라 수치를 다 적는다(plan §5 미결 검증용). */
export function circuitEventText(ev: CircuitEvent): string {
  switch (ev.kind) {
    case 'HALT': {
      const r = ev.record;
      const dir = r.dir > 0 ? '상킷' : r.dir < 0 ? '하킷' : '보합';
      const win = r.windowSec === null ? '첫 정지' : `재개 창 ${r.windowSec.toFixed(0)}초`;
      return `정지 감지 #${ev.count} · ${dir} · 직전가 ${r.price.toFixed(2)} · ${win} · 직전 3분 체결 ${ev.activeTicks}건 · 하킷 연속 ${ev.consecutiveDown}${
        ev.inCircuit ? ' · 서킷 상태(ma5 청산 보류)' : ''
      }`;
    }
    case 'RESUME':
      return `재개 · 첫 체결 ${ev.price.toFixed(2)} (갭 ${(ev.gapPct * 100).toFixed(1)}%) · 정지 ${Math.round(ev.haltedMs / 1000)}초${
        ev.inCircuit ? ' · 서킷 상태 유지' : ''
      }`;
    case 'CIRCUIT_RELEASED':
      return '서킷 상태 해제 · 재개 뒤 5분 정지 없음 — ma5 청산으로 돌아가요';
    case 'SELL':
      return `${ev.reason === 'CIRCUIT' ? '하킷 2연속' : '정지 직전가가 손절선 이하'} → ${
        ev.acted ? '정지 중 지정가 매도' : '(관측 모드) 매도 조건 충족 — 주문은 내지 않아요'
      } · 지정가 ${ev.limitPrice.toFixed(2)} (직전가 ${ev.haltPrice.toFixed(2)} −12%)`;
    default:
      return '서킷 이벤트';
  }
}
