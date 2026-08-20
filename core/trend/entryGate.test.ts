import { describe, expect, it } from 'vitest';

import { entryChaseExceeded, TREND_ENTRY_CHASE_MAX_PCT } from './entryGate';

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
