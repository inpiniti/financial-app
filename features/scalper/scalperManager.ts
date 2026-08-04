// ScalperManager — 멀티 인스턴스 매니저.
//  · 인스턴스 CRUD(상한 3 — 초과 시 명확한 에러)
//  · 구성(티커·수량) AsyncStorage 영속화(재시작 시 카드 복원, 상태는 IDLE부터)
//  · WS 단일 연결 멀티플렉스(RealtimeFeed 1개를 공유, 티커별 구독 등록/해제·틱 라우팅)
//  · 전체 시작/정지, keep-awake(실행 중 인스턴스 ≥1이면 활성)
import {
  buildFreeQuoteTrKey,
  buildQuoteTrKey,
  REALTIME_QUOTE_TR_ID,
  type RealtimeMarketCode,
} from '../../kis/realtimePrice';
import type { OverseasExchangeCode } from '../../kis/trId';
import { ScalperInstance, type ScalperInstanceDeps } from './scalperInstance';
import { appendTradeRecord } from './tradeStore';
import type {
  ClockLike,
  FeedStatus,
  KeepAwakeControl,
  KeyValueStore,
  RealtimeControlMessage,
  RealtimeFeed,
  ScalperBroker,
  ScalperInstanceConfig,
  SchedulerLike,
  TickExtras,
} from './types';

export const MAX_INSTANCES = 10;
export const INSTANCES_STORAGE_KEY = 'scalper:instances';

const DEFAULT_MARKET: RealtimeMarketCode = 'NAS';
const DEFAULT_EXCHANGE: OverseasExchangeCode = 'NASD';

/** 실행 중(감시·주문·보유·청산)으로 보는 상태 — keep-awake 판정용. */
const RUNNING_STATES = new Set(['WATCH_BUY', 'BUYING', 'HOLDING', 'SELLING']);

export type AddInstanceInput = Omit<ScalperInstanceConfig, 'id'> & { id?: string };

export interface ScalperManagerDeps {
  realtime: RealtimeFeed;
  storage: KeyValueStore;
  clock: ClockLike;
  /** 인스턴스별 KIS 주문 게이트웨이 생성기(실서비스는 createKisBroker, 테스트는 가짜 심). */
  makeBroker: (config: ScalperInstanceConfig) => ScalperBroker;
  scheduler?: SchedulerLike;
  keepAwake?: KeepAwakeControl;
  pollIntervalMs?: number;
  /** 매도 리프라이스 주기(ms, 기본 1000) — 인스턴스로 그대로 흘려보낸다. */
  repriceIntervalMs?: number;
  chunkSeconds?: number;
  bufferSize?: number;
  fillTimeoutMs?: number;
  throttleMs?: number;
  /** 매수 모멘텀 문턱(상대 기울기, "%/청크" 소수) — 인스턴스 detector로 그대로 흘려보낸다. 미지정 시 detector 기본. */
  minBuyMomentum?: number;
  /** 매도 모멘텀 문턱(하락 상대 기울기 크기, "%/청크" 소수) — 인스턴스 detector로 그대로 흘려보낸다. 미지정 시 detector 기본. */
  minSellMomentum?: number;
  /** BUY 거래량 스파이크 게이트(배수, 0=끔) — 인스턴스 detector로 그대로 흘려보낸다. */
  minVolumeSpikeRatio?: number;
  /** BUY 체결강도 게이트(STRN, 0=끔) — 인스턴스 detector로 그대로 흘려보낸다. */
  minStrength?: number;
  onError?: (err: unknown) => void;
}

type ListListener = (instances: ScalperInstance[]) => void;
type FeedStatusListener = (status: FeedStatus) => void;

/** 상단 배지 아래 진단 한 줄(구독 ACK 성공/실패, 연결 오류) — 사용자가 "왜 안 들어오지"를 스스로 확인하게. */
export interface FeedEvent {
  at: number;
  text: string;
}
type FeedDiagnosticListener = (event: FeedEvent) => void;

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
  private readonly deps: ScalperManagerDeps;
  private readonly clock: ClockLike;
  private readonly realtime: RealtimeFeed;
  private readonly storage: KeyValueStore;
  private readonly keepAwake?: KeepAwakeControl;

  private readonly instances = new Map<string, ScalperInstance>();
  private readonly configs = new Map<string, ScalperInstanceConfig>();
  private readonly unsubs = new Map<string, () => void>();
  private readonly listListeners = new Set<ListListener>();
  private readonly feedStatusListeners = new Set<FeedStatusListener>();
  private readonly feedDiagnosticListeners = new Set<FeedDiagnosticListener>();
  private feedStatus: FeedStatus = 'idle';
  private _lastFeedEvent: FeedEvent | null = null;
  /** trKey → 마지막 구독 ACK 상태(성공 여부·사유·시각) — lastFeedEvent와 별개로 trKey별 이력을 보존. */
  private readonly subscriptionStatus = new Map<string, FeedSubscriptionStatus>();
  private seq = 0;
  private awake = false;

  constructor(deps: ScalperManagerDeps) {
    this.deps = deps;
    this.clock = deps.clock;
    this.realtime = deps.realtime;
    this.storage = deps.storage;
    this.keepAwake = deps.keepAwake;
    // WS 단일 연결 → 티커별 인스턴스로 라우팅(체결가·호가 둘 다).
    this.realtime.setTickHandler((symb, price, tsMs, extras) => this.routeTick(symb, price, tsMs, extras));
    this.realtime.setQuoteHandler((symb, bid1, ask1, tsMs, bidVol1, askVol1) =>
      this.routeQuote(symb, bid1, ask1, tsMs, bidVol1, askVol1),
    );
    this.realtime.setStatusHandler((status) => this.handleFeedStatus(status));
    this.realtime.setControlHandler((msg) => this.handleFeedControl(msg));
  }

  // ---- 조회/구독 ----

  getInstances(): ScalperInstance[] {
    return [...this.instances.values()];
  }

  get(id: string): ScalperInstance | undefined {
    return this.instances.get(id);
  }

  /** 인스턴스 구성(티커·수량·market/exchange) 조회 — 분봉 차트 등 UI가 거래소 코드를 알아야 할 때 사용. */
  getConfig(id: string): ScalperInstanceConfig | undefined {
    return this.configs.get(id);
  }

  get size(): number {
    return this.instances.size;
  }

  /** 인스턴스 목록 변경(추가/삭제) 구독 — 6단계 카드 리스트 렌더용. */
  subscribe(listener: ListListener): () => void {
    this.listListeners.add(listener);
    return () => {
      this.listListeners.delete(listener);
    };
  }

  /** 현재 WS 연결 상태(시세 수신 진단 배지용). */
  getFeedStatus(): FeedStatus {
    return this.feedStatus;
  }

  /** WS 연결 상태 변화 구독 — 상단 배지(연결됨/연결 중/재연결 중/끊김)용. */
  subscribeFeedStatus(listener: FeedStatusListener): () => void {
    this.feedStatusListeners.add(listener);
    return () => {
      this.feedStatusListeners.delete(listener);
    };
  }

  /** 최근 시세 피드 진단 이벤트(구독 성공/실패 · 연결 오류) — 배지 아래 한 줄 표시용. */
  get lastFeedEvent(): FeedEvent | null {
    return this._lastFeedEvent;
  }

  /** 진단 이벤트 변화 구독 — 상단 배지 아래 한 줄(성공/실패/오류) 갱신용. */
  subscribeFeedDiagnostic(listener: FeedDiagnosticListener): () => void {
    this.feedDiagnosticListeners.add(listener);
    return () => {
      this.feedDiagnosticListeners.delete(listener);
    };
  }

  /**
   * trKey(체결가 D…/호가 R…)별 마지막 구독 ACK 상태 조회 — QuoteSheet 진단용.
   * 아직 ACK를 못 받았으면(응답 없음) null.
   */
  /**
   * trKey별 마지막 구독 ACK. ⚠ 체결가·호가가 같은 trKey 문자열(DNAS…)을 쓰므로 trId까지 넣어 구분한다
   * (기본 HDFSCNT0=체결가, 호가는 'HDFSASP0' 전달).
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

  // ---- CRUD ----

  /** 인스턴스 추가. 상한(MAX_INSTANCES) 초과 시 명확한 에러를 던진다. */
  add(input: AddInstanceInput): ScalperInstance {
    if (this.instances.size >= MAX_INSTANCES) {
      throw new Error(
        `단타 인스턴스는 최대 ${MAX_INSTANCES}개까지 만들 수 있어요. 기존 카드를 지운 뒤 다시 시도해 주세요.`,
      );
    }
    const config: ScalperInstanceConfig = {
      id: input.id ?? `inst-${this.clock.now()}-${++this.seq}`,
      ticker: input.ticker,
      qty: input.qty,
      market: input.market ?? DEFAULT_MARKET,
      exchange: input.exchange ?? DEFAULT_EXCHANGE,
      autoRun: input.autoRun ?? true,
    };
    const instance = this.instantiate(config);
    this.instances.set(config.id, instance);
    this.configs.set(config.id, config);
    this.subscribeFeeds(config);
    void this.persist();
    this.emitList();
    return instance;
  }

  /** 인스턴스 삭제 — 실행 중이면 정지 후 제거. WS 구독은 같은 티커가 없을 때만 해제. */
  remove(id: string): void {
    const instance = this.instances.get(id);
    const config = this.configs.get(id);
    if (!instance || !config) return;
    instance.stop();
    instance.dispose();
    this.instances.delete(id);
    this.configs.delete(id);
    const unsub = this.unsubs.get(id);
    unsub?.();
    this.unsubs.delete(id);
    // 같은 trKey를 쓰는 다른 인스턴스가 없으면 WS 구독 해제(체결가·호가 둘 다).
    const trKey = this.trKeyOf(config);
    const stillUsed = [...this.configs.values()].some((c) => this.trKeyOf(c) === trKey);
    if (!stillUsed) {
      this.realtime.unsubscribe(trKey);
      this.realtime.unsubscribe(this.quoteTrKeyOf(config), REALTIME_QUOTE_TR_ID);
    }
    void this.persist();
    this.refreshKeepAwake();
    this.emitList();
  }

  /**
   * 수량 수정 — Run 도중(감시·체결 대기·보유 중)엔 금지, IDLE(중지)·DONE(사이클 완료)·FAULT에서만 허용.
   * 허용 시 configs 갱신 + persist + 인스턴스(RunCycle 재생성)에 반영한다. 진행 중 사이클엔 소급 적용되지 않는다
   * (인스턴스가 이미 IDLE/DONE/FAULT일 때만 재생성하므로 미체결·보유 포지션이 없는 시점에만 일어난다).
   */
  updateQty(id: string, qty: number): void {
    const instance = this.instances.get(id);
    const config = this.configs.get(id);
    if (!instance || !config) {
      throw new Error('해당 카드를 찾을 수 없어요.');
    }
    if (RUNNING_STATES.has(instance.state)) {
      throw new Error('실행 중에는 수량을 바꿀 수 없어요 — 먼저 정지해 주세요');
    }
    const updated: ScalperInstanceConfig = { ...config, qty };
    this.configs.set(id, updated);
    instance.setQty(qty);
    void this.persist();
    this.emitList();
  }

  /** 오토런 토글 — 실행 중에도 허용(다음 완료 시점에 반영). configs 갱신 + persist + 인스턴스 반영. */
  setAutoRun(id: string, enabled: boolean): void {
    const instance = this.instances.get(id);
    const config = this.configs.get(id);
    if (!instance || !config) {
      throw new Error('해당 카드를 찾을 수 없어요.');
    }
    this.configs.set(id, { ...config, autoRun: enabled });
    instance.setAutoRun(enabled);
    void this.persist();
    this.emitList();
  }

  // ---- 시작/정지 ----

  /** WS 연결 + 전체 인스턴스 Run. */
  startAll(): void {
    this.realtime.connect();
    for (const instance of this.instances.values()) instance.start();
    this.refreshKeepAwake();
  }

  /** 전체 정지 — 보유 중이면 매도 후 종료(SELLING→DONE은 폴/틱으로 진행). */
  stopAll(): void {
    for (const instance of this.instances.values()) instance.stop();
    this.refreshKeepAwake();
  }

  start(id: string): void {
    this.realtime.connect();
    this.instances.get(id)?.start();
    this.refreshKeepAwake();
  }

  stop(id: string): void {
    this.instances.get(id)?.stop();
    this.refreshKeepAwake();
  }

  // ---- 영속화/복원 ----

  /** 저장된 구성으로 카드 복원 — 상태는 IDLE부터. 앱 재시작 진입점. */
  async restore(): Promise<void> {
    const raw = await this.storage.getItem(INSTANCES_STORAGE_KEY);
    if (!raw) return;
    let list: ScalperInstanceConfig[];
    try {
      const parsed = JSON.parse(raw) as unknown;
      list = Array.isArray(parsed) ? (parsed as ScalperInstanceConfig[]) : [];
    } catch {
      return;
    }
    for (const config of list) {
      if (this.instances.has(config.id) || this.instances.size >= MAX_INSTANCES) continue;
      const full: ScalperInstanceConfig = {
        market: DEFAULT_MARKET,
        exchange: DEFAULT_EXCHANGE,
        ...config,
      };
      const instance = this.instantiate(full);
      this.instances.set(full.id, instance);
      this.configs.set(full.id, full);
      this.subscribeFeeds(full);
    }
    this.emitList();
  }

  /** 전체 해제 — 타이머·구독 정리, WS 종료. */
  dispose(): void {
    for (const [id, instance] of this.instances) {
      instance.dispose();
      this.unsubs.get(id)?.();
    }
    this.unsubs.clear();
    this.realtime.close();
  }

  // ---- 내부 ----

  private instantiate(config: ScalperInstanceConfig): ScalperInstance {
    const deps: ScalperInstanceDeps = {
      broker: this.deps.makeBroker(config),
      clock: this.clock,
      scheduler: this.deps.scheduler,
      pollIntervalMs: this.deps.pollIntervalMs,
      repriceIntervalMs: this.deps.repriceIntervalMs,
      chunkSeconds: this.deps.chunkSeconds,
      bufferSize: this.deps.bufferSize,
      fillTimeoutMs: this.deps.fillTimeoutMs,
      throttleMs: this.deps.throttleMs,
      minBuyMomentum: this.deps.minBuyMomentum,
      minSellMomentum: this.deps.minSellMomentum,
      minVolumeSpikeRatio: this.deps.minVolumeSpikeRatio,
      minStrength: this.deps.minStrength,
      onError: this.deps.onError,
      onTrade: (instanceId, record) => {
        void appendTradeRecord(this.storage, instanceId, record).catch((err) =>
          this.deps.onError?.(err),
        );
      },
      onFault: (instanceId, fault) => {
        // 안전 인터록 발동을 상단 진단 한 줄로도 노출한다(카드 빨간 줄과 별개로 눈에 띄게).
        this.setFeedEvent(`자동매매 중단 · ${instanceId} · ${fault.text}`);
      },
      onAutoRun: (instanceId, note, qty) => {
        // 오토런 재시작/중지를 상단 진단 한 줄로 노출한다.
        this.setFeedEvent(`${instanceId} · ${note.text}`);
        // 자동 재시작으로 바뀐 수량을 영속화해 재시작 복원 시에도 유지되게 한다.
        if (note.kind === 'restarted') {
          const config = this.configs.get(instanceId);
          if (config) {
            this.configs.set(instanceId, { ...config, qty });
            void this.persist();
          }
        }
        this.refreshKeepAwake();
        this.emitList();
      },
    };
    const instance = new ScalperInstance(config, deps);
    // 상태 전이 시 keep-awake 재평가(매 틱 아님 — 인스턴스가 전이/스로틀로만 발행).
    const unsub = instance.subscribe(() => this.refreshKeepAwake());
    this.unsubs.set(config.id, unsub);
    return instance;
  }

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
  // 오토파일럿은 여기 등록해 같은 연결의 틱·호가를 나눠 받는다(수동/자동 모드 배타는 UI·매니저 가드 몫).
  private auxTick: ((symb: string, price: number, tsMs: number, extras?: TickExtras) => void) | null = null;
  private auxQuote: ((symb: string, bid1: number, ask1: number, tsMs: number) => void) | null = null;

  /** 외부(자동관리) 수신기 등록 — null로 해제. */
  setAuxRoutes(
    onTick: ((symb: string, price: number, tsMs: number, extras?: TickExtras) => void) | null,
    onQuote: ((symb: string, bid1: number, ask1: number, tsMs: number) => void) | null,
  ): void {
    this.auxTick = onTick;
    this.auxQuote = onQuote;
  }

  private routeTick(symb: string, price: number, tsMs: number, extras?: TickExtras): void {
    for (const instance of this.instances.values()) {
      if (instance.ticker === symb) instance.pushTick(price, tsMs, extras);
    }
    this.auxTick?.(symb, price, tsMs, extras);
  }

  /** 실시간호가(1호가)를 같은 티커의 인스턴스로 라우팅 — 어댑터가 공격적 지정가에 쓴다. */
  private routeQuote(
    symb: string,
    bid1: number,
    ask1: number,
    tsMs: number,
    bidVol1?: number,
    askVol1?: number,
  ): void {
    for (const instance of this.instances.values()) {
      if (instance.ticker === symb) instance.pushQuote(bid1, ask1, tsMs, bidVol1, askVol1);
    }
    this.auxQuote?.(symb, bid1, ask1, tsMs);
  }

  /** 실행 중(감시~청산) 인스턴스가 하나라도 있는가 — 자동관리 모드와의 상호 배타 가드용. */
  get anyRunning(): boolean {
    return [...this.instances.values()].some((i) => RUNNING_STATES.has(i.state));
  }

  /** 인스턴스 1개의 체결가(D…)·호가(R…) 구독을 함께 등록한다. */
  private subscribeFeeds(config: ScalperInstanceConfig): void {
    this.realtime.subscribe(this.trKeyOf(config));
    this.realtime.subscribe(this.quoteTrKeyOf(config), REALTIME_QUOTE_TR_ID);
  }

  /** 체결가(HDFSCNT0) tr_key — D+시장구분+티커. */
  private trKeyOf(config: ScalperInstanceConfig): string {
    return buildFreeQuoteTrKey(config.market ?? DEFAULT_MARKET, config.ticker);
  }

  /** 호가(HDFSASP0) tr_key — R+시장구분+티커. */
  private quoteTrKeyOf(config: ScalperInstanceConfig): string {
    return buildQuoteTrKey(config.market ?? DEFAULT_MARKET, config.ticker);
  }

  private refreshKeepAwake(): void {
    const anyRunning = [...this.instances.values()].some((i) => RUNNING_STATES.has(i.state));
    if (anyRunning && !this.awake) {
      this.awake = true;
      this.keepAwake?.activate();
    } else if (!anyRunning && this.awake) {
      this.awake = false;
      this.keepAwake?.deactivate();
    }
  }

  private async persist(): Promise<void> {
    const list = [...this.configs.values()];
    await this.storage.setItem(INSTANCES_STORAGE_KEY, JSON.stringify(list));
  }

  private emitList(): void {
    if (this.listListeners.size === 0) return;
    const snapshot = this.getInstances();
    for (const l of this.listListeners) l(snapshot);
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
