import { describe, expect, it } from 'vitest';

import {
  bollingerBandWidthPct,
  entryChaseExceeded,
  TREND_ENTRY_CHASE_MAX_PCT,
  TREND_MIN_BAND_WIDTH_PCT,
} from './entryGate';

describe('entryChaseExceeded — 추격 진입 게이트', () => {
  it('ask1이 신호가 +1%를 넘으면 진입 금지', () => {
    expect(entryChaseExceeded(3.5, 3.5 * 1.02)).toBe(true); // ZNB 08-19: +2.02% 추격 → −7.1% 손절
    expect(entryChaseExceeded(9.96, 10.39)).toBe(true); // +4.3%
  });

  it('경계(정확히 +1%)와 그 아래는 허용', () => {
    expect(entryChaseExceeded(100, 101)).toBe(false); // 정확히 +1% — 허용
    expect(entryChaseExceeded(100, 100.5)).toBe(false);
    expect(entryChaseExceeded(100, 100)).toBe(false);
    expect(entryChaseExceeded(100, 99)).toBe(false); // 신호가 아래 — 당연히 허용
  });

  it('maxPct를 넘겨 상한을 바꿀 수 있다', () => {
    expect(entryChaseExceeded(100, 101.5, 0.02)).toBe(false);
    expect(entryChaseExceeded(100, 102.1, 0.02)).toBe(true);
    expect(TREND_ENTRY_CHASE_MAX_PCT).toBe(0.01);
  });

  it('밴드폭 — 수평(챱)은 0%, 변동이 있으면 커진다', () => {
    expect(bollingerBandWidthPct(Array(20).fill(100))).toBe(0); // 완전 수평 = 챱
    // 100↔102 교대 — σ=1, 밴드폭 = 4/101×100 ≈ 3.96%
    const wave = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 100 : 102));
    expect(bollingerBandWidthPct(wave)).toBeCloseTo(396.03 / 100, 1);
    expect(TREND_MIN_BAND_WIDTH_PCT).toBe(1.5);
  });

  it('밴드폭 — 봉 부족·비유한값·0 이하 평균은 null(판정 불가)', () => {
    expect(bollingerBandWidthPct(Array(19).fill(100))).toBeNull();
    expect(bollingerBandWidthPct([...Array(19).fill(100), Number.NaN])).toBeNull();
    expect(bollingerBandWidthPct(Array(20).fill(0))).toBeNull();
    expect(bollingerBandWidthPct(Array(20).fill(100), 1)).toBeNull(); // period<2
  });

  it('밴드폭 — 마지막 period봉만 본다(앞쪽 이력 무관)', () => {
    const closes = [...Array(50).fill(5), ...Array(20).fill(100)];
    expect(bollingerBandWidthPct(closes)).toBe(0);
  });

  it('판정 불가(비유한값·0 이하)는 false — 게이트 미적용', () => {
    expect(entryChaseExceeded(0, 101)).toBe(false);
    expect(entryChaseExceeded(-1, 101)).toBe(false);
    expect(entryChaseExceeded(Number.NaN, 101)).toBe(false);
    expect(entryChaseExceeded(100, 0)).toBe(false);
    expect(entryChaseExceeded(100, Number.NaN)).toBe(false);
    expect(entryChaseExceeded(100, Number.POSITIVE_INFINITY)).toBe(false);
    expect(entryChaseExceeded(100, 200, Number.NaN)).toBe(false);
    expect(entryChaseExceeded(100, 200, -0.01)).toBe(false);
  });
});
