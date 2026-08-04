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
import { FeedSlot, type SlotSignalContext } from './feedSlot';
import { OrderPortAdapter } from './orderPortAdapter';
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
/** 최소 속도 기본값(틱/초) — 0 설정 불가(> 0 강제, 사용자 확정 §4-6). */
export const DEFAULT_MIN_TICK_RATE = 1;
/** 수익 반감의 하한(USD) — 시작금액과 무관하게 $1 밑으로는 안 내려간다(사용자 확정 §4-1). */
export const AMOUNT_FLOOR_USD = 1;

export type AutoPilotState = 'IDLE' | 'SCANNING' | 'ENTERING' | 'HOLDING' | 'EXITING' | 'PAUSED' | 'FAULT';

/** 사용자 설정 — 시작금액·최대금액·최소 속도. */
export interface AutoPilotConfig {
  startAmountUsd: number;
  maxAmountUsd: number;
  minTickRate: number;
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

/** 설정 검증(순수) — 0 < 시작 ≤ 최대, 최소 속도 > 0. 문제 없으면 null, 있으면 사용자 문구. */
export function validateConfig(config: AutoPilotConfig): string | null {
  if (!Number.isFinite(config.startAmountUsd) || config.startAmountUsd <= 0) {
    return '시작금액은 0보다 큰 달러 금액으로 입력해 주세요';
  }
  if (!Number.isFinite(config.maxAmountUsd) || config.maxAmountUsd < config.startAmountUsd) {
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
    };
  }

  // ---- 설정/영속화 ----

  /** 설정 변경 — IDLE에서만. 검증 실패 문구를 반환한다(성공 시 null). 진행 중 세션은 건드리지 않는다. */
  setConfig(config: AutoPilotConfig): string | null {
    if (this.state !== 'IDLE') return '설정은 정지 상태에서 바꿀 수 있어요';
    const error = validateConfig(config);
    if (error) return error;
    this.config = { ...config };
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
      this.event(`세션 #${this.sessionCount} 시작 · $${this.config.startAmountUsd.toFixed(2)}부터`);
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
    let watched = this.watchedTickers.filter((t) => byTicker.has(t) && rateOf(t) >= minRate);

    const candidates = slots
      .map((s) => s.ticker)
      .filter((t) => !watched.includes(t) && rateOf(t) >= minRate)
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
        this.active = { ticker: ctx.ticker, slot, adapter, cycle };
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

    this.syncStateFromCycle();
    if (active.cycle.state === 'DONE') this.settle();
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

    this.stopPollTimer();
    active.slot.detachDetector();
    this.active = null;
    this.deps.unpin(active.ticker);

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
          if (this.config && shouldEndSession(record.pnl, usedAmount, session.pnl, this.config.maxAmountUsd)) {
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
  private async repriceTick(): Promise<void> {
    if (this.repriceTicking) return; // setInterval 재진입 방지
    const active = this.active;
    if (!active || this.state === 'FAULT' || active.adapter.hasFault()) return;
    if (active.cycle.state !== 'SELLING') return;
    this.repriceTicking = true;
    try {
      const quote = active.slot.quote;
      if (quote) active.adapter.setQuote(quote.bid1, quote.ask1, quote.at);
      await active.adapter.repriceSell();
    } finally {
      this.repriceTicking = false;
    }
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
