import { describe, expect, it } from 'vitest';
import { avatarColorFor, avatarInitial, formatSignedPercent, formatSignedUsd, formatUsd, pnlColor } from './format';

describe('formatSignedUsd', () => {
  it('KIS 문자열(-232.08)을 "-$232.08"로 청킹한다', () => {
    expect(formatSignedUsd('-232.08')).toBe('-$232.08');
  });

  it('천단위 콤마를 붙인다', () => {
    expect(formatSignedUsd(1234.5)).toBe('+$1,234.50');
  });

  it('파싱 실패 시 원본을 그대로 돌려준다', () => {
    expect(formatSignedUsd('n/a')).toBe('n/a');
  });
});

describe('formatUsd', () => {
  it('부호 없이 $와 소수 2자리를 붙인다', () => {
    expect(formatUsd('74.3')).toBe('$74.30');
  });
});

describe('formatSignedPercent', () => {
  it('소수 8자리(KIS 원본)를 소수 1자리로 줄인다', () => {
    expect(formatSignedPercent('-14.36000000')).toBe('-14.4%');
  });

  it('양수는 +를 붙인다', () => {
    expect(formatSignedPercent(3.2)).toBe('+3.2%');
  });
});

describe('pnlColor', () => {
  it('이익(양수)은 빨강이다', () => {
    expect(pnlColor('12.3')).toBe('#f04452');
  });

  it('손실(음수)은 파랑이다', () => {
    expect(pnlColor('-12.3')).toBe('#3182f6');
  });
});

describe('avatar helpers', () => {
  it('같은 티커는 항상 같은 색을 돌려준다(결정적)', () => {
    expect(avatarColorFor('AAPL')).toEqual(avatarColorFor('AAPL'));
  });

  it('이니셜은 첫 글자 대문자다', () => {
    expect(avatarInitial('aapl')).toBe('A');
  });
});
