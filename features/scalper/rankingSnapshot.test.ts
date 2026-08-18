import { describe, expect, it, vi } from 'vitest';

import { kisSourceId, planFromSelection, tossSourceId } from '../../core/ranking';
import { buildRankingSnapshot } from './rankingSnapshot';
import type { WatchCandidateRow } from './watchlist';

const row = (symb: string): WatchCandidateRow => ({ symb, rate: '1' });

describe('buildRankingSnapshot — 계획 → 스냅샷 조립', () => {
  it('토스 원천은 한 묶음으로(종목정보 콜 공유), 한투는 종류별로 조회하고 계획 순서·count를 그대로 옮긴다', async () => {
    const plan = planFromSelection({
      [tossSourceId('amount', 'realtime', false)]: { enabled: true, count: 5 },
      [tossSourceId('volume', '1d', true)]: { enabled: true, count: 3 },
      [kisSourceId('tradeVolume')]: { enabled: true, count: 2, window: '1' },
      [kisSourceId('volumeSurge')]: { enabled: true, count: 4, window: '3' },
    });
    const fetchToss = vi.fn(async (queries: readonly { metric: string; duration: string; excludeManagement: boolean }[]) =>
      queries.map((q) => [row(`${q.metric}-${q.duration}-${q.excludeManagement ? 'x' : 'o'}`)]),
    );
    const fetchKis = vi.fn(async (metric: string, window: string) => [row(`${metric}@${window}`)]);

    const snapshot = await buildRankingSnapshot(plan, { fetchToss, fetchKis });

    expect(fetchToss).toHaveBeenCalledTimes(1);
    expect(fetchToss.mock.calls[0][0]).toEqual([
      { metric: 'amount', duration: 'realtime', excludeManagement: true }, // 위험미포함 = 관리종목 제외.
      { metric: 'volume', duration: '1d', excludeManagement: false }, // 위험포함 = 필터 없음.
    ]);
    expect(fetchKis.mock.calls).toEqual([
      ['tradeVolume', '1'],
      ['volumeSurge', '3'],
    ]);
    expect(snapshot.map((s) => [s.source, s.count, s.rows.map((r) => r.symb)])).toEqual([
      [tossSourceId('amount', 'realtime', false), 5, ['amount-realtime-x']],
      [tossSourceId('volume', '1d', true), 3, ['volume-1d-o']],
      [kisSourceId('tradeVolume'), 2, ['tradeVolume@1']],
      [kisSourceId('volumeSurge'), 4, ['volumeSurge@3']],
    ]);
  });

  it('토스 원천이 없으면 fetchToss를 부르지 않고, 계획이 비면 빈 스냅샷', async () => {
    const fetchToss = vi.fn();
    const fetchKis = vi.fn(async () => [row('K')]);
    const plan = planFromSelection({ [kisSourceId('upDownRate')]: { enabled: true, count: 1, window: '0' } });
    const snapshot = await buildRankingSnapshot(plan, { fetchToss, fetchKis });
    expect(fetchToss).not.toHaveBeenCalled();
    expect(snapshot).toHaveLength(1);
    expect(await buildRankingSnapshot([], { fetchToss, fetchKis })).toEqual([]);
  });

  it('한투 원천 하나가 실패하면 그 원천만 비우고 나머지로 계속(onKisError 통지) — 토스 실패는 그대로 던진다', async () => {
    const onKisError = vi.fn();
    const plan = planFromSelection({
      [tossSourceId('amount', 'realtime', false)]: { enabled: true, count: 5 },
      [kisSourceId('tradeVolume')]: { enabled: true, count: 2, window: '0' },
      [kisSourceId('tradeGrowth')]: { enabled: true, count: 2, window: '0' },
    });
    const snapshot = await buildRankingSnapshot(plan, {
      fetchToss: async () => [[row('T')]],
      fetchKis: async (metric) => {
        if (metric === 'tradeVolume') throw new Error('KIS 500');
        return [row('G')];
      },
      onKisError,
    });
    expect(snapshot.map((s) => s.rows.map((r) => r.symb))).toEqual([['T'], [], ['G']]);
    expect(onKisError).toHaveBeenCalledWith('tradeVolume', expect.any(Error));

    await expect(
      buildRankingSnapshot(plan, {
        fetchToss: async () => {
          throw new Error('토스 순위 응답이 비어 있어요');
        },
        fetchKis: async () => [row('G')],
      }),
    ).rejects.toThrow('토스 순위');
  });

  it('한투만 있는 계획에서 전부 실패하면 던진다 — 빈 스냅샷으로 리스트를 통째로 비우지 않게', async () => {
    const plan = planFromSelection({ [kisSourceId('tradeVolume')]: { enabled: true, count: 2, window: '0' } });
    await expect(
      buildRankingSnapshot(plan, {
        fetchToss: async () => [],
        fetchKis: async () => {
          throw new Error('KIS 500');
        },
      }),
    ).rejects.toThrow('모두 실패');
  });
});
