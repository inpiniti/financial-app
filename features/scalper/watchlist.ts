// 단타 리스트 관리자 — plan §2-3 (docs/development/2026-07-31_단타-자동관리-plan.md).
// 원천 확장(3종→4종, 상승률 추가): docs/development/2026-08-03_단타-리스트-상승률확장-plan.md.
//
// 순위 4종(거래량·거래증가율·거래회전율·상승률, NAS·당일)을 3분 간격으로 폴링해
// "등락률 +, 주문가능, 진입금액 이하" 상위 3종목씩 → 서로 다른 12티커를 상시 유지한다.
//  · 현재가 > 진입금액이면 어차피 1주도 못 사서(qtyForAmount=0) 감시·WS 구독이 낭비다 —
//    리스트 구성 단계에서 걸러내고 차순위로 충원한다(maxPriceUsd).
//  · 랭킹 간 중복 티커는 우선권(거래량→증가율→회전율→상승률)에 따라 1개만 올리고 차순위로 충원.
//  · 리스트에서 밀려난 종목은 즉시 제거하되, 사이클 진행 중(핀 고정)이면 제거를 유예하고
//    unpin(사이클 종료) 시점에 즉시 제거한다 — 핀은 여러 개 걸릴 수 있어(다중 그리드)
//    일시적으로 12+동시그리드수 종목까지 허용된다.
//  · 폴링은 start~stop 사이에만 돈다(마스터 Run/Stop과 함께 켜고 끈다 — 별도 장시간 게이트 없음, plan §1-B).
//
// 순수 로직: 랭킹 호출은 fetchSnapshot 주입으로 추상화(테스트는 가짜 스냅샷 심).

import type { SchedulerLike } from './types';

/**
 * 리스트 원천 순위 4종 — 배열 순서가 곧 중복 티커 우선권이다(plan §4-2).
 * 상승률(upDownRate)은 맨 뒤 — 기존 3종 구성을 보존하고 남은 티커만 채운다(확장 plan §1-1 A).
 */
export const WATCH_SOURCES = ['tradeVolume', 'tradeGrowth', 'tradeTurnover', 'upDownRate'] as const;
export type WatchSource = (typeof WATCH_SOURCES)[number];

export const WATCH_SOURCE_LABEL: Record<WatchSource, string> = {
  tradeVolume: '거래량',
  tradeGrowth: '증가율',
  tradeTurnover: '회전율',
  upDownRate: '상승률',
};

/** 순위별 채용 슬롯 수(상위 3) · 폴링 주기 3분(plan §4-10). */
export const WATCH_SLOTS_PER_SOURCE = 3;
/** 평시 리스트 최대 크기(원천 수 × 슬롯 수 = 12) — 핀 유예 중에는 이보다 커질 수 있다. */
export const WATCHLIST_MAX_SIZE = WATCH_SOURCES.length * WATCH_SLOTS_PER_SOURCE;
export const WATCHLIST_POLL_INTERVAL_MS = 180_000;

/** 랭킹 응답에서 리스트 판정에 필요한 최소 필드(kis/ranking.ts RankingRowBase 부분집합). */
export interface WatchCandidateRow {
  /** 티커(symb). 빈 값이면 후보에서 제외. */
  symb: string;
  /** 등락율 원문 — 부호 판정은 sign과 조합(parseSignedRate). */
  rate: string;
  /** 기호: 1(상한)·2(상승)·3(보합)·4(하한)·5(하락). 없으면 rate 부호를 그대로 믿는다. */
  sign?: string;
  /** 매매가능 — 명확히 불가('X'/'N')일 때만 걸러낸다(문서에 값 형식 미기재 — 관대 판정). */
  e_ordyn?: string;
  /** 현재가 원문(RankingRowBase.last) — 진입금액 상한 필터에 쓴다. 없으면 필터를 통과시킨다(관대 판정). */
  last?: string;
}

/** 한 번의 폴링에서 얻은 순위 4종 스냅샷 — 각 배열은 순위 순서(상위부터)라고 가정한다. */
export type RankingSnapshot = Record<WatchSource, readonly WatchCandidateRow[]>;

export interface WatchEntry {
  readonly ticker: string;
  /** 이 티커를 채용한 순위(우선권 반영 후). */
  readonly source: WatchSource;
  /** 채용 시점 등락률(%) — 음전 판정에 쓴 값 그대로(진단·UI 표시용). */
  readonly rate: number;
  /** 사이클 진행 중이라 제거가 유예된 상태(리스트 탈락 후에도 잔류). */
  readonly pinned: boolean;
}

export interface WatchlistDiff {
  readonly added: readonly WatchEntry[];
  readonly removed: readonly string[];
}

export interface WatchlistDeps {
  /** 순위 4종 1회 폴링 — 실서비스는 kis/ranking.ts 4콜 직렬, 테스트는 가짜 스냅샷. */
  fetchSnapshot: () => Promise<RankingSnapshot>;
  scheduler: SchedulerLike;
  pollIntervalMs?: number;
  /** 리스트가 실제로 바뀔 때만 호출(추가/제거 0건이면 생략). */
  onChange?: (entries: readonly WatchEntry[], diff: WatchlistDiff) => void;
  /** 폴링 실패 통지 — 리스트는 직전 상태를 유지한다(다음 주기에 재시도). */
  onError?: (err: unknown) => void;
  /**
   * 종목 현재가 상한(USD) — 진입금액(config.startAmountUsd)을 폴링마다 읽는 getter.
   * 현재가가 이 값보다 비싸면 1주도 못 사므로 리스트에 올리지 않는다. null/미주입이면 필터 없음.
   */
  maxPriceUsd?: () => number | null;
}

/** 등락률 파싱 — sign(4·5=하락)이 있으면 부호를 강제하고, 없으면 rate 원문 부호를 쓴다. */
export function parseSignedRate(row: WatchCandidateRow): number {
  const parsed = Number.parseFloat(row.rate);
  if (!Number.isFinite(parsed)) return Number.NaN;
  if (row.sign === '4' || row.sign === '5') return -Math.abs(parsed);
  if (row.sign === '1' || row.sign === '2') return Math.abs(parsed);
  return parsed;
}

/** 매매가능 판정 — 문서에 값 형식이 없어 "명확한 불가 표기만 배제"로 관대하게 판정한다. */
export function isOrderable(row: WatchCandidateRow): boolean {
  const v = (row.e_ordyn ?? '').trim().toUpperCase();
  return v !== 'X' && v !== 'N';
}

/**
 * 진입금액 상한 판정 — 현재가 > 상한이면 floor(진입금액÷현재가)=0이라 진입 자체가 불가능하다.
 * 상한이 없거나(null/비유한/0 이하) 현재가를 못 읽으면 통과(관대 판정 — 필터 오작동으로 리스트가
 * 통째로 비는 것보다, 못 거른 종목이 진입 시점의 qty<1 방어선에 걸리는 편이 안전하다).
 */
export function isWithinMaxPrice(row: WatchCandidateRow, maxPriceUsd: number | null | undefined): boolean {
  if (maxPriceUsd == null || !Number.isFinite(maxPriceUsd) || maxPriceUsd <= 0) return true;
  const price = Number.parseFloat(row.last ?? '');
  if (!Number.isFinite(price) || price <= 0) return true;
  return price <= maxPriceUsd;
}

/**
 * 스냅샷 → 목표 리스트(서로 다른 최대 WATCHLIST_MAX_SIZE티커) 계산. 순수 함수 — 테스트 진입점.
 * 각 순위에서 "+등락·주문가능·진입금액 이하·미중복" 상위 WATCH_SLOTS_PER_SOURCE개를 우선권 순서로 채용한다.
 * 필터를 통과한 후보가 모자라면 그 순위 슬롯은 비워둔다(억지로 채우지 않는다).
 */
export function computeDesired(snapshot: RankingSnapshot, maxPriceUsd?: number | null): WatchEntry[] {
  const taken = new Set<string>();
  const desired: WatchEntry[] = [];
  for (const source of WATCH_SOURCES) {
    let slots = 0;
    for (const row of snapshot[source] ?? []) {
      if (slots >= WATCH_SLOTS_PER_SOURCE) break;
      const ticker = row.symb?.trim();
      if (!ticker || taken.has(ticker)) continue;
      const rate = parseSignedRate(row);
      if (!Number.isFinite(rate) || rate <= 0) continue;
      if (!isOrderable(row)) continue;
      if (!isWithinMaxPrice(row, maxPriceUsd)) continue;
      taken.add(ticker);
      desired.push({ ticker, source, rate, pinned: false });
      slots += 1;
    }
  }
  return desired;
}

export class ScalperWatchlist {
  private readonly deps: WatchlistDeps;
  private readonly pollIntervalMs: number;
  private entries = new Map<string, WatchEntry>();
  private readonly pinnedTickers = new Set<string>();
  private timer: unknown = null;
  private refreshing = false;

  constructor(deps: WatchlistDeps) {
    this.deps = deps;
    this.pollIntervalMs = deps.pollIntervalMs ?? WATCHLIST_POLL_INTERVAL_MS;
  }

  /** 현재 리스트(채용 순서 유지 — 우선권 순위·순위 내 랭크 순). */
  get list(): readonly WatchEntry[] {
    return [...this.entries.values()];
  }

  get size(): number {
    return this.entries.size;
  }

  has(ticker: string): boolean {
    return this.entries.has(ticker);
  }

  /** 폴링 시작 — 즉시 1회 갱신 후 주기 반복. 중복 start는 무시. */
  start(): void {
    if (this.timer !== null) return;
    void this.refresh();
    this.timer = this.deps.scheduler.setInterval(() => {
      void this.refresh();
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer === null) return;
    this.deps.scheduler.clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * 사이클 진입 종목 핀 고정 — 리스트 탈락에도 제거를 유예한다(plan: RUN 중 제외 미룸).
   * 리스트에 없는 티커의 핀은 무시한다(오토파일럿은 리스트 종목만 진입하므로 정상 흐름에선 없음).
   */
  pin(ticker: string): void {
    const entry = this.entries.get(ticker);
    if (!entry) return;
    this.pinnedTickers.add(ticker);
    if (!entry.pinned) this.entries.set(ticker, { ...entry, pinned: true });
  }

  /** 핀 해제(사이클 종료) — 마지막 목표 리스트에 이미 없는 종목이면 그 자리에서 즉시 제거한다. */
  unpin(ticker: string): void {
    this.pinnedTickers.delete(ticker);
    const entry = this.entries.get(ticker);
    if (!entry) return;
    if (this.lastDesiredTickers !== null && !this.lastDesiredTickers.has(ticker)) {
      this.entries.delete(ticker);
      this.deps.onChange?.(this.list, { added: [], removed: [ticker] });
      return;
    }
    if (entry.pinned) this.entries.set(ticker, { ...entry, pinned: false });
  }

  private lastDesiredTickers: Set<string> | null = null;

  /** 1회 갱신 — 실패 시 리스트를 건드리지 않고 onError만 통지한다. 재진입 방지. */
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const snapshot = await this.deps.fetchSnapshot();
      this.apply(computeDesired(snapshot, this.deps.maxPriceUsd?.() ?? null));
    } catch (err) {
      this.deps.onError?.(err);
    } finally {
      this.refreshing = false;
    }
  }

  /** 목표 리스트를 현재 리스트에 반영 — 핀 종목만 제거 유예. */
  private apply(desired: readonly WatchEntry[]): void {
    const desiredMap = new Map(desired.map((e) => [e.ticker, e]));
    this.lastDesiredTickers = new Set(desiredMap.keys());

    const removed: string[] = [];
    for (const ticker of [...this.entries.keys()]) {
      if (desiredMap.has(ticker)) continue;
      if (this.pinnedTickers.has(ticker)) continue; // 사이클 진행 중 — unpin 때 제거.
      this.entries.delete(ticker);
      removed.push(ticker);
    }

    const added: WatchEntry[] = [];
    for (const entry of desired) {
      const existing = this.entries.get(entry.ticker);
      if (existing) {
        // 유지 종목 — 출처·등락률만 최신화(핀 상태 보존). 변경 통지는 하지 않는다(구독 변화 없음).
        this.entries.set(entry.ticker, { ...entry, pinned: existing.pinned });
      } else {
        const fresh = { ...entry, pinned: this.pinnedTickers.has(entry.ticker) };
        this.entries.set(entry.ticker, fresh);
        added.push(fresh);
      }
    }

    if (added.length > 0 || removed.length > 0) {
      this.deps.onChange?.(this.list, { added, removed });
    }
  }
}
