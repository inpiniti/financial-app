import { describe, expect, it } from 'vitest';
import { RealtimeMa5Calculator, averagingDownQty, shouldEnter } from './index';

describe('RealtimeMa5Calculator', () => {
  it('상향 돌파는 현재 MA5 기준(이전틱 < 현재 MA5 < 현재틱)으로 계산한다', () => {
    const calc = new RealtimeMa5Calculator();

    const first = calc.evaluate([100, 100, 100, 100], 90);
    expect(first.ma5).toBeCloseTo(98);

    const second = calc.evaluate([100, 100, 100, 100, 95], 101);

    expect(second.ma5).toBeCloseTo(99.2);
    expect(second.breakout).toBe(true);
    expect(second.slope).toBe('up');
    expect(shouldEnter(second)).toBe(true);
  });

  it('현재틱이 현재 MA5 아래면 돌파가 아니다(과거 MA5를 넘었어도 false)', () => {
    const calc = new RealtimeMa5Calculator();

    calc.evaluate([100, 100, 100, 100], 80);
    const state = calc.evaluate([100, 100, 100, 100, 100], 97);

    expect(state.ma5).toBeCloseTo(99.4);
    expect(state.breakout).toBe(false);
    expect(shouldEnter(state)).toBe(false);
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

describe('averagingDownQty', () => {
  it('희망수량이 가능최대수량보다 크면 가용자본 기준으로 캡핑한다', () => {
    // gapRate = -5% → 희망수량 = (5 - 1) * 10 = 40주
    // 가능최대수량 = floor(2000 / 95) = 21주
    expect(averagingDownQty(95, 100, 10, 2000)).toBe(21);
  });

  it('가용자본이 충분하면 희망수량 그대로 산다', () => {
    expect(averagingDownQty(95, 100, 10, 10_000)).toBe(40);
  });
});
