// SurgeRecorder — 급등(진입)·하락(이탈) 세트 에피소드 상태기계 + Supabase 기록
// (docs/domain/surge-stock-finder — 기획 §2·§3, DB 문서 §1·에피소드 운영 규칙).
//
// 흐름: SurgeDetector(FeedSlot 병렬 탑재) → 여기로 경보/확정이 흘러온다.
//  · 조기경보(alert) → 호가 동적 구독 대상에 올린다(quoteTargets, 상한 LRU) — 확정 시점 호가 스냅샷 준비.
//  · 급등 확정(surge) → 에피소드 open + DB insert. 같은 종목에 열린 에피소드가 있으면 무시(재급등 무시).
//  · 이탈 확정(exit, 트레일링 하락 — 조용한 하락 포함) → 열린 에피소드를 closed로 종결(+DB update).
//    **세트만 기록한다**(2026-08-13 사용자 확정) — 열린 에피소드 없는 이탈 신호는 버린다(단독 하락 무가치).
//  · 타임아웃(기본 30분) → expired. 트레일링 이탈이 조용한 하락까지 잡으므로 만료는 거래가 죽어
//    청크·틱이 끊긴 극단 케이스에서만 남는다.
// 규칙(문서 확정): 기록 실패는 감지를 멈추지 않는다(logged=false 표시만). disable(=Stop) 시 열린
// 에피소드 전부 expired. enable(=Run) 시 이전 실행이 남긴 DB 고아 open 행을 쓸어 expired 처리.
//
// 매매 연동 없음 — 이 파일은 기록·표시만 한다. AutoPilot 진입 게이트를 우회하는 경로를 만들지 않는다.

import type { SurgeAlert, SurgeSignal } from '../../core/surge';
import type { SurgeCloseInput, SurgeLogClient, SurgeOpenInput } from '../../lib/surgeLog';
import type { ClockLike, SchedulerLike } from './types';

/**
 * UI에 보여줄 에피소드 뷰 — DB 행의 메모리 미러(최근 것만). alerting은 화면 전용(DB엔 없음).
 * plunge* 필드 = 이탈(하락 확정) 시점 값 — DB plunge_* 컬럼과 같은 자리(이름은 스키마를 따른다).
 */
export interface SurgeEpisodeView {
  /** 로컬 id — DB 기록에 성공하면 행 id로 갱신된다. */
  readonly id: string;
  readonly ticker: string;
  readonly market: string;
  readonly status: 'alerting' | 'open' | 'closed' | 'expired';
  readonly surgeAt?: number;
  readonly surgePrice?: number;
  readonly surgeAsk1?: number | null;
  readonly surgeAsk2?: number | null;
  readonly plungeAt?: number;
  readonly plungePrice?: number;
  readonly plungeBid1?: number | null;
  readonly plungeBid2?: number | null;
  /** 체결가 변동율(%) — closed일 때만(표시용 계산, DB 생성 컬럼과 같은 정의). */
  readonly priceChangePct?: number | null;
  /** 1호가 변동율(%) — 급등시 매도1호가에 사서 급락시 매수1호가에 판 값. */
  readonly l1ChangePct?: number | null;
  /** Supabase 기록 성공 여부 — false면 화면에 미기록 표시. */
  readonly logged: boolean;
}

export type SurgeListener = (episodes: readonly SurgeEpisodeView[]) => void;

export interface SurgeRecorderDeps {
  clock: ClockLike;
  scheduler: SchedulerLike;
  /** 기록 클라이언트 — null이면(env 미설정) 감지·표시만 하고 기록은 생략한다. */
  log: SurgeLogClient | null;
  /** 신호 시점 호가 스냅샷 — FeedSlot.quote. 미수신이면 null(그래도 기록한다 — 호가 컬럼 null). */
  getQuote: (ticker: string) => { bid1: number; ask1: number; bid2: number | null; ask2: number | null; at: number } | null;
  getMarket: (ticker: string) => string;
  /** 호가 동적 구독 대상(quoteTargets)이 바뀌었다 — 매니저가 reconcileQuoteSubs를 다시 돈다. */
  onQuoteTargetsChanged: () => void;
  /** 이벤트 타임라인 한 줄. */
  onEvent: (text: string) => void;
  /** 에피소드 호가 동적 구독 상한 — 구독 예산(41건) 안배. 기본 3. */
  maxQuoteSlots?: number;
  /** 급등 후 급락 미발생 타임아웃(ms). 기본 30분. */
  episodeTimeoutMs?: number;
  /** 조기경보 호가 예열 유지(ms) — 이 안에 확정이 안 오면 대상에서 내린다. 기본 60초. */
  quoteWarmTtlMs?: number;
  /** 타임아웃·예열 만료 점검 주기(ms). 기본 30초. */
  sweepIntervalMs?: number;
}

/** 신호 시점 호가 스냅샷 허용 신선도 — 이보다 낡은 캐시는 null 취급(직전 감시가 남긴 옛 호가 오염 방지). */
const QUOTE_FRESH_MS = 10_000;
/** 메모리 에피소드 상한 — 이벤트 타임라인(EVENT_LIMIT=50)과 같은 규모. */
const EPISODE_LIMIT = 50;

const DEFAULT_MAX_QUOTE_SLOTS = 3;
const DEFAULT_EPISODE_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_QUOTE_WARM_TTL_MS = 60_000;
const DEFAULT_SWEEP_INTERVAL_MS = 30_000;

interface OpenEpisode {
  localId: string;
  dbId: string | null;
  ticker: string;
  surgeAt: number;
}

export class SurgeRecorder {
  private readonly deps: SurgeRecorderDeps;
  private readonly maxQuoteSlots: number;
  private readonly episodeTimeoutMs: number;
  private readonly quoteWarmTtlMs: number;
  private readonly sweepIntervalMs: number;

  private enabled = false;
  private timer: unknown = null;
  private seq = 0;

  /** 최신순 에피소드 뷰(상한 EPISODE_LIMIT). */
  private episodes: SurgeEpisodeView[] = [];
  /** 티커 → 열린 에피소드(open) — 재급등 무시·급락 페어링의 기준. */
  private readonly openByTicker = new Map<string, OpenEpisode>();
  /** 티커 → 마지막 조기경보 시각 — 호가 예열 대상(LRU). */
  private readonly warmTickers = new Map<string, number>();

  private readonly listeners = new Set<SurgeListener>();

  constructor(deps: SurgeRecorderDeps) {
    this.deps = deps;
    this.maxQuoteSlots = deps.maxQuoteSlots ?? DEFAULT_MAX_QUOTE_SLOTS;
    this.episodeTimeoutMs = deps.episodeTimeoutMs ?? DEFAULT_EPISODE_TIMEOUT_MS;
    this.quoteWarmTtlMs = deps.quoteWarmTtlMs ?? DEFAULT_QUOTE_WARM_TTL_MS;
    this.sweepIntervalMs = deps.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  }

  // ---- 수명 (autopilotManager.start/stop과 함께 간다 — 기획 미결 (a)안 확정) ----

  /** 기록 시작 — 이전 실행이 남긴 DB 고아 open 행을 먼저 쓸어낸다(expired). */
  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    void this.deps.log?.sweepOrphans().then((count) => {
      if (count !== null && count > 0) {
        this.deps.onEvent(`급등 기록 · 이전 실행의 미종결 ${count}건을 만료 처리했어요`);
      }
    });
    if (this.timer === null) {
      this.timer = this.deps.scheduler.setInterval(() => this.sweep(), this.sweepIntervalMs);
    }
  }

  /** 기록 중단 — 열린 에피소드는 전부 만료로 마감한다(공백 구간과 이어붙이지 않는다). */
  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    if (this.timer !== null) {
      this.deps.scheduler.clearInterval(this.timer);
      this.timer = null;
    }
    for (const open of [...this.openByTicker.values()]) this.expireEpisode(open);
    this.openByTicker.clear();
    this.warmTickers.clear();
    // 화면 전용 alerting 행 제거 — open 이후 상태는 기록이므로 남긴다.
    const before = this.episodes.length;
    this.episodes = this.episodes.filter((e) => e.status !== 'alerting');
    if (before !== this.episodes.length) this.notify();
    this.deps.onQuoteTargetsChanged();
  }

  // ---- 감지기 수신 (FeedSlot 병렬 탑재분이 매니저를 거쳐 여기로) ----

  /** 1단계 조기경보 — 호가 예열 대상 등록 + 화면 전용 alerting 행. 기록은 하지 않는다. */
  handleAlert(ticker: string, alert: SurgeAlert): void {
    if (!this.enabled) return;
    const hadSlot = this.quoteTargets().includes(ticker);
    this.warmTickers.set(ticker, alert.at);
    this.trimWarm();
    if (!hadSlot) this.deps.onQuoteTargetsChanged();

    // 열린 에피소드가 있으면 별도 alerting 행은 만들지 않는다(급락 예열은 이미 그 에피소드가 한다).
    if (this.openByTicker.has(ticker)) return;
    const existing = this.episodes.find((e) => e.ticker === ticker && e.status === 'alerting');
    if (existing) return;
    this.pushEpisode({
      id: this.nextId(),
      ticker,
      market: this.deps.getMarket(ticker),
      status: 'alerting',
      logged: false,
    });
  }

  /**
   * 확정 신호 — surge(진입)는 에피소드 open, exit(이탈)는 종결. price는 확정 시점 체결가.
   * 열린 에피소드 없는 exit는 버린다 — 세트만 기록한다(단독 하락은 무가치, 사용자 확정).
   */
  handleSignal(ticker: string, signal: SurgeSignal, price: number): void {
    if (!this.enabled) return;
    if (signal.kind === 'surge') this.handleSurge(ticker, signal, price);
    else this.handleExit(ticker, signal, price);
  }

  // ---- 조회 ----

  /** 호가 동적 구독 대상 — 열린 에피소드 전 종목 + 최근 조기경보(LRU, 합산 상한 maxQuoteSlots). */
  quoteTargets(): string[] {
    const targets: string[] = [...this.openByTicker.keys()];
    const warm = [...this.warmTickers.entries()]
      .filter(([ticker]) => !this.openByTicker.has(ticker))
      .sort((a, b) => b[1] - a[1]);
    for (const [ticker] of warm) {
      if (targets.length >= this.maxQuoteSlots) break;
      targets.push(ticker);
    }
    return targets.slice(0, Math.max(this.maxQuoteSlots, this.openByTicker.size));
  }

  get recentEpisodes(): readonly SurgeEpisodeView[] {
    return [...this.episodes];
  }

  subscribe(listener: SurgeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ---- 내부 ----

  private handleSurge(ticker: string, signal: SurgeSignal, price: number): void {
    // 재급등 무시 — 에피소드는 급락 또는 타임아웃으로만 끝난다(DB 문서 운영 규칙).
    if (this.openByTicker.has(ticker)) return;

    const localId = this.nextId();
    const quote = this.freshQuote(ticker);
    const market = this.deps.getMarket(ticker);
    const view: SurgeEpisodeView = {
      id: localId,
      ticker,
      market,
      status: 'open',
      surgeAt: signal.at,
      surgePrice: price,
      surgeAsk1: quote?.ask1 ?? null,
      surgeAsk2: quote?.ask2 ?? null,
      logged: false,
    };
    // 같은 종목의 alerting 행은 이 에피소드로 승격된 것 — 제거하고 open 행으로 대체한다.
    this.episodes = this.episodes.filter((e) => !(e.ticker === ticker && e.status === 'alerting'));
    this.pushEpisode(view);
    const open: OpenEpisode = { localId, dbId: null, ticker, surgeAt: signal.at };
    this.openByTicker.set(ticker, open);
    this.deps.onQuoteTargetsChanged(); // 에피소드는 예열 상한과 무관하게 호가를 잡는다.
    this.deps.onEvent(`급등 감지 · ${ticker} $${formatPrice(price)}`);

    const input: SurgeOpenInput = {
      ticker,
      market,
      surgeAtMs: signal.at,
      surgePrice: price,
      surgeAsk1: quote?.ask1 ?? null,
      surgeAsk2: quote?.ask2 ?? null,
    };
    void (this.deps.log?.insertOpen(input) ?? Promise.resolve(null)).then((dbId) => {
      if (dbId === null) return; // 실패 — logged=false 그대로(감지는 계속).
      open.dbId = dbId;
      this.patchEpisode(localId, { id: dbId, logged: true });
      open.localId = dbId;
    });
  }

  private handleExit(ticker: string, signal: SurgeSignal, price: number): void {
    const open = this.openByTicker.get(ticker);
    // 세트만 기록 — 열린 에피소드 없는 이탈은 버린다. (감지기가 추적 모드에서만 exit를 내므로
    // 정상 흐름에선 항상 열려 있다 — 없다면 stop/재시작으로 에피소드가 먼저 정리된 경우다.)
    if (!open) return;

    const quote = this.freshQuote(ticker);
    // 에피소드 종결 — 변동율은 표시용으로만 계산(DB는 생성 컬럼이 정본).
    this.openByTicker.delete(ticker);
    const view = this.episodes.find((e) => e.id === open.localId);
    const surgePrice = view?.surgePrice;
    const surgeAsk1 = view?.surgeAsk1 ?? null;
    const plungeBid1 = quote?.bid1 ?? null;
    const priceChangePct =
      surgePrice !== undefined && surgePrice > 0 ? ((price - surgePrice) / surgePrice) * 100 : null;
    const l1ChangePct =
      surgeAsk1 !== null && surgeAsk1 > 0 && plungeBid1 !== null
        ? ((plungeBid1 - surgeAsk1) / surgeAsk1) * 100
        : null;
    this.patchEpisode(open.localId, {
      status: 'closed',
      plungeAt: signal.at,
      plungePrice: price,
      plungeBid1,
      plungeBid2: quote?.bid2 ?? null,
      priceChangePct,
      l1ChangePct,
    });
    this.deps.onQuoteTargetsChanged();
    // 이탈 경로 표기 — 둔화(soft: 폭주 식음+1%) / 급락(hard: 3%, 속도 무관). 기록 리뷰 때 경로별 성적 비교용.
    const reason = signal.exitReason === 'soft' ? '둔화' : '급락';
    this.deps.onEvent(
      `이탈 확정(${reason}) · ${ticker}${priceChangePct !== null ? ` ${priceChangePct >= 0 ? '+' : ''}${priceChangePct.toFixed(2)}%` : ''}`,
    );
    if (open.dbId !== null) {
      const input: SurgeCloseInput = {
        plungeAtMs: signal.at,
        plungePrice: price,
        plungeBid1,
        plungeBid2: quote?.bid2 ?? null,
      };
      void this.deps.log?.close(open.dbId, input);
    }
  }

  /** 주기 점검 — 에피소드 타임아웃 만료 + 조기경보 예열 TTL 정리. */
  private sweep(): void {
    const now = this.deps.clock.now();
    let targetsChanged = false;

    for (const open of [...this.openByTicker.values()]) {
      if (now - open.surgeAt >= this.episodeTimeoutMs) {
        this.openByTicker.delete(open.ticker);
        this.expireEpisode(open);
        targetsChanged = true;
      }
    }

    for (const [ticker, at] of [...this.warmTickers]) {
      if (now - at >= this.quoteWarmTtlMs) {
        this.warmTickers.delete(ticker);
        targetsChanged = true;
      }
    }

    // 화면 전용 alerting 행도 예열 TTL과 함께 걷어낸다(확정 없이 식은 경보).
    const before = this.episodes.length;
    this.episodes = this.episodes.filter(
      (e) => e.status !== 'alerting' || this.warmTickers.has(e.ticker),
    );
    if (before !== this.episodes.length) this.notify();

    if (targetsChanged) this.deps.onQuoteTargetsChanged();
  }

  private expireEpisode(open: OpenEpisode): void {
    this.patchEpisode(open.localId, { status: 'expired' });
    if (open.dbId !== null) void this.deps.log?.expire(open.dbId);
  }

  /** 신호 시점 호가 — 캐시가 QUOTE_FRESH_MS보다 낡았으면 null(옛 호가 오염 방지, 문서 §3). */
  private freshQuote(ticker: string) {
    const quote = this.deps.getQuote(ticker);
    if (!quote) return null;
    if (this.deps.clock.now() - quote.at > QUOTE_FRESH_MS) return null;
    return quote;
  }

  private pushEpisode(view: SurgeEpisodeView): void {
    this.episodes.unshift(view);
    if (this.episodes.length > EPISODE_LIMIT) {
      // 열린 에피소드는 잘라내지 않는다 — 페어링 기준이 사라지면 급락이 단독 행으로 갈라진다.
      const removable = [...this.episodes].reverse().find((e) => e.status !== 'open');
      if (removable) this.episodes = this.episodes.filter((e) => e !== removable);
      else this.episodes.length = EPISODE_LIMIT;
    }
    this.notify();
  }

  private patchEpisode(id: string, patch: Partial<SurgeEpisodeView>): void {
    const idx = this.episodes.findIndex((e) => e.id === id);
    if (idx < 0) return;
    this.episodes[idx] = { ...this.episodes[idx], ...patch };
    this.notify();
  }

  private trimWarm(): void {
    while (this.warmTickers.size > this.maxQuoteSlots) {
      let oldest: string | null = null;
      let oldestAt = Infinity;
      for (const [ticker, at] of this.warmTickers) {
        if (at < oldestAt) {
          oldestAt = at;
          oldest = ticker;
        }
      }
      if (oldest === null) return;
      this.warmTickers.delete(oldest);
    }
  }

  private nextId(): string {
    this.seq += 1;
    return `local-${this.seq}`;
  }

  private notify(): void {
    const snapshot = this.recentEpisodes;
    for (const l of this.listeners) l(snapshot);
  }
}

function formatPrice(price: number): string {
  return price >= 100 ? price.toFixed(2) : price.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}
