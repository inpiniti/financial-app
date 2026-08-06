// SimLab — 가상 전략 매트릭스 (시뮬레이션 plan 2026-08-06 §B-1, 재진입 규칙 개정 2026-08-06).
//
// 오토파일럿의 진입 체결 1건을 신호로, 폭×배율 ~20조합의 "가상 계좌"가 같은 진입가로 자기 그리드
// (평단×(1∓w))를 관리한다. 주문은 내지 않는다 — 체결 판정은 SimExchange와 같은 트레이드스루 규칙
// (매수 P → tick < P, 매도 P → tick > P)의 순수 계산이다.
//
// ★ 재진입 규칙(사용자 확정): 전략은 **각자 독립된 가상 계좌**다. 같은 종목에 재진입이 와도
//   보유 중인 전략은 그대로 자기 에피소드를 이어가고, **놀고 있는(이미 탈출한) 전략만** 새 진입가로
//   새 에피소드를 시작한다. 예전처럼 재진입이 이전 에피소드를 강제 마감하면 넓은 폭 전략의 측정이
//   조직적으로 잘려 통계가 불리하게 편향된다(ONFO 데이터로 확인된 실측 문제).
//
// 시뮬 모드뿐 아니라 **실거래 중에도** 돈다(mode='live'로 기록) — 실제 주문은 하나만 나가고
// 뒤에서 20개 전략이 같은 시세를 평가하며 데이터를 쌓는 구조(사용자 원안).
//
// 진행 중 앱이 죽으면 그 에피소드는 기록 없이 소실된다(plan §5 — 주기 flush는 다음 단계).
// 시각은 전부 **한국시간(KST)** 문자열로 기록한다(사용자 확정 §5-7).

import { roundGridPrice } from '../../core/grid';
import { isDaytimeSessionOpen } from './daySession';
import type { ClockLike } from './types';

/** 가상 전략 1개의 설정 — 그리드 폭(%)·매수 배율. */
export interface SimStrategyConfig {
  widthPct: number;
  buyMultiplier: number;
  /** 사용자의 실제 설정 조합인가 — 기록에서 실전 대응 행을 바로 걸러내는 용도. */
  isPrimary?: boolean;
}

/** 기본 매트릭스 축 — 폭 5종 × 배율 4종 = 20조합. */
export const SIM_MATRIX_WIDTHS_PCT = [2, 3, 5, 7, 10] as const;
export const SIM_MATRIX_MULTIPLIERS = [0.5, 1, 2, 3] as const;

/** 동시에 열어 둘 수 있는 종목 수 — WS 구독 예산 보호(초과 시 가장 오래된 종목을 축출 기록). */
export const DEFAULT_MAX_EPISODES = 8;

/**
 * 매트릭스 조립 — 기본 20조합에 사용자 실제 설정을 primary로 표시한다.
 * 사용자 조합이 축 위에 없으면(예: 4%/1.5배) 21번째로 추가한다 — 실전 대응 행이 반드시 존재해야 비교가 된다.
 */
export function buildSimMatrix(primary: { widthPct: number; buyMultiplier: number }): SimStrategyConfig[] {
  const matrix: SimStrategyConfig[] = [];
  let primaryFound = false;
  for (const widthPct of SIM_MATRIX_WIDTHS_PCT) {
    for (const buyMultiplier of SIM_MATRIX_MULTIPLIERS) {
      const isPrimary = widthPct === primary.widthPct && buyMultiplier === primary.buyMultiplier;
      primaryFound ||= isPrimary;
      matrix.push(isPrimary ? { widthPct, buyMultiplier, isPrimary: true } : { widthPct, buyMultiplier });
    }
  }
  if (!primaryFound && primary.widthPct > 0 && primary.buyMultiplier > 0) {
    matrix.push({ widthPct: primary.widthPct, buyMultiplier: primary.buyMultiplier, isPrimary: true });
  }
  return matrix;
}

/** 에피소드 1건의 결과 — Supabase sim_episodes 한 행(컬럼명과 1:1). */
export interface SimEpisodeRecord {
  mode: 'sim' | 'live';
  ticker: string;
  /** 진입일(KST, YYYY-MM-DD). */
  trade_date: string;
  /** KST 'YYYY-MM-DD HH:mm:ss'. */
  entered_at: string;
  exited_at: string;
  duration_s: number;
  entry_price: number;
  exit_price: number;
  min_price: number;
  /** 최대 역행률(MAE, 양수 %) = (진입가 − 최저가) / 진입가 × 100. */
  mae_pct: number;
  max_qty: number;
  /** 최대 투입금액(USD, 무한 현금 기준) — 이 전략의 최소 필요 자금. */
  max_invested_usd: number;
  rebuy_count: number;
  width_pct: number;
  buy_multiplier: number;
  is_primary: boolean;
  escaped: boolean;
  exit_reason: 'escaped' | 'data_lost' | 'stopped' | 'evicted';
  tick_rate_at_entry: number | null;
  /** 세션 구분(라벨은 장 기준, 시각 기록은 KST): 'pre' | 'regular' | 'after' | 'off' | 'daytime'. */
  entry_session: string;
}

/** 진입 당시 컨텍스트 — 오토파일럿 onEntryFilled 훅에서 온다. */
export interface SimEntryContext {
  tickRate?: number;
  mode: 'sim' | 'live';
}

/** 전략 1개의 진행 중 에피소드 — 진입 정보를 각자 들고 있다(전략별 독립 계좌·재진입 규칙의 핵심). */
interface StrategyState {
  cfg: SimStrategyConfig;
  mode: 'sim' | 'live';
  entryPrice: number;
  enteredAtMs: number;
  tickRate: number | null;
  qty: number;
  avgPrice: number;
  buyLegPrice: number;
  /** 물타기 수량 floor(qty×배율) — 0이면 매수 다리 없음(매도만 기다린다). */
  buyLegQty: number;
  sellLegPrice: number;
  investedUsd: number;
  maxInvestedUsd: number;
  maxQty: number;
  minPrice: number;
  rebuyCount: number;
}

/** 종목 1개의 장부 — 진행 중 전략들 + 최근 시세. 전략이 다 끝나면 장부째 정리(구독 해제). */
interface TickerBook {
  strategies: Map<string, StrategyState>;
  lastPrice: number;
  lastTsMs: number;
}

export interface SimLabDeps {
  clock: ClockLike;
  matrix: SimStrategyConfig[];
  /** 에피소드 결과 1행 — Supabase 기록기로 연결(호출부가 fire-and-forget·큐잉을 책임진다). */
  onRecord: (record: SimEpisodeRecord) => void;
  /** 종목 감시 시작/끝의 WS 구독 유지 훅 — AutoPilotManager.holdTick/releaseTick으로 연결. */
  hold?: (ticker: string) => void;
  release?: (ticker: string) => void;
  maxEpisodes?: number;
}

export class SimLab {
  private readonly deps: SimLabDeps;
  private readonly books = new Map<string, TickerBook>();

  constructor(deps: SimLabDeps) {
    this.deps = deps;
  }

  /** 진행 중 전략이 남아 있는 티커(진단·테스트용). */
  get activeTickers(): string[] {
    return [...this.books.keys()];
  }

  /**
   * 진입 체결 1건 → **놀고 있는 전략만** 이 진입가로 새 에피소드를 연다.
   * 이미 보유 중인 전략(직전 진입에서 아직 탈출 못 함)은 건드리지 않는다 — 각자 독립 계좌(사용자 확정).
   */
  onEntry(ticker: string, qty: number, entryPrice: number, ctx: SimEntryContext): void {
    if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(qty) || qty < 1) return;

    let book = this.books.get(ticker);
    if (!book) {
      // 새 종목 — 슬롯 초과면 가장 오래된 종목(가장 이른 진입을 품은 장부)을 축출 기록으로 마감.
      const limit = this.deps.maxEpisodes ?? DEFAULT_MAX_EPISODES;
      while (this.books.size >= limit) {
        const oldest = this.oldestTicker();
        if (!oldest) break;
        this.closeEpisode(oldest, 'evicted');
      }
      book = { strategies: new Map(), lastPrice: entryPrice, lastTsMs: this.deps.clock.now() };
      this.books.set(ticker, book);
      this.deps.hold?.(ticker);
    }

    const now = this.deps.clock.now();
    const tickRate = Number.isFinite(ctx.tickRate) ? (ctx.tickRate as number) : null;
    for (const cfg of this.deps.matrix) {
      const key = strategyKey(cfg);
      if (book.strategies.has(key)) continue; // 보유 중 — 자기 에피소드를 계속 간다.
      const w = cfg.widthPct / 100;
      book.strategies.set(key, {
        cfg,
        mode: ctx.mode,
        entryPrice,
        enteredAtMs: now,
        tickRate,
        qty,
        avgPrice: entryPrice,
        buyLegPrice: roundGridPrice(entryPrice * (1 - w)),
        buyLegQty: Math.floor(qty * cfg.buyMultiplier),
        sellLegPrice: roundGridPrice(entryPrice * (1 + w)),
        investedUsd: qty * entryPrice,
        maxInvestedUsd: qty * entryPrice,
        maxQty: qty,
        minPrice: entryPrice,
        rebuyCount: 0,
      });
    }
    book.lastPrice = entryPrice;
    book.lastTsMs = now;
  }

  /** WS 체결 틱 — 해당 티커의 진행 중 전략 전부를 트레이드스루 규칙으로 판정한다. */
  onTick(symb: string, price: number, tsMs?: number): void {
    const book = this.books.get(symb);
    if (!book || !Number.isFinite(price) || price <= 0) return;
    book.lastPrice = price;
    book.lastTsMs = tsMs ?? this.deps.clock.now();

    for (const [key, s] of [...book.strategies]) {
      if (price < s.minPrice) s.minPrice = price;

      // 매도(+w) 우선 — SOLD가 리브래킷보다 우선한다는 core/grid 원칙과 동일.
      if (price > s.sellLegPrice) {
        book.strategies.delete(key);
        this.emitRecord(symb, book, s, s.sellLegPrice, 'escaped');
        continue;
      }
      // 매수(−w) 트레이드스루 → 물타기·리브래킷.
      if (s.buyLegQty >= 1 && price < s.buyLegPrice) {
        const fillPrice = s.buyLegPrice;
        const nextQty = s.qty + s.buyLegQty;
        s.avgPrice = (s.qty * s.avgPrice + s.buyLegQty * fillPrice) / nextQty;
        s.qty = nextQty;
        s.investedUsd += s.buyLegQty * fillPrice;
        s.maxInvestedUsd = Math.max(s.maxInvestedUsd, s.investedUsd);
        s.maxQty = Math.max(s.maxQty, s.qty);
        s.rebuyCount += 1;
        const w = s.cfg.widthPct / 100;
        s.buyLegPrice = roundGridPrice(s.avgPrice * (1 - w));
        s.buyLegQty = Math.floor(s.qty * s.cfg.buyMultiplier);
        s.sellLegPrice = roundGridPrice(s.avgPrice * (1 + w));
      }
    }
    if (book.strategies.size === 0) this.dropBook(symb);
  }

  /** 미탈출 마감 — 그 종목의 진행 중 전략 전부를 그 시점 상태로 기록한다(미탈출 데이터가 더 귀중하다). */
  closeEpisode(ticker: string, reason: 'data_lost' | 'stopped' | 'evicted'): void {
    const book = this.books.get(ticker);
    if (!book) return;
    for (const [key, s] of [...book.strategies]) {
      book.strategies.delete(key);
      this.emitRecord(ticker, book, s, book.lastPrice, reason);
    }
    this.dropBook(ticker);
  }

  /** 전체 마감(Stop·모드 전환) — 진행 중인 모든 전략을 같은 사유로 닫는다. */
  closeAll(reason: 'data_lost' | 'stopped' | 'evicted'): void {
    for (const ticker of [...this.books.keys()]) this.closeEpisode(ticker, reason);
  }

  // ---- 내부 ----

  /** 가장 이른 진입을 품고 있는 티커 — 축출 대상 선정용. */
  private oldestTicker(): string | null {
    let best: string | null = null;
    let bestTs = Infinity;
    for (const [ticker, book] of this.books) {
      for (const s of book.strategies.values()) {
        if (s.enteredAtMs < bestTs) {
          bestTs = s.enteredAtMs;
          best = ticker;
        }
      }
      // 전략이 없는 장부(이론상 없음)는 즉시 축출 후보.
      if (book.strategies.size === 0 && best === null) best = ticker;
    }
    return best ?? this.books.keys().next().value ?? null;
  }

  private emitRecord(
    ticker: string,
    book: TickerBook,
    s: StrategyState,
    exitPrice: number,
    reason: SimEpisodeRecord['exit_reason'],
  ): void {
    const exitedAtMs = book.lastTsMs;
    this.deps.onRecord({
      mode: s.mode,
      ticker,
      trade_date: kstDateOf(s.enteredAtMs),
      entered_at: kstTimeOf(s.enteredAtMs),
      exited_at: kstTimeOf(exitedAtMs),
      duration_s: Math.max(0, Math.round((exitedAtMs - s.enteredAtMs) / 1000)),
      entry_price: s.entryPrice,
      exit_price: exitPrice,
      min_price: s.minPrice,
      // 소수 4자리로 절사 — 부동소수 잔재(7.000000000000001)가 DB에 그대로 남지 않게.
      mae_pct: s.entryPrice > 0 ? Math.round(((s.entryPrice - s.minPrice) / s.entryPrice) * 100 * 10_000) / 10_000 : 0,
      max_qty: s.maxQty,
      max_invested_usd: s.maxInvestedUsd,
      rebuy_count: s.rebuyCount,
      width_pct: s.cfg.widthPct,
      buy_multiplier: s.cfg.buyMultiplier,
      is_primary: s.cfg.isPrimary === true,
      escaped: reason === 'escaped',
      exit_reason: reason,
      tick_rate_at_entry: s.tickRate,
      // 주간거래 창(KST 10:00~16:00)이 정규장(ET 기준)보다 먼저 판정된다 — 두 창은 겹치지 않으므로
      // 순서는 결과에 영향 없지만, 주간거래 라벨을 정규장 4종(pre/regular/after/off)과 구분해야 한다.
      entry_session: isDaytimeSessionOpen(s.enteredAtMs) ? 'daytime' : sessionOf(s.enteredAtMs),
    });
  }

  private dropBook(ticker: string): void {
    if (this.books.delete(ticker)) this.deps.release?.(ticker);
  }
}

function strategyKey(cfg: SimStrategyConfig): string {
  return `${cfg.widthPct}|${cfg.buyMultiplier}${cfg.isPrimary ? '|p' : ''}`;
}

// ---- 시각/세션 헬퍼 (순수) ----

/** KST 날짜(YYYY-MM-DD) — 사용자 확정: 기록 시각은 무조건 한국시간. */
export function kstDateOf(epochMs: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(epochMs));
}

/** KST 'YYYY-MM-DD HH:mm:ss' — DB에서 바로 읽어도 헷갈리지 않는 문자열 형식. */
export function kstTimeOf(epochMs: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(epochMs));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  // Intl이 24시를 '24'로 주는 로케일 잔재 방어.
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}:${get('second')}`;
}

/**
 * 미국장 세션 구분 — 판정은 미국 동부 시각으로 하되(장의 정의가 그쪽이므로) 라벨만 반환한다.
 * pre 04:00–09:30 · regular 09:30–16:00 · after 16:00–20:00 · off 그 외. 서머타임은 Intl이 처리.
 */
export function sessionOf(epochMs: number): 'pre' | 'regular' | 'after' | 'off' {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(epochMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const minutes = (get('hour') % 24) * 60 + get('minute');
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return 'pre';
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return 'regular';
  if (minutes >= 16 * 60 && minutes < 20 * 60) return 'after';
  return 'off';
}
