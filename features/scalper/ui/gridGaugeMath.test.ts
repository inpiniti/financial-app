import { describe, expect, it } from 'vitest';
import { normalizeGridPosition } from './gridGaugeMath';

describe('normalizeGridPosition', () => {
  it('① 매수가=0, 매도가=1, 평단(중앙)=0.5로 정규화한다', () => {
    expect(normalizeGridPosition(90, 90, 110)).toBe(0);
    expect(normalizeGridPosition(110, 90, 110)).toBe(1);
    expect(normalizeGridPosition(100, 90, 110)).toBeCloseTo(0.5, 10);
  });

  it('② 구간 안의 값은 선형 보간된다', () => {
    expect(normalizeGridPosition(95, 90, 110)).toBeCloseTo(0.25, 10);
    expect(normalizeGridPosition(105, 90, 110)).toBeCloseTo(0.75, 10);
  });

  it('③ 범위 밖 값은 끝에 고정(clamp)된다', () => {
    expect(normalizeGridPosition(80, 90, 110)).toBe(0);
    expect(normalizeGridPosition(120, 90, 110)).toBe(1);
  });

  it('④ 비정상 입력(NaN·역전된 구간)은 중앙(0.5)으로 안전 폴백한다', () => {
    expect(normalizeGridPosition(Number.NaN, 90, 110)).toBe(0.5);
    expect(normalizeGridPosition(100, Number.NaN, 110)).toBe(0.5);
    expect(normalizeGridPosition(100, 110, 90)).toBe(0.5); // 매수가 > 매도가(역전)
    expect(normalizeGridPosition(100, 100, 100)).toBe(0.5); // 폭 0
  });
});
