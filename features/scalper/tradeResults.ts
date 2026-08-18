// 거래 결과 기록·조회 — Supabase `trade_results` (docs/domain/켈리 §4·§5, supabase/migrations/0006).
//
//  · 기록: 자동관리 정산(onTrade)마다 1행 insert. **로컬 tradeStore가 정본**이고 여기는 추가 기록처 —
//    실패해도 매매를 멈추지 않는다(fail-open). 실패 행은 AsyncStorage 대기열에 남겨 두고 재전송한다.
//  · 조회: 켈리 배율 **척도** 계산용 수익률 배열(전략 필터·최근 n건 또는 전체). 매매와 무관.
//  Supabase 클라이언트는 최소 인터페이스로 받아 테스트에서 가짜로 갈아끼운다(lib/accessControl.ts 관례).

import type { TradeRecord } from '../../core/cycle';
import type { KeyValueStore } from './types';
import type { WatchMarket } from './watchlist';

/** 진입·청산 규칙 태그 — 켈리는 전략별로 따로 센다. */
export type TradeStrategy = 'trend' | 'inflection' | 'ladder' | 'grid';

/** insert 행 — 마이그레이션 0006 컬럼(생성 컬럼 제외). */
export interface TradeResultRow {
  account_no: string;
  strategy: TradeStrategy;
  exit_reason: string;
  ticker: string;
  market: string | null;
  name: string | null;
  qty: number;
  entry_price: number;
  entry_at: string;
  exit_price: number;
  exit_at: string;
  gross_pnl: number;
  fees: number;
  pnl: number;
  equity_usd: number | null;
  sizing_mode: 'fixed' | 'kelly';
  kelly_fraction: number | null;
  entry_snapshot: unknown;
  exit_snapshot: unknown;
  app_version: string | null;
}

interface InsertResult {
  error: { message: string; code?: string } | null;
}
interface SelectResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

/** 기록에 필요한 최소 클라이언트. */
export interface TradeResultsInsertClient {
  from(table: string): { insert(values: Record<string, unknown>): PromiseLike<InsertResult> };
}

/** 조회에 필요한 최소 클라이언트 — supabase-js 체이닝의 부분집합. */
export interface TradeResultsSelectClient {
  from(table: string): {
    select(columns: string): {
      eq(
        column: string,
        value: string,
      ): {
        eq(
          column: string,
          value: string,
        ): {
          order(column: string, opts: { ascending: boolean }): {
            limit(n: number): PromiseLike<SelectResult<{ return_pct: number | string | null }>>;
          } & PromiseLike<SelectResult<{ return_pct: number | string | null }>>;
        };
      };
    };
  };
}

export const TRADE_RESULTS_TABLE = 'trade_results';
/** 미업로드 대기열 저장 키(AsyncStorage). */
export const TRADE_RESULTS_PENDING_KEY = 'tradeResults.pending';
/** 대기열 상한 — 오래 오프라인이어도 무한히 쌓이지 않게(오래된 것부터 버린다). */
export const TRADE_RESULTS_PENDING_LIMIT = 500;

/** TradeRecord(+거래소·종목명) → insert 행. 순수 함수. */
export function toTradeResultRow(input: {
  accountNo: string;
  strategy: TradeStrategy;
  record: TradeRecord;
  market?: WatchMarket;
  name?: string;
  equityUsd?: number | null;
  appVersion?: string | null;
}): TradeResultRow {
  const r = input.record;
  return {
    account_no: input.accountNo,
    strategy: input.strategy,
    exit_reason: r.exitReason,
    ticker: r.ticker,
    market: input.market ?? null,
    name: input.name ?? null,
    qty: r.qty,
    entry_price: r.entryPrice,
    entry_at: new Date(r.entryTs).toISOString(),
    exit_price: r.exitPrice,
    exit_at: new Date(r.exitTs).toISOString(),
    gross_pnl: r.grossPnl ?? (r.exitPrice - r.entryPrice) * r.qty,
    fees: r.fees ?? 0,
    pnl: r.pnl,
    equity_usd: input.equityUsd ?? null,
    sizing_mode: 'fixed',
    kelly_fraction: null,
    entry_snapshot: r.entrySnapshot,
    exit_snapshot: r.exitSnapshot,
    app_version: input.appVersion ?? null,
  };
}

/** 유니크 인덱스(23505) 위반 = 이미 올라간 행 — 성공으로 본다(재전송 중복). */
function isDuplicate(err: { code?: string; message: string }): boolean {
  return err.code === '23505' || /duplicate key/i.test(err.message);
}

export interface TradeResultRecorderDeps {
  client: TradeResultsInsertClient;
  storage: KeyValueStore;
  /** 실패·재전송 알림(이벤트 문구). 없으면 조용히. */
  onEvent?: (text: string) => void;
}

/**
 * 기록기 — insert 1건, 실패 시 대기열(AsyncStorage)에 보관, flushPending으로 직렬 재전송.
 * 매매를 모른다: 행을 받아 올리기만 한다.
 */
export class TradeResultRecorder {
  private readonly deps: TradeResultRecorderDeps;
  private flushing = false;

  constructor(deps: TradeResultRecorderDeps) {
    this.deps = deps;
  }

  /** 1건 기록 — 성공 true. 실패는 대기열에 넣고 false(throw 없음). */
  async record(row: TradeResultRow): Promise<boolean> {
    const ok = await this.tryInsert(row);
    if (ok) return true;
    await this.enqueue(row);
    this.deps.onEvent?.(`${row.ticker} 거래 기록 업로드 실패 — 로컬에는 남아 있고, 다음에 다시 올려요`);
    return false;
  }

  /** 대기열 재전송(직렬). 올라간 건수를 돌려준다. 하나라도 실패하면 거기서 멈추고 나머지는 대기열에 남긴다. */
  async flushPending(): Promise<number> {
    if (this.flushing) return 0;
    this.flushing = true;
    try {
      const pending = await this.readPending();
      let sent = 0;
      while (sent < pending.length) {
        const ok = await this.tryInsert(pending[sent]);
        if (!ok) break;
        sent += 1;
      }
      if (sent > 0) {
        await this.writePending(pending.slice(sent));
        this.deps.onEvent?.(`거래 기록 ${sent}건 재전송 완료${pending.length - sent > 0 ? ` · ${pending.length - sent}건 대기` : ''}`);
      }
      return sent;
    } finally {
      this.flushing = false;
    }
  }

  async pendingCount(): Promise<number> {
    return (await this.readPending()).length;
  }

  private async tryInsert(row: TradeResultRow): Promise<boolean> {
    try {
      const { error } = await this.deps.client.from(TRADE_RESULTS_TABLE).insert(row as unknown as Record<string, unknown>);
      if (!error) return true;
      return isDuplicate(error);
    } catch {
      return false;
    }
  }

  private async readPending(): Promise<TradeResultRow[]> {
    const raw = await this.deps.storage.getItem(TRADE_RESULTS_PENDING_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as TradeResultRow[]) : [];
    } catch {
      return [];
    }
  }

  private async writePending(rows: TradeResultRow[]): Promise<void> {
    await this.deps.storage.setItem(TRADE_RESULTS_PENDING_KEY, JSON.stringify(rows));
  }

  private async enqueue(row: TradeResultRow): Promise<void> {
    const pending = await this.readPending();
    pending.push(row);
    if (pending.length > TRADE_RESULTS_PENDING_LIMIT) pending.splice(0, pending.length - TRADE_RESULTS_PENDING_LIMIT);
    await this.writePending(pending);
  }
}

/**
 * 켈리 조회용 수익률 배열(소수) — 전략 필터, 최근 n건(미지정이면 전체). 최신이 앞.
 * return_pct(생성 컬럼, %)를 소수로 바꿔 돌려준다. 실패는 throw(호출부 화면이 안내).
 */
export async function fetchTradeReturns(
  client: TradeResultsSelectClient,
  accountNo: string,
  strategy: TradeStrategy,
  limit?: number,
): Promise<number[]> {
  const base = client
    .from(TRADE_RESULTS_TABLE)
    .select('return_pct')
    .eq('account_no', accountNo)
    .eq('strategy', strategy)
    .order('exit_at', { ascending: false });
  const q = limit !== undefined && Number.isFinite(limit) && limit > 0 ? base.limit(Math.floor(limit)) : base;
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? [])
    .filter((r) => r.return_pct !== null && r.return_pct !== undefined)
    .map((r) => Number(r.return_pct))
    .filter((v) => Number.isFinite(v))
    .map((pct) => pct / 100);
}
