import { describe, expect, it } from 'vitest';

import { computeKelly } from './index';

// 이익 4건(+6%) + 손실 6건(−1.5%) — 승률 40%, 손익비 4 → 이산형 0.25 (문서 §2-1 예).
const SAMPLE = [0.06, 0.06, 0.06, 0.06, -0.015, -0.015, -0.015, -0.015, -0.015, -0.015];

describe('computeKelly', () => {
  it('빈 배열 — 전부 null, 표본 부족 플래그', () => {
    const r = computeKelly([]);
    expect(r.n).toBe(0);
    expect(r.raw).toBeNull();
    expect(r.flags).toEqual({ insufficientSamples: true, negativeEdge: false });
  });

  it('이산형 — 승률 40%·평균이익 6%·평균손실 1.5% → f_disc 0.25', () => {
    const r = computeKelly(SAMPLE, { minSamples: 5 });
    expect(r.winRate).toBeCloseTo(0.4);
    expect(r.avgWin).toBeCloseTo(0.06);
    expect(r.avgLoss).toBeCloseTo(0.015);
    expect(r.payoff).toBeCloseTo(4);
    expect(r.discrete).toBeCloseTo(0.25);
    expect(r.flags.insufficientSamples).toBe(false);
  });

  it('raw는 이산·연속 중 작은 쪽, half는 그 절반', () => {
    const r = computeKelly(SAMPLE);
    expect(r.continuous).not.toBeNull();
    expect(r.raw).toBe(Math.min(r.discrete!, r.continuous!));
    expect(r.half).toBeCloseTo(r.raw! * 0.5);
  });

  it('음수 엣지 — 승률 30%·손익비 2 → f_disc −0.05, negativeEdge=true, 값은 그대로 계산', () => {
    const xs = [0.02, 0.02, 0.02, -0.01, -0.01, -0.01, -0.01, -0.01, -0.01, -0.01];
    const r = computeKelly(xs);
    expect(r.discrete).toBeCloseTo(-0.05);
    expect(r.raw).not.toBeNull();
    expect(r.flags.negativeEdge).toBe(true);
  });

  it('전부 이익 — 손실 없음 → payoff·discrete null, 연속형만', () => {
    const r = computeKelly([0.01, 0.02, 0.03]);
    expect(r.avgLoss).toBeNull();
    expect(r.discrete).toBeNull();
    expect(r.continuous).not.toBeNull();
    expect(r.raw).toBe(r.continuous);
  });

  it('전부 같은 값 — 분산 0 → 연속형 null, 손실도 없어 raw null', () => {
    const r = computeKelly([0.01, 0.01, 0.01]);
    expect(r.variance).toBe(0);
    expect(r.continuous).toBeNull();
    expect(r.raw).toBeNull();
    expect(r.flags.negativeEdge).toBe(false);
  });

  it('비유한값은 버리고 n에도 세지 않는다', () => {
    const r = computeKelly([0.01, Number.NaN, -0.01, Number.POSITIVE_INFINITY]);
    expect(r.n).toBe(2);
    expect(r.winRate).toBeCloseTo(0.5);
  });

  it('표본 문턱은 플래그만 — 기본 30 미만이면 true, 계산은 됨', () => {
    const alt = (len: number) => Array.from({ length: len }, (_, i) => (i % 2 === 0 ? 0.02 : -0.01));
    const r = computeKelly(alt(29));
    expect(r.flags.insufficientSamples).toBe(true);
    expect(r.raw).not.toBeNull();
    expect(computeKelly(alt(30)).flags.insufficientSamples).toBe(false);
  });
});
