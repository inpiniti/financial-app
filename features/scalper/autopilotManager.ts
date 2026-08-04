// AutoPilotManager — 자동관리 모드 배선 (plan §3-5단계).
//
// watchlist(순위 폴링) → FeedSlot(WS 수신) → AutoPilot(감시·사이클)을 조립하고,
// WS 구독 예산을 지킨다(plan §4-11): 체결가(D)는 리스트 전 종목, 호가(R)는 감시 중(틱/초 top3,
// 사이클 중엔 보유 1종목)만 — 리스트 원천 4종 확장 후 최대 16건(체결가 12 + 핀 유예 1 + 호가 3).
//
// WS 핸들러는 ScalperManager가 유일 소유하므로, 이 매니저는 setAuxRoutes로 등록된
// routeTick/routeQuote를 통해 같은 연결의 수신을 나눠 받는다(수동/자동 상호 배타는 start 가드).

import { appendTradeRecord } from './tradeStore';
import { AutoPilot, type AutoPilotEvent, type AutoPilotView } from './autopilot';
import { FeedSlot, type FeedSlotView } from './feedSlot';
import { ScalperWatchlist, type RankingSnapshot, type WatchEntry } from './watchlist';
import {
  buildFreeQuoteTrKey,
  buildQuoteTrKey,
  REALTIME_QUOTE_TR_ID,
  type RealtimeMarketCode,
} from '../../kis/realtimePrice';
import type {
  ClockLike,
  InstanceFault,
  KeepAwakeControl,
  KeyValueStore,
  RealtimeFeed,
  ScalperBroker,
  SchedulerLike,
  TickExtras,
} from './types';

/** 거래 기록의 instanceId — 자동관리 사이클은 전부 이 아이디로 남긴다. */
export const AUTOPILOT_TRADE_ID = 'autopilot';

/** 리스트는 NAS 전용(plan §1-A) — trKey 시장구분도 고정. */
const MARKET: RealtimeMarketCode = 'NAS';

const defaultScheduler: SchedulerLike = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export interface AutoPilotManagerDeps {
  realtime: RealtimeFeed;
  storage: KeyValueStore;
  clock: ClockLike;
  scheduler?: SchedulerLike;
  /** 티커별 주문 게이트웨이 — 리스트가 NAS 전용이므로 거래소는 NASD로 고정해 만든다(provider 몫). */
  makeBroker: (ticker: string) => ScalperBroker;
  /** 순위 4종 1회 폴링(거래량·증가율·회전율·상승률, NAS·당일) — provider가 kis/ranking 4콜로 구현. */
  fetchSnapshot: () => Promise<RankingSnapshot>;
  /** 수동 카드 모드가 실행 중인가 — true면 start를 거부한다(상호 배타, plan §3-5단계). */
  isManualBusy?: () => boolean;
  /** 매수가능금액(USD) 사전 조회 — 현금 부족 PAUSED 판정(세션 확장 plan §2-4). 실패/미주입 시 판정 생략. */
  fetchBuyableUsd?: (ticker: string, price: number) => Promise<number | null>;
  /** 재시작 보유 감지(잔고조회 → 보유 티커 목록) — 감지되면 경고 이벤트만 낸다(차단 안 함, plan §2-6). */
  fetchHoldings?: () => Promise<string[]>;
  keepAwake?: KeepAwakeControl;
  chunkSeconds?: number;
  bufferSize?: number;
  minBuyMomentum?: number;
  minSellMomentum?: number;
  /** BUY 거래량 스파이크 게이트(배수, 0=끔) — FeedSlot detector로 그대로 흘려보낸다. */
  minVolumeSpikeRatio?: number;
  /** BUY 체결강도 게이트(STRN, 0=끔) — FeedSlot detector로 그대로 흘려보낸다. */
  minStrength?: number;
  /** 거래 수수료율(소수·편도, 0=끔) — AutoPilot으로 그대로 흘려보낸다. */
  feeRate?: number;
  pollIntervalMs?: number;
  /** 매도 리프라이스 주기(ms, 기본 1000) — AutoPilot으로 그대로 흘려보낸다. */
  repriceIntervalMs?: number;
  /** 매수 미체결 자동 취소 대기(ms, 0=끔) — AutoPilot으로 그대로 흘려보낸다. */
  buyCancelAfterMs?: number;
  reselectIntervalMs?: number;
  watchlistPollIntervalMs?: number;
  onError?: (err: unknown) => void;
}

export interface AutoPilotSlotRow {
  entry: WatchEntry;
  view: FeedSlotView;
}

type ViewListener = (view: AutoPilotView) => void;
type EventListener = (event: AutoPilotEvent) => void;
type ListListener = (rows: readonly AutoPilotSlotRow[]) => void;

const EVENT_LIMIT = 50;

export class AutoPilotManager {
  readonly pilot: AutoPilot;
  readonly watchlist: ScalperWatchlist;

  private readonly deps: AutoPilotManagerDeps;
  private readonly slots = new Map<string, FeedSlot>();
  /** 호가(R) 구독 중인 티커 — 감시 top3(또는 보유 1)만 유지한다. */
  private readonly quoteSubs = new Set<string>();
  private readonly events: AutoPilotEvent[] = [];
  private readonly viewListeners = new Set<ViewListener>();
  private readonly eventListeners = new Set<EventListener>();
  private readonly listListeners = new Set<ListListener>();
  private awake = false;

  constructor(deps: AutoPilotManagerDeps) {
    this.deps = deps;
    const scheduler = deps.scheduler ?? defaultScheduler;

    this.watchlist = new ScalperWatchlist({
      fetchSnapshot: deps.fetchSnapshot,
      scheduler,
      pollIntervalMs: deps.watchlistPollIntervalMs,
      onChange: (entries, diff) => {
        for (const ticker of diff.removed) this.dropSlot(ticker);
        for (const entry of diff.added) this.addSlot(entry.ticker);
        // 리스트가 바뀌면 즉시 감시 재선정 — 초기 채움(added)도 빈 감시 슬롯을 채워야 하고,
        // 감시 중이던 종목이 빠졌으면(removed) 대체 감시가 필요하다.
        this.pilot.reselect();
        this.emitList();
      },
      onError: (err) => {
        this.pushEvent({ at: this.deps.clock.now(), text: `순위 조회 실패 · ${summarize(err)}` });
        this.deps.onError?.(err);
      },
    });

    this.pilot = new AutoPilot({
      slots: () => [...this.slots.values()],
      pin: (t) => this.watchlist.pin(t),
      unpin: (t) => this.watchlist.unpin(t),
      makeBroker: deps.makeBroker,
      fetchBuyableUsd: deps.fetchBuyableUsd,
      clock: deps.clock,
      scheduler,
      storage: deps.storage,
      feeRate: deps.feeRate,
      pollIntervalMs: deps.pollIntervalMs,
      repriceIntervalMs: deps.repriceIntervalMs,
      buyCancelAfterMs: deps.buyCancelAfterMs,
      reselectIntervalMs: deps.reselectIntervalMs,
      onTrade: (record) => {
        void appendTradeRecord(deps.storage, AUTOPILOT_TRADE_ID, record).catch((err) =>
          this.deps.onError?.(err),
        );
      },
      onEvent: (e) => this.pushEvent(e),
      onFault: (fault: InstanceFault) => this.pushEvent({ at: fault.at, text: fault.text }),
    });

    this.pilot.subscribe((view) => {
      this.reconcileQuoteSubs(view);
      this.refreshKeepAwake(view);
      for (const l of this.viewListeners) l(view);
      this.emitList();
    });
  }

  // ---- 모드 수명주기 ----

  /** 자동관리 시작 — 수동 카드 실행 중이면 거부한다(상호 배타). */
  start(): void {
    if (this.deps.isManualBusy?.()) {
      throw new Error('수동 단타 카드가 실행 중이에요. 카드를 모두 정지한 뒤 자동 단타를 시작해 주세요.');
    }
    this.deps.realtime.connect();
    this.watchlist.start();
    this.pilot.start();
    void this.checkHoldings();
  }

  stop(): void {
    this.pilot.stop();
    this.watchlist.stop();
  }

  /** 앱 재시작 복원 — 금액 상태 로드(+보유 감지는 start 시점에 다시 한다). */
  async restore(): Promise<void> {
    await this.pilot.restore();
  }

  dispose(): void {
    this.pilot.dispose();
    this.watchlist.stop();
    for (const ticker of [...this.slots.keys()]) this.dropSlot(ticker);
  }

  // ---- WS 수신(ScalperManager.setAuxRoutes에 등록) ----

  routeTick = (symb: string, price: number, tsMs: number, extras?: TickExtras): void => {
    this.slots.get(symb)?.pushTick(price, tsMs, extras);
  };

  routeQuote = (symb: string, bid1: number, ask1: number, _tsMs: number): void => {
    this.slots.get(symb)?.pushQuote(bid1, ask1);
  };

  // ---- UI 구독 ----

  subscribeView(listener: ViewListener): () => void {
    this.viewListeners.add(listener);
    return () => {
      this.viewListeners.delete(listener);
    };
  }

  subscribeEvents(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  subscribeList(listener: ListListener): () => void {
    this.listListeners.add(listener);
    return () => {
      this.listListeners.delete(listener);
    };
  }

  /** 최근 이벤트(최신순, 최대 50) — 타임라인 초기 렌더용. */
  get recentEvents(): readonly AutoPilotEvent[] {
    return [...this.events];
  }

  /** 리스트 카드용 행 — watchlist 엔트리 + 해당 슬롯의 실시간 뷰. */
  getRows(): AutoPilotSlotRow[] {
    return this.watchlist.list
      .map((entry) => {
        const slot = this.slots.get(entry.ticker);
        return slot ? { entry, view: slot.getView() } : null;
      })
      .filter((r): r is AutoPilotSlotRow => r !== null);
  }

  /**
   * 호가 스냅샷(조회 전용) — WatchQuoteSheet가 "수신 시각"을 표시하려고 쓴다. FeedSlotView(getRows()의 view)엔
   * 수신 시각이 없어서(feedSlot.ts는 수정 금지 대상) 여기서 FeedSlot.quote 게터를 그대로 노출만 한다.
   * slot이 없거나(리스트에서 빠짐) 아직 호가를 못 받았으면 null — 호가는 감시 top3(또는 보유 1)에만 붙는다.
   */
  getQuote(ticker: string): { bid1: number; ask1: number; at: number } | null {
    return this.slots.get(ticker)?.quote ?? null;
  }

  // ---- 내부 ----

  private addSlot(ticker: string): void {
    if (this.slots.has(ticker)) return;
    this.slots.set(
      ticker,
      new FeedSlot({
        ticker,
        clock: this.deps.clock,
        chunkSeconds: this.deps.chunkSeconds,
        bufferSize: this.deps.bufferSize,
        minBuyMomentum: this.deps.minBuyMomentum,
        minSellMomentum: this.deps.minSellMomentum,
        minVolumeSpikeRatio: this.deps.minVolumeSpikeRatio,
        minStrength: this.deps.minStrength,
      }),
    );
    this.deps.realtime.subscribe(buildFreeQuoteTrKey(MARKET, ticker)); // 체결가(D) — 전 종목.
  }

  private dropSlot(ticker: string): void {
    const slot = this.slots.get(ticker);
    if (!slot) return;
    slot.detachDetector();
    this.slots.delete(ticker);
    this.deps.realtime.unsubscribe(buildFreeQuoteTrKey(MARKET, ticker));
    if (this.quoteSubs.delete(ticker)) {
      this.deps.realtime.unsubscribe(buildQuoteTrKey(MARKET, ticker), REALTIME_QUOTE_TR_ID);
    }
  }

  /** 호가(R) 구독을 감시 대상에 맞춘다 — 사이클 중엔 보유 1종목, 평시엔 top3(plan §4-11). */
  private reconcileQuoteSubs(view: AutoPilotView): void {
    const targets = new Set(view.activeTicker ? [view.activeTicker] : view.watched);
    for (const ticker of [...this.quoteSubs]) {
      if (!targets.has(ticker)) {
        this.quoteSubs.delete(ticker);
        this.deps.realtime.unsubscribe(buildQuoteTrKey(MARKET, ticker), REALTIME_QUOTE_TR_ID);
      }
    }
    for (const ticker of targets) {
      if (!this.quoteSubs.has(ticker) && this.slots.has(ticker)) {
        this.quoteSubs.add(ticker);
        this.deps.realtime.subscribe(buildQuoteTrKey(MARKET, ticker), REALTIME_QUOTE_TR_ID);
      }
    }
  }

  /** 자동 단타가 도는 동안 화면을 켜 둔다(IDLE·FAULT·PAUSED는 해제 — 일시정지 중엔 배터리를 아낀다). */
  private refreshKeepAwake(view: AutoPilotView): void {
    const running = view.state !== 'IDLE' && view.state !== 'FAULT' && view.state !== 'PAUSED';
    if (running && !this.awake) {
      this.awake = true;
      this.deps.keepAwake?.activate();
    } else if (!running && this.awake) {
      this.awake = false;
      this.deps.keepAwake?.deactivate();
    }
  }

  /** 재시작 보유 감지 — 감지돼도 차단하지 않고 경고만 한다(같은 계좌의 장기 보유가 있을 수 있다). */
  private async checkHoldings(): Promise<void> {
    if (!this.deps.fetchHoldings) return;
    try {
      const holdings = await this.deps.fetchHoldings();
      if (holdings.length > 0) {
        this.pushEvent({
          at: this.deps.clock.now(),
          text: `계좌에 보유 종목이 있어요(${holdings.join(', ')}) — 이전 세션의 미정리 포지션이면 수동으로 정리해 주세요`,
        });
      }
    } catch (err) {
      this.deps.onError?.(err);
    }
  }

  private pushEvent(event: AutoPilotEvent): void {
    this.events.unshift(event);
    if (this.events.length > EVENT_LIMIT) this.events.length = EVENT_LIMIT;
    for (const l of this.eventListeners) l(event);
  }

  private emitList(): void {
    if (this.listListeners.size === 0) return;
    const rows = this.getRows();
    for (const l of this.listListeners) l(rows);
  }
}

function summarize(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
