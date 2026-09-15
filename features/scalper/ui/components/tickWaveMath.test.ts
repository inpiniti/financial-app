import { describe, expect, it } from 'vitest';
import {
  calculateWaveTranslateRange,
  DEFAULT_THROTTLE_MS,
  getNextPoolIndex,
  getWaveColors,
  shouldThrottleTick,
  WAVE_COLORS,
  WAVE_POOL_SIZE,
} from './tickWaveMath';

describe('tickWaveMath — 틱 웨이브 애니메이션 수학 및 헬퍼', () => {
  describe('getWaveColors', () => {
    it('상승 틱(up)은 붉은색 계열을 반환한다', () => {
      const colors = getWaveColors('up');
      expect(colors.hex).toBe('#f04452');
      expect(colors.primary).toBe(WAVE_COLORS.up.primary);
    });

    it('하락 틱(down)은 푸른색 계열을 반환한다', () => {
      const colors = getWaveColors('down');
      expect(colors.hex).toBe('#3182f6');
      expect(colors.primary).toBe(WAVE_COLORS.down.primary);
    });

    it('보합 틱(same)은 회색/중립 계열을 반환한다', () => {
      const colors = getWaveColors('same');
      expect(colors.hex).toBe('#8b95a1');
      expect(colors.primary).toBe(WAVE_COLORS.same.primary);
    });
  });

  describe('getNextPoolIndex', () => {
    it('라운드로빈 방식으로 0, 1, 2 순환한다', () => {
      expect(getNextPoolIndex(0, 3)).toBe(1);
      expect(getNextPoolIndex(1, 3)).toBe(2);
      expect(getNextPoolIndex(2, 3)).toBe(0);
    });

    it('기본 풀 크기(WAVE_POOL_SIZE=3)로 정상 순환한다', () => {
      let idx = 0;
      const sequence: number[] = [idx];
      for (let i = 0; i < 5; i++) {
        idx = getNextPoolIndex(idx);
        sequence.push(idx);
      }
      expect(sequence).toEqual([0, 1, 2, 0, 1, 2]);
    });

    it('poolSize가 0 이하일 때 안전하게 0을 반환한다', () => {
      expect(getNextPoolIndex(1, 0)).toBe(0);
    });
  });

  describe('shouldThrottleTick', () => {
    it('첫 틱(lastTriggerTs <= 0)은 스로틀하지 않는다', () => {
      expect(shouldThrottleTick(1000, 0)).toBe(false);
      expect(shouldThrottleTick(1000, -1)).toBe(false);
    });

    it('80ms 이내의 연타는 스로틀(true)한다', () => {
      expect(shouldThrottleTick(1050, 1000, 80)).toBe(true); // 50ms 경과
      expect(shouldThrottleTick(1079, 1000, 80)).toBe(true); // 79ms 경과
    });

    it('80ms 이상의 간격은 통과(false)시킨다', () => {
      expect(shouldThrottleTick(1080, 1000, 80)).toBe(false); // 80ms 경과
      expect(shouldThrottleTick(1200, 1000, 80)).toBe(false); // 200ms 경과
    });

    it('기본값 DEFAULT_THROTTLE_MS가 80ms로 적용된다', () => {
      expect(DEFAULT_THROTTLE_MS).toBe(80);
      expect(shouldThrottleTick(1040, 1000)).toBe(true);
      expect(shouldThrottleTick(1100, 1000)).toBe(false);
    });
  });

  describe('calculateWaveTranslateRange', () => {
    it('웨이브 시작 좌표는 -waveWidth, 끝 좌표는 rowWidth + waveWidth*0.5이다', () => {
      const { fromX, toX } = calculateWaveTranslateRange(360, 140);
      expect(fromX).toBe(-140);
      expect(toX).toBe(360 + 70);
    });

    it('rowWidth가 0 이하인 경우 안전하게 방어한다', () => {
      const { fromX, toX } = calculateWaveTranslateRange(0, 100);
      expect(fromX).toBe(-100);
      expect(toX).toBe(50);
    });
  });
});
