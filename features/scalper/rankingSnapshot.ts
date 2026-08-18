// 순위 계획(core/ranking.RankingPlan) → 워치리스트 스냅샷(watchlist.RankingSnapshot) 조립.
// 토스 원천은 한 번에 묶어 조회(fetchToss — 종목정보 콜을 공유), 한투 원천은 종류별로 조회(fetchKis).
// 실제 HTTP는 주입(managerProvider가 lib/tossRanking·kis/ranking으로 배선) — 이 파일은 순수 조립 로직이라 테스트가 쉽다.
//
// 실패 정책: 토스 묶음이 실패하면 throw(워치리스트가 직전 리스트 유지). 한투는 원천 하나가 실패해도 그 원천만
// 빈 결과로 두고 나머지로 계속한다(KIS 순위는 거래소별 직렬 호출이라 부분 실패가 잦다) — 단, 계획의 **모든** 원천이
// 실패했으면 throw한다(빈 스냅샷으로 리스트를 통째로 비우지 않게).

import type { KisMetric, KisWindow, RankingPlan, TossDuration, TossMetric } from '../../core/ranking';
import type { RankingSnapshot, RankingSourceSnapshot, WatchCandidateRow } from './watchlist';

export interface TossSnapshotQuery {
  metric: TossMetric;
  duration: TossDuration;
  /** true = 관리종목 제외 필터(KRX_MANAGEMENT_STOCK)를 건다(= 위험미포함). */
  excludeManagement: boolean;
}

export interface RankingSnapshotDeps {
  /** 토스 순위 여러 건 — 요청 순서대로 후보 행 배열. 하나라도 비면 throw(lib/tossRanking.fetchTossRankingQueries 관례). */
  fetchToss: (queries: readonly TossSnapshotQuery[]) => Promise<readonly (readonly WatchCandidateRow[])[]>;
  /** 한투 순위 1종(미국 거래소 병합·정렬 완료) — 실패는 throw. */
  fetchKis: (metric: KisMetric, window: KisWindow) => Promise<readonly WatchCandidateRow[]>;
  /** 한투 원천 개별 실패 통지(선택). */
  onKisError?: (metric: KisMetric, err: unknown) => void;
}

/** 계획대로 원천을 조회해 우선권 순서 그대로의 스냅샷을 만든다. 계획이 비면 빈 스냅샷(리스트가 비는 것이 맞다). */
export async function buildRankingSnapshot(plan: RankingPlan, deps: RankingSnapshotDeps): Promise<RankingSnapshot> {
  if (plan.length === 0) return [];

  const tossItems = plan.filter((p) => p.source.provider === 'toss');
  const tossQueries: TossSnapshotQuery[] = tossItems.map((p) => {
    const src = p.source as Extract<RankingPlan[number]['source'], { provider: 'toss' }>;
    return { metric: src.metric, duration: src.duration, excludeManagement: !src.includeRisk };
  });

  const [tossLists, kisResults] = await Promise.all([
    tossQueries.length > 0 ? deps.fetchToss(tossQueries) : Promise.resolve([] as readonly (readonly WatchCandidateRow[])[]),
    Promise.all(
      plan
        .filter((p) => p.source.provider === 'kis')
        .map(async (p) => {
          const src = p.source as Extract<RankingPlan[number]['source'], { provider: 'kis' }>;
          try {
            return { id: p.source.id, rows: await deps.fetchKis(src.metric, p.window ?? '0'), ok: true };
          } catch (err) {
            deps.onKisError?.(src.metric, err);
            return { id: p.source.id, rows: [] as readonly WatchCandidateRow[], ok: false };
          }
        }),
    ),
  ]);

  if (kisResults.length > 0 && tossQueries.length === 0 && kisResults.every((r) => !r.ok)) {
    throw new Error('한투 순위 조회가 모두 실패했어요');
  }

  const rowsById = new Map<string, readonly WatchCandidateRow[]>();
  tossItems.forEach((p, i) => rowsById.set(p.source.id, tossLists[i] ?? []));
  for (const r of kisResults) rowsById.set(r.id, r.rows);

  const snapshot: RankingSourceSnapshot[] = plan.map((p) => ({
    source: p.source.id,
    count: p.count,
    rows: rowsById.get(p.source.id) ?? [],
  }));
  return snapshot;
}
