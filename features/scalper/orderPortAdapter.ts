// OrderPortAdapter — core RunCycle의 "동기" OrderPort를 KIS "async" REST(ScalperBroker)에 브리징한다.
//
// core 계약(수정 금지):
//   OrderPort { buy(req): OrderRef; sell(req): OrderRef; cancel(ref): void; checkFilled(ref): FillResult }
//   - buy/sell/cancel/checkFilled 모두 동기. checkFilled는 즉시 FillResult를 반환해야 한다.
//   - poll() 구동 루프가 checkFilled를 주기적으로 부른다(clock.now로 타임아웃 판정).
//
// 브리징 전략:
//   - buy/sell: 로컬 OrderRef를 "동기"로 만들어 즉시 반환하고, 실제 발주(placeOrder)는 async로 내보낸다(fire-and-forget).
//     발주가 완료되면 KIS odno를 그 ref에 채운다. 발주 실패는 ref에 기록(checkFilled는 계속 미체결 → 타임아웃→cancel 경로).
//   - cancel: odno가 도착했으면 즉시 취소, 아직이면 취소 플래그만 세우고 발주 완료 시점에 취소한다.
//   - checkFilled: 폴러(refreshFills)가 주문체결내역 폴링 결과로 갱신해 둔 캐시를 "동기"로 읽어 반환한다.
//     이 값이 true가 되기 전까지 RunCycle은 미체결로 보고 무한 대기한다(자동 타임아웃 취소 없음). 취소는 오직 Stop 경로.
import { decideBuyReprice, decideReprice } from '../../core/reprice';
import type {
  CancelReason,
  CancelState,
  FillResult,
  OrderPort,
  OrderRef,
  OrderRequest,
} from '../../core/cycle';
import { roundOverseasOrderPrice, roundingForSide } from '../../kis/order';
import type { AdapterFault, ClockLike, ScalperBroker } from './types';

/** 정정이 연속으로 이만큼 거절되면 리프라이스만 자진 중단한다(주문은 그대로 — 기존 무한 대기로 복귀). */
export const AMEND_FAIL_LIMIT = 8;
/** 정정 실패 백오프 상한(ms). kis/에 유량 제어 계층이 없어 자기방어가 필요하다. */
export const AMEND_BACKOFF_MAX_MS = 30_000;
/**
 * 자동 포기 취소가 거절된 뒤 체결도 확인 안 될 때 FAULT로 올리기까지 버티는 폴 횟수(폴 2초 × 3 ≈ 6초).
 * 2~3초 자동 취소는 "취소 요청 중 체결" 레이스가 잦아, 즉시 FAULT로 올리면 오탐이 폭증한다.
 * 유예 동안에도 관찰은 계속되므로 늦은 체결이 오면 정상적으로 HOLDING이 된다. Stop 사유는 유예 없이 즉시 FAULT.
 */
export const ABANDON_REJECT_GRACE_POLLS = 3;

interface PendingOrder {
  ref: OrderRef;
  side: 'buy' | 'sell';
  pdno: string;
  /** 원 주문수량 — **전량 체결 판정의 기준**. 정정해도 바뀌지 않는다. */
  qty: number;
  /** 발주 완료 시 채워지는 KIS 원주문번호. 정정에 성공하면 새 번호로 교체된다. */
  odno: string | null;
  /** 폴러가 갱신하는 동기 반환용 캐시. */
  fill: FillResult;
  /** core가 취소를 요청함(발주 전이면 발주 완료 즉시 취소). */
  cancelRequested: boolean;
  /**
   * 취소의 확정 상태(레이스 방지의 핵심). core는 'confirmed'가 되기 전까지 미체결로 단정하지 않는다.
   *  'none'=취소 요청 없음, 'pending'=요청했으나 KIS 응답 대기, 'confirmed'=취소 성공(진짜 미체결),
   *  'rejected'=취소 거절(이미 체결 추정).
   */
  cancelState: CancelState;
  /** 발주 async 실패 기록. */
  placeError?: unknown;

  // ── 리프라이스(2026-08-04 매도 실행기) ──
  /** 실제 KIS에 접수된 지정가(절사 후). 정정 트리거 비교의 기준 — raw 호가와 비교하면 안 된다. */
  orderPrice: number;
  /** 현재 odno가 명목상 들고 있는 수량. 정정하면 잔량으로 줄어든다(원 수량 qty와 구분). */
  liveQty: number;
  /**
   * 이전 odno들에서 확정된 누적 체결량(절대량 오프셋).
   * 정정 시 새 주문의 ORD_QTY는 "잔량"이라, 새 odno의 체결량은 새 주문 기준이다. 이 오프셋을 더하지 않으면
   * 체결량이 리셋돼 영원히 전량에 도달하지 못한다.
   */
  filledBase: number;
  /**
   * 이전 odno들에서 확정된 누적 체결**대금**(= Σ 수량×가격). filledBase의 금액 쌍둥이.
   * 정정하면 가격대가 바뀌므로 이걸 들고 있어야 전량 체결가를 수량 가중평균으로 낼 수 있다.
   *
   * 근사 가정: 브로커의 체결가(ft_ccld_unpr3)가 해당 odno의 **평균** 체결단가라고 본다. 문서에 평균인지
   * 마지막 체결가인지 명시가 없다 — 어긋나도 오차는 odno 내부 가격 변동폭(보통 1~2틱)에 그친다.
   */
  filledValueBase: number;
  /** 지금까지 관찰된 절대 누적 체결량 = filledBase + 현재 odno 관찰치. 단조 증가. */
  filledQty: number;
  /** 마지막으로 관찰된 체결단가. */
  lastFillPrice: number | null;
  /** 정정 요청 왕복 중 — 이 구간에는 "목록 부재→전량체결" 추론을 보류한다. */
  amendInFlight: boolean;
  /** 연속 정정 실패 횟수(성공 시 0). */
  amendFailStreak: number;
  /** 연속 실패 상한 초과로 리프라이스 자진 중단. */
  repriceDisabled: boolean;
  /** 실패 백오프 — 이 시각 전에는 재시도하지 않는다. */
  amendNotBefore: number;

  // ── 매수 미체결 자동 포기(2026-08-06) ──
  /** 이 취소가 어느 경로에서 왔는가. 미요청이면 null. 거절 처리 정책이 갈린다. */
  cancelReason: CancelReason | null;
  /**
   * 자동 포기 취소가 'confirmed'된 **뒤** 체결내역을 최소 1회 더 조회해 잔량을 확정했는가.
   * 이게 없으면 "취소 확정과 거의 동시에 들어온 부분체결"을 영영 관찰하지 못한 채 0주로 단정하게 된다
   * (confirmed가 되면 그 주문은 관찰 대상에서 빠지므로) — 유령 포지션의 유일한 잔여 구멍이었다.
   */
  abandonVerified: boolean;
  /** 자동 포기 취소가 거절된 뒤 체결도 확인 안 된 채 지나간 폴 횟수(FAULT 승격 유예 카운터). */
  rejectGracePolls: number;
}

export interface OrderPortAdapterOptions {
  broker: ScalperBroker;
  /** 발주/취소 async 실패 통지(옵션). */
  onError?: (err: unknown) => void;
  /** 호가 신선도 판정용 시계(기본 Date.now). */
  clock?: ClockLike;
  /** 호가를 "오래됐다"고 보는 기준(ms, 기본 10000). 초과하면 마지막 체결가로 폴백한다. */
  quoteStaleMs?: number;
  /**
   * 매수 발주가를 **마지막 체결가(limitPrice)**로 — 매도1호가 크로스를 쓰지 않는다(2026-09-02 기울기 단타, 사용자 확정:
   * "호가로 주문을 거니 너무 손해보고 매수한다"). 안 붙으면 설정의 매수 미체결 취소가 정리한다. 매도는 그대로 매수1호가 크로스.
   */
  buyAtLastPrice?: boolean;
}

export class OrderPortAdapter implements OrderPort {
  private readonly broker: ScalperBroker;
  private readonly onError?: (err: unknown) => void;
  private readonly clock: ClockLike;
  private readonly quoteStaleMs: number;
  private readonly buyAtLastPrice: boolean;
  private readonly orders = new Map<OrderRef, PendingOrder>();
  private seq = 0;
  /** 지정가 발주에 쓸 폴백 기준가(마지막 체결가) — 러너가 신호 직전 최신가로 갱신한다. 호가가 없거나 오래됐을 때만 쓴다. */
  private limitPrice = 0;
  /** 최신 1호가 캐시(공격적 지정가용) — 매수1호가/매도1호가와 수신시각. 0은 "유효 호가 없음". */
  private bid1 = 0;
  private ask1 = 0;
  private quoteAt = Number.NEGATIVE_INFINITY;
  /**
   * 안전 인터록 — fire-and-forget 발주·취소 오류나 체결 확인 실패가 조용히 삼켜지지 않도록 여기 모은다.
   * 러너가 매 폴/틱마다 takeFault()로 회수해 인스턴스를 FAULT로 전환한다. 첫 오류만 보존한다(먼저 감지된 원인).
   */
  private pendingFault: AdapterFault | null = null;

  constructor(options: OrderPortAdapterOptions) {
    this.broker = options.broker;
    this.onError = options.onError;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.quoteStaleMs = options.quoteStaleMs ?? 10_000;
    this.buyAtLastPrice = options.buyAtLastPrice ?? false;
  }

  /** 감지됐지만 아직 회수되지 않은 오류가 있는가(러너의 동기 가드용). */
  hasFault(): boolean {
    return this.pendingFault !== null;
  }

  /** 모아 둔 오류를 회수(1회성) — 러너가 FAULT 전환에 쓴다. */
  takeFault(): AdapterFault | null {
    const f = this.pendingFault;
    this.pendingFault = null;
    return f;
  }

  /**
   * 매수 프리플라이트 — 체결 확인 API(fetchFills)가 지금 정상 동작하는지 1회 확인한다.
   * 죽어 있으면(throw) 오류를 반환한다 → 러너는 주문을 내지 않고 FAULT. (중복 매수 최소장치)
   * 정상이면 null. pendingFault에 쌓지 않고 즉시 반환한다(러너가 그 자리에서 처리).
   */
  async preflightCheckFills(): Promise<AdapterFault | null> {
    try {
      await this.broker.fetchFills();
      return null;
    } catch (err) {
      this.onError?.(err);
      return { kind: 'FILL_CHECK', reason: summarizeError(err) };
    }
  }

  private setFault(fault: AdapterFault, err: unknown): void {
    if (!this.pendingFault) this.pendingFault = fault;
    this.onError?.(err);
  }

  /** 러너가 매 신호 직전(또는 매 틱) 호출해 폴백 기준가를 최신 체결가로 둔다. */
  setLimitPrice(price: number): void {
    if (Number.isFinite(price) && price > 0) this.limitPrice = price;
  }

  /**
   * 최신 1호가 캐시 갱신 — 러너가 1호가(체결가 페이로드의 PBID/PASK) 수신 때마다 호출한다.
   * bid/ask는 유효(유한·양수)할 때만 반영하고, 수신시각(at)은 신선도 판정에 쓴다.
   */
  setQuote(bid1: number, ask1: number, at: number): void {
    this.bid1 = Number.isFinite(bid1) && bid1 > 0 ? bid1 : 0;
    this.ask1 = Number.isFinite(ask1) && ask1 > 0 ? ask1 : 0;
    this.quoteAt = at;
  }

  /**
   * 발주 단가 결정 — 공격적 지정가: 매수는 매도1호가(ask1), 매도는 매수1호가(bid1)에 걸어 반대편 호가를 크로스한다.
   * 호가가 없거나 오래됐으면(quoteStaleMs 초과) 마지막 체결가(limitPrice)로 폴백한다 — 호가 미수신이 발주를 막지 않는다.
   * resolveOrderPrice(실제 발주 경로)·previewOrderPrice(표시 전용)가 이 계산 하나를 공유한다(단일 소스, 중복 구현 없음).
   */
  private computeOrderPrice(side: 'buy' | 'sell'): { price: number; usedQuote: boolean } {
    // 매수를 현재가로(buyAtLastPrice) — 호가 크로스 없이 마지막 체결가에 건다(기울기 단타). 폴백 경로와 같은 값.
    if (side === 'buy' && this.buyAtLastPrice && this.limitPrice > 0) return { price: this.limitPrice, usedQuote: false };
    const fresh = this.clock.now() - this.quoteAt <= this.quoteStaleMs;
    if (fresh) {
      if (side === 'buy' && this.ask1 > 0) return { price: this.ask1, usedQuote: true };
      if (side === 'sell' && this.bid1 > 0) return { price: this.bid1, usedQuote: true };
    }
    return { price: this.limitPrice, usedQuote: false };
  }

  private resolveOrderPrice(side: 'buy' | 'sell'): number {
    return this.computeOrderPrice(side).price;
  }

  /**
   * 발주 단가 미리보기(읽기 전용) — resolveOrderPrice와 완전히 같은 규칙(computeOrderPrice)을 재현해
   * 표시용 가격과 "폴백 중인가"를 반환한다. 실제 주문에는 관여하지 않는다(QuoteSheet 진단용).
   */
  previewOrderPrice(side: 'buy' | 'sell'): { price: number; fallback: boolean } {
    const { price, usedQuote } = this.computeOrderPrice(side);
    // 발주와 같은 절사(매도 내림·매수 올림)까지 재현해 실제 접수가와 정확히 일치시킨다.
    // 단 이건 읽기 전용 진단이라, 아직 가격이 없는 시점(호가·체결가 모두 미수신)에도 호출된다 — 그때는 0 그대로.
    return {
      price: price > 0 ? roundOverseasOrderPrice(price, roundingForSide(side)) : price,
      fallback: !usedQuote,
    };
  }

  buy(req: OrderRequest): OrderRef {
    return this.place('buy', req);
  }

  sell(req: OrderRequest): OrderRef {
    return this.place('sell', req);
  }

  /** 기본 사유는 'stop' — 기본값을 'abandon'으로 두면 Stop 경로의 FAULT가 조용히 느슨해진다. */
  cancel(ref: OrderRef, reason: CancelReason = 'stop'): void {
    const p = this.orders.get(ref);
    if (!p) return;
    p.cancelRequested = true;
    if (p.cancelReason === null) p.cancelReason = reason; // 먼저 요청한 쪽의 사유를 보존한다
    if (p.cancelState === 'none') p.cancelState = 'pending';
    if (p.odno) this.fireCancel(p);
    // odno 미도착이면 발주 완료 콜백에서 취소한다.
  }

  checkFilled(ref: OrderRef): FillResult {
    const p = this.orders.get(ref);
    if (!p) return { filled: false };
    // 자동 포기 경로가 아니면 기존 그대로 반환한다 — 다른 경로는 partialQty를 읽지 않고,
    // 필드를 덧붙이면 결과 형태를 단정하는 기존 계약이 바뀐다.
    if (p.cancelReason !== 'abandon') return p.fill;
    // 취소가 confirmed됐지만 사후 검증 폴 전이면 undefined를 준다 —
    // core가 fail-closed로 복귀를 보류하게 해서, 취소 확정과 동시에 들어온 부분체결을 놓치지 않는다.
    const unverified = p.cancelState === 'confirmed' && !p.abandonVerified;
    return { ...p.fill, partialQty: unverified ? undefined : p.filledQty };
  }

  /**
   * 자동 취소 판단 전용 읽기 스냅샷 — 진행 중(미체결·미확정) 매수 주문 1건. 없으면 null.
   * ⚠ 판단만 한다. 상태를 바꾸지 않는다.
   */
  buyProbe(): { hasOdno: boolean; filledQty: number; cancelState: CancelState; verified: boolean } | null {
    for (const p of this.orders.values()) {
      if (p.side !== 'buy' || p.fill.filled || p.placeError) continue;
      return {
        hasOdno: p.odno !== null,
        filledQty: p.filledQty,
        cancelState: p.cancelState,
        verified: p.abandonVerified,
      };
    }
    return null;
  }

  cancelState(ref: OrderRef): CancelState {
    return this.orders.get(ref)?.cancelState ?? 'none';
  }

  /**
   * 폴러: 주문체결내역(fetchFills)을 조회해 미체결 캐시를 갱신한다.
   * 러너의 pollCycle이 RunCycle.poll() 직전에 await로 부른다.
   * @returns 체결 확인이 정상 동작했으면 true. fetchFills가 throw하면 **false**(= 미체결 아님, 확인 불가) — 러너는
   *   이 폴 사이클에서 RunCycle.poll()(타임아웃→취소→복귀)을 진행하지 않고 FAULT로 전환한다. (사고의 핵심 방지)
   */
  async refreshFills(): Promise<boolean> {
    // 아직 체결/취소가 확정되지 않아 관찰이 필요한 주문이 없으면 네트워크 호출 자체를 아낀다.
    // 취소를 요청한 주문도 "취소 성공(confirmed)"이 확정되기 전까지는 늦은 체결을 잡기 위해 계속 관찰한다
    // (기존엔 cancelRequested면 바로 관찰을 끊어 늦은 체결이 영영 레코닝되지 않는 사고가 났다).
    const needsPoll = [...this.orders.values()].some(stillObserving);
    if (!needsPoll) return true;

    let fills;
    try {
      fills = await this.broker.fetchFills();
    } catch (err) {
      this.setFault({ kind: 'FILL_CHECK', reason: summarizeError(err) }, err);
      return false;
    }
    const byOdno = new Map(fills.map((f) => [f.odno, f]));
    for (const p of this.orders.values()) {
      if (!stillObserving(p)) continue;
      const f = byOdno.get(p.odno!);
      if (f) {
        // 부분체결 수량을 버리지 않고 절대 누적으로 보존한다.
        // (예전엔 filledQty >= qty만 보고 부분체결을 통째로 버려서, 잔량이 안 붙으면 SELLING에 갇혔다.)
        // filledBase = 이전 odno들에서 확정된 몫. 정정하면 새 주문은 잔량 기준이라 이 오프셋이 필수다.
        p.filledQty = Math.max(p.filledQty, p.filledBase + f.filledQty);
        if (f.filledPrice !== null) p.lastFillPrice = f.filledPrice;
      } else if (p.amendInFlight) {
        // 정정 왕복 중의 "목록 부재"는 체결이 아니라 정정 때문일 수 있다 — 추론을 보류한다.
        // (이 가드가 없으면 정정 성공 순간 가짜 전량체결로 사이클이 끝난다.)
        continue;
      }
      // 전량 판정은 **절대 누적** 기준 — core 계약(FillResult.filled)은 그대로 유지한다.
      if (p.filledQty >= p.qty) {
        p.fill = {
          filled: true,
          price: this.settlePrice(p),
          qty: p.filledQty,
        };
        continue;
      }
      // 자동 포기 취소가 확정됐으면, 이번 조회로 잔량이 확정된 것이다 — 이 마킹 뒤에야 관찰이 끝난다.
      if (p.cancelReason === 'abandon' && p.cancelState === 'confirmed') {
        p.abandonVerified = true;
        continue;
      }
      // 취소가 거절됐는데(이미 체결 추정) 체결도 확인되지 않으면 확인 불가 → FAULT로 승격한다.
      // (취소 성공 확인 전까지 미체결로 단정하지 않는다 — 늦은 체결은 위에서 잡히고, 여기 오면 진짜 확인 불가)
      if (p.cancelState === 'rejected') {
        // 자동 포기 경로만 유예를 준다 — "취소 요청 중 체결" 레이스가 잦아 즉시 FAULT면 오탐이 폭증한다.
        // 유예 동안에도 관찰은 계속되므로 늦은 체결이 오면 정상적으로 filled→HOLDING이 된다.
        if (p.cancelReason === 'abandon') {
          p.rejectGracePolls += 1;
          if (p.rejectGracePolls < ABANDON_REJECT_GRACE_POLLS) continue;
        }
        this.setFault(
          { kind: 'CANCEL', reason: '취소 거절 — 미체결 주문이 계좌에 남아있을 수 있음' },
          new Error('cancel rejected but fill not confirmed'),
        );
      }
    }
    return true;
  }

  /**
   * 손익 계산에 쓸 체결가를 정한다.
   *
   * 실물 브로커는 **전량 체결 시 체결가를 주지 않는다** — "미체결 목록에서 사라짐"으로 체결을 추론하기
   * 때문이다(createKisBroker). 그래서 대부분의 거래에 체결가가 없다.
   *
   * 이때 예전에는 core가 "신호 시점 틱 가격"으로 폴백했는데, 우리는 매수를 매도1호가·매도를 매수1호가에
   * 내므로 **왕복 스프레드가 손익에서 통째로 빠졌다**(낙관 편향). 대신 **실제 접수된 지정가(orderPrice)**로
   * 폴백하면 지정가 성질상 매수는 체결가 ≤ 발주가, 매도는 체결가 ≥ 발주가라 **오차가 항상 보수적**이고
   * 스프레드가 손익에 들어온다.
   *
   * ⚠ orderPrice가 0(발주가를 정하지 못한 주문)이면 undefined를 돌려준다 — 0을 체결가로 흘리면
   *   손익이 -진입금액이 되는 최악의 오염이 된다.
   */
  private settlePrice(p: PendingOrder): number | undefined {
    // 정정을 거쳤으면 odno마다 가격대가 다르므로 수량 가중평균을 낸다.
    // 정정이 없었으면 filledValueBase=0·filledBase=0이라 아래 식이 단순 폴백과 완전히 같은 값이 된다.
    const tailQty = p.filledQty - p.filledBase;
    const tailPrice = p.lastFillPrice !== null && p.lastFillPrice > 0 ? p.lastFillPrice : p.orderPrice;
    if (tailPrice <= 0 && p.filledValueBase <= 0) return undefined;
    const value = p.filledValueBase + Math.max(0, tailQty) * tailPrice;
    const avg = p.filledQty > 0 ? value / p.filledQty : tailPrice;
    return avg > 0 ? avg : undefined;
  }

  private place(side: 'buy' | 'sell', req: OrderRequest): OrderRef {
    const ref: OrderRef = `${side}-${this.seq++}`;
    // 발주가를 여기서 미리 절사해 둔다 — 정정 트리거가 "실제 접수될 값"끼리 비교하게 만들고,
    // previewOrderPrice(진단 UI)도 실제 접수가와 정확히 일치하게 된다.
    //
    // ⚠ roundOverseasOrderPrice는 가격이 0 이하면 throw한다. 이 메서드는 core의 **동기** OrderPort 계약이라
    //   여기서 예외가 새면 RunCycle.placeBuy/placeSell 호출부까지 역류한다 — 특히 stop()→placeSell 경로에서
    //   터지면 **사용자 Stop이 통째로 실패하고 포지션이 HOLDING으로 남는다**(정지했다고 믿는데 안 됨).
    //   그래서 여기서 삼키고 FAULT 채널로 넘긴다: 발주는 하지 않고 주문만 등록해 두면
    //   러너의 faultBarrier()가 다음 폴에서 회수해 정상적으로 인터록에 진입한다.
    let price = 0;
    let priceError: unknown = null;
    try {
      price = roundOverseasOrderPrice(this.resolveOrderPrice(side), roundingForSide(side));
    } catch (err) {
      priceError = err;
    }

    const p: PendingOrder = {
      ref,
      side,
      pdno: req.ticker,
      qty: req.qty,
      odno: null,
      fill: { filled: false },
      cancelRequested: false,
      cancelState: 'none',
      orderPrice: price,
      liveQty: req.qty,
      filledBase: 0,
      filledValueBase: 0,
      filledQty: 0,
      lastFillPrice: null,
      amendInFlight: false,
      amendFailStreak: 0,
      repriceDisabled: false,
      amendNotBefore: Number.NEGATIVE_INFINITY,
      cancelReason: null,
      abandonVerified: false,
      rejectGracePolls: 0,
    };
    this.orders.set(ref, p);

    if (priceError !== null) {
      // odno가 영영 null이라 refreshFills의 needsPoll·findRepriceablSell에서 자동 제외된다(유령 폴링 없음).
      p.placeError = priceError;
      this.setFault(
        { kind: 'PLACE', reason: '발주가를 정할 수 없어요 — 호가·체결가를 아직 못 받았어요' },
        priceError,
      );
      return ref;
    }

    this.broker
      .placeOrder({ side, pdno: req.ticker, qty: req.qty, price })
      .then((r) => {
        p.odno = r.odno;
        // 발주 완료 전에 core가 취소를 요청했다면 지금 취소한다.
        if (p.cancelRequested) this.fireCancel(p);
      })
      .catch((err) => {
        // 발주 실패(fire-and-forget)를 조용히 삼키지 않는다 — FAULT로 노출한다. (사고: 발주 오류 은닉)
        p.placeError = err;
        this.setFault({ kind: 'PLACE', reason: summarizeError(err) }, err);
      });

    return ref;
  }

  /**
   * 매도 리프라이스 1회 — 러너의 리프라이스 타이머가 주기적으로 await한다.
   * 매수1호가가 접수가와 다를 때만 정정을 내고, 그 외에는 **네트워크 호출 없이** 즉시 반환한다(유량 절감).
   * 정정 실패는 FAULT로 올리지 않는다 — 정정 거절은 원주문이 그대로 살아있음이 보장되는 유일한 실패라
   * 안전 불변식이 깨지지 않는다. 백오프 후 재시도하고, 연속 상한을 넘으면 리프라이스만 자진 중단한다.
   */
  async repriceSell(): Promise<void> {
    const p = this.findRepriceablSell();
    if (!p) return;
    if (this.clock.now() < p.amendNotBefore) return;

    const quote = this.computeOrderPrice('sell');
    const bid1 = quote.usedQuote ? roundOverseasOrderPrice(quote.price, 'floor') : 0;
    const decision = decideReprice({
      currentPrice: p.orderPrice,
      bid1,
      quoteFresh: quote.usedQuote,
      remainingQty: p.qty - p.filledQty,
      amendInFlight: p.amendInFlight,
      cancelInvolved: p.cancelState !== 'none' || p.cancelRequested,
      disabled: p.repriceDisabled,
    });
    if (decision.action === 'hold') return;

    await this.fireAmend(p, decision.price, decision.qty);
  }

  /**
   * 매수 리프라이스 1회(2026-08-28, 물타기 시험 모드) — repriceSell의 거울. 매도1호가가 접수가와 다를 때만
   * 정정해 따라간다(시간 양보 없음). 취소가 얽혀 있으면(자동 포기 진행 중) 보류.
   */
  async repriceBuy(): Promise<void> {
    const p = this.findRepriceable('buy');
    if (!p) return;
    if (this.clock.now() < p.amendNotBefore) return;

    const quote = this.computeOrderPrice('buy');
    const ask1 = quote.usedQuote ? roundOverseasOrderPrice(quote.price, 'ceil') : 0;
    const decision = decideBuyReprice({
      currentPrice: p.orderPrice,
      ask1,
      quoteFresh: quote.usedQuote,
      remainingQty: p.qty - p.filledQty,
      amendInFlight: p.amendInFlight,
      cancelInvolved: p.cancelState !== 'none' || p.cancelRequested,
      disabled: p.repriceDisabled,
    });
    if (decision.action === 'hold') return;

    await this.fireAmend(p, decision.price, decision.qty, 'buy');
  }

  /** 리프라이스 대상 매도 주문 — 발주 완료(odno 확보)됐고 아직 전량 체결되지 않은 것 하나. */
  private findRepriceablSell(): PendingOrder | null {
    return this.findRepriceable('sell');
  }

  private findRepriceable(side: 'buy' | 'sell'): PendingOrder | null {
    for (const p of this.orders.values()) {
      if (p.side !== side || p.fill.filled || !p.odno || p.placeError) continue;
      return p;
    }
    return null;
  }

  /** 정정 요청 1회. 성공 시 odno·접수가·명목수량·체결 오프셋을 한 번에 갈아끼운다. */
  private async fireAmend(p: PendingOrder, price: number, qty: number, side: 'buy' | 'sell' = 'sell'): Promise<void> {
    p.amendInFlight = true;
    try {
      const r = await this.broker.amendOrder({
        pdno: p.pdno,
        odno: p.odno!,
        qty,
        price,
        side,
      });
      // ↓ await가 없는 동기 구간 — 중간 상태를 아무도 관찰할 수 없어 원자성이 자동 보장된다.
      //   filledBase를 먼저 고정해야 새 odno의 "새 주문 기준" 체결량이 절대 누적으로 이어진다.
      //   ★ 순서 주의: 옛 odno 몫의 체결대금을 누적한 **뒤에** orderPrice를 새 값으로 덮어야 한다.
      const tailQty = p.filledQty - p.filledBase;
      if (tailQty > 0) p.filledValueBase += tailQty * (p.lastFillPrice ?? p.orderPrice);
      p.filledBase = p.filledQty;
      // ★ 체결가 리셋 — 없으면 옛 주문 가격대의 체결가가 새 주문 체결가로 둔갑한다.
      //   (새 odno가 "목록 부재→전량체결"로 확정되면 체결가가 안 오므로 옛 값이 그대로 남아버린다.)
      p.lastFillPrice = null;
      p.odno = r.odno;
      p.orderPrice = price;
      p.liveQty = qty;
      p.amendFailStreak = 0;
    } catch (err) {
      p.amendFailStreak += 1;
      // ⚠ pendingFault에 넣지 않는다 — 정정 실패로 FAULT 인터록을 오염시키지 않는다.
      this.onError?.(err);
      const backoff = Math.min(1000 * 2 ** p.amendFailStreak, AMEND_BACKOFF_MAX_MS);
      p.amendNotBefore = this.clock.now() + backoff;
      if (p.amendFailStreak >= AMEND_FAIL_LIMIT) {
        // 가격 추종만 포기한다 — 주문은 그대로 살아 기존 무한 대기로 안전하게 복귀한다.
        p.repriceDisabled = true;
      }
      return;
    } finally {
      p.amendInFlight = false;
    }
    // 정정에 성공했으면 즉시 체결 확인을 1회 더 돌린다.
    // 새 odno는 "최소 1폴 유예" 규칙 때문에 목록 부재를 체결로 확정하지 못하는데, 정정 주기(1초)가
    // 폴 주기(2초)보다 짧으면 매 폴마다 odno가 새것이 되어 진짜 전량체결도 영영 안 잡힌다(상호 기아).
    // 정정이 실제로 일어난 경우에만 드는 비용이라 유량 절감 원칙과 충돌하지 않는다.
    await this.refreshFills();
  }

  private fireCancel(p: PendingOrder): void {
    if (!p.odno) return;
    this.broker
      .cancelOrder({ pdno: p.pdno, odno: p.odno, qty: p.qty })
      // 취소 성공 = 그 주문은 진짜 미체결이었다 → core가 안전하게 되돌아갈 수 있다(confirmed).
      .then(() => {
        if (p.cancelState !== 'rejected') p.cancelState = 'confirmed';
      })
      // 취소 거절 = 이미 체결됐을 수 있음. 즉시 FAULT로 단정하지 않고 'rejected'로 표시한 뒤
      // 체결 확인 경로에 맡긴다 — 체결이 관찰되면 정상 완료, 끝내 확인 불가면 refreshFills가 FAULT로 승격한다.
      .catch((err) => {
        p.cancelState = 'rejected';
        this.onError?.(err);
      });
  }
}

/**
 * 아직 체결내역 관찰이 필요한 주문인가.
 *
 * 취소를 요청한 주문도 "취소 성공(confirmed)"이 확정되기 전까지는 늦은 체결을 잡기 위해 계속 관찰한다
 * (기존엔 cancelRequested면 바로 관찰을 끊어 늦은 체결이 영영 레코닝되지 않는 사고가 났다).
 * ★ 자동 포기 취소는 confirmed 이후에도 **한 번 더** 관찰한다 — 취소 확정과 거의 동시에 들어온
 *   부분체결을 놓치면 앱은 "포지션 없음"으로 믿는데 계좌엔 주식이 남는 유령 포지션이 생긴다.
 */
function stillObserving(p: PendingOrder): boolean {
  if (p.fill.filled || !p.odno) return false;
  if (p.cancelState !== 'confirmed') return true;
  return p.cancelReason === 'abandon' && !p.abandonVerified;
}

/** 오류 객체를 짧은 한 줄로 요약(스택은 담지 않는다). */
function summarizeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
