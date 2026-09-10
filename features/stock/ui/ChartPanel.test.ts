import { describe, expect, it } from 'vitest';
import { applyLivePriceOverlay, buildTradeMarkers } from './chartView';

describe('buildTradeMarkers', () => {
  it('오늘의 매수·매도 체결을 가장 가까운 캔들 위치에 B/S 마커로 만든다', () => {
    const candles = [
      { key: '1', label: '09:00', open: 100, high: 101, low: 99, close: 100, volume: 1, ts: new Date('2026-09-10T09:00:00Z').getTime() },
      { key: '2', label: '09:01', open: 100, high: 105, low: 98, close: 103, volume: 2, ts: new Date('2026-09-10T09:01:00Z').getTime() },
      { key: '3', label: '09:02', open: 103, high: 108, low: 102, close: 107, volume: 3, ts: new Date('2026-09-10T09:02:00Z').getTime() },
    ];

    const markers = buildTradeMarkers(candles, [
      { ticker: 'AAPL', qty: 2, entryPrice: 101, entryTs: new Date('2026-09-10T09:00:30Z').getTime(), exitPrice: 107, exitTs: new Date('2026-09-10T09:02:05Z').getTime(), pnl: 12, entrySnapshot: { price: 101, slope: 0, accel: 0, ts: new Date('2026-09-10T09:00:30Z').getTime() }, exitSnapshot: { price: 107, slope: 0, accel: 0, ts: new Date('2026-09-10T09:02:05Z').getTime() }, exitReason: 'SELL_SIGNAL' },
    ]);

    expect(markers).toHaveLength(2);
    expect(markers.map((m) => m.side)).toEqual(['buy', 'sell']);
    expect(markers.map((m) => m.price)).toEqual([101, 107]);
  });
});

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
