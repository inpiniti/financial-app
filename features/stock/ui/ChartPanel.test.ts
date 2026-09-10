import { describe, expect, it } from 'vitest';
import { applyLivePriceOverlay } from './chartView';

describe('applyLivePriceOverlay', () => {
  it('과거 드래그 뷰에서는 현재 시점 실시간 봉을 붙이지 않는다', () => {
    const candles = [
      { key: '1', label: '09:00', open: 100, high: 100, low: 99, close: 99, volume: 1 },
      { key: '2', label: '09:01', open: 99, high: 101, low: 98, close: 101, volume: 2 },
      { key: '3', label: '09:02', open: 101, high: 102, low: 100, close: 100, volume: 3 },
    ];

    const next = applyLivePriceOverlay({
      candles,
      livePrice: 115,
      liveTickAt: Date.now(),
      minuteInterval: 1,
      mode: 'minute',
      isHistoricalView: true,
    });

    expect(next).toEqual(candles);
    expect(next?.[next.length - 1].close).toBe(100);
  });

  it('최신 뷰에서는 마지막 봉을 현재가로 갱신한다', () => {
    const candles = [
      { key: '1', label: '09:00', open: 100, high: 100, low: 99, close: 99, volume: 1 },
      { key: '2', label: '09:01', open: 99, high: 101, low: 98, close: 101, volume: 2 },
    ];

    const next = applyLivePriceOverlay({
      candles,
      livePrice: 115,
      liveTickAt: Date.now(),
      minuteInterval: 1,
      mode: 'minute',
      isHistoricalView: false,
    });

    expect(next).not.toBeNull();
    expect(next?.[next!.length - 1].close).toBe(115);
  });
});
