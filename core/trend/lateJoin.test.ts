import { describe, expect, it } from 'vitest';

import { allUpAge, lateJoinEligible, TREND_LATE_JOIN_MAX_AGE } from './lateJoin';

/** 오름차순 — 매 봉 4선 상승. */
const asc = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);
const flat = (n: number, v = 100): number[] => Array.from({ length: n }, () => v);

describe('allUpAge — 4선 상승이 몇 봉째인가', () => {
  it('마지막 봉에서 막 플립했으면 1', () => {
    const closes = [...flat(121), 100.5];
    expect(allUpAge(closes)).toBe(1);
  });

  it('플립 뒤 한 봉 더 오르면 2, 두 봉 더면 3', () => {
    const base = flat(121);
    expect(allUpAge([...base, 100.5, 101])).toBe(2);
    expect(allUpAge([...base, 100.5, 101, 101.5])).toBe(3);
  });

  it('마지막 봉이 상승이 아니면 0', () => {
    const closes = asc(122);
    closes[121] = 116; // ma5 꺾임
    expect(allUpAge(closes)).toBe(0);
  });

  it('봉이 모자라 판정 불가면 null', () => {
    expect(allUpAge(asc(120))).toBeNull();
    expect(allUpAge([5])).toBeNull();
  });

  it('쭉 오르기만 한 오름차순은 나이가 크다', () => {
    expect(allUpAge(asc(140))).toBeGreaterThan(TREND_LATE_JOIN_MAX_AGE);
  });
});

describe('lateJoinEligible — 리스트 진입 시 1회 매수 자격', () => {
  it('플립 직후(1봉)·2봉까지는 자격 있음', () => {
    const base = flat(121);
    expect(lateJoinEligible([...base, 100.5])).toBe(true);
    expect(lateJoinEligible([...base, 100.5, 101])).toBe(true);
  });

  it('3봉째부터는 자격 없음 — 한참 달린 뒤 올라타면 머리 매수(2026-08-21 실측 −3.05%p)', () => {
    const base = flat(121);
    expect(lateJoinEligible([...base, 100.5, 101, 101.5])).toBe(false);
    expect(lateJoinEligible(asc(140))).toBe(false);
  });

  it('상승 중이 아니면 자격 없음', () => {
    const closes = asc(122);
    closes[121] = 116;
    expect(lateJoinEligible(closes)).toBe(false);
    expect(lateJoinEligible(flat(130))).toBe(false);
  });

  it('봉이 모자라면 자격 없음 — fail-closed', () => {
    expect(lateJoinEligible(asc(120))).toBe(false);
    expect(lateJoinEligible([10, 11, 12])).toBe(false);
  });
});
