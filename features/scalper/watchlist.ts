// 단타 리스트 관리자 — plan §2-3 (docs/development/2026-07-31_단타-자동관리-plan.md).
// 원천 확장(3종→4종, 상승률 추가): docs/development/2026-08-03_단타-리스트-상승률확장-plan.md.
//
// 원천 교체(2026-08-11 사용자 요청): KIS 순위 4종 → 토스 실시간 순위(lib/tossRanking.ts).
// 원천 확장(2026-08-14 사용자 요청): 거래량 1종 → **거래대금+거래량 2종, 각 15개**(관리종목 제외 필터).
// 원천 옵션화(2026-08-18 순위 도메인, core/ranking): 어느 순위(토스 8종·한투 7종)에서 몇 개씩 뽑을지는
//   설정(순위 선택)이 정한다. 이 파일은 원천을 모른다 — 폴링 결과(RankingSnapshot = 원천별 {source, count, rows})를
//   우선권 순서대로 받아 필터·중복 제거·차순위 충원만 한다. 기본 선택은 옛 구성(토스 거래대금·거래량 실시간 각 15)이다.
// 순위(ETF·ETN 제외)를 3분 간격으로 폴링해
// "등락률 +, 주문가능, 진입금액 이하" 상위 총 최대 30티커를 상시 유지한다(모자라면 차순위로 충원).
//  · 현재가 > 진입금액이면 어차피 1주도 못 사서(qtyForAmount=0) 감시·WS 구독이 낭비다 —
//    리스트 구성 단계에서 걸러내고 차순위로 충원한다(maxPriceUsd).
//  · 중복 티커는 1개만 올리고 차순위로 충원(원천이 여러 개면 배열 순서가 곧 우선권).
//  · 리스트에서 밀려난 종목은 즉시 제거하되, 사이클 진행 중(핀 고정)이면 제거를 유예하고
//    unpin(사이클 종료) 시점에 즉시 제거한다 — 핀은 여러 개 걸릴 수 있어(다중 그리드)
//    일시적으로 12+동시그리드수 종목까지 허용된다.
//  · 폴링은 start~stop 사이에만 돈다(마스터 Run/Stop과 함께 켜고 끈다 — 별도 장시간 게이트 없음, plan §1-B).
//
// 순수 로직: 랭킹 호출은 fetchSnapshot 주입으로 추상화(테스트는 가짜 스냅샷 심).

import type { SchedulerLike } from './types';

/**
 * 리스트 원천 식별자 — 순위 도메인(core/ranking)의 RankingSourceId(예: 'toss:amount:realtime:norisk', 'kis:tradeVolume').
 * 표시명은 core/ranking.rankingSourceLabelOf로 얻는다. 이 파일은 id를 불투명 문자열로만 다룬다.
 */
export type WatchSource = string;

/**
 * 평시 리스트 최대 크기 — 구독 예산(KIS 41건): 체결가 30 + 호가(감시 3 + 진입·보유 + 급등 에피소드 3) + 상세화면 ≤ 41.
 * 순위 선택의 개수 합 상한(core/ranking.RANKING_TOTAL_MAX)과 같은 값. 핀 유예 중에는 이보다 커질 수 있다.
 */
export const WATCHLIST_MAX_SIZE = 30;
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
  /** 거래소코드(NAS·NYS·AMS) — 3거래소 병합 조회(2026-08-08) 이후 채용 거래소 판별용. 없으면 NAS 취급. */
  excd?: string;
  /** 종목명(순위 응답의 name, 없으면 ename) — 리스트·종목상세 표시용. 매매 판정에는 쓰지 않는다. */
  name?: string;
}

/** 리스트가 다루는 미국 3거래소 — WS 구독 시장구분·주문 거래소를 티커별로 고르는 근거. */
export type WatchMarket = 'NAS' | 'NYS' | 'AMS';

/** 랭킹 행의 excd를 미국 3거래소 코드로 정규화 — 모르는 값은 NAS(기존 동작 보존). */
export function toWatchMarket(excd: string | undefined): WatchMarket {
  const v = (excd ?? '').trim().toUpperCase();
  return v === 'NYS' || v === 'AMS' ? v : 'NAS';
}

/** 원천 하나의 폴링 결과 — rows는 순위 순서(상위부터), count는 이 원천에서 채용할 최대 개수. */
export interface RankingSourceSnapshot {
  readonly source: WatchSource;
  readonly count: number;
  readonly rows: readonly WatchCandidateRow[];
}

/**
 * 한 번의 폴링에서 얻은 스냅샷 — **배열 순서가 우선권**(앞 원천이 겹치는 티커를 가져간다).
 * 순위 계획(core/ranking.RankingPlan)의 순서를 그대로 따른다.
 */
export type RankingSnapshot = readonly RankingSourceSnapshot[];

export interface WatchEntry {
  readonly ticker: string;
  /** 이 티커를 채용한 순위(우선권 반영 후). */
  readonly source: WatchSource;
  /** 채용 시점 등락률(%) — 음전 판정에 쓴 값 그대로(진단·UI 표시용). */
  readonly rate: number;
  /** 채용 거래소(NAS·NYS·AMS) — WS trKey 시장구분·주문 거래소가 이 값을 따른다. */
  readonly market: WatchMarket;
  /** 종목명 — 순위 응답에 있으면 채운다(없으면 undefined, 화면은 티커로 폴백). */
  readonly name?: string;
  /** 사이클 진행 중이라 제거가 유예된 상태(리스트 탈락 후에도 잔류). */
  readonly pinned: boolean;
}

export interface WatchlistDiff {
  readonly added: readonly WatchEntry[];
  readonly removed: readonly string[];
}

export interface WatchlistDeps {
  /** 원천 1회 폴링 — 실서비스는 lib/tossRanking.ts(순위 2종+종목정보, 총 3콜), 테스트는 가짜 스냅샷. */
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
 * 각 순위에서 "+등락·주문가능·진입금액 이하·미중복" 상위 count개를 우선권(배열) 순서로 채용한다.
 * 필터를 통과한 후보가 모자라면 그 순위 슬롯은 비워둔다(억지로 채우지 않는다).
 * 총합이 WATCHLIST_MAX_SIZE를 넘으면 뒤 원천부터 잘린다(계획 단계에서 이미 막지만 최후 방어선).
 */
export function computeDesired(snapshot: RankingSnapshot, maxPriceUsd?: number | null): WatchEntry[] {
  const taken = new Set<string>();
  const desired: WatchEntry[] = [];
  for (const { source, count, rows } of snapshot) {
    let slots = 0;
    for (const row of rows) {
      if (slots >= count || desired.length >= WATCHLIST_MAX_SIZE) break;
      const ticker = row.symb?.trim();
      if (!ticker || taken.has(ticker)) continue;
      const rate = parseSignedRate(row);
      if (!Number.isFinite(rate) || rate <= 0) continue;
      if (!isOrderable(row)) continue;
      if (!isWithinMaxPrice(row, maxPriceUsd)) continue;
      taken.add(ticker);
      desired.push({
        ticker,
        source,
        rate,
        market: toWatchMarket(row.excd),
        name: row.name?.trim() || undefined,
        pinned: false,
      });
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

  /** 폴링 중인가(start~stop 사이) — 순위 선택이 바뀌었을 때 즉시 재조회할지 판단하는 데 쓴다. */
  get running(): boolean {
    return this.timer !== null;
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
        // 종목명은 한 번 알아낸 값을 유지한다 — 순위 종류에 따라 비어 오는 응답에 이름이 사라지지 않게.
        this.entries.set(entry.ticker, { ...entry, name: entry.name ?? existing.name, pinned: existing.pinned });
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
