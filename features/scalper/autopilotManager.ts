// AutoPilotManager — 자동관리 모드 배선 (plan §3-5단계).
//
// watchlist(순위 폴링) → FeedSlot(WS 수신) → AutoPilot(감시·사이클)을 조립하고,
// WS 구독 예산을 지킨다(plan §4-11): 체결가(D)는 리스트 전 종목, 호가(R)는 **감시 top3 ∪ 보유 전 종목**.
// 다중 그리드(2026-08-05) 이후 보유 중에도 감시가 계속 돌기 때문에 둘의 합집합이다 —
// 리스트 원천 4종 기준 최대 (체결가 12 + 핀 유예 1) + 호가 (3 + 동시 그리드 수, 최대 6) ≈ 22건.
//
// WS 핸들러는 ScalperManager가 유일 소유하므로, 이 매니저는 setAuxRoutes로 등록된
// routeTick/routeQuote를 통해 같은 연결의 수신을 나눠 받는다(수동/자동 상호 배타는 start 가드).

import { appendTradeRecord } from './tradeStore';
import {
  AutoPilot,
  type AutoPilotDeps,
  type AutoPilotEvent,
  type AutoPilotView,
  type GridExitConfig,
} from './autopilot';
import { isDaytimeSessionOpen } from './daySession';
import { FeedSlot, type FeedSlotView } from './feedSlot';
import { ScalperWatchlist, type RankingSnapshot, type WatchEntry } from './watchlist';
import {
  buildDaytimeQuoteTrKey,
  buildFreeQuoteTrKey,
  REALTIME_QUOTE_TR_ID,
  type DaytimeMarketCode,
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
/**
 * 주간거래(2026-08-06 주간거래 plan v4, 사용자 확정: 정규장과 동일 종목군 공유) — 같은 워치리스트를
 * 그대로 쓰되, 주간거래 창(KST 10~16시)에는 나스닥-주간(BAQ) 시장구분 + R 접두로 구독한다.
 */
const DAYTIME_MARKET: DaytimeMarketCode = 'BAQ';

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
  /** 매도 관리 그리드 설정(폭·매수배율) — 주입되면 진입 후 청산을 ±w OCO 그리드가 인계한다(D5). 미주입이면 기존 청산. */
  gridConfig?: GridExitConfig;
  /** 재시작 보유 감지(잔고조회 → 보유 티커 목록) — 감지되면 경고 이벤트만 낸다(차단 안 함, plan §2-6). */
  fetchHoldings?: () => Promise<string[]>;
  /**
   * 시뮬레이션 모드 판정 — true면 거래 기록을 tradeStore(실거래 손익 화면)에 쓰지 않고
   * 이벤트에 [시뮬] 접두를 붙인다. **함수**인 이유: 모드는 IDLE에서 재빌드 없이 전환되므로(mutable ref)
   * 생성 시점 값을 캡처하면 전환이 반영되지 않는다. 미주입이면 항상 실거래.
   */
  isSimulation?: () => boolean;
  /** 진입 체결 확정 훅 — AutoPilot으로 그대로 흘려보낸다(SimLab 에피소드 개시). */
  onEntryFilled?: AutoPilotDeps['onEntryFilled'];
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
  /**
   * 체결가 구독 중인 티커 → 실제 구독에 쓴 trKey 문자열. 구독 시점의 세션(정규장 D / 주간거래 R)으로
   * 고정해 기억해둔다 — unsubscribe 시점에 세션이 바뀌어 있어도(예: 구독은 주간거래 중, 해제는 정규장
   * 중) 엉뚱한 키로 취소 요청을 보내 구독이 고아로 남는 사고를 막는다.
   */
  private readonly tickTrKeys = new Map<string, string>();
  /** 호가(R) 구독 중인 티커 → 실제 구독 trKey — 감시 top3(또는 보유 1)만 유지한다. tickTrKeys와 동일한 이유로 Map. */
  private readonly quoteSubs = new Map<string, string>();
  /**
   * 체결가(D) 구독 유지 홀드(티커별 참조 카운트) — **트레이딩 중인 종목은 리스트 탈락과 무관하게
   * WS 구독을 유지한다**(시뮬레이션 plan §5-4, 사용자 확정: 실전 포함 필수 수정).
   * 잡는 쪽: ① 보유·진입 중 사이클(pilot view의 activeTickers를 여기서 diff) ② SimLab 에피소드.
   * 홀드가 남아 있는 동안 dropSlot을 건너뛰고, 마지막 해제 때 리스트에 없으면 그때 정리한다.
   */
  private readonly tickHolds = new Map<string, number>();
  /** 직전 view의 activeTickers — 홀드 diff 계산용. */
  private prevActive = new Set<string>();
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
      // 진입금액보다 비싼 종목은 1주도 못 사서 감시·WS 구독만 낭비 — 리스트 단계에서 거른다.
      // setConfig는 IDLE에서만 통과하고 폴링은 start 직후 즉시 1회 돌므로, 시작 시점 금액이 곧바로 반영된다.
      maxPriceUsd: () => this.pilot.getView().config?.startAmountUsd ?? null,
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
      gridConfig: deps.gridConfig,
      clock: deps.clock,
      scheduler,
      storage: deps.storage,
      feeRate: deps.feeRate,
      pollIntervalMs: deps.pollIntervalMs,
      repriceIntervalMs: deps.repriceIntervalMs,
      buyCancelAfterMs: deps.buyCancelAfterMs,
      reselectIntervalMs: deps.reselectIntervalMs,
      onTrade: (record) => {
        // 시뮬 거래는 실거래 손익 화면(trades.* 키)을 오염시키지 않는다 — 기록은 SimLab→Supabase 몫.
        if (this.deps.isSimulation?.()) return;
        void appendTradeRecord(deps.storage, AUTOPILOT_TRADE_ID, record).catch((err) =>
          this.deps.onError?.(err),
        );
      },
      onEvent: (e) => this.pushEvent(e),
      onFault: (fault: InstanceFault) => this.pushEvent({ at: fault.at, text: fault.text }),
      onEntryFilled: deps.onEntryFilled,
    });

    this.pilot.subscribe((view) => {
      this.reconcileTickHolds(view);
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

  /**
   * 그리드 폭·매수배율 교체 — 설정 탭에서 저장한 값을 반영한다(managerProvider가 단타 탭 포커스마다 호출).
   * ⚠ 이 매니저는 모듈 스코프 싱글턴이라 앱을 껐다 켜기 전에는 buildManager()가 다시 돌지 않는다.
   *   이 경로가 없으면 설정 탭에서 폭을 바꿔도 최초 부팅 때 읽은 값으로 계속 발주한다(실제 사고).
   */
  setGridConfig(config: GridExitConfig | undefined): void {
    this.pilot.setGridConfig(config);
  }

  // ---- 잔고 보유분 입양(FAULT 이후 복구) ----

  /**
   * 계좌 보유 종목 티커 — 이미 관리 중인 종목은 빼고 돌려준다(등록 시트가 고를 목록).
   * fetchHoldings가 주입되지 않았으면 빈 배열.
   */
  async listAdoptableHoldings(): Promise<string[]> {
    if (!this.deps.fetchHoldings) return [];
    const managed = new Set(this.pilot.getView().activeTickers);
    const holdings = await this.deps.fetchHoldings();
    return holdings.filter((t) => !managed.has(t));
  }

  /** 보유분 1종목을 그리드 관리에 등록한다. 성공하면 null, 실패하면 사용자 문구. */
  adoptHolding(ticker: string): Promise<string | null> {
    return this.pilot.adoptPosition(ticker);
  }

  dispose(): void {
    this.pilot.dispose();
    this.watchlist.stop();
    this.tickHolds.clear(); // 홀드 가드보다 먼저 비워야 아래 dropSlot이 실제로 구독을 정리한다.
    this.prevActive.clear();
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

  /** 지금(clock.now())이 주간거래 창이면 R+BAQ, 아니면 D+NAS — 체결가·호가 구독 공용(같은 trKey 문자열). */
  private marketTrKeyOf(ticker: string): string {
    return isDaytimeSessionOpen(this.deps.clock.now())
      ? buildDaytimeQuoteTrKey(DAYTIME_MARKET, ticker)
      : buildFreeQuoteTrKey(MARKET, ticker);
  }

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
    const trKey = this.marketTrKeyOf(ticker); // 체결가 — 전 종목(정규장 D 또는 주간거래 R).
    this.tickTrKeys.set(ticker, trKey);
    this.deps.realtime.subscribe(trKey);
  }

  private dropSlot(ticker: string): void {
    // 홀드가 남아 있으면(트레이딩 중·에피소드 진행 중) 리스트에서 빠져도 슬롯·구독을 유지한다(§5-4).
    // 마지막 releaseTick이 리스트 부재를 확인하고 다시 이리로 온다.
    if ((this.tickHolds.get(ticker) ?? 0) > 0) return;
    const slot = this.slots.get(ticker);
    if (!slot) return;
    slot.detachDetector();
    this.slots.delete(ticker);
    const tickTrKey = this.tickTrKeys.get(ticker);
    this.tickTrKeys.delete(ticker);
    if (tickTrKey) this.deps.realtime.unsubscribe(tickTrKey);
    const quoteTrKey = this.quoteSubs.get(ticker);
    if (quoteTrKey) {
      this.quoteSubs.delete(ticker);
      this.deps.realtime.unsubscribe(quoteTrKey, REALTIME_QUOTE_TR_ID);
    }
  }

  /**
   * 호가(R) 구독을 감시·보유 대상에 맞춘다(plan §4-11).
   * 다중 그리드에서는 **감시 top3 ∪ 보유 전 종목**이 대상이다 — 보유 중에도 감시가 계속 돌기 때문에
   * 둘 중 하나만 구독하면 그리드 게이지(현재가)나 신규 진입 판단 중 하나가 눈이 먼다.
   * 예산: 체결가(D) 리스트 전 종목 + 호가(R) 최대 (3 + maxGrids)건.
   */
  private reconcileQuoteSubs(view: AutoPilotView): void {
    const targets = new Set([...view.watched, ...view.activeTickers]);
    for (const [ticker, trKey] of [...this.quoteSubs]) {
      if (!targets.has(ticker)) {
        this.quoteSubs.delete(ticker);
        this.deps.realtime.unsubscribe(trKey, REALTIME_QUOTE_TR_ID);
      }
    }
    for (const ticker of targets) {
      if (!this.quoteSubs.has(ticker) && this.slots.has(ticker)) {
        const trKey = this.marketTrKeyOf(ticker);
        this.quoteSubs.set(ticker, trKey);
        this.deps.realtime.subscribe(trKey, REALTIME_QUOTE_TR_ID);
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

  /** 현재 시뮬레이션 모드인가 — UI 배지가 읽는다(설정값이 아니라 실제 적용 모드). */
  get simulation(): boolean {
    return this.deps.isSimulation?.() === true;
  }

  /** 외부(managerProvider 등)가 타임라인에 안내 한 줄을 남길 때 쓴다 — 모드 전환 안내 등. */
  notify(text: string): void {
    this.pushEvent({ at: this.deps.clock.now(), text });
  }

  // ---- 체결가(D) 구독 유지 홀드 ----

  /**
   * 티커의 체결가(D) 구독을 리스트와 무관하게 유지한다(참조 카운트).
   * 슬롯이 없으면 만들어 구독까지 건다 — 입양(리스트 밖) 종목·SimLab 에피소드 종목이 여기에 해당.
   */
  holdTick(ticker: string): void {
    this.tickHolds.set(ticker, (this.tickHolds.get(ticker) ?? 0) + 1);
    this.addSlot(ticker);
  }

  /** 홀드 해제 — 마지막 해제이고 워치리스트에도 없으면 그때 슬롯·구독을 정리한다. */
  releaseTick(ticker: string): void {
    const count = this.tickHolds.get(ticker) ?? 0;
    if (count <= 1) {
      this.tickHolds.delete(ticker);
      if (!this.watchlist.list.some((e) => e.ticker === ticker)) this.dropSlot(ticker);
    } else {
      this.tickHolds.set(ticker, count - 1);
    }
  }

  /** 보유·진입 중 사이클의 홀드를 view 변화에 맞춘다 — 진입 시 잡고 정산·포기 시 푼다. */
  private reconcileTickHolds(view: AutoPilotView): void {
    const next = new Set(view.activeTickers);
    for (const ticker of next) {
      if (!this.prevActive.has(ticker)) this.holdTick(ticker);
    }
    for (const ticker of this.prevActive) {
      if (!next.has(ticker)) this.releaseTick(ticker);
    }
    this.prevActive = next;
  }

  private pushEvent(event: AutoPilotEvent): void {
    // 시뮬 모드 이벤트는 접두로 구분한다 — 타임라인만 봐도 실거래가 아님이 즉시 보이게.
    if (this.deps.isSimulation?.() && !event.text.startsWith('[시뮬]')) {
      event = { ...event, text: `[시뮬] ${event.text}` };
    }
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
