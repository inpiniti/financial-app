import type { ExitReason, TradeRecord } from '../../core/cycle';
import type { ClockLike, KeyValueStore } from './types';
import type { WatchMarket } from './watchlist';

export const TRADE_KEY_PREFIX = 'trades.';
export const TRADE_ACTION_KEY_PREFIX = 'trade_actions.';

export type TradeActionType = 'ENTRY' | 'SCALE_IN' | 'EXIT';

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

/** epoch ms → 'YYYY-MM-DD' (UTC). */
export function formatTradeDate(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10);
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
 * 체결 액션 기록이 아직 없고 완료된 StoredTrade만 있는 경우(기존 데이터),
 * ENTRY와 EXIT 액션으로 자동 합성 변환하여 과거 데이터와 100% 호환된다.
 */
export async function readTodayTradeActions(
  storage: KeyValueStore,
  clock: ClockLike,
): Promise<TradeActionRecord[]> {
  const dateKey = tradeActionKeyFor(clock.now());
  const actions = await readKey<TradeActionRecord>(storage, dateKey);
  if (actions.length > 0) return actions;

  // 레거시 StoredTrade 폴백 변환
  const legacyTrades = await readTodayTrades(storage, clock);
  if (legacyTrades.length === 0) return [];

  const converted: TradeActionRecord[] = [];
  for (const t of legacyTrades) {
    converted.push({
      id: `${t.ticker}-entry-${t.entryTs}`,
      cycleId: t.instanceId,
      action: 'ENTRY',
      ticker: t.ticker,
      market: t.market,
      name: t.name,
      price: t.entryPrice,
      qty: t.qty,
      amountUsd: t.entryPrice * t.qty,
      ts: t.entryTs,
    });
    converted.push({
      id: `${t.ticker}-exit-${t.exitTs}`,
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
  return converted.sort((a, b) => a.ts - b.ts);
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

