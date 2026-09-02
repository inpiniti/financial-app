import { describe, expect, it } from 'vitest';
import { gaugeScaleOf, normalizeGridPosition } from './gridGaugeMath';

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

describe('gaugeScaleOf — 게이지 축 범위(2026-09-02)', () => {
  it('모든 마커를 감싸는 최소~최대 + 3% 패딩', () => {
    const s = gaugeScaleOf([100, 97, 103, 95, 108], 97, 103);
    expect(s.lo).toBeCloseTo(95 - 13 * 0.03, 10);
    expect(s.hi).toBeCloseTo(108 + 13 * 0.03, 10);
  });

  it('null·undefined·0 이하·NaN은 무시한다', () => {
    const s = gaugeScaleOf([null, undefined, -1, Number.NaN, 100, 104], 0, 0);
    expect(s.lo).toBeLessThan(100);
    expect(s.hi).toBeGreaterThan(104);
  });

  it('유효값이 없으면 폴백(밴드 양끝)을 쓴다', () => {
    const s = gaugeScaleOf([null, undefined], 97, 103);
    expect(s.lo).toBeLessThan(97);
    expect(s.hi).toBeGreaterThan(103);
  });

  it('폭이 0으로 접히면 ±0.5%를 벌린다(눈금 겹침 방지)', () => {
    const s = gaugeScaleOf([100, 100], 100, 100);
    expect(s.hi).toBeGreaterThan(s.lo);
    expect(s.lo).toBeLessThan(100);
    expect(s.hi).toBeGreaterThan(100);
  });
});
