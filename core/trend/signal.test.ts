import { describe, expect, it } from 'vitest';

import { evaluateTrend } from './signal';

/** 1..n 오름차순 — 4선 모두 매 봉 상승, 종가는 항상 ma60 위. */
const asc = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);
const flat = (n: number, v = 100): number[] => Array.from({ length: n }, () => v);

describe('evaluateTrend — 진입(BUY)', () => {
  it('4선 2봉 연속 상승 + 종가 > ma60 → BUY (122봉이면 판정 가능)', () => {
    const r = evaluateTrend(asc(122));
    expect(r.signal).toBe('BUY');
    expect(r.up).toEqual({ ma5: true, ma20: true, ma60: true, ma120: true });
    expect(r.prevAllUp).toBe(true);
    expect(r.aboveMa60).toBe(true);
    expect(r.bars).toBe(122);
  });

  it('121봉이면 ma120의 2봉 전이 없어 prevAllUp=null → 신호 없음(fail-closed), 120봉이면 up.ma120도 null', () => {
    const r = evaluateTrend(asc(121));
    expect(r.signal).toBeNull();
    expect(r.up.ma120).toBe(true);
    expect(r.prevAllUp).toBeNull();
    const r2 = evaluateTrend(asc(120));
    expect(r2.up.ma120).toBeNull();
    expect(r2.signal).toBeNull();
  });

  it('상승 첫 봉(prevAllUp=false)에는 신호 없음, 2번째 연속 봉에서만 BUY', () => {
    const base = flat(121);
    const first = evaluateTrend([...base, 100.5]);
    expect(first.up).toEqual({ ma5: true, ma20: true, ma60: true, ma120: true });
    expect(first.prevAllUp).toBe(false);
    expect(first.signal).toBeNull();
    const second = evaluateTrend([...base, 100.5, 101]);
    expect(second.prevAllUp).toBe(true);
    expect(second.signal).toBe('BUY');
  });

  it('4선 모두 상승이어도 종가 ≤ ma60이면 신호 없음', () => {
    // 오름차순에 60봉 창 안쪽(양쪽 봉 모두 포함되는 위치)에 스파이크를 심어 ma60을 종가 위로 띄운다.
    const closes = asc(122);
    for (let i = 65; i <= 75; i += 1) closes[i] = 10_000;
    const r = evaluateTrend(closes);
    expect(r.up).toEqual({ ma5: true, ma20: true, ma60: true, ma120: true });
    expect(r.prevAllUp).toBe(true);
    expect(r.aboveMa60).toBe(false);
    expect(r.signal).toBeNull();
  });

  it('보합(같은 값)은 상승이 아니다 — 신호 없음', () => {
    const r = evaluateTrend(flat(130));
    expect(r.up).toEqual({ ma5: false, ma20: false, ma60: false, ma120: false });
    expect(r.signal).toBeNull();
  });
});

describe('evaluateTrend — 청산(SELL: 종가 < ma5, 2026-08-19)', () => {
  it('종가가 ma5 아래로 내려오면 SELL — ma5 기울기가 아직 상승이어도(옛 규칙보다 1~2봉 빠름)', () => {
    // 5봉 평균이 아직 오르는 중인데 마지막 종가가 평균 아래: [10,11,12,13,14] → ma5=12, 다음 봉 11.9 → ma5(t)=12.38>12(상승) but close<ma5
    const r = evaluateTrend([1, 2, 3, 10, 11, 12, 13, 14, 11.9]);
    expect(r.up.ma5).toBe(true);
    expect(r.signal).toBe('SELL');
  });

  it('종가가 ma5 위면 ma5가 꺾여도 SELL 아님(위치 규칙)', () => {
    // 급등봉 하나가 창에서 빠져 ma5는 내려가지만 종가는 여전히 평균 위.
    const r = evaluateTrend([50, 10, 10, 10, 10, 10.5]);
    expect(r.up.ma5).toBe(false);
    expect(r.signal).toBeNull();
  });

  it('ma5 하락 + 종가<ma5면 SELL — 다른 3선이 상승 중이어도', () => {
    // 오름차순 뒤 마지막 봉만 살짝 하락(122→116): ma5는 꺾이고 ma20/60/120은 여전히 상승.
    const closes = asc(122);
    closes[121] = 116;
    const r = evaluateTrend(closes);
    expect(r.up.ma5).toBe(false);
    expect(r.up.ma20).toBe(true);
    expect(r.signal).toBe('SELL');
  });

  it('봉이 6개만 있어도 ma5 판정은 가능(다른 선 null) — 하락이면 SELL', () => {
    const r = evaluateTrend([10, 10, 10, 10, 10, 9]);
    expect(r.lines.ma20).toBeNull();
    expect(r.signal).toBe('SELL');
  });

  it('종가 = ma5(보합)이면 SELL 아님', () => {
    const r = evaluateTrend([10, 10, 10, 10, 10, 10]);
    expect(r.signal).toBeNull();
  });

  it('봉 2개 미만이면 전부 null', () => {
    const r = evaluateTrend([5]);
    expect(r.signal).toBeNull();
    expect(r.up.ma5).toBeNull();
    expect(r.aboveMa60).toBeNull();
  });
});
