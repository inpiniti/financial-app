import type { ExitReason, TradeRecord } from '../../core/cycle';
import type { ClockLike, KeyValueStore } from './types';
import type { WatchMarket } from './watchlist';

export const TRADE_KEY_PREFIX = 'trades.';
export const TRADE_ACTION_KEY_PREFIX = 'trade_actions.';

export type TradeActionType = 'ENTRY' | 'SCALE_IN' | 'EXIT';

/**
 * 추가진입(물타기) 체결 이벤트 정보 (ScaleInExecution VO)
 */
export interface ScaleInExecution {
  ticker: string;
  price: number;
  qty: number;
  prevAvgPrice: number;
  newAvgPrice: number;
  totalQty: number;
  ts: number;
}

/** 체결 액션 고유 ID 생성 규칙 일원화 */
export function makeTradeActionId(ticker: string, action: TradeActionType, ts: number): string {
  return `${ticker}-${action.toLowerCase().replace('_', '-')}-${ts}`;
}

/**
 * 실시간 체결 액션 레코드 — 진입, 추가진입(물타기), 청산 체결 즉시 AsyncStorage에 저장된다.
 * 트레이딩 > 오늘성과 > 오늘거래 기록 화면에서 세세하게 볼 수 있는 정본 데이터.
 */
export interface TradeActionRecord {
  id: string;
  cycleId?: string;
  action: TradeActionType;
  ticker: string;
  market?: WatchMarket;
  name?: string;
  price: number;
  qty: number;
  amountUsd: number;
  ts: number;
  /** 진입 시의 익절 목표가 (선등록 매도 등) */
  targetPrice?: number;
  /** 추가진입 전 평단가 */
  prevAvgPrice?: number;
  /** 추가진입 후 새 평단가 */
  newAvgPrice?: number;
  /** 추가진입 후 총 보유 수량 */
  totalQty?: number;
  /** 청산 사유 */
  exitReason?: ExitReason;
  /** 청산 시점의 진입 평단가 */
  entryAvgPrice?: number;
  /** 청산 실현 순손익 (USD) */
  pnl?: number;
  /** 수수료 차감 전 손익 (USD) */
  grossPnl?: number;
  /** 부과된 수수료 (USD) */
  fees?: number;
  /** 수익률 (진입 평단 대비 청산가 비율, 예: 0.03 = +3%) */
  returnRatio?: number;
}

/** 저장 레코드 = core TradeRecord + 어느 인스턴스가 낸 거래인지 + 채용 거래소·종목명. (사이클 완료 정산용) */
export interface StoredTrade extends TradeRecord {
  instanceId: string;
  /** 채용 거래소(WatchEntry.market) — 종목상세 진입 시 시장 판별용. 옛 기록에는 없어 optional. */
  market?: WatchMarket;
  /** 종목명(WatchEntry.name) — 기록 화면이 티커만 보여주지 않게. 옛 기록에는 없어 optional. */
  name?: string;
}

// 모듈 스코프에서 한 번만 생성 — formatTradeDate가 빈번하게 호출되므로 GC 압박을 방지한다(perf §js-hoist-intl).
const NY_DATE_DTF = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** epoch ms → 'YYYY-MM-DD' (미국 동부시간 America/New_York, ET 기준일). */
export function formatTradeDate(tsMs: number): string {
  return NY_DATE_DTF.format(new Date(tsMs));
}

export function tradeKeyFor(tsMs: number): string {
  return `${TRADE_KEY_PREFIX}${formatTradeDate(tsMs)}`;
}

export function tradeActionKeyFor(tsMs: number): string {
  return `${TRADE_ACTION_KEY_PREFIX}${formatTradeDate(tsMs)}`;
}

async function readKey<T>(storage: KeyValueStore, key: string): Promise<T[]> {
  const raw = await storage.getItem(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/**
 * 체결 액션(진입, 추가진입, 청산) 1건을 그날 배열 끝에 append한다. 기록 시각은 action.ts 기준.
 */
export async function appendTradeAction(
  storage: KeyValueStore,
  action: TradeActionRecord,
): Promise<void> {
  const key = tradeActionKeyFor(action.ts);
  const list = await readKey<TradeActionRecord>(storage, key);
  list.push(action);
  await storage.setItem(key, JSON.stringify(list));
}

/** 특정 날짜('YYYY-MM-DD')의 체결 액션 목록을 읽는다. */
export async function readTradeActionsByDate(
  storage: KeyValueStore,
  date: string,
): Promise<TradeActionRecord[]> {
  return readKey<TradeActionRecord>(storage, `${TRADE_ACTION_KEY_PREFIX}${date}`);
}

/**
 * 오늘(clock 기준 UTC 일자) 체결 액션 목록을 읽는다.
 * 체결 액션과 완료된 StoredTrade(레거시 데이터)가 공존하더라도,
 * ID 기반 중복 방지를 거쳐 무손실로 합성·병합하여 시간순으로 반환한다.
 */
export async function readTodayTradeActions(
  storage: KeyValueStore,
  clock: ClockLike,
): Promise<TradeActionRecord[]> {
  const dateKey = tradeActionKeyFor(clock.now());
  const actions = await readKey<TradeActionRecord>(storage, dateKey);
  const legacyTrades = await readTodayTrades(storage, clock);

  if (actions.length === 0 && legacyTrades.length === 0) return [];
  if (legacyTrades.length === 0) return [...actions].sort((a, b) => a.ts - b.ts);

  // 레거시 StoredTrade 변환 및 중복 방지 병합
  const existingIds = new Set(actions.map((a) => a.id));
  const merged: TradeActionRecord[] = [...actions];

  for (const t of legacyTrades) {
    const entryId = makeTradeActionId(t.ticker, 'ENTRY', t.entryTs);
    if (!existingIds.has(entryId)) {
      merged.push({
        id: entryId,
        cycleId: t.instanceId,
        action: 'ENTRY',
        ticker: t.ticker,
        market: t.market,
        name: t.name,
        price: t.entryPrice,
        qty: t.qty,
        amountUsd: t.entryPrice * t.qty,
        ts: t.entryTs,
        targetPrice: t.entryPrice > 0 ? +(t.entryPrice * 1.03).toFixed(2) : undefined,
      });
    }

    const exitId = makeTradeActionId(t.ticker, 'EXIT', t.exitTs);
    if (!existingIds.has(exitId)) {
      merged.push({
        id: exitId,
        cycleId: t.instanceId,
        action: 'EXIT',
        ticker: t.ticker,
        market: t.market,
        name: t.name,
        price: t.exitPrice,
        qty: t.qty,
        amountUsd: t.exitPrice * t.qty,
        ts: t.exitTs,
        exitReason: t.exitReason,
        entryAvgPrice: t.entryPrice,
        pnl: t.pnl,
        grossPnl: t.grossPnl,
        fees: t.fees,
        returnRatio: t.entryPrice > 0 ? (t.exitPrice - t.entryPrice) / t.entryPrice : 0,
      });
    }
  }

  return merged.sort((a, b) => a.ts - b.ts);
}

/**
 * 당일 체결 액션 집계 요약 통계
 */
export interface TradeSummaryStats {
  entries: number;
  scaleIns: number;
  exits: number;
  totalPnl: number;
}

/**
 * 당일 체결 기록 및 집계 요약 VO
 */
export interface TodayTradeSummary {
  actions: TradeActionRecord[];
  stats: TradeSummaryStats;
}

/**
 * 체결 액션 목록으로부터 요약 통계를 순수 함수로 집계한다.
 */
export function calculateTradeSummaryStats(actions: readonly TradeActionRecord[]): TradeSummaryStats {
  let entries = 0;
  let scaleIns = 0;
  let exits = 0;
  let totalPnl = 0;
  for (const a of actions) {
    if (a.action === 'ENTRY') entries++;
    else if (a.action === 'SCALE_IN') scaleIns++;
    else if (a.action === 'EXIT') {
      exits++;
      totalPnl += a.pnl ?? 0;
    }
  }
  return { entries, scaleIns, exits, totalPnl };
}

/**
 * 오늘 체결 액션 목록 및 사전 집계된 통계 요약을 함께 읽는다.
 */
export async function readTodayTradeSummary(
  storage: KeyValueStore,
  clock: ClockLike,
): Promise<TodayTradeSummary> {
  const actions = await readTodayTradeActions(storage, clock);
  const stats = calculateTradeSummaryStats(actions);
  return { actions, stats };
}

/**
 * 거래 1건을 그날 배열 끝에 append한다. 기록 시각은 record.exitTs(청산 체결 시각) 기준.
 */
export async function appendTradeRecord(
  storage: KeyValueStore,
  instanceId: string,
  record: TradeRecord,
  market?: WatchMarket,
  name?: string,
): Promise<void> {
  const key = tradeKeyFor(record.exitTs);
  const list = await readKey<StoredTrade>(storage, key);
  list.push({ ...record, instanceId, ...(market ? { market } : {}), ...(name ? { name } : {}) });
  await storage.setItem(key, JSON.stringify(list));
}

/** 특정 날짜('YYYY-MM-DD')의 거래 기록을 읽는다. */
export async function readTradesByDate(
  storage: KeyValueStore,
  date: string,
): Promise<StoredTrade[]> {
  return readKey<StoredTrade>(storage, `${TRADE_KEY_PREFIX}${date}`);
}

/** 오늘(clock 기준 UTC 일자) 거래 기록을 읽는다 — 조회 탭 "오늘 거래"·6단계 진입점. */
export async function readTodayTrades(
  storage: KeyValueStore,
  clock: ClockLike,
): Promise<StoredTrade[]> {
  return readKey<StoredTrade>(storage, tradeKeyFor(clock.now()));
}

