// 테스트 지원(가짜 KIS 심) — 이 파일은 index.ts에서 export하지 않는다. vitest 전용.
import type {
  BrokerAmendInput,
  BrokerFill,
  BrokerCancelInput,
  BrokerPlaceInput,
  FeedStatus,
  KeyValueStore,
  RealtimeControlMessage,
  RealtimeFeed,
  ScalperBroker,
  SchedulerLike,
  TickExtras,
} from './types';

/** 마이크로/매크로태스크 배수 — 어댑터의 fire-and-forget placeOrder .then 정착용. */
export function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 주입식 가짜 시계 — RunCycle 타임아웃·스로틀 판정을 결정론적으로. */
export function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
      return t;
    },
    set: (v: number) => {
      t = v;
    },
  };
}

/**
 * 가짜 주문 게이트웨이. autoFill=true면 발주 즉시 전량 체결로 기록한다.
 * 안전 인터록 테스트용 실패 토글(기본 전부 off — 기존 시나리오는 영향 없음):
 *   failFetchFills / failPlaceOrder / failCancel 을 true로 두면 해당 호출이 throw한다(APTR0058 등 재현).
 */
export class FakeBroker implements ScalperBroker {
  placed: Array<BrokerPlaceInput & { odno: string }> = [];
  canceled: string[] = [];
  autoFill: boolean;
  /** 체결 확인 API 장애(주문체결내역 APTR0058) 재현 — true면 fetchFills가 throw. */
  failFetchFills = false;
  /** 발주 자체가 throw(주문 API 오류) 재현. */
  failPlaceOrder = false;
  /** 취소가 KIS 오류로 거절(이미 체결 등) 재현. */
  failCancel = false;
  /** 정정이 KIS 오류로 거절(이미 체결·수량 불일치 등) 재현. */
  failAmend = false;
  /** 정정 이력(옛 odno → 새 odno·가격·수량) — 유량 절감 검증에 호출 횟수로 쓴다. */
  amended: Array<{ from: string; to: string; qty: number; price: number }> = [];
  /** fetchFills가 실제로 호출된 횟수(프리플라이트 포함) — 검증용. */
  fetchFillsCalls = 0;
  private seq = 0;
  private fills = new Map<string, BrokerFill>();

  constructor(opts: { autoFill?: boolean } = {}) {
    this.autoFill = opts.autoFill ?? false;
  }

  async placeOrder(input: BrokerPlaceInput): Promise<{ odno: string }> {
    if (this.failPlaceOrder) throw new Error('주문 API 오류(모의)');
    const odno = `O${++this.seq}`;
    this.placed.push({ ...input, odno });
    this.fills.set(odno, {
      odno,
      orderQty: input.qty,
      filledQty: this.autoFill ? input.qty : 0,
      filledPrice: this.autoFill ? input.price : null,
    });
    return { odno };
  }

  async cancelOrder(input: BrokerCancelInput): Promise<void> {
    if (this.failCancel) throw new Error('APTR: 취소 거절(모의)');
    this.canceled.push(input.odno);
    this.fills.delete(input.odno);
  }

  /**
   * 정정 — 실물처럼 **새 odno를 채번**하고 옛 odno를 목록에서 없앤다.
   * 이미 체결된 수량은 새 주문으로 이월하지 않는다(실물도 잔량만 새 주문이 된다).
   */
  async amendOrder(input: BrokerAmendInput): Promise<{ odno: string }> {
    if (this.failAmend) throw new Error('APTR: 정정 거절(모의)');
    const next = `O${++this.seq}`;
    this.amended.push({ from: input.odno, to: next, qty: input.qty, price: input.price });
    this.fills.delete(input.odno);
    this.placed.push({ side: input.side, pdno: input.pdno, qty: input.qty, price: input.price, odno: next });
    this.fills.set(next, {
      odno: next,
      orderQty: input.qty,
      filledQty: this.autoFill ? input.qty : 0,
      filledPrice: this.autoFill ? input.price : null,
    });
    return { odno: next };
  }

  async fetchFills(): Promise<BrokerFill[]> {
    this.fetchFillsCalls += 1;
    if (this.failFetchFills) throw new Error('APTR0058: 체결 확인 거절(모의)');
    return [...this.fills.values()];
  }

  /** 잔고 포지션 심(그리드 D1) — 테스트가 세팅한다. failFetchPosition=true면 throw. */
  position: { qty: number; avgPrice: number } | null = null;
  failFetchPosition = false;
  async fetchPosition(): Promise<{ qty: number; avgPrice: number } | null> {
    if (this.failFetchPosition) throw new Error('잔고 조회 거절(모의)');
    return this.position;
  }

  /** 수동 체결(미체결 시나리오에서 특정 odno 체결 처리). */
  fill(odno: string, price: number): void {
    const f = this.fills.get(odno);
    if (f) {
      f.filledQty = f.orderQty;
      f.filledPrice = price;
    }
  }

  /**
   * 체결가 없이 전량체결 — 실물의 주된 경로를 재현한다.
   * createKisBroker는 "미체결 목록에서 사라짐"으로 전량체결을 추론하므로 그때 filledPrice가 null이다.
   */
  fillWithoutPrice(odno: string): void {
    const f = this.fills.get(odno);
    if (f) {
      f.filledQty = f.orderQty;
      f.filledPrice = null;
    }
  }

  /** 부분체결 주입 — 잔량 재정정 시나리오 검증용. */
  fillPartial(odno: string, qty: number, price: number): void {
    const f = this.fills.get(odno);
    if (f) {
      f.filledQty = Math.min(qty, f.orderQty);
      f.filledPrice = price;
    }
  }
}

/** 가짜 WS 피드 — emit으로 (symb, price, ts) 틱을 주입해 라우팅을 검증한다. */
export class FakeFeed implements RealtimeFeed {
  connected = false;
  closed = false;
  readonly subscribed = new Set<string>();
  /** 구독된 trKey → trId(검증용). */
  readonly subscribedTrIds = new Map<string, string>();
  /** `${trId}|${trKey}` 복합 키 — 체결가·호가가 같은 trKey를 쓰므로 refcount 검증은 이 셋으로 한다. */
  readonly subs = new Set<string>();
  private handler: ((symb: string, price: number, tsMs: number, extras?: TickExtras) => void) | null = null;
  private quoteHandler:
    | ((symb: string, bid1: number, ask1: number, tsMs: number, bidVol1?: number, askVol1?: number) => void)
    | null = null;
  private statusHandler: ((status: FeedStatus) => void) | null = null;
  private controlHandler: ((msg: RealtimeControlMessage) => void) | null = null;

  connect(): void {
    this.connected = true;
  }
  close(): void {
    this.closed = true;
  }
  subscribe(trKey: string, trId = 'HDFSCNT0'): void {
    this.subscribed.add(trKey);
    this.subscribedTrIds.set(trKey, trId);
    this.subs.add(`${trId}|${trKey}`);
  }
  unsubscribe(trKey: string, trId = 'HDFSCNT0'): void {
    this.subscribed.delete(trKey);
    this.subscribedTrIds.delete(trKey);
    this.subs.delete(`${trId}|${trKey}`);
  }
  setTickHandler(handler: (symb: string, price: number, tsMs: number, extras?: TickExtras) => void): void {
    this.handler = handler;
  }
  setQuoteHandler(
    handler: (symb: string, bid1: number, ask1: number, tsMs: number, bidVol1?: number, askVol1?: number) => void,
  ): void {
    this.quoteHandler = handler;
  }
  setStatusHandler(handler: (status: FeedStatus) => void): void {
    this.statusHandler = handler;
  }
  setControlHandler(handler: (msg: RealtimeControlMessage) => void): void {
    this.controlHandler = handler;
  }
  emit(symb: string, price: number, tsMs: number, extras?: TickExtras): void {
    this.handler?.(symb, price, tsMs, extras);
  }
  /** 테스트 전용 — 1호가 수신을 주입한다. bidVol1/askVol1은 선택(잔량 진단 테스트용). */
  emitQuote(symb: string, bid1: number, ask1: number, tsMs: number, bidVol1?: number, askVol1?: number): void {
    this.quoteHandler?.(symb, bid1, ask1, tsMs, bidVol1, askVol1);
  }
  /** 테스트 전용 — WS 상태 변화를 주입한다. */
  emitStatus(status: FeedStatus): void {
    this.statusHandler?.(status);
  }
  /** 테스트 전용 — 구독 ACK 등 제어 프레임을 주입한다. */
  emitControl(msg: RealtimeControlMessage): void {
    this.controlHandler?.(msg);
  }
}

/** 가짜 AsyncStorage. */
export class FakeStore implements KeyValueStore {
  readonly map = new Map<string, string>();
  async getItem(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async setItem(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async removeItem(key: string): Promise<void> {
    this.map.delete(key);
  }
}

/** 실타이머를 쓰지 않는 스케줄러(콜백을 잡아 두되 자동 실행 안 함). */
export function noopScheduler(): SchedulerLike & { fired: Array<() => void> } {
  const fired: Array<() => void> = [];
  return {
    fired,
    setInterval: (fn: () => void) => {
      fired.push(fn);
      return fired.length;
    },
    clearInterval: () => {},
  };
}
