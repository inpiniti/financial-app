import { describe, expect, it } from 'vitest';
import { snapToStep, DEFAULT_APP_SETTINGS } from './appSettings';

describe('DEFAULT_APP_SETTINGS', () => {
  it('기본 모드는 LIVE다 (PRD §9-6 확정)', () => {
    expect(DEFAULT_APP_SETTINGS.environment).toBe('live');
  });

  it('리스트 가격 상한 기본은 $200 — 수량 모드에서 진입금액 겸용 상한을 대체한다(2026-08-20 풀데이 시뮬)', () => {
    expect(DEFAULT_APP_SETTINGS.maxPriceUsd).toBe(200);
  });
});

describe('snapToStep — 슬라이더 격자 스냅', () => {
  it('① [사고 재현] 격자는 최솟값 기준이다 — min 7·step 2에서 7이 8로, 51이 52로 튀지 않는다', () => {
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

  it('④ 최솟값이 0인 소수 스텝 슬라이더는 부동소수 오차 없이 붙는다', () => {
    expect(snapToStep(0.0149, 0, 0.05, 0.005)).toBe(0.015);
    expect(snapToStep(0.0061, 0, 0.03, 0.003)).toBe(0.006);
    expect(snapToStep(1.55, 0, 3, 0.1)).toBe(1.6);
    expect(snapToStep(97, 0, 200, 10)).toBe(100);
  });

  it('⑤ 정수 스텝(미체결 취소 min 0·step 1)은 정수 그대로다', () => {
    expect(snapToStep(0, 0, 10, 1)).toBe(0);
    expect(snapToStep(4.4, 0, 10, 1)).toBe(4);
    expect(snapToStep(10, 0, 10, 1)).toBe(10);
  });
});
