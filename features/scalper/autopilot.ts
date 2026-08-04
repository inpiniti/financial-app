// AutoPilot — 단타 관리자 (plan: 2026-07-31_단타-자동관리 + 2026-08-01_단타-세션-확장).
//
// 단타 도메인의 중앙 관리자: 상태·금액(세션)·종목을 한 곳에서 관리한다.
//  · 리스트(FeedSlot들)는 전부 시세를 받지만, 변곡점 감시(detector)는
//    **최소 속도(minTickRate) 이상인 종목 중** 틱/초 상위 최대 3개에만 부착(자격자가 없으면 0개 — 진입 없음).
//  · RUN(매매 사이클)은 동시에 1종목만 — RunCycle + OrderPortAdapter를 사이클마다 새로 만든다.
//  · 세션: 시작금액으로 개시, 사이클마다 수익 절반(하한 $1)·손실 2배(상한 없음)로 조정.
//    종료 조건(AND, 금액 조정 **전** 판정): 마지막 사이클 수익 + 투입금액 ≥ 최대금액 + 세션 성과 ≥ 0
//    → 달성 시 새 세션(시작금액·성과 0) 자동 개시.
//  · 현금 부족(매수가능금액 < 필요금액) → PAUSED. 새 세션 자동 개시 금지 —
//    사람이 "이어서 재개" 또는 "세션 초기화"를 선택한다(사용자 확정 §4-3).
//
// 안전장치는 ScalperInstance와 같은 원칙: 매수 전 프리플라이트, FAULT 인터록(사용자 Stop으로만 해제),
// 미체결 무한 대기(취소는 사용자 Stop 경로에서만).

import { RunCycle, type SignalSnapshot, type TradeRecord } from '../../core/cycle';
import type { Signal } from '../../core/detector';
import { Grid, type GridPollResult } from '../../core/grid';
import { FeedSlot, type SlotSignalContext } from './feedSlot';
import { OrderPortAdapter } from './orderPortAdapter';
import { createGridOrderPort } from './gridOrderPort';
import type {
  AdapterFault,
  ClockLike,
  InstanceFault,
  KeyValueStore,
  ScalperBroker,
  SchedulerLike,
} from './types';

export const AUTOPILOT_STORAGE_KEY = 'scalper:autopilot';

/** 감시 대상 수(자격자 중 상위 N) · 재평가 주기 · 히스테리시스 배율. */
export const WATCH_COUNT = 3;
export const RESELECT_INTERVAL_MS = 30_000;
export const HYSTERESIS_RATIO = 1.2;
/** 연속 매수 취소가 이 횟수에 닿으면 그 종목 매수를 잠시 쉰다. */
export const ABANDON_COOLDOWN_STREAK = 3;
/** 매수 취소 쿨다운 길이(ms). */
export const ABANDON_COOLDOWN_MS = 60_000;
/** 최소 속도 기본값(틱/초) — 0 설정 불가(> 0 강제, 사용자 확정 §4-6). */
export const DEFAULT_MIN_TICK_RATE = 1;
/**
 * 수익 반감의 하한(USD) — 시작금액과 무관하게 $1 밑으로는 안 내려간다(사용자 확정 §4-1).
 * 마틴게일을 켰을 때만 적용된다(끄면 금액 조정 자체가 없다).
 */
export const AMOUNT_FLOOR_USD = 1;

/**
 * 매도 관리 그리드로 진입 후 청산을 대체할지(D5). true면 진입 체결 후 관리를 ±w OCO 지정가 그리드가
 * 인계한다(변곡점 매도 신호 무시). false로 두면 기존 변곡점 청산 경로로 **한 줄 롤백**된다.
 * ⚠ 실제 활성화는 이 상수 **그리고** deps.gridConfig 주입이 모두 있어야 한다 —
 *    gridConfig가 없으면(기존 테스트 하네스) 항상 기존 청산 경로로 동작한다.
 */
export const GRID_EXIT = true;

/** 그리드 설정 — 폭(w)·매수 배율(buyMultiplier). 설정 화면 노출은 다음 단계, 지금은 주입 기본값. */
export interface GridExitConfig {
  /** 폭 w(기본 0.10). buyPrice=P×(1−w), sellPrice=P×(1+w). */
  width: number;
  /** 매수 배율(기본 1). 매수수량 = floor(N×배율), 매도는 항상 N 전량. */
  buyMultiplier: number;
}

export type AutoPilotState = 'IDLE' | 'SCANNING' | 'ENTERING' | 'HOLDING' | 'EXITING' | 'PAUSED' | 'FAULT';

/** 사용자 설정 — 시작금액·최대금액·최소 속도(+마틴게일 on/off). */
export interface AutoPilotConfig {
  startAmountUsd: number;
  maxAmountUsd: number;
  minTickRate: number;
  /**
   * 마틴게일(손실 2배·수익 절반·세션 완주 판정) 사용 여부. **미지정이면 켬** — 기존 저장값 하위호환.
   * 끄면 금액이 절대 변하지 않고 세션 완주 판정도 하지 않는다(정지할 때까지 같은 금액으로 반복).
   * 끌 때는 maxAmountUsd를 startAmountUsd와 같은 값으로 정규화해 저장한다(불변식 유지·ON 복귀 대비).
   */
  martingale?: boolean;
}

/**
 * 마틴게일 사용 여부 단일 판정. **명시적 false일 때만 끔**이다.
 * `?? true`가 아니라 `!== false`인 이유: 저장값이 손상돼 null·0·"false" 같은 값이 들어와도
 * 기존 동작(켬)으로 안전하게 폴백하기 위해서다.
 */
export function isMartingaleOn(config: Pick<AutoPilotConfig, 'martingale'>): boolean {
  return config.martingale !== false;
}

/** 진행 중 세션 — Stop·FAULT·재시작에도 유지되고, 종료 조건 달성 때만 리셋된다. */
export interface SessionState {
  amountUsd: number;
  /** 세션 누적 실현손익(USD). */
  pnl: number;
  cycles: number;
  /** 현금 부족으로 일시정지된 세션 — 재개/초기화는 사람이 선택. */
  paused: boolean;
}

export interface AutoPilotEvent {
  at: number;
  text: string;
}

export interface AutoPilotView {
  readonly state: AutoPilotState;
  readonly config: AutoPilotConfig | null;
  readonly session: SessionState | null;
  /** 오늘(미국 장 기준일) 열린 세션 수. */
  readonly sessionCount: number;
  /** 변곡점 감시 중인 티커(자격자 중 상위 — 0~3개). */
  readonly watched: readonly string[];
  readonly activeTicker: string | null;
  /** 오늘(미국 장 기준일) 전체 완료 사이클 수·누적 실현손익(세션과 무관). */
  readonly cycles: number;
  readonly cumPnl: number;
  readonly lastEvent: AutoPilotEvent | null;
  readonly lastFault: InstanceFault | null;
  /**
   * 매도 관리 그리드 상태 — 진입 후 그리드가 인계 중일 때만 채워진다(그 외 null).
   * 다음 단계 게이지 UI가 읽는 필드: 평단·매수가·매도가·현재가·보유수량·매수배율·활성여부.
   */
  readonly grid: AutoPilotGridView | null;
}

/** 게이지 UI가 소비할 그리드 뷰(관리 중 종목 1개). */
export interface AutoPilotGridView {
  ticker: string;
  /** 평단가 P(그리드가 관리하는 평균 — 리브래킷하면 낮아진다). */
  avgPrice: number;
  /** 매수 지정가 P×(1−w). */
  buyPrice: number;
  /** 매도 지정가 P×(1+w). */
  sellPrice: number;
  /** 최근 틱 현재가 — 게이지 화살표 위치용. 아직 없으면 null. */
  currentPrice: number | null;
  /** 보유수량 N. */
  holdingQty: number;
  /** 매수 배율. */
  buyMultiplier: number;
  /** 그리드가 두 주문을 실제로 걸고 관리 중인가(ARMED). */
  gridActive: boolean;
}

export interface AutoPilotDeps {
  /** 현재 리스트의 FeedSlot들 — 매니저(배선)가 watchlist 기준으로 유지한다. */
  slots: () => readonly FeedSlot[];
  /** 사이클 진입/종료 시 watchlist 제거 유예 훅. */
  pin: (ticker: string) => void;
  unpin: (ticker: string) => void;
  /** 티커별 주문 게이트웨이(실서비스 createKisBroker, 테스트 가짜 심). */
  makeBroker: (ticker: string) => ScalperBroker;
  /**
   * 매도 관리 그리드 설정(폭·매수배율). **주입되면** 진입 체결 후 관리를 ±w OCO 그리드가 인계한다(D5·GRID_EXIT).
   * 미주입이면(기존 하네스) 기존 변곡점 청산 경로로 동작한다 — 하위호환·회귀 안전.
   */
  gridConfig?: GridExitConfig;
  /**
   * 매수가능금액(USD) 사전 조회 — 현금 부족 PAUSED 판정용. null 반환/미주입/throw면
   * 판정 없이 진행한다(주문 거절은 기존 FAULT 인터록이 받는다 — plan §2-4 폴백).
   */
  fetchBuyableUsd?: (ticker: string, price: number) => Promise<number | null>;
  clock: ClockLike;
  scheduler: SchedulerLike;
  storage: KeyValueStore;
  /** 사이클 종료 기록 — 매니저가 tradeStore에 연결. */
  onTrade?: (record: TradeRecord) => void;
  onEvent?: (event: AutoPilotEvent) => void;
  onFault?: (fault: InstanceFault) => void;
  /** 거래 수수료율(소수·편도, 0=끔) — 사이클 RunCycle로 넘겨 손익에서 차감한다. */
  feeRate?: number;
  /** 체결 폴링 주기(ms, 기본 2000 — 기존 인스턴스와 동일). */
  pollIntervalMs?: number;
  /** 매도 리프라이스 주기(ms, 기본 1000). 매수1호가가 바뀐 경우에만 정정을 낸다. */
  repriceIntervalMs?: number;
  /** 매수 미체결 자동 취소 대기(ms, 0=끔). 부분체결이면 취소하지 않는다. */
  buyCancelAfterMs?: number;
  reselectIntervalMs?: number;
  hysteresisRatio?: number;
  watchCount?: number;
}

/** 금액 조정 규칙(순수) — 수익 절반(하한 $1)·손실 2배(상한 없음)·본전 유지. */
export function nextAmountUsd(current: number, pnl: number): number {
  if (pnl > 0) return Math.max(current / 2, AMOUNT_FLOOR_USD);
  if (pnl < 0) return current * 2;
  return current;
}

/** 진입 수량(순수) — 금액÷가격 내림. 1 미만이면 0(진입 포기 신호). */
export function qtyForAmount(amountUsd: number, price: number): number {
  if (!Number.isFinite(amountUsd) || !Number.isFinite(price) || price <= 0) return 0;
  return Math.floor(amountUsd / price);
}

/**
 * 세션 종료 판정(순수) — AND 3조건, **금액 조정 전**의 이번 사이클 투입금액 기준(사용자 확정 §4-2).
 * 성과는 0 포함(≥ 0 — §4-8).
 */
export function shouldEndSession(
  cyclePnl: number,
  usedAmountUsd: number,
  sessionPnl: number,
  maxAmountUsd: number,
): boolean {
  return cyclePnl > 0 && usedAmountUsd >= maxAmountUsd && sessionPnl >= 0;
}

/**
 * 설정 검증(순수) — 0 < 시작 ≤ 최대, 최소 속도 > 0. 문제 없으면 null, 있으면 사용자 문구.
 * 마틴게일을 끄면 최대금액이 의미가 없으므로 그 검사만 건너뛴다(= 규칙이 더 관대해진다).
 * ⚠ restore()가 이 함수로 저장값을 필터링하므로, 규칙을 **엄격하게** 바꾸면 기존 설정이 조용히 소실된다.
 */
export function validateConfig(config: AutoPilotConfig): string | null {
  const martingaleOn = isMartingaleOn(config);
  if (!Number.isFinite(config.startAmountUsd) || config.startAmountUsd <= 0) {
    return martingaleOn
      ? '시작금액은 0보다 큰 달러 금액으로 입력해 주세요'
      : '금액은 0보다 큰 달러 금액으로 입력해 주세요';
  }
  if (martingaleOn && (!Number.isFinite(config.maxAmountUsd) || config.maxAmountUsd < config.startAmountUsd)) {
    return '최대금액은 시작금액 이상으로 입력해 주세요';
  }
  if (!Number.isFinite(config.minTickRate) || config.minTickRate <= 0) {
    return '최소 속도는 0보다 크게 입력해 주세요 (기본 1틱/초)';
  }
  return null;
}

/** 미국 장 기준일(America/New_York 날짜, YYYY-MM-DD) — "오늘"의 기준(사용자 확정 §4-7). */
export function etDateOf(epochMs: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(epochMs));
}

interface ActiveCycle {
  ticker: string;
  slot: FeedSlot;
  adapter: OrderPortAdapter;
  cycle: RunCycle;
  /** 이 사이클의 브로커 — 그리드 발주에 재사용한다(진입 어댑터와 같은 브로커). */
  broker: ScalperBroker;
  /** 매도 관리 그리드(진입 후 인계). 미인계면 null. */
  grid: Grid | null;
  /** 그리드가 두 주문을 실제로 발주했는가(arm 성공). */
  gridArmed: boolean;
}

interface PendingBuy {
  ctx: SlotSignalContext;
  tickRate: number;
}

interface PersistedV2 {
  version: 2;
  config: AutoPilotConfig | null;
  session: SessionState | null;
  daily: { date: string; sessionCount: number; cycles: number; cumPnl: number } | null;
}

type Listener = (view: AutoPilotView) => void;

export class AutoPilot {
  private readonly deps: AutoPilotDeps;
  private readonly pollIntervalMs: number;
  private readonly repriceIntervalMs: number;
  private readonly buyCancelAfterMs: number;
  private readonly reselectIntervalMs: number;
  private readonly hysteresisRatio: number;
  private readonly watchCount: number;

  private state: AutoPilotState = 'IDLE';
  private config: AutoPilotConfig | null = null;
  private session: SessionState | null = null;
  private dailyDate: string | null = null;
  private sessionCount = 0;
  private watchedTickers: string[] = [];
  private active: ActiveCycle | null = null;
  private pendingBuy: PendingBuy | null = null;
  private buyCommitting = false;
  private pendingSettle: TradeRecord | null = null;
  /** BUYING 진입 시각(자동 포기 경과 기점). */
  private buyingSince: number | null = null;
  /** 이 주문에 자동 포기를 이미 요청했는가. */
  private abandonRequested = false;
  /** 티커별 연속 취소 기록 — 사이클마다 종목이 바뀌므로 맵으로 둔다. */
  private readonly abandonState = new Map<string, { streak: number; until: number }>();
  private stopRequested = false;
  private cycles = 0;
  private cumPnl = 0;
  private lastEvent: AutoPilotEvent | null = null;
  private lastFault: InstanceFault | null = null;

  private pollTimer: unknown = null;
  /** 매도 리프라이스 타이머(폴 타이머와 함께 켜고 끈다). */
  private repriceTimer: unknown = null;
  /** 리프라이스 틱 재진입 방지. */
  private repriceTicking = false;
  private reselectTimer: unknown = null;
  private readonly listeners = new Set<Listener>();

  constructor(deps: AutoPilotDeps) {
    this.deps = deps;
    this.pollIntervalMs = deps.pollIntervalMs ?? 2000;
    this.repriceIntervalMs = deps.repriceIntervalMs ?? 1000;
    this.buyCancelAfterMs = deps.buyCancelAfterMs ?? 0;
    this.reselectIntervalMs = deps.reselectIntervalMs ?? RESELECT_INTERVAL_MS;
    this.hysteresisRatio = deps.hysteresisRatio ?? HYSTERESIS_RATIO;
    this.watchCount = deps.watchCount ?? WATCH_COUNT;
  }

  // ---- 구독/뷰 ----

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getView(): AutoPilotView {
    return {
      state: this.state,
      config: this.config ? { ...this.config } : null,
      session: this.session ? { ...this.session } : null,
      sessionCount: this.sessionCount,
      watched: [...this.watchedTickers],
      activeTicker: this.active?.ticker ?? null,
      cycles: this.cycles,
      cumPnl: this.cumPnl,
      lastEvent: this.lastEvent,
      lastFault: this.lastFault,
      grid: this.gridView(),
    };
  }

  /** 관리 중 그리드 뷰 조립 — 그리드가 인계된 활성 사이클이 있을 때만. */
  private gridView(): AutoPilotGridView | null {
    const active = this.active;
    if (!active || !active.grid) return null;
    const v = active.grid.view;
    return {
      ticker: active.ticker,
      avgPrice: v.avgPrice,
      buyPrice: v.buyPrice,
      sellPrice: v.sellPrice,
      currentPrice: active.slot.getView().price,
      holdingQty: v.holdingQty,
      buyMultiplier: v.buyMultiplier,
      gridActive: v.gridActive,
    };
  }

  /** 그리드 인계가 켜져 있는가 — 상수 롤백 스위치 AND 설정 주입. */
  private gridEnabled(): boolean {
    return GRID_EXIT && this.deps.gridConfig !== undefined;
  }

  // ---- 설정/영속화 ----

  /** 설정 변경 — IDLE에서만. 검증 실패 문구를 반환한다(성공 시 null). 진행 중 세션은 건드리지 않는다. */
  setConfig(config: AutoPilotConfig): string | null {
    if (this.state !== 'IDLE') return '설정은 정지 상태에서 바꿀 수 있어요';
    const error = validateConfig(config);
    if (error) return error;
    this.config = { ...config };
    // ★ 마틴 OFF에는 "다음 세션"이 없다(세션 완주 판정을 안 하므로). 진행 중 세션을 동기화하지 않으면
    //   사용자가 금액을 바꿔도 영원히 예전 금액으로 진입한다. ON→OFF 전환 시 불어난 금액도 여기서 내려온다.
    //   setConfig는 IDLE에서만 통과하므로 진행 중 사이클·미체결 주문과 충돌하지 않는다.
    //   (OFF→ON은 동기화하지 않는다 — 마틴 진행 중 성과를 임의로 리셋하지 않기 위해.)
    if (!isMartingaleOn(this.config) && this.session) {
      this.session.amountUsd = this.config.startAmountUsd;
    }
    void this.persist();
    this.emit();
    return null;
  }

  /** 재시작 복원 — v2 설정·세션·일일 카운트. v1(baseAmountUsd)은 마이그레이션(plan §4-5). */
  async restore(): Promise<void> {
    const raw = await this.deps.storage.getItem(AUTOPILOT_STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedV2> & { baseAmountUsd?: number };
      if (parsed.version === 2) {
        if (parsed.config && validateConfig(parsed.config) === null) this.config = parsed.config;
        if (parsed.session && Number.isFinite(parsed.session.amountUsd) && parsed.session.amountUsd > 0) {
          this.session = { ...parsed.session, paused: parsed.session.paused ?? false };
        }
        if (parsed.daily && typeof parsed.daily.date === 'string') {
          this.dailyDate = parsed.daily.date;
          this.sessionCount = parsed.daily.sessionCount ?? 0;
          this.cycles = parsed.daily.cycles ?? 0;
          this.cumPnl = parsed.daily.cumPnl ?? 0;
        }
      } else if (typeof parsed.baseAmountUsd === 'number' && parsed.baseAmountUsd > 0) {
        // v1 → v2: base → 시작금액, base×4 → 최대금액, 최소 속도 기본 1.
        this.config = {
          startAmountUsd: parsed.baseAmountUsd,
          maxAmountUsd: parsed.baseAmountUsd * 4,
          minTickRate: DEFAULT_MIN_TICK_RATE,
        };
        void this.persist();
      }
    } catch {
      // 손상된 저장값 — 무시.
    }
    this.rolloverDailyIfNeeded();
    this.emit();
  }

  private async persist(): Promise<void> {
    const data: PersistedV2 = {
      version: 2,
      config: this.config,
      session: this.session,
      daily:
        this.dailyDate === null
          ? null
          : { date: this.dailyDate, sessionCount: this.sessionCount, cycles: this.cycles, cumPnl: this.cumPnl },
    };
    await this.deps.storage.setItem(AUTOPILOT_STORAGE_KEY, JSON.stringify(data));
  }

  /** 미국 장 기준일이 바뀌었으면 일일 통계를 리셋한다(진행 중 세션이 있으면 그 세션이 오늘의 1번째). */
  private rolloverDailyIfNeeded(): void {
    const today = etDateOf(this.deps.clock.now());
    if (this.dailyDate === today) return;
    this.dailyDate = today;
    this.sessionCount = this.session ? 1 : 0;
    this.cycles = 0;
    this.cumPnl = 0;
  }

  // ---- 시작/정지 ----

  /** Run — 설정 필수. 세션이 없으면 시작금액으로 개시. 일시정지된 세션이면 PAUSED로 진입(사람이 선택). */
  start(): void {
    if (this.state !== 'IDLE') return;
    if (!this.config) {
      this.event('시작금액·최대금액·최소 속도를 먼저 설정해 주세요');
      return;
    }
    this.stopRequested = false;
    this.rolloverDailyIfNeeded();
    if (!this.session) {
      this.session = { amountUsd: this.config.startAmountUsd, pnl: 0, cycles: 0, paused: false };
      this.sessionCount += 1;
      const amount = `$${this.config.startAmountUsd.toFixed(2)}`;
      this.event(
        `세션 #${this.sessionCount} 시작 · ${isMartingaleOn(this.config) ? `${amount}부터` : `${amount} 고정`}`,
      );
    }
    if (this.session.paused) {
      // 현금 부족으로 멈췄던 세션 — 자동 재개하지 않는다(§4-3). 사람이 재개/초기화를 고른다.
      this.state = 'PAUSED';
      this.reselectTimer = this.deps.scheduler.setInterval(() => this.reselect(), this.reselectIntervalMs);
      this.event('현금 부족으로 멈춘 세션이 있어요 — 이어서 재개하거나 세션을 초기화해 주세요');
      this.emit();
      return;
    }
    this.state = 'SCANNING';
    this.reselect();
    this.reselectTimer = this.deps.scheduler.setInterval(() => this.reselect(), this.reselectIntervalMs);
    this.event('자동 단타를 시작했어요');
    void this.persist();
    this.emit();
  }

  stop(): void {
    this.stopRequested = true;
    this.pendingBuy = null;
    if (this.state === 'FAULT') {
      // 인터록 해제 — 추가 주문·취소 없이 정리만(포지션은 계좌에서 수동 처리).
      const active = this.active;
      if (active) {
        active.cycle.stop(); // FAULT→DONE(코어가 주문 없이 종료).
        active.slot.detachDetector();
        this.deps.unpin(active.ticker);
        this.active = null;
        this.pendingSettle = null;
      }
      this.finishStop();
      return;
    }
    if (this.active) {
      this.active.cycle.stop();
      // SELLING→DONE은 pollCycle이 진행 — settle에서 stopRequested를 보고 IDLE로 마감한다.
      void this.pollCycle();
      this.emit();
      return;
    }
    this.finishStop();
  }

  private finishStop(): void {
    if (this.state === 'IDLE') return;
    this.detachAll();
    this.stopPollTimer();
    if (this.reselectTimer !== null) {
      this.deps.scheduler.clearInterval(this.reselectTimer);
      this.reselectTimer = null;
    }
    this.lastFault = null;
    this.state = 'IDLE';
    this.event('자동 단타를 정지했어요');
    void this.persist();
    this.emit();
  }

  // ---- PAUSED (현금 부족 — plan §2-4) ----

  /** 이어서 재개 — 같은 세션·같은 금액으로 감시 복귀(입금 후 사용자가 누른다). */
  resume(): void {
    if (this.state !== 'PAUSED' || !this.session) return;
    this.session.paused = false;
    this.state = 'SCANNING';
    this.reselect();
    this.event('세션을 이어서 재개했어요');
    void this.persist();
    this.emit();
  }

  /** 세션 초기화하고 재개 — 현 세션을 버리고 시작금액으로 새 세션. */
  resetSession(): void {
    if (this.state !== 'PAUSED' || !this.config) return;
    this.rolloverDailyIfNeeded();
    this.session = { amountUsd: this.config.startAmountUsd, pnl: 0, cycles: 0, paused: false };
    this.sessionCount += 1;
    this.state = 'SCANNING';
    this.reselect();
    this.event(`세션 #${this.sessionCount} 시작 · $${this.config.startAmountUsd.toFixed(2)}부터 (초기화)`);
    void this.persist();
    this.emit();
  }

  private enterPaused(reason: string): void {
    if (!this.session) return;
    this.session.paused = true;
    this.pendingBuy = null;
    this.detachAll();
    this.stopPollTimer();
    this.state = 'PAUSED';
    this.event(reason);
    void this.persist();
    this.emit();
  }

  dispose(): void {
    this.stopPollTimer();
    if (this.reselectTimer !== null) {
      this.deps.scheduler.clearInterval(this.reselectTimer);
      this.reselectTimer = null;
    }
  }

  // ---- 감시 대상 선정 (최소 속도 자격 필터 — 세션 확장 plan §2-2) ----

  /**
   * 자격자(틱/초 ≥ minTickRate) 중 상위 watchCount 재평가. 자격자가 모자라면 빈 자리를 비워 둔다(0개 허용).
   * 감시 중 종목이 자격을 잃으면 히스테리시스와 무관하게 즉시 해제한다(저유동성 이탈이 목적).
   * 히스테리시스(기본 1.2배)는 자격자끼리의 교체에만 적용. 사이클 진행 중엔 재평가하지 않는다.
   */
  reselect(): void {
    if (this.state !== 'SCANNING') return;
    const minRate = this.config?.minTickRate ?? DEFAULT_MIN_TICK_RATE;
    const now = this.deps.clock.now();
    const slots = this.deps.slots();
    const byTicker = new Map(slots.map((s) => [s.ticker, s]));
    const rateOf = (t: string) => byTicker.get(t)?.tickRate(now) ?? 0;

    // 리스트에서 사라졌거나 자격 미달이 된 감시 종목은 즉시 정리.
    let watched = this.watchedTickers.filter((t) => byTicker.has(t) && rateOf(t) >= minRate && !this.inAbandonCooldown(t));

    const candidates = slots
      .map((s) => s.ticker)
      .filter((t) => !watched.includes(t) && rateOf(t) >= minRate && !this.inAbandonCooldown(t))
      .sort((a, b) => rateOf(b) - rateOf(a));

    // 빈 자리는 자격자로만 채운다(히스테리시스 없음 — 신규 편입).
    while (watched.length < this.watchCount && candidates.length > 0) {
      watched.push(candidates.shift()!);
    }

    // 교체 판정 — 최저 감시 vs 최고 후보, 배율 상회 시에만.
    watched.sort((a, b) => rateOf(a) - rateOf(b));
    for (const challenger of candidates) {
      const lowest = watched[0];
      if (lowest === undefined) break;
      if (rateOf(challenger) > rateOf(lowest) * this.hysteresisRatio) {
        watched.shift();
        watched.push(challenger);
        watched.sort((a, b) => rateOf(a) - rateOf(b));
      } else {
        break;
      }
    }

    const next = watched.sort((a, b) => rateOf(b) - rateOf(a));
    const prev = this.watchedTickers;
    const changed = next.length !== prev.length || next.some((t) => !prev.includes(t));
    if (!changed) return;

    for (const t of prev) {
      if (!next.includes(t)) byTicker.get(t)?.detachDetector();
    }
    for (const t of next) {
      const slot = byTicker.get(t);
      if (slot && !slot.watched) {
        slot.attachDetector((signal, ctx) => this.handleSignal(signal, ctx));
      }
    }
    this.watchedTickers = next;
    this.event(
      next.length > 0
        ? `감시 교체 · ${next.join(', ')}`
        : `감시 대상 없음 · 모든 종목이 ${minRate}틱/초 미만이라 기다리고 있어요`,
    );
    this.emit();
  }

  private detachAll(): void {
    for (const slot of this.deps.slots()) {
      if (slot.watched) slot.detachDetector();
    }
    this.watchedTickers = [];
  }

  // ---- 신호 → 사이클 ----

  private handleSignal(signal: Signal, ctx: SlotSignalContext): void {
    if (signal === 'BUY') {
      this.handleBuySignal(ctx);
      return;
    }
    // SELL — 보유 종목의 매도 변곡점만 의미 있다(유동성이 죽어도 사이클은 반드시 완주 — §4-4).
    if (this.active && ctx.ticker === this.active.ticker) {
      // 그리드가 청산을 관리하면 변곡점 매도는 무시한다(D5) — 매도는 +w 지정가 체결로만 일어난다.
      if (this.gridEnabled()) return;
      this.active.adapter.setLimitPrice(ctx.price);
      this.active.cycle.onSignal('SELL', this.toSnapshot(ctx));
      this.syncStateFromCycle();
      void this.pollCycle();
    }
  }

  /**
   * 매수 신호 — SCANNING에서만. 프리플라이트가 도는 짧은 창 안에 다른 감시 종목의
   * BUY가 오면 틱/초 높은 쪽으로 후보를 교체한다(동시 신호 중재).
   */
  private handleBuySignal(ctx: SlotSignalContext): void {
    if (this.stopRequested || this.state === 'FAULT' || this.state === 'PAUSED') return;
    const rate = this.slotOf(ctx.ticker)?.tickRate(this.deps.clock.now()) ?? 0;

    if (this.state === 'SCANNING' && this.pendingBuy === null) {
      this.pendingBuy = { ctx, tickRate: rate };
      this.state = 'ENTERING';
      this.emit();
      void this.commitBuy();
      return;
    }
    if (this.state === 'ENTERING' && this.pendingBuy !== null && rate > this.pendingBuy.tickRate) {
      this.pendingBuy = { ctx, tickRate: rate };
      this.event(`동시 신호 · 더 활발한 ${ctx.ticker}(으)로 교체했어요`);
    }
  }

  /** 프리플라이트 → 속도 재검사 → 현금 검사 → 발주 확정. 대기 중 후보가 교체되면 재시도. */
  private async commitBuy(): Promise<void> {
    if (this.buyCommitting) return;
    this.buyCommitting = true;
    try {
      for (;;) {
        const candidate = this.pendingBuy;
        const session = this.session;
        const config = this.config;
        if (candidate === null || session === null || config === null || this.stopRequested) {
          this.backToScanning();
          return;
        }
        const { ctx } = candidate;
        const qty = qtyForAmount(session.amountUsd, ctx.price);
        if (qty < 1) {
          this.pendingBuy = null;
          this.event(
            `${ctx.ticker} 진입 포기 · 투입 금액($${session.amountUsd.toFixed(2)})이 1주 가격($${ctx.price})보다 작아요`,
          );
          this.backToScanning();
          return;
        }

        const slot = this.slotOf(ctx.ticker);
        if (!slot) {
          this.pendingBuy = null;
          this.backToScanning();
          return;
        }

        const broker = this.deps.makeBroker(ctx.ticker);
        const adapter = new OrderPortAdapter({ broker, clock: this.deps.clock });
        const fault = await adapter.preflightCheckFills();
        if (this.stopRequested) {
          this.backToScanning();
          return;
        }
        if (fault) {
          this.enterFault(fault);
          return;
        }
        if (this.pendingBuy !== candidate) continue; // 대기 중 교체 — 새 후보로 다시.

        // 진입 직전 속도 재검사(§4-4) — 감시 선정과 신호 사이에 유동성이 죽었으면 포기.
        const rateNow = slot.tickRate(this.deps.clock.now());
        if (rateNow < config.minTickRate) {
          this.pendingBuy = null;
          this.event(
            `${ctx.ticker} 진입 포기 · 속도가 ${rateNow.toFixed(1)}틱/초로 떨어져 기준(${config.minTickRate})에 못 미쳐요`,
          );
          this.backToScanning();
          return;
        }

        // 현금 부족 사전 판정(§2-4) — 조회 실패(null/throw)면 판정 없이 진행(FAULT 인터록이 최후 방어선).
        const needed = qty * ctx.price;
        let buyable: number | null = null;
        try {
          buyable = (await this.deps.fetchBuyableUsd?.(ctx.ticker, ctx.price)) ?? null;
        } catch {
          buyable = null;
        }
        if (this.stopRequested) {
          this.backToScanning();
          return;
        }
        if (this.pendingBuy !== candidate) continue;
        if (buyable !== null && buyable < needed) {
          this.enterPaused(
            `현금이 부족해서 쉬고 있어요 · 필요 $${needed.toFixed(2)} > 주문가능 $${buyable.toFixed(2)} — 입금 후 재개하거나 세션을 초기화해 주세요`,
          );
          return;
        }

        // 확정 — 사이클 개시.
        this.pendingBuy = null;
        const cycle = new RunCycle({
          ticker: ctx.ticker,
          qty,
          port: adapter,
          clock: this.deps.clock,
          feeRate: this.deps.feeRate,
          onTrade: (record) => {
            this.pendingSettle = record;
            this.deps.onTrade?.(record);
          },
        });
        this.active = { ticker: ctx.ticker, slot, adapter, cycle, broker, grid: null, gridArmed: false };
        this.deps.pin(ctx.ticker);
        for (const t of this.watchedTickers) {
          if (t !== ctx.ticker) this.slotOf(t)?.detachDetector();
        }
        this.watchedTickers = [ctx.ticker];

        adapter.setLimitPrice(ctx.price);
        const quote = slot.quote;
        if (quote) adapter.setQuote(quote.bid1, quote.ask1, quote.at);

        cycle.start();
        cycle.onSignal('BUY', this.toSnapshot(ctx));
    this.buyingSince = this.deps.clock.now();
    this.abandonRequested = false;
        this.startPollTimer();
        this.syncStateFromCycle();
        this.event(`${ctx.ticker} 진입 · ${qty}주 × $${ctx.price} (목표 $${session.amountUsd.toFixed(2)})`);
        this.emit();
        return;
      }
    } finally {
      this.buyCommitting = false;
    }
  }

  // ---- 사이클 폴링/정산 ----

  /** 체결 폴링 1회 — 인스턴스와 같은 순서: fault 회수 → refreshFills → cycle.poll → 정산. */
  async pollCycle(): Promise<void> {
    const active = this.active;
    if (!active || this.state === 'FAULT') return;

    const pending = active.adapter.takeFault();
    if (pending) {
      this.enterFault(pending);
      return;
    }

    // 그리드가 인계됐으면 진입 어댑터 대신 그리드를 구동한다(매도 체결→SCANNING, 매수 체결→리브래킷).
    if (active.grid && active.gridArmed) {
      await this.pollGrid(active);
      return;
    }

    const ok = await active.adapter.refreshFills();
    if (!ok) {
      this.enterFault(active.adapter.takeFault() ?? { kind: 'FILL_CHECK', reason: '체결 확인 실패' });
      return;
    }

    const view = active.slot.getView();
    if (view.price !== null) active.adapter.setLimitPrice(view.price);
    const quote = active.slot.quote;
    if (quote) active.adapter.setQuote(quote.bid1, quote.ask1, quote.at);

    active.cycle.poll();

    const late = active.adapter.takeFault();
    if (late) {
      this.enterFault(late);
      return;
    }

    // ★ 자동 포기로 감시 복귀한 사이클 — syncStateFromCycle보다 먼저 잡아야 한다.
    //   (그 함수가 WATCH_BUY를 'ENTERING'으로 매핑해 버려 상태가 갇힌다.)
    if (active.cycle.state === 'WATCH_BUY') {
      this.abandonActive(active.ticker);
      return;
    }
    if (active.cycle.state === 'HOLDING') {
      // 체결에 성공했다 — 경과 시계와 연속 취소 카운터를 푼다.
      this.buyingSince = null;
      this.abandonRequested = false;
      this.clearAbandon(active.ticker);
      // 진입 체결 → 매도 관리 그리드 인계(D5). 그리드가 켜져 있고 아직 안 걸었으면 지금 두 주문을 건다.
      if (this.gridEnabled() && !active.grid) {
        await this.armGrid(active);
        // arm이 FAULT면 gridArmed=false로 남는다 — 인터록은 armGrid가 이미 걸었으니 그대로 반환한다.
        if (!active.gridArmed) return;
        this.syncStateFromCycle(); // 그리드가 관리해도 뷰 상태는 HOLDING을 유지한다.
        return;
      }
    }
    this.syncStateFromCycle();
    if (active.cycle.state === 'DONE') this.settle();
  }

  // ---- 매도 관리 그리드(D5) ----

  /**
   * 진입 체결 후 그리드 인계 — 잔고에서 평단·수량을 읽어(D1, 폴백=진입 체결) 두 지정가를 건다.
   * 현금은 fetchBuyableUsd로 미리 조회해 매수 다리 축소/생략에 쓴다(D2). 발주 실패는 FAULT.
   */
  private async armGrid(active: ActiveCycle): Promise<void> {
    const cfg = this.deps.gridConfig!;
    const pos = active.cycle.position;
    const fallback = pos ? { qty: pos.qty, avgPrice: pos.entryPrice } : undefined;
    const buyPrice = (pos?.entryPrice ?? 0) * (1 - cfg.width);
    let availableCashUsd: number | undefined;
    try {
      const cash = await this.deps.fetchBuyableUsd?.(active.ticker, buyPrice);
      if (typeof cash === 'number' && Number.isFinite(cash)) availableCashUsd = cash;
    } catch {
      // 현금 판정 생략 — 전량 매수 다리로 진행(주문 거절은 FAULT 인터록이 받는다).
    }
    if (this.stopRequested) return;
    const grid = new Grid({
      port: createGridOrderPort(active.broker, active.ticker),
      clock: this.deps.clock,
      config: { width: cfg.width, buyMultiplier: cfg.buyMultiplier, availableCashUsd },
    });
    active.grid = grid;
    await grid.arm(fallback);
    if (grid.state === 'FAULT') {
      this.enterFault({ kind: 'PLACE', reason: grid.faultText ?? '그리드 발주 실패' });
      return;
    }
    active.gridArmed = true;
    const v = grid.view;
    this.event(
      `${active.ticker} 그리드 관리 인계 · 매수 $${v.buyPrice}(평단 −${Math.round(cfg.width * 100)}%) · 매도 $${v.sellPrice}(평단 +${Math.round(cfg.width * 100)}%)`,
    );
    this.emit();
  }

  /** 그리드 폴 1회 — 매도 체결→정산·SCANNING, 매수 체결→리브래킷, 취소 거절→FAULT. */
  private async pollGrid(active: ActiveCycle): Promise<void> {
    const result = await active.grid!.poll();
    switch (result.kind) {
      case 'sold':
        this.settleGrid(active, result);
        break;
      case 'rebracket':
        this.event(
          `${active.ticker} 그리드 리브래킷 · 평단 $${result.position.avgPrice.toFixed(2)} · ${result.position.qty}주`,
        );
        this.emit();
        break;
      case 'fault':
        this.enterFault({ kind: 'CANCEL', reason: result.reason });
        break;
      default:
        this.emit(); // armed — 현재가 화살표 갱신용.
        break;
    }
  }

  /**
   * 그리드 매도(+w) 체결 정산 — 관리 평단→매도가 손익으로 TradeRecord를 합성해 기존 settle 경로로 넘긴다.
   * (RunCycle은 HOLDING에 파킹돼 있었을 뿐 — 실제 매도는 그리드가 냈으므로 cycle.stop()을 부르지 않는다.)
   */
  private settleGrid(active: ActiveCycle, result: Extract<GridPollResult, { kind: 'sold' }>): void {
    const pos = active.cycle.position;
    const entryPrice = result.avgPrice;
    const exitPrice = result.exitPrice;
    const qty = result.qty;
    const grossPnl = (exitPrice - entryPrice) * qty;
    const feeRate = this.deps.feeRate ?? 0;
    const fees = feeRate * (entryPrice * qty + exitPrice * qty);
    const now = this.deps.clock.now();
    const record: TradeRecord = {
      ticker: active.ticker,
      qty,
      entryPrice,
      entryTs: pos?.entryTs ?? now,
      exitPrice,
      exitTs: now,
      pnl: grossPnl - fees,
      grossPnl,
      fees,
      entrySnapshot: pos?.entrySnapshot ?? { price: entryPrice, slope: 0, accel: 0, ts: now },
      exitSnapshot: null,
      exitReason: 'SELL_SIGNAL',
    };
    this.pendingSettle = record;
    this.deps.onTrade?.(record);
    this.settle();
  }

  /**
   * 진행 중 사이클의 자원을 정리한다 — 폴·리프라이스 타이머 정지, detector 해제, 핀 해제.
   * ⚠ 핀(`pin`)은 `commitBuy`에서 걸리고 여기서만 풀린다. 이 경로를 거치지 않으면 워치리스트가 영구 오염된다.
   */
  private teardownActive(active: ActiveCycle): void {
    this.stopPollTimer();
    active.slot.detachDetector();
    this.active = null;
    this.deps.unpin(active.ticker);
  }

  /**
   * 매수 미체결 자동 포기로 사이클을 접고 감시(SCANNING)로 복귀한다 — 거래 기록이 없는 유일한 종료 경로.
   * ⚠ `AutoPilot.stop()`을 부르면 `stopRequested`가 서서 IDLE로 종료돼 버리므로 절대 재활용하지 않는다.
   */
  private abandonActive(ticker: string): void {
    const active = this.active;
    if (!active) return;
    active.cycle.stop(); // WATCH_BUY→DONE (이 전이는 포트를 호출하지 않는다 — 폐기 위생용)
    this.teardownActive(active);
    this.markAbandon(ticker);
    this.event(`${ticker} 매수 취소 · 안 붙어서 다시 감시해요`);
    if (this.stopRequested) {
      this.finishStop();
      return;
    }
    this.state = 'SCANNING';
    this.watchedTickers = [];
    this.reselect(); // ⚠ state를 SCANNING으로 세운 **뒤**에 불러야 동작한다
    this.emit();
  }

  /** 자동 포기 1회 기록 — 연속 상한에 닿으면 그 종목 매수를 잠시 쉰다. */
  private markAbandon(ticker: string): void {
    const now = this.deps.clock.now();
    const prev = this.abandonState.get(ticker);
    const streak = (prev?.streak ?? 0) + 1;
    const until = streak >= ABANDON_COOLDOWN_STREAK ? now + ABANDON_COOLDOWN_MS : (prev?.until ?? 0);
    this.abandonState.set(ticker, { streak, until });
    if (streak >= ABANDON_COOLDOWN_STREAK) {
      this.event(`${ticker} 매수 취소가 ${streak}번 이어져서 ${ABANDON_COOLDOWN_MS / 1000}초간 쉬어요`);
    }
  }

  /** 그 종목이 자동 포기 쿨다운 중인가 — 감시 후보에서도 빠지고 매수 신호도 넘긴다. */
  private inAbandonCooldown(ticker: string): boolean {
    const s = this.abandonState.get(ticker);
    return s !== undefined && this.deps.clock.now() < s.until;
  }

  /** 체결에 성공했다 — 그 종목의 연속 취소 기록을 지운다. */
  private clearAbandon(ticker: string): void {
    this.abandonState.delete(ticker);
  }

  /**
   * 사이클 종료 정산 — 세션 성과 반영 → 종료 조건(AND, 금액 조정 전 판정) → 조정 또는 새 세션.
   * 수동 Stop 청산(STOP)은 금액 조정도 세션 종료 판정도 하지 않는다(성과에는 반영).
   */
  private settle(): void {
    const active = this.active;
    if (!active) return;
    const record = this.pendingSettle;
    this.pendingSettle = null;

    this.teardownActive(active);

    if (record) {
      this.rolloverDailyIfNeeded();
      this.cycles += 1;
      this.cumPnl += record.pnl;
      const session = this.session;
      if (session) {
        const usedAmount = session.amountUsd;
        session.pnl += record.pnl;
        session.cycles += 1;
        if (record.exitReason === 'SELL_SIGNAL') {
          // ★ 마틴 OFF 검사가 반드시 shouldEndSession보다 **먼저** 와야 한다.
          //   뒤로 가면 start=max 설정에서 OFF 세션이 완주해버린다.
          //   (세션 손익·사이클 수와 일일 통계는 위에서 이미 누적됐다 — OFF에서도 통계는 그대로 쌓인다.)
          if (this.config && !isMartingaleOn(this.config)) {
            this.event(
              `${record.ticker} 청산 · 손익 $${record.pnl.toFixed(2)} · 금액 고정 $${session.amountUsd.toFixed(2)}`,
            );
          } else if (this.config && shouldEndSession(record.pnl, usedAmount, session.pnl, this.config.maxAmountUsd)) {
            // 세션 종료 — 금액 조정 없이 새 세션(시작금액·성과 0).
            const endedPnl = session.pnl;
            this.session = { amountUsd: this.config.startAmountUsd, pnl: 0, cycles: 0, paused: false };
            this.sessionCount += 1;
            this.event(
              `세션 완주 · 성과 $${endedPnl.toFixed(2)} — 세션 #${this.sessionCount} 시작 · $${this.config.startAmountUsd.toFixed(2)}부터`,
            );
          } else {
            const before = session.amountUsd;
            session.amountUsd = nextAmountUsd(before, record.pnl);
            const verb =
              record.pnl > 0 ? '수익 → 금액 절반' : record.pnl < 0 ? '손실 → 금액 2배' : '본전 → 금액 유지';
            this.event(
              `${record.ticker} 청산 · 손익 $${record.pnl.toFixed(2)} · ${verb} ($${before.toFixed(2)}→$${session.amountUsd.toFixed(2)})`,
            );
          }
        } else {
          this.event(`${record.ticker} 수동 청산 · 손익 $${record.pnl.toFixed(2)} · 금액 유지`);
        }
      }
      void this.persist();
    }

    if (this.stopRequested) {
      this.finishStop();
      return;
    }
    this.state = 'SCANNING';
    this.watchedTickers = [];
    this.reselect();
    this.emit();
  }

  // ---- 내부 ----

  private backToScanning(): void {
    if (this.state === 'ENTERING' && this.active === null) {
      if (this.stopRequested) {
        this.finishStop();
        return;
      }
      this.state = 'SCANNING';
      this.emit();
    }
  }

  private syncStateFromCycle(): void {
    const active = this.active;
    if (!active) return;
    const prev = this.state;
    switch (active.cycle.state) {
      case 'WATCH_BUY':
      case 'BUYING':
        this.state = 'ENTERING';
        break;
      case 'HOLDING':
        this.state = 'HOLDING';
        break;
      case 'SELLING':
        this.state = 'EXITING';
        break;
      case 'FAULT':
        this.state = 'FAULT';
        break;
      default:
        break; // DONE은 settle에서.
    }
    if (this.state !== prev) this.emit();
  }

  /** 인터록 발동 — 자동매매 동결. 사용자 Stop만 해제한다(기존 인스턴스와 동일 원칙). */
  private enterFault(fault: AdapterFault): void {
    if (this.state === 'FAULT') return;
    const text = `자동매매를 멈췄어요 · ${faultKindLabel(fault)} — ${fault.reason}. 계좌를 확인한 뒤 Stop으로 해제해 주세요`;
    this.lastFault = { at: this.deps.clock.now(), text };
    this.active?.cycle.fault();
    this.stopPollTimer();
    this.state = 'FAULT';
    this.deps.onFault?.(this.lastFault);
    this.event(text);
    this.emit();
  }

  private slotOf(ticker: string): FeedSlot | null {
    return this.deps.slots().find((s) => s.ticker === ticker) ?? null;
  }

  private toSnapshot(ctx: SlotSignalContext): SignalSnapshot {
    return { price: ctx.price, slope: ctx.slope, accel: ctx.accel, ts: ctx.at };
  }

  private startPollTimer(): void {
    if (this.pollTimer !== null) return;
    this.pollTimer = this.deps.scheduler.setInterval(() => {
      void this.pollCycle();
    }, this.pollIntervalMs);
    if (this.repriceTimer === null) {
      this.repriceTimer = this.deps.scheduler.setInterval(() => {
        void this.repriceTick();
      }, this.repriceIntervalMs);
    }
  }

  private stopPollTimer(): void {
    if (this.pollTimer !== null) {
      this.deps.scheduler.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.repriceTimer !== null) {
      this.deps.scheduler.clearInterval(this.repriceTimer);
      this.repriceTimer = null;
    }
  }

  /**
   * 매도 리프라이스 1틱 — 청산(EXITING/SELLING) 중에만 매수1호가를 따라간다.
   * Stop 요청 뒤에도 계속한다(그 매도가 곧 청산). FAULT면 멈춘다.
   *
   * ⚠ 자동관리는 호가를 pollCycle(2초)에서만 어댑터에 넣으므로, 여기서 슬롯의 최신 호가를 **먼저** 반영하지
   * 않으면 최대 2초 낡은 값으로 정정하게 되어 리프라이스가 사실상 무의미해진다.
   */
  /**
   * 빠른 틱(기본 1초) — 상태에 따라 하나만 한다.
   *  · SELLING → 매도 리프라이스(슬롯 최신 호가를 먼저 반영)
   *  · BUYING  → 매수 미체결 경과 판정 → 자동 포기 요청(설정을 켰을 때만)
   * 새 타이머를 만들지 않고 겸용한다 — 하네스가 인스턴스당 타이머 2개를 가정한다.
   */
  private async repriceTick(): Promise<void> {
    if (this.repriceTicking) return;
    const active = this.active;
    if (!active || this.state === 'FAULT' || active.adapter.hasFault()) return;
    const cycleState = active.cycle.state;
    if (cycleState !== 'SELLING' && cycleState !== 'BUYING') {
      this.buyingSince = null;
      return;
    }
    this.repriceTicking = true;
    try {
      if (cycleState === 'SELLING') {
        const quote = active.slot.quote;
        if (quote) active.adapter.setQuote(quote.bid1, quote.ask1, quote.at);
        await active.adapter.repriceSell();
      } else {
        await this.tryAbandonBuy(active);
      }
    } finally {
      this.repriceTicking = false;
    }
  }

  /** 매수 미체결 자동 포기 판정 1회 — 요청 게이트 3겹(odno 확보·취소 미요청·관찰 체결량 0). */
  private async tryAbandonBuy(active: ActiveCycle): Promise<void> {
    if (this.buyCancelAfterMs <= 0) return;
    const probe = active.adapter.buyProbe();
    if (!probe) return;

    if (this.abandonRequested) {
      if (probe.verified && probe.cancelState === 'confirmed' && probe.filledQty > 0) {
        this.enterFault({
          kind: 'CANCEL',
          reason: '부분체결 상태에서 취소가 확정됐어요 — 계좌를 확인해 주세요',
        });
        return;
      }
      if (probe.cancelState === 'confirmed') await this.pollCycle();
      return;
    }

    if (this.buyingSince === null) {
      this.buyingSince = this.deps.clock.now();
      return;
    }
    if (this.deps.clock.now() - this.buyingSince < this.buyCancelAfterMs) return;
    if (!probe.hasOdno) return;
    if (probe.cancelState !== 'none') return;
    if (probe.filledQty > 0) return; // ★ 부분체결이면 취소하지 않는다
    if (active.cycle.abandonBuy()) this.abandonRequested = true;
  }

  private event(text: string): void {
    this.lastEvent = { at: this.deps.clock.now(), text };
    this.deps.onEvent?.(this.lastEvent);
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const view = this.getView();
    for (const l of this.listeners) l(view);
  }
}

function faultKindLabel(fault: AdapterFault): string {
  switch (fault.kind) {
    case 'FILL_CHECK':
      return '체결 확인 실패';
    case 'PLACE':
      return '발주 실패';
    case 'CANCEL':
      return '취소 실패';
    default:
      return '브로커 오류';
  }
}
