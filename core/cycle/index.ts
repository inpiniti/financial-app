// Run 사이클 상태기계 (인스턴스 1개 기준). 1 Run = 1사이클(매수→청산→종료).
// 진입·청산은 오직 변곡점 신호로만 실행 — 손절/익절/시간손절 없음. (PRD §2·§4-D·§4-F)
// 주문·체결확인은 주입된 OrderPort로만, 시각은 주입된 Clock으로만 — 실시간/RN/KIS 의존 없음.
import type { Signal } from '../detector';

export type { Signal };

/**
 * 상태:
 *  IDLE       — Run 전
 *  WATCH_BUY  — BUY 변곡점 대기 (PRD IDLE 의미의 감시 상태)
 *  BUYING     — 매수 주문 후 체결 대기
 *  HOLDING    — 포지션 보유, SELL 변곡점 대기 (PRD ENTERED)
 *  SELLING    — 매도 주문 후 체결 대기
 *  DONE       — 1사이클 종료 (PRD EXITED)
 *  FAULT      — 안전 인터록. 체결 확인/발주/취소가 오류로 신뢰 불가 → 동결.
 *               신규 주문·취소·재진입 없음. onSignal·poll은 무반응. 오직 stop()으로만 빠져나온다.
 *               ※ RunCycle 스스로는 전이하지 않는다 — 러너(ScalperInstance)가 async 브로커 오류를 감지해 fault()를 호출한다.
 */
export type CycleState = 'IDLE' | 'WATCH_BUY' | 'BUYING' | 'HOLDING' | 'SELLING' | 'DONE' | 'FAULT';

/** SELL_SIGNAL=신호 청산, STOP=수동/중지 청산, STOP_LOSS=추세 손절선(틱 판정, 2026-08-18). */
/** 청산 사유 — CIRCUIT(서킷 하킷 2연속, 정지 중 지정가)·MANUAL(외부·한투앱 매도를 잔고 재확인으로 인지)은 2026-08-19 서킷 도메인. */
export type ExitReason = 'SELL_SIGNAL' | 'STOP' | 'STOP_LOSS' | 'CIRCUIT' | 'MANUAL';

/** 신호 발생 시점의 스냅샷(거래 기록용). */
export interface SignalSnapshot {
  price: number;
  slope: number;
  accel: number;
  ts: number;
}

export interface OrderRequest {
  ticker: string;
  qty: number;
}

export type OrderRef = string;

export interface FillResult {
  filled: boolean;
  price?: number;
  qty?: number;
  /**
   * **관찰이 확정된** 누적 체결 수량(부분체결 포함).
   *
   * ⚠ `undefined`는 "아직 확정하지 못했다"이지 0이 아니다. 자동 취소 복귀(abandonBuy) 경로는
   * 이 값이 **명시적으로 0**일 때만 미체결로 단정한다(fail-closed) — 모르는 걸 0으로 취급했다가
   * 부분체결분이 계좌에 남는 유령 포지션이 생긴 것이 과거 사고의 핵심이었다.
   */
  partialQty?: number;
}

/**
 * 취소를 요청한 이유. 포트 구현이 거절 처리 정책을 경로별로 나눌 수 있게 한다.
 *  'stop'    — 사용자 Stop. 거절되면 즉시 FAULT(기존 동작).
 *  'abandon' — 매수 미체결 자동 포기. "취소 중 체결" 레이스가 잦아 유예 후 FAULT.
 */
export type CancelReason = 'stop' | 'abandon';

/**
 * 취소 요청의 진행 상태(레이스 방지의 핵심).
 *  'none'      — 취소 요청 안 함.
 *  'pending'   — 취소 요청했으나 아직 성공/거절이 확정되지 않음.
 *  'confirmed' — 취소 성공 = 그 주문은 진짜 미체결이었다(안전하게 미체결 단정 가능).
 *  'rejected'  — 취소 거절 = 이미 체결됐을 가능성이 높다(미체결 단정 금지 → 체결 확인 경로로).
 */
export type CancelState = 'none' | 'pending' | 'confirmed' | 'rejected';

/** 주문·체결확인 포트. 구현(KIS REST)은 5단계 몫. 동기 인터페이스로 코어를 결정적으로 유지. */
export interface OrderPort {
  buy(req: OrderRequest): OrderRef;
  sell(req: OrderRequest): OrderRef;
  /** 취소 요청. reason 미지정은 'stop'(사용자 Stop) — 기존 구현체는 인자를 무시해도 계약을 만족한다. */
  cancel(ref: OrderRef, reason?: CancelReason): void;
  checkFilled(ref: OrderRef): FillResult;
  /**
   * 취소 요청의 확정 상태를 동기로 반환한다. RunCycle은 타임아웃으로 취소를 지시한 뒤,
   * "취소 성공(confirmed)"이 확인되기 전까지는 미체결로 단정하지 않는다(늦은 체결 레이스 방지).
   */
  cancelState(ref: OrderRef): CancelState;
}

/** 시각 주입 — 실시간 의존 금지. */
export interface Clock {
  now(): number;
}

export interface Position {
  ticker: string;
  qty: number;
  entryPrice: number;
  entryTs: number;
  entrySnapshot: SignalSnapshot;
}

export interface TradeRecord {
  ticker: string;
  qty: number;
  entryPrice: number;
  entryTs: number;
  exitPrice: number;
  exitTs: number;
  /**
   * **순손익** = grossPnl - fees. 마틴게일·세션 성과·오토런 수량 판정이 전부 이 값을 기준으로 한다.
   * (수수료율이 0이면 grossPnl과 같다 — 기존 동작.)
   */
  pnl: number;
  /**
   * 수수료 차감 전 손익 = (exitPrice - entryPrice) * qty.
   * 사후 분석용 — "수수료가 없었다면?"을 되돌려 볼 수 있다. 옛 기록에는 없어 optional.
   */
  grossPnl?: number;
  /** 이 사이클에 부과된 총 수수료(매수·매도 대금 합산, USD). 수수료율 0이면 0. 옛 기록에는 없어 optional. */
  fees?: number;
  entrySnapshot: SignalSnapshot;
  /** STOP 청산 등 신호 없이 나간 경우 null. */
  exitSnapshot: SignalSnapshot | null;
  exitReason: ExitReason;
}

export interface RunCycleOptions {
  ticker: string;
  qty: number;
  port: OrderPort;
  clock: Clock;
  /**
   * @deprecated 더 이상 사용하지 않는다(무한 대기). 예전엔 미체결 취소까지의 대기 시간이었으나,
   * 실기기에서 "취소가 KIS에 거절됐는데 주문은 미체결로 살아있는" 오작동이 재현돼 자동 타임아웃 취소를 없앴다.
   * 이제 BUYING/SELLING은 체결될 때까지 무한정 대기하며, 취소는 오직 사용자 Stop 경로에서만 시도한다.
   * 옵션 시그니처는 호출부 호환을 위해 남겨 두되 값은 무시한다.
   *
   * 후속(2026-08-06): 매수 한정 자동 취소가 `abandonBuy()` + 러너의 `buyCancelAfterMs`로 **다른 이름**으로
   * 재도입됐다(이 옵션과 무관·기본 끔). 되돌리는 경로에 "취소 확정 + 0주 재확인 + 부분체결 제외"를 요구해
   * 위 사고의 원인(취소 결과를 확인하지 않고 되돌림)을 구조적으로 막는다.
   */
  fillTimeoutMs?: number;
  /**
   * 거래 수수료율 — **소수**(0.0025 = 0.25%), **편도 기준**. 미지정·0이면 수수료를 반영하지 않는다(기존 동작).
   * 매수 체결대금과 매도 체결대금에 각각 곱해 손익에서 뺀다(왕복이면 실질 두 번).
   */
  feeRate?: number;
  /** 사이클 종료 시 거래 기록 발행 콜백. */
  onTrade?: (record: TradeRecord) => void;
}

/** 수수료율 정리 — 유한한 양수만 유효, 그 외는 0(끔). NaN이 손익을 오염시키지 않게 막는 유일 지점. */
export function normalizeFeeRate(rate: number | undefined): number {
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : 0;
}

/** 정산 기록 합성 입력 — 진입 쪽(우리가 산 포지션이면 실측, 입양이면 없음)과 청산 쪽. */
export interface TradeRecordInput {
  ticker: string;
  qty: number;
  entryPrice: number;
  exitPrice: number;
  exitReason: ExitReason;
  /** 진입 시각·스냅샷 — 사이클이 있으면 실측, 입양(잔고에서 주워 온) 포지션이면 null → 청산 시각·가격으로 폴백. */
  entry?: { entryTs: number; entrySnapshot: SignalSnapshot } | null;
  exitSnapshot?: SignalSnapshot | null;
  /** 편도 수수료율(소수). 유한한 양수 외는 0. */
  feeRate?: number;
  /** 청산 시각(ms) — 호출자의 시계에서 읽어 넘긴다. */
  now: number;
}

/**
 * 거래 기록(TradeRecord) 합성 — 손익·수수료 규칙의 **유일한** 자리.
 * grossPnl = (청산가 − 진입가) × 수량, fees = 편도 요율 × (매수 대금 + 매도 대금)(증권사 과금 구조), pnl = gross − fees.
 * 사이클 정산·OCO 그리드 정산·조건부 그리드 정산·수동청산 정산이 모두 이 함수를 쓴다.
 */
export function makeTradeRecord(input: TradeRecordInput): TradeRecord {
  const { ticker, qty, entryPrice, exitPrice, exitReason, now } = input;
  const grossPnl = (exitPrice - entryPrice) * qty;
  const fees = normalizeFeeRate(input.feeRate) * (entryPrice * qty + exitPrice * qty);
  return {
    ticker,
    qty,
    entryPrice,
    entryTs: input.entry?.entryTs ?? now,
    exitPrice,
    exitTs: now,
    pnl: grossPnl - fees,
    grossPnl,
    fees,
    entrySnapshot: input.entry?.entrySnapshot ?? { price: entryPrice, slope: 0, accel: 0, ts: now },
    exitSnapshot: input.exitSnapshot ?? null,
    exitReason,
  };
}

export class RunCycle {
  private readonly ticker: string;
  private readonly qty: number;
  private readonly port: OrderPort;
  private readonly clock: Clock;
  private readonly feeRate: number;
  private readonly onTrade?: (record: TradeRecord) => void;

  private _state: CycleState = 'IDLE';
  private _position: Position | null = null;

  // 진행 중 주문 추적
  private pendingRef: OrderRef | null = null;
  private pendingSnapshot: SignalSnapshot | null = null;
  private exitReason: ExitReason = 'SELL_SIGNAL';
  /**
   * 사용자 Stop으로 미체결 매수 취소를 지시한 뒤 그 결과를 기다리는 중인가(오직 Stop 경로에서만 set).
   * true인 동안은 미체결로 단정해 되돌아가지 않는다 — 취소 성공(confirmed)이 확인되면 종료(DONE),
   * 그 사이 늦은 체결이 관찰되면 정상 보유 전환(HOLDING). 취소 거절은 러너(ScalperInstance)가 FAULT로 승격한다.
   */
  private awaitingCancel = false;
  /**
   * 매수 미체결 자동 포기(abandonBuy)를 지시하고 결과를 기다리는 중인가. awaitingCancel(Stop)과 **의도적으로 분리**한다.
   *  · Stop    → 취소 성공 확인 시 DONE (사용자가 멈춘 것)
   *  · abandon → 취소 성공 **그리고** 0주 체결 확정 시 WATCH_BUY (감시 복귀)
   * 둘이 겹치면 Stop이 이긴다(사용자 의도 우선).
   */
  private abandoning = false;
  /**
   * 이 주문에 취소를 이미 한 번 요청했는가 — **재취소 발사 금지**.
   * 취소를 반복해서 쏘는 동작이 과거 사고에서 오판을 증폭시킨 요인이었다.
   */
  private cancelRequested = false;

  constructor(options: RunCycleOptions) {
    this.ticker = options.ticker;
    this.qty = options.qty;
    this.port = options.port;
    this.clock = options.clock;
    this.feeRate = normalizeFeeRate(options.feeRate);
    this.onTrade = options.onTrade;
  }

  get state(): CycleState {
    return this._state;
  }

  get position(): Position | null {
    return this._position;
  }

  /** Run 시작: IDLE 또는 DONE에서만 감시를 개시한다(자동 재진입 아님 — 사용자 재실행). */
  start(): void {
    if (this._state !== 'IDLE' && this._state !== 'DONE') return;
    this._state = 'WATCH_BUY';
    this._position = null;
    this.clearPending();
  }

  /**
   * 미체결 매수 포기 요청 — 러너(타이머)가 "N초 안 붙었고 관찰 체결량 0"을 확인한 뒤에만 부른다.
   *
   * **여기서 상태를 바꾸지 않는다.** 취소 성공(confirmed)과 0주 확정이 폴에서 모두 확인돼야 WATCH_BUY로 돌아간다.
   * 과거 사고("취소했으니 미체결이 맞다"고 단정하고 되돌린 것)를 구조적으로 막는 지점이다.
   *
   * @returns 요청이 접수되면 true(러너의 이벤트·카운터용).
   */
  abandonBuy(): boolean {
    if (this._state !== 'BUYING') return false;
    if (this.cancelRequested) return false; // Stop 취소 진행 중이거나 이미 요청함 — 재발사 금지
    if (!this.pendingRef) return false;
    this.port.cancel(this.pendingRef, 'abandon');
    this.cancelRequested = true;
    this.abandoning = true;
    return true;
  }

  /** 변곡점 신호 수신. 상태에 맞는 신호만 반응한다. */
  onSignal(signal: Signal, snapshot: SignalSnapshot): void {
    if (this._state === 'WATCH_BUY' && signal === 'BUY') {
      this.placeBuy(snapshot);
    } else if (this._state === 'HOLDING' && signal === 'SELL') {
      this.placeSell(snapshot, 'SELL_SIGNAL');
    }
    // 그 외 상태·신호는 무시 (1포지션·1사이클 원칙)
  }

  /** 체결/타임아웃 점검. 구동 루프가 주기적으로 호출한다(clock.now 사용). */
  poll(): void {
    if (this._state === 'BUYING') this.pollBuying();
    else if (this._state === 'SELLING') this.pollSelling();
  }

  /**
   * 안전 인터록 — 러너가 async 브로커 오류(체결 확인/발주/취소 실패)를 감지하면 호출한다.
   * 진행 중 주문 추적을 버리되(clearPending) **취소는 하지 않는다** — 취소조차 신뢰할 수 없기 때문.
   * 포지션은 보존한다(사용자가 계좌에서 직접 처리). 이후 onSignal·poll은 무반응, stop()만 빠져나온다.
   */
  fault(): void {
    if (this._state === 'DONE' || this._state === 'FAULT') return;
    this.clearPending();
    this._state = 'FAULT';
  }

  /**
   * Stop: 포지션 없으면 즉시 종료, 보유 중이면 전량 매도 후 종료. 어느 상태든 가능.
   * 미체결 취소는 오직 이 경로에서만 일어난다(자동 타임아웃 취소는 제거됨 — 무한 대기).
   */
  stop(): void {
    switch (this._state) {
      case 'IDLE':
      case 'WATCH_BUY':
        this._state = 'DONE';
        break;
      case 'FAULT':
        // 동결 해제 — 오류 상황이므로 추가 주문/취소 없이 종료만 한다(포지션은 계좌에서 수동 처리).
        this.clearPending();
        this._state = 'DONE';
        break;
      case 'BUYING':
        // 진행 중 매수를 취소 시도하고, 취소 결과를 기다린다(즉시 DONE 아님).
        //  · 취소 성공(confirmed) 확인 → DONE (포지션 없음).
        //  · 그 사이 늦은 체결 관찰 → HOLDING (실제 매수됨 — 계좌에서 확인).
        //  · 취소 거절(rejected) → 러너가 FAULT로 승격(미체결 주문이 계좌에 남아있을 수 있음).
        if (this.pendingRef) {
          // 자동 포기가 이미 취소를 쐈다면 재발사하지 않는다 — 재취소 반복은 과거 사고의 증폭 요인.
          // 다만 awaitingCancel은 세운다: Stop이 abandon을 이겨 DONE으로 마감된다(사용자 의도 우선).
          if (!this.cancelRequested) this.port.cancel(this.pendingRef, 'stop');
          this.cancelRequested = true;
          this.awaitingCancel = true;
        } else {
          this.clearPending();
          this._state = 'DONE';
        }
        break;
      case 'HOLDING':
        this.placeSell(null, 'STOP');
        break;
      case 'SELLING':
        // 이미 청산(매도) 진행 중 — 그 매도가 곧 청산이므로 취소하지 않고 체결을 기다린다(무한 대기).
        // 사유만 STOP으로 승격해 완료 시 STOP 청산으로 기록되게 한다.
        this.exitReason = 'STOP';
        break;
      case 'DONE':
        break;
    }
  }

  // ---- 내부 전이 ----

  private placeBuy(snapshot: SignalSnapshot): void {
    this.pendingRef = this.port.buy({ ticker: this.ticker, qty: this.qty });
    this.pendingSnapshot = snapshot;
    this.awaitingCancel = false;
    this.abandoning = false;
    this.cancelRequested = false;
    this._state = 'BUYING';
  }

  private placeSell(snapshot: SignalSnapshot | null, reason: ExitReason): void {
    this.pendingRef = this.port.sell({ ticker: this.ticker, qty: this.qty });
    this.pendingSnapshot = snapshot;
    this.exitReason = reason;
    this.awaitingCancel = false;
    this.abandoning = false;
    this.cancelRequested = false;
    this._state = 'SELLING';
  }

  private enterHolding(fill: FillResult): void {
    const entrySnap = this.pendingSnapshot!;
    this._position = {
      ticker: this.ticker,
      qty: this.qty,
      entryPrice: fill.price ?? entrySnap.price,
      entryTs: this.clock.now(),
      entrySnapshot: entrySnap,
    };
    this.clearPending();
    this._state = 'HOLDING';
  }

  /**
   * 매수 체결 대기 폴. **분기 순서가 곧 안전 계약**이다 — 위에서부터 우선순위가 높다.
   *  ① 체결 확인이 항상 최우선(늦은 체결 구제)
   *  ② Stop 취소 확정 → DONE (사용자 의도가 자동 포기보다 우선)
   *  ③ 자동 포기 확정 + 0주 확정 → WATCH_BUY (감시 복귀)
   * 어디에도 해당하지 않으면 아무것도 하지 않는다 = BUYING 유지(무한 대기, 기본 동작).
   */
  private pollBuying(): void {
    // 러너가 poll 직전 fetchFills로 캐시를 갱신하므로 이 값은 최신이다.
    const fill = this.port.checkFilled(this.pendingRef!);
    if (fill.filled) {
      this.enterHolding(fill);
      return;
    }
    if (this.awaitingCancel) {
      // 사용자 Stop으로 취소를 지시했고 결과를 기다리는 중 — "취소 성공(진짜 미체결)"이 확인되면 종료한다.
      // 'rejected'(이미 체결 추정)는 위 체결 확인으로 보유 전환되거나, 확인 불가 시 러너가 FAULT로 승격한다.
      if (this.port.cancelState(this.pendingRef!) === 'confirmed') {
        this.clearPending();
        this._state = 'DONE'; // Stop 취소 성공 → 매수 없이 종료
      }
      return;
    }
    if (this.abandoning) {
      // 취소가 확정되기 전에는 절대 되돌리지 않는다(과거 사고: 취소 실패를 무시하고 되돌려 재매수 반복).
      if (this.port.cancelState(this.pendingRef!) !== 'confirmed') return;
      // ★ 엄격 비교. undefined(= 관찰 미확정)나 >0(부분체결)이면 되돌리지 않는다 — fail-closed.
      //   되돌리지 못한 채 부분체결이 드러나면 러너가 FAULT로 승격해 사람을 부른다.
      if (fill.partialQty !== 0) return;
      this.clearPending();
      // DONE을 스치지 않는다 — 러너의 타이머·리샘플 버퍼·detector(prevSlope)가 전부 보존되고,
      // 그 덕에 재매수에 최소 2~3청크의 구조적 간격이 그대로 유지된다.
      this._state = 'WATCH_BUY';
      return;
    }
    // 그 외에는 아무것도 하지 않는다 — 체결이 올 때까지 BUYING 유지(무한 대기).
  }

  private pollSelling(): void {
    // 체결 확인 우선. 타임아웃 자동취소 없음 — 매도가 체결될 때까지 무한 대기한다(SELL_SIGNAL·STOP 청산 모두).
    const fill = this.port.checkFilled(this.pendingRef!);
    if (fill.filled) {
      this.emitTrade(fill);
      this._position = null;
      this.clearPending();
      this._state = 'DONE';
      return;
    }
    // 매도는 Stop 경로에서도 취소하지 않는다(그 매도 자체가 청산) — 체결을 기다린다.
  }

  private emitTrade(fill: FillResult): void {
    const pos = this._position!;
    const exitPrice = fill.price ?? this.pendingSnapshot?.price ?? pos.entryPrice;
    const record = makeTradeRecord({
      ticker: pos.ticker,
      qty: pos.qty,
      entryPrice: pos.entryPrice,
      exitPrice,
      entry: pos,
      exitSnapshot: this.pendingSnapshot,
      exitReason: this.exitReason,
      feeRate: this.feeRate,
      now: this.clock.now(),
    });
    this.onTrade?.(record);
  }

  private clearPending(): void {
    this.pendingRef = null;
    this.pendingSnapshot = null;
    this.exitReason = 'SELL_SIGNAL';
    this.awaitingCancel = false;
    this.abandoning = false;
    this.cancelRequested = false;
  }
}
