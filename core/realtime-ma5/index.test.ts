import { describe, expect, it } from 'vitest';
import { RealtimeMa5Calculator, shouldEnter } from './index';

describe('RealtimeMa5Calculator', () => {
  it('상향 돌파는 이전 MA5를 기준으로 계산한다 — 현재가가 과거 MA5를 넘어섰으면 true다', () => {
    const calc = new RealtimeMa5Calculator();

    const first = calc.evaluate([100, 100, 100, 100], 90);
    expect(first.ma5).toBeCloseTo(98);

    const second = calc.evaluate([100, 100, 100, 100, 95], 101);

    expect(second.ma5).toBeCloseTo(99.2);
    expect(second.breakout).toBe(true);
    expect(second.slope).toBe('up');
    expect(shouldEnter(second)).toBe(true);
  });

  it('기울기 하락이면 진입 조건은 거짓이다', () => {
    const calc = new RealtimeMa5Calculator();
    calc.evaluate([100, 100, 100, 100], 90);
    const state = calc.evaluate([100, 100, 100, 100, 110], 90);

    expect(state.slope).toBe('down');
    expect(state.breakout).toBe(false);
    expect(shouldEnter(state)).toBe(false);
  });
});
