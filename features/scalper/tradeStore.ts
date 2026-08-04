// 거래 기록 — RunCycle onTrade가 발행하는 TradeRecord를 일자별로 AsyncStorage에 append한다.
// 키: `trades.YYYY-MM-DD` (UTC 기준 — kis/orderHistory의 당일 조회와 동일 관례), 값: StoredTrade[] JSON.
// 조회 탭 "오늘 거래"와 6단계 UI가 readTodayTrades로 읽는다.
import type { TradeRecord } from '../../core/cycle';
import type { ClockLike, KeyValueStore } from './types';

export const TRADE_KEY_PREFIX = 'trades.';

/** 저장 레코드 = core TradeRecord + 어느 인스턴스가 낸 거래인지. */
export interface StoredTrade extends TradeRecord {
  instanceId: string;
}

/** epoch ms → 'YYYY-MM-DD' (UTC). */
export function formatTradeDate(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10);
}

export function tradeKeyFor(tsMs: number): string {
  return `${TRADE_KEY_PREFIX}${formatTradeDate(tsMs)}`;
}

async function readKey(storage: KeyValueStore, key: string): Promise<StoredTrade[]> {
  const raw = await storage.getItem(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as StoredTrade[]) : [];
  } catch {
    // 파손된 저장값 — 빈 배열로 자연 복구(append는 새 배열로 덮어쓴다).
    return [];
  }
}

/**
 * 거래 1건을 그날 배열 끝에 append한다. 기록 시각은 record.exitTs(청산 체결 시각) 기준.
 */
export async function appendTradeRecord(
  storage: KeyValueStore,
  instanceId: string,
  record: TradeRecord,
): Promise<void> {
  const key = tradeKeyFor(record.exitTs);
  const list = await readKey(storage, key);
  list.push({ ...record, instanceId });
  await storage.setItem(key, JSON.stringify(list));
}

/** 특정 날짜('YYYY-MM-DD')의 거래 기록을 읽는다. */
export async function readTradesByDate(
  storage: KeyValueStore,
  date: string,
): Promise<StoredTrade[]> {
  return readKey(storage, `${TRADE_KEY_PREFIX}${date}`);
}

/** 오늘(clock 기준 UTC 일자) 거래 기록을 읽는다 — 조회 탭 "오늘 거래"·6단계 진입점. */
export async function readTodayTrades(
  storage: KeyValueStore,
  clock: ClockLike,
): Promise<StoredTrade[]> {
  return readKey(storage, tradeKeyFor(clock.now()));
}
