// ScalperManager — 실시간 시세 피드 허브.
//  · WS 단일 연결의 유일 소유자(RealtimeFeed 핸들러 등록·연결 상태/구독 ACK 진단)
//  · 자동 단타(AutoPilotManager)·시뮬레이션(SimExchange/SimLab)으로 틱·호가 분배(setAuxRoutes)
//  · 종목 상세화면의 구독 획득/해제(refcount, acquireFeed/releaseFeed)와 데이터 리스너(subscribeFeedData)
// (옛 수동 카드 매니저 — 인스턴스 CRUD·영속화·개별 Run/Stop — 는 2026-08-08 수동 카드 제거로 걷어냈다.)
import { REALTIME_PRICE_TR_ID } from '../../kis/realtimePrice';
import type {
  ClockLike,
  FeedStatus,
  RealtimeControlMessage,
  RealtimeFeed,
  TickExtras,
} from './types';

export interface ScalperManagerDeps {
  realtime: RealtimeFeed;
  clock: ClockLike;
}

type FeedStatusListener = (status: FeedStatus) => void;

/** 진단 한 줄(구독 ACK 성공/실패, 연결 오류) — 사용자가 "왜 안 들어오지"를 스스로 확인하게. */
export interface FeedEvent {
  at: number;
  text: string;
}
type FeedDiagnosticListener = (event: FeedEvent) => void;

/** 상세화면 등 보조 소비자가 티커 1개의 틱·호가를 받아보는 리스너 — subscribeFeedData로 등록한다. */
export interface FeedDataListener {
  onTick?: (price: number, tsMs: number) => void;
  onQuote?: (bid1: number, ask1: number, tsMs: number, bidVol1?: number, askVol1?: number) => void;
}

/**
 * trKey(체결가 D…/호가 R…) 1개의 마지막 구독 ACK 상태 — lastFeedEvent는 전체 매니저 기준으로 매번
 * 덮어써져 trKey별 이력이 사라지므로, QuoteSheet 등이 trKey별로 조회할 수 있게 별도로 보존한다.
 */
export interface FeedSubscriptionStatus {
  /** rt_cd '0'이면 성공. */
  success: boolean;
  /** 실패 사유(msg1/msg_cd) — 성공이면 빈 문자열일 수 있다. */
  message: string;
  /** ACK 수신 시각(clock 기준). */
  at: number;
}

export class ScalperManager {
  private readonly clock: ClockLike;
  private readonly realtime: RealtimeFeed;

  private readonly feedStatusListeners = new Set<FeedStatusListener>();
  private readonly feedDiagnosticListeners = new Set<FeedDiagnosticListener>();
  private feedStatus: FeedStatus = 'idle';
  private _lastFeedEvent: FeedEvent | null = null;
  /** trKey → 마지막 구독 ACK 상태(성공 여부·사유·시각) — lastFeedEvent와 별개로 trKey별 이력을 보존. */
  private readonly subscriptionStatus = new Map<string, FeedSubscriptionStatus>();

  constructor(deps: ScalperManagerDeps) {
    this.clock = deps.clock;
    this.realtime = deps.realtime;
    // WS 단일 연결 → 보조 소비자(자동 단타·시뮬·상세화면)로 라우팅(체결가·호가 둘 다).
    this.realtime.setTickHandler((symb, price, tsMs, extras) => this.routeTick(symb, price, tsMs, extras));
    this.realtime.setQuoteHandler((symb, bid1, ask1, tsMs, bidVol1, askVol1) =>
      this.routeQuote(symb, bid1, ask1, tsMs, bidVol1, askVol1),
    );
    this.realtime.setStatusHandler((status) => this.handleFeedStatus(status));
    this.realtime.setControlHandler((msg) => this.handleFeedControl(msg));
  }

  // ---- 연결 상태/진단 ----

  /** 현재 WS 연결 상태(시세 수신 진단 배지용). */
  getFeedStatus(): FeedStatus {
    return this.feedStatus;
  }

  /** WS 연결 상태 변화 구독 — 배지(연결됨/연결 중/재연결 중/끊김)용. */
  subscribeFeedStatus(listener: FeedStatusListener): () => void {
    this.feedStatusListeners.add(listener);
    return () => {
      this.feedStatusListeners.delete(listener);
    };
  }

  /** 최근 시세 피드 진단 이벤트(구독 성공/실패 · 연결 오류). */
  get lastFeedEvent(): FeedEvent | null {
    return this._lastFeedEvent;
  }

  /** 진단 이벤트 변화 구독. */
  subscribeFeedDiagnostic(listener: FeedDiagnosticListener): () => void {
    this.feedDiagnosticListeners.add(listener);
    return () => {
      this.feedDiagnosticListeners.delete(listener);
    };
  }

  /**
   * trKey별 마지막 구독 ACK. ⚠ 체결가·호가가 같은 trKey 문자열(DNAS…)을 쓰므로 trId까지 넣어 구분한다
   * (기본 HDFSCNT0=체결가, 호가는 'HDFSASP0' 전달). 아직 ACK를 못 받았으면(응답 없음) null.
   */
  getSubscriptionStatus(trKey: string, trId = 'HDFSCNT0'): FeedSubscriptionStatus | null {
    return this.subscriptionStatus.get(`${trId}|${trKey}`) ?? null;
  }

  /**
   * WS 연결/전송 오류 통지 — createRealtimeFeed의 onError는 매니저 생성 이전에 배선되므로
   * (managerProvider가 realtime을 먼저 만든다) 매니저가 나중에 이 메서드로 직접 호출받는다.
   */
  reportFeedError(err: unknown): void {
    this.setFeedEvent(`연결 오류 · ${summarizeError(err)}`);
  }

  /** 전체 해제 — WS 종료. */
  dispose(): void {
    this.realtime.close();
  }

  // ---- 내부 ----

  private handleFeedStatus(status: FeedStatus): void {
    if (status === this.feedStatus) return;
    this.feedStatus = status;
    for (const l of this.feedStatusListeners) l(status);
  }

  /**
   * 구독 등록/해제 ACK — rt_cd '0'이 성공, 그 외는 실패(KIS 문서 기준).
   * 전체 진단(lastFeedEvent)은 매번 덮어쓰므로, trKey가 있으면 trKey별 이력도 별도 보존한다
   * (QuoteSheet가 체결가 키·호가 키 각각의 마지막 상태를 따로 조회할 수 있게).
   */
  private handleFeedControl(msg: RealtimeControlMessage): void {
    const success = msg.rtCd === '0';
    const text = success
      ? `구독 성공 · ${msg.trKey ?? ''}`
      : `구독 실패 · ${msg.msg1 ?? msg.msgCd ?? '알 수 없음'}`;
    this.setFeedEvent(text);
    if (msg.trKey) {
      // 체결가(HDFSCNT0)·호가(HDFSASP0)가 같은 trKey를 쓰므로 (trId|trKey) 복합 키로 보존.
      this.subscriptionStatus.set(`${msg.trId}|${msg.trKey}`, {
        success,
        message: msg.msg1 ?? msg.msgCd ?? '',
        at: this.clock.now(),
      });
    }
  }

  private setFeedEvent(text: string): void {
    const event: FeedEvent = { at: this.clock.now(), text };
    this._lastFeedEvent = event;
    for (const l of this.feedDiagnosticListeners) l(event);
  }

  // 자동관리(AutoPilotManager) 보조 수신기 — WS 핸들러는 이 매니저가 유일 소유하므로,
  // 오토파일럿은 여기 등록해 같은 연결의 틱·호가를 나눠 받는다.
  private auxTick: ((symb: string, price: number, tsMs: number, extras?: TickExtras) => void) | null = null;
  private auxQuote: ((symb: string, bid1: number, ask1: number, tsMs: number) => void) | null = null;

  // ---- 보조 소비자(종목 상세화면) 구독 refcount — 2026-08-07 종목상세화면 plan §4 ----

  /** `${trId}|${trKey}` → 참조 수. 상세화면 진입/이탈이 이 카운트로 획득/해제한다. */
  private readonly auxFeedCounts = new Map<string, number>();
  /**
   * 다른 소유자(자동 단타)가 이 키를 구독 중인지 조회하는 프로브 — managerProvider가 배선한다.
   * 상세화면 해제가 자동 단타의 감시 호가를 끊지 않게 하는 최후 가드.
   */
  private feedUseProbe: ((trKey: string, trId: string) => boolean) | null = null;
  /** 상세화면 데이터 리스너 — 티커별 셋. routeTick/routeQuote가 aux와 함께 여기에도 흘린다. */
  private readonly feedDataListeners = new Map<string, Set<FeedDataListener>>();

  /** 외부 구독 소유자 프로브 등록 — null로 해제. */
  setFeedUseProbe(probe: ((trKey: string, trId: string) => boolean) | null): void {
    this.feedUseProbe = probe;
  }

  /** 보조 소비자(상세화면)가 이 (trId|trKey)를 잡고 있는가 — 자동 단타가 해제 전에 조회한다. */
  holdsFeed(trKey: string, trId: string): boolean {
    return (this.auxFeedCounts.get(`${trId}|${trKey}`) ?? 0) > 0;
  }

  /**
   * 참조 카운트 기반 구독 획득 — 상세화면 진입 시 체결가/호가 각각 호출한다.
   * 자동 단타가 이미 같은 키를 구독 중이면 등록 프레임을 다시 보내지 않는다
   * (KIS가 중복 SUBSCRIBE에 오류 ACK를 줘 진단 줄이 "구독 실패"로 오염되는 것 방지).
   */
  acquireFeed(trKey: string, trId: string = REALTIME_PRICE_TR_ID): void {
    this.realtime.connect();
    const key = `${trId}|${trKey}`;
    const next = (this.auxFeedCounts.get(key) ?? 0) + 1;
    this.auxFeedCounts.set(key, next);
    if (next === 1 && !this.feedUseProbe?.(trKey, trId)) {
      this.realtime.subscribe(trKey, trId);
    }
  }

  /** 구독 해제 — 카운트가 0이 되고, 자동 단타도 안 쓸 때만 실제 unsubscribe. */
  releaseFeed(trKey: string, trId: string = REALTIME_PRICE_TR_ID): void {
    const key = `${trId}|${trKey}`;
    const current = this.auxFeedCounts.get(key) ?? 0;
    if (current <= 0) return;
    if (current > 1) {
      this.auxFeedCounts.set(key, current - 1);
      return;
    }
    this.auxFeedCounts.delete(key);
    if (!this.feedUseProbe?.(trKey, trId)) {
      this.realtime.unsubscribe(trKey, trId);
    }
  }

  /** 상세화면이 티커 1개의 틱·호가 수신을 구독한다 — 반환 함수로 해제. 구독 획득(acquireFeed)과는 별개. */
  subscribeFeedData(symb: string, listener: FeedDataListener): () => void {
    let set = this.feedDataListeners.get(symb);
    if (!set) {
      set = new Set();
      this.feedDataListeners.set(symb, set);
    }
    set.add(listener);
    return () => {
      const listeners = this.feedDataListeners.get(symb);
      listeners?.delete(listener);
      if (listeners && listeners.size === 0) this.feedDataListeners.delete(symb);
    };
  }

  /** 외부(자동관리) 수신기 등록 — null로 해제. */
  setAuxRoutes(
    onTick: ((symb: string, price: number, tsMs: number, extras?: TickExtras) => void) | null,
    onQuote: ((symb: string, bid1: number, ask1: number, tsMs: number) => void) | null,
  ): void {
    this.auxTick = onTick;
    this.auxQuote = onQuote;
  }

  private routeTick(symb: string, price: number, tsMs: number, extras?: TickExtras): void {
    this.auxTick?.(symb, price, tsMs, extras);
    const detailListeners = this.feedDataListeners.get(symb);
    if (detailListeners) {
      for (const l of detailListeners) l.onTick?.(price, tsMs);
    }
  }

  /** 실시간호가(1호가)를 보조 소비자로 라우팅 — 자동 단타 어댑터가 공격적 지정가에 쓴다. */
  private routeQuote(
    symb: string,
    bid1: number,
    ask1: number,
    tsMs: number,
    bidVol1?: number,
    askVol1?: number,
  ): void {
    this.auxQuote?.(symb, bid1, ask1, tsMs);
    const detailListeners = this.feedDataListeners.get(symb);
    if (detailListeners) {
      for (const l of detailListeners) l.onQuote?.(bid1, ask1, tsMs, bidVol1, askVol1);
    }
  }
}

/** 오류 객체를 짧은 한 줄 텍스트로 요약(진단 배지용 — 스택은 노출하지 않는다). */
function summarizeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
