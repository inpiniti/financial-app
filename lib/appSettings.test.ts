import { describe, expect, it } from 'vitest';
import { isOddBufferSize, snapToStep, DEFAULT_APP_SETTINGS } from './appSettings';

describe('isOddBufferSize', () => {
  it('홀수면 true다 (SG 윈도 요건)', () => {
    expect(isOddBufferSize(31)).toBe(true);
    expect(isOddBufferSize(51)).toBe(true);
  });

  it('짝수면 false다', () => {
    expect(isOddBufferSize(30)).toBe(false);
    expect(isOddBufferSize(0)).toBe(false);
  });
});

describe('DEFAULT_APP_SETTINGS', () => {
  it('기본 모드는 LIVE다 (PRD §9-6 확정)', () => {
    expect(DEFAULT_APP_SETTINGS.environment).toBe('live');
  });
});

describe('snapToStep — 슬라이더 격자 스냅', () => {
  it('① [사고 재현] 버퍼(min 7·step 2)는 항상 홀수다 — 7이 8로, 51이 52로 튀지 않는다', () => {
    expect(snapToStep(7, 7, 51, 2)).toBe(7);
    expect(snapToStep(51, 7, 51, 2)).toBe(51);
    // 격자 전체가 홀수여야 한다.
    for (let v = 7; v <= 51; v += 0.25) {
      const snapped = snapToStep(v, 7, 51, 2);
      expect(Math.abs(snapped % 2)).toBe(1);
    }
  });

  it('② 가장 가까운 격자점으로 붙는다', () => {
    expect(snapToStep(14.4, 7, 51, 2)).toBe(15);
    expect(snapToStep(15.6, 7, 51, 2)).toBe(15);
    expect(snapToStep(16.2, 7, 51, 2)).toBe(17);
  });

  it('③ 범위를 벗어난 값은 최소·최대로 가둔다', () => {
    expect(snapToStep(-100, 7, 51, 2)).toBe(7);
    expect(snapToStep(9999, 7, 51, 2)).toBe(51);
    expect(snapToStep(Number.NaN, 7, 51, 2)).toBe(7);
  });

  it('④ 최솟값이 0인 문턱 슬라이더는 부동소수 오차 없이 붙는다', () => {
    expect(snapToStep(0.0149, 0, 0.05, 0.005)).toBe(0.015);
    expect(snapToStep(0.0061, 0, 0.03, 0.003)).toBe(0.006);
    expect(snapToStep(1.55, 0, 3, 0.1)).toBe(1.6);
    expect(snapToStep(97, 0, 200, 10)).toBe(100);
  });

  it('⑤ 청크(min 1·step 1)는 정수 그대로다', () => {
    expect(snapToStep(1, 1, 10, 1)).toBe(1);
    expect(snapToStep(4.4, 1, 10, 1)).toBe(4);
    expect(snapToStep(10, 1, 10, 1)).toBe(10);
  });
});
