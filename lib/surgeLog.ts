// 급등주 찾기 신호 기록 클라이언트 — surge_events 테이블 insert/update 전용
// (docs/domain/surge-stock-finder/2026-08-13_surge-stock-finder-db-schema.md).
//
// 변동율 3종(price/l1/l2_change_pct)은 DB 생성 컬럼이라 여기서 보내지 않는다 — 원천값만 넣는다.
// 기록 실패는 감지를 멈추지 않는다 — 호출부(SurgeRecorder)는 실패를 logged=false 표시로만 쓴다.
import { getSupabaseClient, isSupabaseConfigured } from './supabase';

/** 급등(open) 행 생성 입력 — 호가는 미수신이면 null로 넣는다(버리지 않는다). */
export interface SurgeOpenInput {
  ticker: string;
  market: string;
  surgeAtMs: number;
  surgePrice: number;
  surgeAsk1: number | null;
  surgeAsk2: number | null;
  /** v2 — 급등 출발가(60초 수익률 시작점). */
  anchorPrice: number | null;
  /** v2 — 확정 시점 σ(소수). */
  surgeSigma: number | null;
}

/** 에피소드 종결(open→closed) 입력 — plunge_* 컬럼 = 이탈(하락 확정) 시점 값. */
export interface SurgeCloseInput {
  plungeAtMs: number;
  plungePrice: number;
  plungeBid1: number | null;
  plungeBid2: number | null;
  /** v2 — 추적 중 트레일링 고점(MFE 기준). */
  peakPrice: number | null;
  /** v2 — 이탈 경로. */
  exitReason: 'breakout_fail' | 'soft' | 'hard' | null;
}

export interface SurgeLogClient {
  /** 급등 행 생성 — 성공 시 행 id, 실패 시 null(호출부는 미기록 표시만). */
  insertOpen(input: SurgeOpenInput): Promise<string | null>;
  /** open → closed 종결(이탈 확정). 성공 여부만 돌려준다. */
  close(id: string, input: SurgeCloseInput): Promise<boolean>;
  /** open → expired (타임아웃·stop 정리). */
  expire(id: string): Promise<boolean>;
  /**
   * 고아 행 정리 — 이 기기(앱)가 모르는 open 행 전부를 expired로 마감한다.
   * 재시작 이전 실행이 남긴 행이 대상 — 공백 구간의 가격 흐름을 모르므로 이후 급락과 이어붙이지 않는다.
   * 성공 시 정리한 행 수, 실패 시 null.
   */
  sweepOrphans(): Promise<number | null>;
}

const TABLE = 'surge_events';

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * surge_events 기록 클라이언트를 만든다. Supabase env 미설정이면 null —
 * 호출부(SurgeRecorder)는 null이어도 감지·표시는 그대로 하고 기록만 생략한다.
 */
export function createSurgeLog(): SurgeLogClient | null {
  if (!isSupabaseConfigured()) return null;
  const supabase = getSupabaseClient();

  return {
    async insertOpen(input) {
      try {
        const { data, error } = await supabase
          .from(TABLE)
          .insert({
            ticker: input.ticker,
            market: input.market,
            surge_at: toIso(input.surgeAtMs),
            surge_price: input.surgePrice,
            surge_ask1: input.surgeAsk1,
            surge_ask2: input.surgeAsk2,
            anchor_price: input.anchorPrice,
            surge_sigma: input.surgeSigma,
            status: 'open',
          })
          .select('id')
          .single();
        if (error) return null;
        return (data as { id: string } | null)?.id ?? null;
      } catch {
        return null;
      }
    },

    async close(id, input) {
      try {
        const { error } = await supabase
          .from(TABLE)
          .update({
            plunge_at: toIso(input.plungeAtMs),
            plunge_price: input.plungePrice,
            plunge_bid1: input.plungeBid1,
            plunge_bid2: input.plungeBid2,
            peak_price: input.peakPrice,
            exit_reason: input.exitReason,
            status: 'closed',
          })
          .eq('id', id)
          .eq('status', 'open');
        return !error;
      } catch {
        return false;
      }
    },

    async expire(id) {
      try {
        const { error } = await supabase
          .from(TABLE)
          .update({ status: 'expired' })
          .eq('id', id)
          .eq('status', 'open');
        return !error;
      } catch {
        return false;
      }
    },

    async sweepOrphans() {
      try {
        const { data, error } = await supabase
          .from(TABLE)
          .update({ status: 'expired' })
          .eq('status', 'open')
          .select('id');
        if (error) return null;
        return (data as { id: string }[] | null)?.length ?? 0;
      } catch {
        return null;
      }
    },
  };
}
