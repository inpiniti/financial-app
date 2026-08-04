import { describe, expect, it } from 'vitest';
import { isOddBufferSize, DEFAULT_APP_SETTINGS } from './appSettings';

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
