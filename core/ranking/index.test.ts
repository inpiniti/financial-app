import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RANKING_SELECTION,
  RANKING_SOURCES,
  RANKING_TOTAL_MAX,
  defaultKisWindow,
  findRankingSource,
  kisSourceId,
  kisWindowLabel,
  normalizeRankingSelection,
  planFromSelection,
  rankingPlanKey,
  rankingSourceLabel,
  rankingSourceLabelOf,
  tossSourceId,
  totalSelectedCount,
  validateRankingSelection,
} from './index';

describe('카탈로그', () => {
  it('토스 8종(종류2×기간2×위험2) + 한투 7종 = 15원천, id는 유일하고 토스가 앞(우선권)', () => {
    expect(RANKING_SOURCES).toHaveLength(15);
    expect(new Set(RANKING_SOURCES.map((s) => s.id)).size).toBe(15);
    expect(RANKING_SOURCES.slice(0, 8).every((s) => s.provider === 'toss')).toBe(true);
    expect(RANKING_SOURCES.slice(8).every((s) => s.provider === 'kis')).toBe(true);
    // 기본 선택 두 원천이 카탈로그 맨 앞 두 자리는 아니어도 토스 구간 안에 있다(거래대금 → 거래량 순).
    const ids = RANKING_SOURCES.map((s) => s.id);
    expect(ids.indexOf(tossSourceId('amount', 'realtime', false))).toBeLessThan(ids.indexOf(tossSourceId('volume', 'realtime', false)));
  });

  it('라벨 — 토스는 종류·기간·위험, 한투는 종류만(기간창은 선택값)', () => {
    expect(rankingSourceLabelOf(tossSourceId('amount', 'realtime', false))).toBe('토스 거래대금 실시간 위험미포함');
    expect(rankingSourceLabelOf(tossSourceId('volume', '1d', true))).toBe('토스 거래량 1일 위험포함');
    expect(rankingSourceLabelOf(kisSourceId('tradeGrowth'))).toBe('한투 거래증가율');
    expect(rankingSourceLabelOf('unknown:id')).toBe('unknown:id'); // 모르는 id는 그대로.
    expect(rankingSourceLabel(findRankingSource(kisSourceId('upDownRate'))!)).toBe('한투 상승율');
  });

  it('한투 기간창 — 일 단위는 당일, 분 단위는 5분전이 기본이고 라벨은 단위별', () => {
    expect(defaultKisWindow('tradeVolume')).toBe('0');
    expect(defaultKisWindow('volumeSurge')).toBe('3');
    expect(kisWindowLabel('tradeVolume', '0')).toBe('당일');
    expect(kisWindowLabel('volumePower', '3')).toBe('5분전'); // 매수체결강도는 NDAY지만 분 단위.
  });
});

describe('선택 정리·검증', () => {
  it('기본 선택 = 토스 거래대금·거래량 실시간 위험미포함 각 15(옛 고정 구성) — 합 30', () => {
    const sel = normalizeRankingSelection(DEFAULT_RANKING_SELECTION);
    expect(Object.keys(sel)).toHaveLength(15);
    expect(sel[tossSourceId('amount', 'realtime', false)]).toEqual({ enabled: true, count: 15 });
    expect(sel[tossSourceId('volume', 'realtime', false)]).toEqual({ enabled: true, count: 15 });
    expect(sel[kisSourceId('tradeVolume')]).toEqual({ enabled: false, count: 0, window: '0' });
    expect(totalSelectedCount(sel)).toBe(30);
    expect(validateRankingSelection(sel)).toBeNull();
  });

  it('파손·부분 저장값 — 모르는 id 폐기, 음수·소수·문자 개수는 0/절사, 이상한 기간창은 기본값', () => {
    const sel = normalizeRankingSelection({
      bogus: { enabled: true, count: 99 },
      [kisSourceId('volumeSurge')]: { enabled: true, count: '2.9', window: 'zz' },
      [tossSourceId('volume', '1d', true)]: { enabled: 'yes', count: -3 },
    });
    expect(sel.bogus).toBeUndefined();
    expect(sel[kisSourceId('volumeSurge')]).toEqual({ enabled: true, count: 2, window: '3' });
    expect(sel[tossSourceId('volume', '1d', true)]).toEqual({ enabled: false, count: 0 });
    expect(normalizeRankingSelection(null)[kisSourceId('tradeVolume')]).toEqual({ enabled: false, count: 0, window: '0' });
  });

  it('검증 — 켜진 개수 합이 0이면 거부, 30 초과면 거부, 꺼진 원천의 개수는 세지 않는다', () => {
    expect(validateRankingSelection(normalizeRankingSelection({}))).toMatch(/하나 이상/);
    expect(
      validateRankingSelection({
        [tossSourceId('amount', 'realtime', false)]: { enabled: true, count: 20 },
        [tossSourceId('volume', 'realtime', false)]: { enabled: true, count: 11 },
      }),
    ).toMatch(new RegExp(`${RANKING_TOTAL_MAX}`));
    expect(
      validateRankingSelection({
        [tossSourceId('amount', 'realtime', false)]: { enabled: true, count: 30 },
        [tossSourceId('volume', 'realtime', false)]: { enabled: false, count: 99 },
      }),
    ).toBeNull();
  });
});

describe('계획', () => {
  it('켜져 있고 개수>0인 원천만 카탈로그 순서로, 한투는 기간창을 싣는다', () => {
    const plan = planFromSelection({
      [kisSourceId('tradeGrowth')]: { enabled: true, count: 3, window: '1' },
      [tossSourceId('volume', 'realtime', true)]: { enabled: true, count: 3 },
      [tossSourceId('amount', '1d', false)]: { enabled: true, count: 0 }, // 0개 — 제외.
      [kisSourceId('tradeVolume')]: { enabled: false, count: 5 }, // 꺼짐 — 제외.
    });
    expect(plan.map((p) => [p.source.id, p.count, p.window])).toEqual([
      [tossSourceId('volume', 'realtime', true), 3, undefined],
      [kisSourceId('tradeGrowth'), 3, '1'],
    ]);
    expect(rankingPlanKey(plan)).toBe(`${tossSourceId('volume', 'realtime', true)}#3#|${kisSourceId('tradeGrowth')}#3#1`);
  });

  it('총합이 상한을 넘는 저장값이 들어와도 계획은 뒤 원천부터 잘라 30을 지킨다', () => {
    const plan = planFromSelection({
      [tossSourceId('amount', 'realtime', false)]: { enabled: true, count: 25 },
      [tossSourceId('volume', 'realtime', false)]: { enabled: true, count: 25 },
      [kisSourceId('tradeVolume')]: { enabled: true, count: 5 },
    });
    expect(plan.map((p) => p.count)).toEqual([25, 5]);
    expect(plan.reduce((a, p) => a + p.count, 0)).toBe(RANKING_TOTAL_MAX);
  });

  it('아무것도 안 켜면 빈 계획', () => {
    expect(planFromSelection({})).toEqual([]);
    expect(rankingPlanKey([])).toBe('');
  });
});
