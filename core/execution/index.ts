// core/execution — 매매(Execution) 도메인: 주문 1건을 현재가 추격으로 체결까지 책임진다 (순수 TS).
//
// 도메인 문서: docs/domain/매매/2026-08-15_매매-도메인-plan.md
//  · 판단(언제·왜)은 변곡점+조건부 그리드 몫 — 매매는 방향·수량만 받고 **판단하지 않는다**.
//    취소선(shouldAbort)조차 판단 쪽이 술어로 주입한다(문턱 %값은 판단 소유).
//  · 현재가 지정가 발주 → 체결되면 끝(DONE). 미체결 중 현재가가 바뀌면 **정정(amend)** 으로 추격한다
//    (취소→재발주가 아니라 정정 — 원자 교체라 무주문 공백·이중 주문 레이스가 없고 REST 1회로 끝난다).
//  · 추격 중 취소선 도달 → 잔량 취소하고 CANCELLED(체결분만 보고) — 판단이 다음 변곡점을 기다린다.
//  · 부분 체결은 잔량만 추격한다(문서 열린 문제 #2의 확정). 재정정은 최소 간격 스로틀(문제 #1).
//  · 취소/정정 거절은 "이미 체결"(잔량 없음) 신호일 수 있어 재발사 없이 추격만 멈추고, 폴의 수량 실측이
//    판정한다 — 체결 확정=DONE, 잔량 생존 실측(정정)=추격 재개, 한도 폴까지 모호하면 FAULT(문제 #3).
//
// 주문 발주/정정/취소/체결확인은 포트로 주입받아 vitest로 전 분기를 재생 검증한다(Grid와 같은 원칙).

import { roundGridPrice } from '../grid';

/** 시각 주입 — core.Clock / kis.ClockLike와 동일 계약. */
export interface ClockLike {
  now(): number;
}

/** 체결 스냅샷 1건 — GridOrderFill과 같은 모양(브로커 fetchFills 계약). */
export interface ExecutionOrderFill {
  odno: string;
  orderQty: number;
  filledQty: number;
  /** 평균 체결단가 — 미확정이면 null("목록 부재→전량체결" 추론). */
  filledPrice: number | null;
  /**
   * 미체결 목록 **실측** 스냅샷인가 — true면 주문이 목록에 살아 있고 filledQty는 잔량 역산 실측.
   * false/미지정은 추론(목록 부재, 유예, 정정 왕복 보류). 정정 거절 후 "주문 생존" 판정에만 쓴다.
   */
  listed?: boolean;
}

/**
 * 매매가 의존하는 주문 게이트웨이 — 정확 지정가 + 정정 + 취소.
 * 실서비스는 ScalperBroker를 감싼 얇은 글루(features/scalper/executionPort.ts), 테스트는 가짜 심.
 */
export interface ExecutionOrderPort {
  placeOrder(side: 'buy' | 'sell', qty: number, price: number): Promise<{ odno: string }>;
  /** 정정 — 새 odno를 돌려준다(옛 odno는 소멸). 거절이면 throw. */
  amendOrder(odno: string, side: 'buy' | 'sell', qty: number, price: number): Promise<{ odno: string }>;
  cancelOrder(odno: string, qty: number): Promise<void>;
  fetchFills(): Promise<ExecutionOrderFill[]>;
}

/**
 * 상태:
 *  IDLE      — start 전.
 *  WORKING   — 주문 접수, 체결 대기·추격 중.
 *  DONE      — 전량 체결(끝). result에 체결 요약.
 *  CANCELLED — 취소선 도달(또는 release)로 잔량 취소·종료. result에 체결분(부분 체결분 포함).
 *  FAULT     — 발주/정정/취소/체결확인이 반복 실패로 신뢰 불가 → 동결(신규 호출 무시).
 */
export type ExecutionState = 'IDLE' | 'WORKING' | 'DONE' | 'CANCELLED' | 'FAULT';

export interface ExecutionResult {
  /** 이 매매에서 체결된 총 수량(부분 체결 포함, CANCELLED면 0일 수 있다). */
  filledQty: number;
  /** 체결 가중평균 단가 — 체결이 없으면 null. 추론 체결(가격 미확정)은 그 다리의 지정가로 대체된다. */
  fillPrice: number | null;
  /**
   * 체결가가 전부 실측인가 — false면 일부가 "목록 부재→전량체결" 추론이다.
   * 매도 정산 전 잔고 검증(호출부)의 트리거로 쓴다(세션 일괄 취소 오판 방어).
   */
  priceConfirmed: boolean;
}

export type ExecutionPollResult =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'done'; result: ExecutionResult }
  | { kind: 'cancelled'; result: ExecutionResult }
  | { kind: 'fault'; reason: string };

export interface ExecutionDeps {
  port: ExecutionOrderPort;
  clock: ClockLike;
  side: 'buy' | 'sell';
  qty: number;
  /**
   * 취소선 술어 — true면 추격을 접고 잔량을 취소한다(CANCELLED). 판단(조건부 그리드)이 주입한다.
   * 매매는 이 술어의 내용을 모른다 — "판단하지 않는다" 계약의 구현 지점.
   */
  shouldAbort: (price: number) => boolean;
  /** 재정정 최소 간격(ms, 기본 1000) — KIS REST 유량 방어. 현재가가 틱마다 바뀌어도 이 간격으로만 정정한다. */
  minReorderIntervalMs?: number;
  /**
   * 정정 거절 라운드 한도(기본 3) — 거절 1회마다 추격을 동결하고 폴이 "주문 생존(listed 잔량)"을
   * 실측한 뒤에만 재개하므로, 한도 도달 = 살아 있는 주문의 정정이 3라운드 연속 거절(진짜 API 장애).
   * 이미 체결된 주문의 거절(APBK0124)은 폴의 체결 확정(DONE)으로 흡수돼 여기 오지 않는다.
   */
  amendFailLimit?: number;
  /** 체결확인 연속 실패 한도(기본 3) — Grid.FILL_FAIL_LIMIT와 같은 원칙. */
  fillFailLimit?: number;
  /** 취소·정정 거절 후 체결(정정은 생존도)이 확인되지 않는 폴 수 한도(기본 3) — 도달 시 FAULT(모호 — 사람 호출). */
  cancelAmbiguityLimit?: number;
}

interface ExecLeg {
  odno: string;
  qty: number;
  price: number;
}

export class Execution {
  private readonly port: ExecutionOrderPort;
  private readonly clock: ClockLike;
  readonly side: 'buy' | 'sell';
  readonly qty: number;
  private readonly shouldAbort: (price: number) => boolean;
  private readonly minReorderIntervalMs: number;
  private readonly amendFailLimit: number;
  private readonly fillFailLimit: number;
  private readonly cancelAmbiguityLimit: number;

  private _state: ExecutionState = 'IDLE';
  private faultReason: string | null = null;
  private leg: ExecLeg | null = null;
  private lastOrderAt = 0;

  /** 정정으로 소멸한 옛 다리들의 체결 적립(수량·대금·실측 여부) — 현재 다리 관찰과 합산해 총 체결이 된다. */
  private bankedQty = 0;
  private bankedCost = 0;
  private bankedConfirmed = true;
  /** 현재 다리에서 마지막 폴이 관찰한 체결. */
  private observedQty = 0;
  private observedPrice: number | null = null;

  /**
   * 취소/정정이 거절돼 "이미 체결 추정" 상태 — 폴이 체결을 확정할 때까지 추격을 멈춘다.
   * 재취소 반복 금지(RunCycle과 같은 원칙 — 재발사가 과거 사고의 오판 증폭 요인).
   */
  private cancelAmbiguous = false;
  private cancelAmbiguousPolls = 0;
  /**
   * 정정이 거절돼 "이미 체결 추정" 상태 — 재정정을 멈추고 폴의 수량 실측을 기다린다(재발사 금지, §4-3).
   *  · 폴이 전량 체결을 확정 → DONE (2026-08-18 사고의 정상 경로 — APBK0124는 잔량 없음 신호였다).
   *  · 폴이 잔량 있는 생존(listed)을 실측 → 거절은 일시 장애였다 — 동결 해제, 추격 재개.
   *  · 한도 폴까지 둘 다 확인 안 되면 FAULT(모호 — 사람 호출).
   */
  private amendAmbiguous = false;
  private amendAmbiguousPolls = 0;
  private lastAmendError: string | null = null;
  /** 취소선 도달로 취소했는가(true) vs release 호출인가 — 결과 의미는 같아 상태만 CANCELLED로 둔다. */
  private amendFailStreak = 0;
  private fillFailStreak = 0;
  /** 비동기 재진입 방지 — onPrice(1초 틱)와 poll(2초 폴)이 서로 다른 타이머에서 겹쳐 들어온다. */
  private busy = false;

  constructor(deps: ExecutionDeps) {
    this.port = deps.port;
    this.clock = deps.clock;
    this.side = deps.side;
    this.qty = deps.qty;
    this.shouldAbort = deps.shouldAbort;
    this.minReorderIntervalMs = deps.minReorderIntervalMs ?? 1000;
    this.amendFailLimit = deps.amendFailLimit ?? 3;
    this.fillFailLimit = deps.fillFailLimit ?? 3;
    this.cancelAmbiguityLimit = deps.cancelAmbiguityLimit ?? 3;
  }

  get state(): ExecutionState {
    return this._state;
  }

  get faultText(): string | null {
    return this.faultReason;
  }

  /** 현재 걸려 있는 지정가(추격 위치) — WORKING이 아니면 null. UI·이벤트 문구용. */
  get orderPrice(): number | null {
    return this._state === 'WORKING' ? (this.leg?.price ?? null) : null;
  }

  /** 지금까지 확인된 체결 요약(진행 중에도 조회 가능). */
  get result(): ExecutionResult {
    const total = this.totalFilled();
    return {
      filledQty: total,
      fillPrice: total > 0 ? this.totalCost() / total : null,
      priceConfirmed: this.bankedConfirmed && (this.observedQty === 0 || this.observedPrice !== null),
    };
  }

  /** 매매 시작 — 현재가 정확 지정가 1건 발주. 발주 실패는 즉시 FAULT(아직 주문이 없어 안전). */
  async start(price: number): Promise<void> {
    if (this._state !== 'IDLE') return;
    const target = roundGridPrice(price);
    try {
      const { odno } = await this.port.placeOrder(this.side, this.qty, target);
      this.leg = { odno, qty: this.qty, price: target };
      this.lastOrderAt = this.clock.now();
      this._state = 'WORKING';
    } catch (err) {
      this.enterFault(`발주 실패 — ${summarize(err)}`);
    }
  }

  /**
   * 현재가 갱신 1회(빠른 틱이 부른다) — 취소선 판정이 추격보다 우선한다.
   *  · 취소선 도달 → 잔량 취소 → CANCELLED (취소 거절이면 "이미 체결 추정" — 폴 확정 대기).
   *  · 가격이 바뀌었고 스로틀 경과 → 잔량을 새 현재가로 **정정**(새 odno로 교체).
   */
  async onPrice(price: number): Promise<void> {
    if (this._state !== 'WORKING' || this.busy || this.leg === null) return;
    if (!Number.isFinite(price) || price <= 0) return;
    this.busy = true;
    try {
      if (this.shouldAbort(price)) {
        await this.cancelRemaining();
        return;
      }
      if (this.cancelAmbiguous || this.amendAmbiguous) return; // 취소/정정 거절 후 — 폴이 수량을 확정할 때까지 손대지 않는다.
      const target = roundGridPrice(price);
      if (target === this.leg.price) return;
      if (this.clock.now() - this.lastOrderAt < this.minReorderIntervalMs) return;
      const remaining = this.qty - this.totalFilled();
      if (remaining < 1) return; // 전량 체결 추정 — 폴이 DONE을 확정한다.
      try {
        const { odno } = await this.port.amendOrder(this.leg.odno, this.side, remaining, target);
        // 옛 다리의 관찰 체결을 적립하고 새 다리로 원자 교체(정정 성공 = 옛 odno 소멸).
        this.bankObserved();
        this.leg = { odno, qty: remaining, price: target };
        this.lastOrderAt = this.clock.now();
        this.amendFailStreak = 0;
      } catch (err) {
        // 정정 거절 — "이미 체결"(잔량 없음, APBK0124)이 가장 흔한 원인이다. 재정정을 쏘지 않고(재발사 금지)
        // 동결한 뒤 폴의 수량 실측에 판정을 맡긴다: 체결 확정→DONE, 잔량 생존 실측→추격 재개.
        // 한도(amendFailLimit)는 "생존 실측 후 재개했는데 또 거절"이 반복된 라운드 수 — 진짜 API 장애만 남는다.
        this.amendFailStreak += 1;
        this.lastAmendError = summarize(err);
        if (this.amendFailStreak >= this.amendFailLimit) {
          this.enterFault(`정정 ${this.amendFailStreak}회 연속 거절 — ${this.lastAmendError}`);
          return;
        }
        this.amendAmbiguous = true;
        this.amendAmbiguousPolls = 0;
      }
    } finally {
      this.busy = false;
    }
  }

  /** 체결 폴 1회(느린 폴이 부른다) — 전량 체결이면 DONE. */
  async poll(): Promise<ExecutionPollResult> {
    if (this._state !== 'WORKING') return this.stateResult();
    if (this.busy) return { kind: 'working' };
    this.busy = true;
    try {
      let fills: ExecutionOrderFill[];
      try {
        fills = await this.port.fetchFills();
        this.fillFailStreak = 0;
      } catch (err) {
        this.fillFailStreak += 1;
        if (this.fillFailStreak >= this.fillFailLimit) {
          this.enterFault(`체결 확인 ${this.fillFailStreak}회 연속 실패 — ${summarize(err)}`);
          return { kind: 'fault', reason: this.faultReason! };
        }
        return { kind: 'working' };
      }
      const f = this.leg ? fills.find((x) => x.odno === this.leg!.odno) : undefined;
      if (f) {
        this.observedQty = Math.min(f.filledQty, this.leg!.qty);
        this.observedPrice = f.filledPrice !== null && f.filledPrice > 0 ? f.filledPrice : null;
      }
      if (this.totalFilled() >= this.qty) {
        this._state = 'DONE';
        return { kind: 'done', result: this.result };
      }
      if (this.amendAmbiguous) {
        if (f && f.listed === true && f.filledQty < this.leg!.qty) {
          // 주문이 미체결 목록에 잔량과 함께 살아 있다(실측) — 거절은 일시 장애였다. 추격을 재개한다.
          // (거절 라운드 카운트 amendFailStreak는 유지 — 재개 후 또 거절이 반복되면 FAULT로 간다.)
          this.amendAmbiguous = false;
        } else {
          // 체결 확정도 생존 실측도 아직 없다 — 몇 폴은 반영 지연으로 보고 기다리되, 한도에서 사람을 부른다.
          this.amendAmbiguousPolls += 1;
          if (this.amendAmbiguousPolls >= this.cancelAmbiguityLimit) {
            this.enterFault(
              `정정이 거절됐는데 체결도 확인되지 않아요 — ${this.lastAmendError ?? '원인 미상'} — 계좌에서 주문을 확인해 주세요`,
            );
            return { kind: 'fault', reason: this.faultReason! };
          }
        }
      }
      if (this.cancelAmbiguous) {
        // 취소/정정이 거절됐는데 체결도 안 보인다 — 몇 폴은 지연으로 보고 기다리되, 한도에서 사람을 부른다.
        this.cancelAmbiguousPolls += 1;
        if (this.cancelAmbiguousPolls >= this.cancelAmbiguityLimit) {
          this.enterFault('취소가 거절됐는데 체결도 확인되지 않아요 — 계좌에서 주문을 확인해 주세요');
          return { kind: 'fault', reason: this.faultReason! };
        }
      }
      return { kind: 'working' };
    } finally {
      this.busy = false;
    }
  }

  /**
   * 외부 종료(사용자 Stop 등) — 잔량을 최선껏 취소하고 CANCELLED로 마감한다.
   * 취소 거절도 그대로 CANCELLED(재시도 없음) — 주문이 계좌에 남을 수 있음은 호출부가 안내한다.
   */
  async release(): Promise<void> {
    if (this._state !== 'WORKING') return;
    if (this.leg) {
      try {
        await this.port.cancelOrder(this.leg.odno, Math.max(1, this.qty - this.totalFilled()));
      } catch {
        // 최선껏 — 이미 체결/취소된 주문의 거절은 정상이다.
      }
    }
    this._state = 'CANCELLED';
  }

  // ---- 내부 ----

  /** 취소선 도달 — 잔량 취소. 거절이면 "이미 체결 추정"으로 폴 확정 대기(재취소 발사 금지). */
  private async cancelRemaining(): Promise<void> {
    if (this.cancelAmbiguous) return;
    const remaining = Math.max(1, this.qty - this.totalFilled());
    try {
      await this.port.cancelOrder(this.leg!.odno, remaining);
      this._state = 'CANCELLED';
    } catch {
      this.cancelAmbiguous = true;
      this.cancelAmbiguousPolls = 0;
    }
  }

  private bankObserved(): void {
    if (this.observedQty > 0) {
      this.bankedQty += this.observedQty;
      this.bankedCost += this.observedQty * (this.observedPrice ?? this.leg!.price);
      if (this.observedPrice === null) this.bankedConfirmed = false;
    }
    this.observedQty = 0;
    this.observedPrice = null;
  }

  private totalFilled(): number {
    return Math.min(this.qty, this.bankedQty + this.observedQty);
  }

  private totalCost(): number {
    return this.bankedCost + this.observedQty * (this.observedPrice ?? this.leg?.price ?? 0);
  }

  private stateResult(): ExecutionPollResult {
    switch (this._state) {
      case 'DONE':
        return { kind: 'done', result: this.result };
      case 'CANCELLED':
        return { kind: 'cancelled', result: this.result };
      case 'FAULT':
        return { kind: 'fault', reason: this.faultReason ?? '동결됨' };
      default:
        return { kind: 'idle' };
    }
  }

  private enterFault(reason: string): void {
    this.faultReason = reason;
    this._state = 'FAULT';
  }
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
