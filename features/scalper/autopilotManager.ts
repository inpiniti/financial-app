// AutoPilotManager — 자동관리 모드 배선 (plan §3-5단계).
//
// watchlist(순위 폴링) → FeedSlot(WS 수신) → AutoPilot(감시·사이클)을 조립한다.
// WS 구독은 체결가(HDFSCNT0)뿐이다 — 호가(1호가)는 체결가 틱에 실려 오는 PBID/PASK로 받는다
// (2026-08-14 호가(HDFSASP0) 구독 제거). 예산: 체결가 리스트 전 종목(≤30) + 보유 홀드 —
// KIS 한도(41건) 안이고 상세화면 몫도 남는다.
//
// WS 핸들러는 ScalperManager(피드 허브)가 유일 소유하므로, 이 매니저는 setAuxRoutes로 등록된
// routeTick/routeQuote를 통해 같은 연결의 수신을 나눠 받는다.

import { appendTradeRecord } from './tradeStore';
import {
  AutoPilot,
  type AutoPilotConfig,
  type AutoPilotDeps,
  type AutoPilotEvent,
  type AutoPilotView,
  type GridExitConfig,
  type InflectionGridConfig,
  type TrendGridConfig,
} from './autopilot';
import { isDaytimeSessionOpen } from './daySession';
import { FeedSlot, INFLECTION_ENTRY, LADDER_ENTRY, type FeedSlotView, type LadderEntryOptions } from './feedSlot';
import { TREND_MODE } from './trendMode';
import type { TradeStrategy } from './tradeResults';
import type { TradeRecord } from '../../core/cycle';
import { ScalperWatchlist, type RankingSnapshot, type WatchEntry, type WatchMarket } from './watchlist';
import type { MinuteBar } from '../../core/trend/bars';
import {
  buildDaytimeQuoteTrKey,
  buildFreeQuoteTrKey,
  REALTIME_PRICE_TR_ID,
  type DaytimeMarketCode,
} from '../../kis/realtimePrice';
import type { OverseasExchangeCode } from '../../kis/trId';
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

// 리스트는 미국 거래소 병합(2026-08-08 3거래소 확대 → 2026-08-10 아멕스 제외, 현재 NAS·NYS) — 티커별 채용 거래소(WatchEntry.market)가
// WS trKey 시장구분·주문 거래소를 정한다. AMS 매핑은 기존 채용 종목·방어적 정규화용으로 유지.
/** 주문 거래소 매핑 — features/stock/marketCodes.ts MARKET_TO_EXCHANGE와 같은 값(순환 참조 회피용 사본). */
const MARKET_TO_EXCHANGE: Record<WatchMarket, OverseasExchangeCode> = { NAS: 'NASD', NYS: 'NYSE', AMS: 'AMEX' };
/** 주간거래 창(KST 10~16시)의 WS 시장구분 — R 접두 + 거래소별 주간 코드(실시간지연체결가.txt). */
const MARKET_TO_DAYTIME: Record<WatchMarket, DaytimeMarketCode> = { NAS: 'BAQ', NYS: 'BAY', AMS: 'BAA' };
/** 세션 전환(정규장↔주간거래) 감지 주기 — 전환 시 구독 trKey를 새 세션 키로 회전한다. */
const SESSION_KEY_CHECK_MS = 30_000;
/** 추세 워밍업(REST 분봉조회) 실패 재시도 — 1회, 60초 뒤. 그 뒤로는 WS 봉으로 채운다. */
export const TREND_WARMUP_RETRY_MS = 60_000;
export const TREND_WARMUP_MAX_RETRY = 1;

const defaultScheduler: SchedulerLike = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export interface AutoPilotManagerDeps {
  realtime: RealtimeFeed;
  storage: KeyValueStore;
  clock: ClockLike;
  scheduler?: SchedulerLike;
  /** 티커별 주문 게이트웨이 — 거래소는 채용 거래소(WatchEntry.market → NASD/NYSE/AMEX)를 넘긴다. */
  makeBroker: (ticker: string, exchange: OverseasExchangeCode) => ScalperBroker;
  /** 리스트 원천 1회 폴링 — provider가 토스 거래량 실시간 순위(lib/tossRanking.ts)로 구현한다. */
  fetchSnapshot: () => Promise<RankingSnapshot>;
  /** 매수가능금액(USD) 사전 조회 — 현금 부족 PAUSED 판정. 실패/미주입 시 판정 생략. */
  fetchBuyableUsd?: (ticker: string, price: number, exchange: OverseasExchangeCode) => Promise<number | null>;
  /** 매도 관리 그리드 설정(폭·매수배율) — 주입되면 진입 후 청산을 ±w OCO 그리드가 인계한다(D5). 미주입이면 기존 청산. */
  gridConfig?: GridExitConfig;
  /**
   * 변곡점+그리드 조합 문턱(+2%/−3%, 2026-08-15 도메인 문서) — 주입되고 스위치(INFLECTION_GRID·
   * INFLECTION_ENTRY)가 켜져 있으면 진입 감지는 신호 전용 SG(청크 1초·버퍼 21 고정), 포지션 관리는
   * 조건부 그리드+매매가 맡는다(gridConfig·entryLadder보다 우선). 미주입이면 기존 동작 — 회귀 안전.
   */
  inflection?: InflectionGridConfig;
  /**
   * 추세 → 그리드 → 매매(2026-08-18 도메인 문서) — 주입되고 trendMode.TREND_MODE=true면 슬롯은 분봉(TREND_BAR_MINUTES) 합성+4선으로
   * 신호를 내고(FeedSlot trend), 포지션 관리는 추세 청산 규칙+매매가 맡는다(AutoPilot trendConfig). 조합·사다리보다 우선.
   * 미주입이면 기존 동작 — 회귀 안전.
   */
  trend?: TrendGridConfig;
  /**
   * 추세 워밍업 — 분봉조회(REST 120봉)를 분 키·종가로 돌려준다. 슬롯 생성마다 직렬 큐로 1회 호출해
   * FeedSlot.seedTrend에 넣는다. 미주입이면 WS 봉만으로 서서히 채운다(2시간 뒤에야 4선 완성).
   */
  fetchMinuteBars?: (ticker: string, market: WatchMarket) => Promise<MinuteBar[]>;
  /**
   * 거래 결과 외부 기록(docs/domain/켈리 §4 — Supabase trade_results). 정산마다 로컬 tradeStore append 뒤에
   * **await 없이** 부른다. 실패는 여기서 이벤트로만 남기고 매매는 계속(fail-open). 미주입이면 로컬 기록만.
   * 매매 판단·켈리 계산과 무관 — 기록만.
   */
  recordTradeResult?: (input: {
    record: TradeRecord;
    strategy: TradeStrategy;
    market: WatchMarket;
    name?: string;
  }) => Promise<void>;
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
  /**
   * 사다리 진입 감지 옵션(간격 g 소수·홀 횟수 N) — 주입되고 feedSlot.LADDER_ENTRY=true면
   * 감시가 SG 기울기 대신 가상 그리드 사다리로 변곡점을 판정한다(2026-08-07 plan).
   * 미주입(기존 하네스·테스트)이면 기존 SG 감지 그대로다.
   */
  entryLadder?: LadderEntryOptions;
  /** 거래 수수료율(소수·편도, 0=끔) — AutoPilot으로 그대로 흘려보낸다. */
  feeRate?: number;
  pollIntervalMs?: number;
  /** 매도 리프라이스 주기(ms, 기본 1000) — AutoPilot으로 그대로 흘려보낸다. */
  repriceIntervalMs?: number;
  /** 매수 미체결 자동 취소 대기(ms, 0=끔) — AutoPilot으로 그대로 흘려보낸다. */
  buyCancelAfterMs?: number;
  reselectIntervalMs?: number;
  watchlistPollIntervalMs?: number;
  /**
   * 외부 보조 소비자(종목 상세화면)가 이 (trKey, trId)를 잡고 있는지 조회 — managerProvider가
   * ScalperManager.holdsFeed로 배선한다. true면 dropSlot/reconcileQuoteSubs가 unsubscribe를 건너뛴다
   * (상세화면이 보고 있는 시세를 리스트 이탈이 끊지 않게 — 2026-08-07 종목상세화면 plan §4).
   */
  isFeedHeldExternally?: (trKey: string, trId: string) => boolean;
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
  /**
   * 오토파일럿 본체 — **테스트 하네스 전용**(타이머 대신 reselect/pollCycle을 직접 구동).
   * 화면·provider는 이 필드를 만지지 않고 getView/resume/setConfig 등 매니저 인터페이스만 쓴다.
   */
  readonly pilot: AutoPilot;
  readonly watchlist: ScalperWatchlist;

  private readonly deps: AutoPilotManagerDeps;
  /** 새 슬롯에 주입할 사다리 감지 옵션 — deps에서 초기값만 받고 setEntryLadder로 갈아끼운다. */
  private entryLadder: LadderEntryOptions | undefined;
  private readonly slots = new Map<string, FeedSlot>();
  /**
   * 체결가 구독 중인 티커 → 실제 구독에 쓴 trKey 문자열. 구독 시점의 키로 고정해 기억해둔다 —
   * 해제 시점에 채용 거래소 기록이 달라져 있어도 실제 구독했던 키 그대로 취소해 고아 구독을 막는다.
   */
  private readonly tickTrKeys = new Map<string, string>();
  /**
   * 체결가(D) 구독 유지 홀드(티커별 참조 카운트) — **트레이딩 중인 종목은 리스트 탈락과 무관하게
   * WS 구독을 유지한다**. 잡는 쪽: 보유·진입 중 사이클(pilot view의 activeTickers를 여기서 diff).
   * 홀드가 남아 있는 동안 dropSlot을 건너뛰고, 마지막 해제 때 리스트에 없으면 그때 정리한다.
   */
  private readonly tickHolds = new Map<string, number>();
  /** 직전 view의 activeTickers — 홀드 diff 계산용. */
  private prevActive = new Set<string>();
  /**
   * 티커 → 채용 거래소(마지막으로 리스트에서 본 값). 리스트 탈락 후에도 지우지 않는다 —
   * 핀·홀드로 살아 있는 사이클의 구독 해제·주문이 채용 당시 거래소를 계속 써야 하기 때문.
   * 기록이 없는 티커(입양 보유분 등)는 NAS로 간주한다(옛 NAS 전용 동작 보존).
   */
  private readonly tickerMarkets = new Map<string, WatchMarket>();
  /**
   * 티커 → 종목명(마지막으로 리스트에서 본 값). tickerMarkets와 같은 이유로 탈락 후에도 지우지 않는다 —
   * 거래 기록은 청산 시점에 남는데, 그때 이미 리스트에서 빠져 있는 종목이 흔하다.
   */
  private readonly tickerNames = new Map<string, string>();
  private readonly events: AutoPilotEvent[] = [];
  private readonly viewListeners = new Set<ViewListener>();
  private readonly eventListeners = new Set<EventListener>();
  private readonly listListeners = new Set<ListListener>();
  private awake = false;
  private readonly scheduler: SchedulerLike;
  /** 세션 전환 감지 타이머 — start()에서 걸고 dispose()에서만 푼다(stop 후에도 구독이 살아 있어서). */
  private sessionTimer: unknown = null;
  /** 직전 세션 판정(주간거래 여부) — 바뀐 순간에만 구독 키를 회전한다. */
  private lastDaytime: boolean;

  constructor(deps: AutoPilotManagerDeps) {
    this.deps = deps;
    this.entryLadder = deps.entryLadder;
    const scheduler = deps.scheduler ?? defaultScheduler;
    this.scheduler = scheduler;
    this.lastDaytime = isDaytimeSessionOpen(deps.clock.now());

    this.watchlist = new ScalperWatchlist({
      fetchSnapshot: deps.fetchSnapshot,
      scheduler,
      pollIntervalMs: deps.watchlistPollIntervalMs,
      // 진입금액보다 비싼 종목은 1주도 못 사서 감시·WS 구독만 낭비 — 리스트 단계에서 거른다.
      // setConfig는 IDLE에서만 통과하고 폴링은 start 직후 즉시 1회 돌므로, 시작 시점 금액이 곧바로 반영된다.
      // 진입 수량(entryQty)을 지정해도 이 필터는 유지한다 — 그때 진입금액은 "이 가격 이하 종목만"이라는
      // 상한 역할을 한다(사용자 확정 2026-08-18: 테스트 중이라 $10 이하 종목만 1주씩 같은 운용).
      maxPriceUsd: () => this.pilot.getView().config?.startAmountUsd ?? null,
      onChange: (entries, diff) => {
        // 구독·주문 거래소 판별용 — dropSlot/addSlot보다 먼저 최신화한다(추가 종목의 trKey가 이 맵을 읽는다).
        for (const entry of entries) {
          this.tickerMarkets.set(entry.ticker, entry.market);
          if (entry.name) this.tickerNames.set(entry.ticker, entry.name);
        }
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
      // AutoPilot은 거래소를 모른다 — 채용 거래소를 여기서 끼워 넣는다(리스트에 없던 티커는 NAS).
      makeBroker: (t) => deps.makeBroker(t, MARKET_TO_EXCHANGE[this.marketOf(t)]),
      fetchBuyableUsd: deps.fetchBuyableUsd
        ? (t, price) => deps.fetchBuyableUsd!(t, price, MARKET_TO_EXCHANGE[this.marketOf(t)])
        : undefined,
      gridConfig: deps.gridConfig,
      inflectionConfig: deps.inflection,
      trendConfig: deps.trend,
      clock: deps.clock,
      scheduler,
      storage: deps.storage,
      feeRate: deps.feeRate,
      pollIntervalMs: deps.pollIntervalMs,
      repriceIntervalMs: deps.repriceIntervalMs,
      buyCancelAfterMs: deps.buyCancelAfterMs,
      reselectIntervalMs: deps.reselectIntervalMs,
      onTrade: (record) => {
        // 채용 거래소를 함께 남긴다 — 거래기록 화면에서 행 탭 → 종목상세 진입 시 시장 판별용.
        // 종목명도 같이 남긴다 — 기록은 나중에 읽히는데 그때는 리스트에 없어 이름을 되찾을 길이 없다.
        void appendTradeRecord(
          deps.storage,
          AUTOPILOT_TRADE_ID,
          record,
          this.marketOf(record.ticker),
          this.tickerNames.get(record.ticker),
        ).catch((err) => this.deps.onError?.(err));
        // 외부 기록(켈리 조회용) — 실패해도 매매와 로컬 기록에는 영향 없다.
        if (deps.recordTradeResult) {
          void deps
            .recordTradeResult({
              record,
              strategy: this.strategyTag(),
              market: this.marketOf(record.ticker),
              name: this.tickerNames.get(record.ticker),
            })
            .catch((err) => this.pushEvent({ at: this.deps.clock.now(), text: `거래 기록 업로드 실패 · ${summarize(err)}` }));
        }
      },
      onEvent: (e) => this.pushEvent(e),
      onFault: (fault: InstanceFault) => this.pushEvent({ at: fault.at, text: fault.text }),
    });

    this.pilot.subscribe((view) => {
      this.reconcileTickHolds(view);
      this.refreshKeepAwake(view);
      for (const l of this.viewListeners) l(view);
      this.emitList();
    });
  }

  // ---- 모드 수명주기 ----

  /** 자동관리 시작. */
  /** 오토파일럿 현재 뷰(상태·감시·활성 사이클·설정) — 화면 초기 렌더·설정 화면 동기화용. */
  getView(): AutoPilotView {
    return this.pilot.getView();
  }

  /** 현금 부족 등으로 PAUSED된 오토파일럿을 사용자가 재개한다. */
  resume(): void {
    this.pilot.resume();
  }

  /** 트레이딩 설정 저장(IDLE에서만 통과) — 거절 사유 문자열 또는 null. */
  setConfig(config: AutoPilotConfig): string | null {
    return this.pilot.setConfig(config);
  }

  start(): void {
    this.deps.realtime.connect();
    this.watchlist.start();
    this.pilot.start();
    void this.checkHoldings();
    // 세션 전환(정규장↔주간거래) 감시 — 전환 시 살아 있는 구독의 trKey를 새 세션 키로 회전한다.
    if (this.sessionTimer === null) {
      this.sessionTimer = this.scheduler.setInterval(() => this.rotateSessionKeys(), SESSION_KEY_CHECK_MS);
    }
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

  /**
   * 사다리 진입 감지(간격·홀 횟수) 교체 — 그리드 폭과 같은 이유로 필요한 경로다.
   * 감지 옵션은 슬롯(FeedSlot)마다 박혀 있어 여기서 **살아 있는 슬롯 전부**에 흘려 넣고,
   * 앞으로 만들어질 슬롯을 위해 기준값도 갈아끼운다(addSlot이 이 값을 읽는다).
   * 감시 중이던 슬롯은 새 간격 기준의 새 앵커에서 홀을 다시 센다(FeedSlot.setLadderOptions).
   */
  setEntryLadder(options: LadderEntryOptions | undefined): void {
    const prev = this.entryLadder;
    if (
      prev === options ||
      (prev !== undefined &&
        options !== undefined &&
        prev.interval === options.interval &&
        prev.triggerCount === options.triggerCount)
    ) {
      return;
    }
    this.entryLadder = options;
    for (const slot of this.slots.values()) slot.setLadderOptions(options);
    if (options) {
      this.pushEvent({
        at: this.deps.clock.now(),
        text: `진입 감지 설정 적용 · 간격 ${(options.interval * 100).toFixed(2)}% · ${options.triggerCount}칸`,
      });
    }
  }

  /** 매수 미체결 취소 대기(ms) 교체 — 파일럿으로 그대로 흘려보낸다(설정 탭 저장 반영). */
  setBuyCancelAfterMs(ms: number): void {
    this.pilot.setBuyCancelAfterMs(ms);
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
    if (this.sessionTimer !== null) {
      this.scheduler.clearInterval(this.sessionTimer);
      this.sessionTimer = null;
    }
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

  /**
   * 이 매니저가 현재 (trKey, trId)를 구독 중인가 — ScalperManager.acquireFeed/releaseFeed가
   * 실제 subscribe/unsubscribe 여부를 판단할 때 프로브로 조회한다(교차 해제 방지).
   * 구독은 체결가(HDFSCNT0)뿐이므로 다른 trId는 항상 false다.
   */
  usesTrKey(trKey: string, trId: string): boolean {
    if (trId !== REALTIME_PRICE_TR_ID) return false;
    return [...this.tickTrKeys.values()].includes(trKey);
  }

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

  /** 리스트 카드용 행 — watchlist 엔트리 + 해당 슬롯의 실시간 뷰. 틱/초 빠른 순으로 정렬. */
  getRows(): AutoPilotSlotRow[] {
    return this.watchlist.list
      .map((entry) => {
        const slot = this.slots.get(entry.ticker);
        return slot ? { entry, view: slot.getView() } : null;
      })
      .filter((r): r is AutoPilotSlotRow => r !== null)
      .sort((a, b) => b.view.tickRate - a.view.tickRate);
  }

  /**
   * 호가 스냅샷(조회 전용) — FeedSlot.quote 게터 노출. slot이 없거나(리스트에서 빠짐) 아직 호가를
   * 못 받았으면 null. 옛 WatchQuoteSheet가 쓰던 API지만 진단·테스트 접근용으로 남긴다.
   */
  getQuote(ticker: string): { bid1: number; ask1: number; at: number } | null {
    return this.slots.get(ticker)?.quote ?? null;
  }

  // ---- 내부 ----

  /** 현재 배선의 진입·청산 규칙 태그(거래 결과 기록용) — 스위치·주입 조합을 그대로 읽는다. */
  strategyTag(): TradeStrategy {
    if (TREND_MODE && this.deps.trend !== undefined) return 'trend';
    if (INFLECTION_ENTRY && this.deps.inflection !== undefined) return 'inflection';
    if (LADDER_ENTRY && this.entryLadder !== undefined) return 'ladder';
    return 'grid';
  }

  /** 티커의 채용 거래소 — 리스트에서 한 번도 못 본 티커(입양 보유분 등)는 NAS. */
  private marketOf(ticker: string): WatchMarket {
    return this.tickerMarkets.get(ticker) ?? 'NAS';
  }

  /**
   * 지금(clock.now())이 주간거래 창이면 R+주간시장(BAQ/BAY/BAA), 아니면 D+채용거래소 —
   * 체결가·호가 구독 공용(같은 trKey 문자열, tr_id로만 구분). 워치리스트는 정규장과 공유한다
   * (2026-08-06 주간거래 plan §6-1 사용자 확정, 2026-08-10 실거래 재개로 부활).
   */
  private marketTrKeyOf(ticker: string): string {
    const market = this.marketOf(ticker);
    return isDaytimeSessionOpen(this.deps.clock.now())
      ? buildDaytimeQuoteTrKey(MARKET_TO_DAYTIME[market], ticker)
      : buildFreeQuoteTrKey(market, ticker);
  }

  /**
   * 세션 전환(정규장↔주간거래) 시 살아 있는 구독을 새 세션 키로 회전한다 — 이게 없으면 10:00/16:00
   * 경계에서 기존 종목의 구독 키가 옛 세션 것으로 남아 틱이 끊긴다(리스트가 안 바뀐 종목은 재구독 계기가
   * 없다). 새 키 구독 → 옛 키 해제 순서. 상세화면이 잡고 있는 옛 키는 해제하지 않는다(교차 해제 방지).
   */
  private rotateSessionKeys(): void {
    const daytime = isDaytimeSessionOpen(this.deps.clock.now());
    if (daytime === this.lastDaytime) return;
    this.lastDaytime = daytime;
    for (const [ticker, oldKey] of [...this.tickTrKeys]) {
      const newKey = this.marketTrKeyOf(ticker);
      if (newKey === oldKey) continue;
      this.tickTrKeys.set(ticker, newKey);
      this.deps.realtime.subscribe(newKey);
      if (!this.deps.isFeedHeldExternally?.(oldKey, REALTIME_PRICE_TR_ID)) {
        this.deps.realtime.unsubscribe(oldKey);
      }
    }
  }

  private addSlot(ticker: string): void {
    if (this.slots.has(ticker)) return;
    const slot = new FeedSlot({
      ticker,
      clock: this.deps.clock,
      chunkSeconds: this.deps.chunkSeconds,
      bufferSize: this.deps.bufferSize,
      minBuyMomentum: this.deps.minBuyMomentum,
      minSellMomentum: this.deps.minSellMomentum,
      minVolumeSpikeRatio: this.deps.minVolumeSpikeRatio,
      minStrength: this.deps.minStrength,
      ladder: this.entryLadder,
      inflection: this.deps.inflection !== undefined,
      trend: this.deps.trend !== undefined,
    });
    this.slots.set(ticker, slot);
    const trKey = this.marketTrKeyOf(ticker); // 체결가 — 전 종목(정규장 D 또는 주간거래 R).
    this.tickTrKeys.set(ticker, trKey);
    this.deps.realtime.subscribe(trKey);
    this.enqueueTrendWarmup(ticker);
  }

  // ---- 추세 워밍업 큐(REST 분봉조회 → FeedSlot.seedTrend) — 직렬 1개, 티커 중복 제거, 실패 1회 재시도 ----

  private readonly trendWarmupQueue: string[] = [];
  private trendWarmupBusy = false;
  private readonly trendWarmupAttempts = new Map<string, number>();

  private enqueueTrendWarmup(ticker: string): void {
    if (this.deps.trend === undefined || !this.deps.fetchMinuteBars) return;
    if (this.trendWarmupQueue.includes(ticker)) return;
    this.trendWarmupQueue.push(ticker);
    void this.drainTrendWarmup();
  }

  private async drainTrendWarmup(): Promise<void> {
    if (this.trendWarmupBusy) return;
    this.trendWarmupBusy = true;
    try {
      while (this.trendWarmupQueue.length > 0) {
        const ticker = this.trendWarmupQueue.shift()!;
        const slot = this.slots.get(ticker);
        if (!slot) continue; // 그 사이 리스트에서 빠졌다.
        try {
          const bars = await this.deps.fetchMinuteBars!(ticker, this.marketOf(ticker));
          const live = this.slots.get(ticker);
          if (!live) continue;
          const n = live.seedTrend(bars);
          this.trendWarmupAttempts.delete(ticker);
          const lastKey = live.trendLastBarKey;
          const nowKey = Math.floor(this.deps.clock.now() / 60_000);
          this.pushEvent({
            at: this.deps.clock.now(),
            // 이음새 검증용 — 마지막 시드 봉과 현재 분의 간격(분). 실사용 첫날 오프셋 확인에 쓴다.
            text: `${ticker} 추세 시드 · ${n}봉 · 마지막 봉 ${lastKey === null ? '없음' : `${nowKey - lastKey}분 전`}`,
          });
        } catch (err) {
          const attempt = (this.trendWarmupAttempts.get(ticker) ?? 0) + 1;
          this.trendWarmupAttempts.set(ticker, attempt);
          if (attempt <= TREND_WARMUP_MAX_RETRY) {
            this.pushEvent({
              at: this.deps.clock.now(),
              text: `${ticker} 추세 시드 실패 · ${summarize(err)} — ${Math.round(TREND_WARMUP_RETRY_MS / 1000)}초 뒤 다시 시도해요`,
            });
            const handle = this.scheduler.setInterval(() => {
              this.scheduler.clearInterval(handle);
              this.enqueueTrendWarmup(ticker);
            }, TREND_WARMUP_RETRY_MS);
          } else {
            this.trendWarmupAttempts.delete(ticker);
            this.pushEvent({
              at: this.deps.clock.now(),
              text: `${ticker} 추세 시드 포기 · ${summarize(err)} — 체결가 봉으로 서서히 채워요(4선 완성까지 약 2시간)`,
            });
          }
        }
      }
    } finally {
      this.trendWarmupBusy = false;
    }
  }

  private dropSlot(ticker: string): void {
    // 홀드가 남아 있으면(트레이딩 중) 리스트에서 빠져도 슬롯·구독을 유지한다.
    // 마지막 releaseTick이 리스트 부재를 확인하고 다시 이리로 온다.
    if ((this.tickHolds.get(ticker) ?? 0) > 0) return;
    const slot = this.slots.get(ticker);
    if (!slot) return;
    slot.detachDetector();
    this.slots.delete(ticker);
    const qi = this.trendWarmupQueue.indexOf(ticker);
    if (qi >= 0) this.trendWarmupQueue.splice(qi, 1);
    this.trendWarmupAttempts.delete(ticker);
    const tickTrKey = this.tickTrKeys.get(ticker);
    this.tickTrKeys.delete(ticker);
    // 상세화면이 같은 키를 잡고 있으면 실제 해제는 건너뛴다 — 그쪽 releaseFeed가 마지막에 정리한다.
    if (tickTrKey && !this.deps.isFeedHeldExternally?.(tickTrKey, REALTIME_PRICE_TR_ID)) {
      this.deps.realtime.unsubscribe(tickTrKey);
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
          text: `계좌에 보유 종목이 있어요(${holdings.join(', ')}) — 이전 실행의 미정리 포지션이면 수동으로 정리해 주세요`,
        });
      }
    } catch (err) {
      this.deps.onError?.(err);
    }
  }

  // ---- 체결가(D) 구독 유지 홀드 ----

  /**
   * 티커의 체결가(D) 구독을 리스트와 무관하게 유지한다(참조 카운트).
   * 슬롯이 없으면 만들어 구독까지 건다 — 입양(리스트 밖) 종목이 여기에 해당.
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
