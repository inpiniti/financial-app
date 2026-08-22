import { describe, expect, it } from 'vitest';

import { evaluateTrend, evaluateTrendLive } from './signal';

/** 1..n 오름차순 — 4선 모두 매 봉 상승. */
const asc = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);
const flat = (n: number, v = 100): number[] => Array.from({ length: n }, () => v);

describe('evaluateTrend — 진입(BUY: 4선 상승 플립, 2026-08-21)', () => {
  it('직전 봉은 allUp이 아니고 이번 봉에 allUp이 되면 BUY', () => {
    const base = flat(121);
    const r = evaluateTrend([...base, 100.5]);
    expect(r.up).toEqual({ ma5: true, ma20: true, ma60: true, ma120: true });
    expect(r.prevAllUp).toBe(false);
    expect(r.signal).toBe('BUY');
  });

  it('allUp이 이어지는 동안에는 재발화하지 않는다(엣지) — 122봉 오름차순은 신호 없음', () => {
    const r = evaluateTrend(asc(122));
    expect(r.up).toEqual({ ma5: true, ma20: true, ma60: true, ma120: true });
    expect(r.prevAllUp).toBe(true);
    expect(r.signal).toBeNull();
  });

  it('121봉이면 prevAllUp=null이라 플립 판정 불가 → 신호 없음(fail-closed), 120봉이면 up.ma120도 null', () => {
    const r = evaluateTrend(asc(121));
    expect(r.prevAllUp).toBeNull();
    expect(r.signal).toBeNull();
    const r2 = evaluateTrend(asc(120));
    expect(r2.up.ma120).toBeNull();
    expect(r2.signal).toBeNull();
  });

  it('종가가 ma60 아래여도 플립이면 BUY — ma60 요건은 2026-08-21에 없앴다', () => {
    // 완만한 우상향 + ma60/ma120 창 **양쪽에 똑같이 들어가는** 옛 스파이크(idx 100)로 ma60만 종가 위로 띄운다.
    // 스파이크가 두 창에 다 들어가므로 기울기에는 영향이 없다. 직전 봉(idx 120)에 눌림을 넣어 플립을 만든다.
    const closes = Array.from({ length: 122 }, (_, i) => 100 + i * 0.01);
    closes[100] = 10_000;
    closes[120] = closes[119] - 0.5; // 이 봉에서 ma5가 안 올라 prevAllUp=false
    const r = evaluateTrend(closes);
    expect(r.prevAllUp).toBe(false);
    expect(r.up).toEqual({ ma5: true, ma20: true, ma60: true, ma120: true });
    expect(r.aboveMa60).toBe(false);
    expect(r.signal).toBe('BUY');
  });

  it('보합(같은 값)은 상승이 아니다 — 신호 없음이 아니라 SELL(allUp=false)', () => {
    const r = evaluateTrend(flat(130));
    expect(r.up).toEqual({ ma5: false, ma20: false, ma60: false, ma120: false });
    expect(r.signal).toBe('SELL');
  });
});

describe('evaluateTrend — 청산(SELL: 4선 중 하나라도 안 오름, 2026-08-21)', () => {
  it('ma5만 꺾여도 SELL — 나머지 3선이 상승 중이어도', () => {
    const closes = asc(122);
    closes[121] = 116;
    const r = evaluateTrend(closes);
    expect(r.up.ma5).toBe(false);
    expect(r.up.ma20).toBe(true);
    expect(r.signal).toBe('SELL');
  });

  it('종가가 ma5 아래여도 4선이 모두 상승이면 SELL 아님 — 옛 규칙(종가<ma5)과 갈리는 지점', () => {
    // 오름차순 122봉에서 마지막 종가를 ma5 아래로만 살짝 내린다(4선 기울기는 유지).
    // ma5 상승 조건은 close(121) > close(116)=117, 종가<ma5 조건은 close < 119.5 → 118.5가 둘 다 만족.
    const closes = asc(122);
    closes[121] = 118.5;
    const r = evaluateTrend(closes);
    expect(r.lines.ma5).not.toBeNull();
    expect(closes[121] < (r.lines.ma5 as number)).toBe(true);
    expect(r.up).toEqual({ ma5: true, ma20: true, ma60: true, ma120: true });
    expect(r.signal).toBeNull(); // 보유 중이면 계속 탄다
  });

  it('4선 판정 불가(봉 부족)면 SELL도 내지 않는다(fail-closed)', () => {
    const r = evaluateTrend([10, 10, 10, 10, 10, 9]);
    expect(r.lines.ma20).toBeNull();
    expect(r.signal).toBeNull();
  });

  it('봉 2개 미만이면 전부 null', () => {
    const r = evaluateTrend([5]);
    expect(r.signal).toBeNull();
    expect(r.up.ma5).toBeNull();
    expect(r.aboveMa60).toBeNull();
  });
});

describe('evaluateTrendLive — 진행 중(미완성) 봉 포함 재판정 (2026-08-22)', () => {
  it('닫힌 봉으로는 아직 상승인데 진행 중 봉이 꺾이면 SELL — 봉 마감을 기다리지 않는다', () => {
    const closed = asc(122); // 122봉 전부 상승 = allUp, 신호 없음
    expect(evaluateTrend(closed).signal).toBeNull();
    // 진행 중 봉이 급락하면 ma5가 꺾인다 → 그 자리에서 SELL.
    const live = evaluateTrendLive(closed, 1);
    expect(live.up.ma5).toBe(false);
    expect(live.signal).toBe('SELL');
    expect(live.bars).toBe(123); // 진행 중 봉을 포함해 잰 값이다
  });

  it('진행 중 봉이 BUY 조건이어도 BUY는 내지 않는다 — 진입은 봉 마감 확정에서만', () => {
    const closed = flat(122); // 보합 = allUp 아님
    const live = evaluateTrendLive(closed, 500); // 이 한 봉으로 4선이 다 상승 = 플립
    expect(evaluateTrend([...closed, 500]).signal).toBe('BUY'); // 마감 기준이면 BUY지만
    expect(live.signal).toBeNull(); // 진행 중 봉으로는 내지 않는다
    expect(live.up).toEqual({ ma5: true, ma20: true, ma60: true, ma120: true }); // 값 자체는 그대로 보여 준다
  });

  it('진행 중 종가가 비유한·0 이하면 판정하지 않는다(fail-closed)', () => {
    expect(evaluateTrendLive(asc(122), 0).signal).toBeNull();
    expect(evaluateTrendLive(asc(122), Number.NaN).up.ma5).toBeNull();
  });

  it('봉이 모자라 4선을 못 재면 SELL도 내지 않는다', () => {
    expect(evaluateTrendLive([10, 10, 10, 10, 10], 1).signal).toBeNull();
  });
});
