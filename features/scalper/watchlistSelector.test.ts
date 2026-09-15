import { describe, expect, it } from 'vitest';
import { selectWatchedTickers } from './watchlistSelector';

describe('watchlistSelector', () => {
  function makeSlot(ticker: string, rate: number) {
    return { ticker, tickRate: () => rate };
  }

  it('자격 미달 종목을 제외하고 상위 N개를 선별한다', () => {
    const slots = [
      makeSlot('AAPL', 5.0),
      makeSlot('TSLA', 3.0),
      makeSlot('MSFT', 0.5), // minTickRate 미달
      makeSlot('NVDA', 4.0),
    ];

    const { next, changed } = selectWatchedTickers({
      slots,
      currentlyWatched: [],
      minTickRate: 1.0,
      watchCount: 2,
      hysteresisRatio: 1.2,
      isExcluded: () => false,
      nowMs: 1000,
    });

    expect(changed).toBe(true);
    expect(next).toEqual(['AAPL', 'NVDA']); // 5.0, 4.0 상위 2개
  });

  it('히스테리시스 배율을 넘지 못하는 도전자로는 교체하지 않는다', () => {
    const slots = [
      makeSlot('AAPL', 5.0),
      makeSlot('TSLA', 4.0), // 현재 감시 중
      makeSlot('NVDA', 4.5), // 4.5 <= 4.0 * 1.2(4.8) -> 교체 안 됨
    ];

    const { next, changed } = selectWatchedTickers({
      slots,
      currentlyWatched: ['AAPL', 'TSLA'],
      minTickRate: 1.0,
      watchCount: 2,
      hysteresisRatio: 1.2,
      isExcluded: () => false,
      nowMs: 1000,
    });

    expect(changed).toBe(false);
    expect(next).toEqual(['AAPL', 'TSLA']);
  });

  it('히스테리시스 배율(1.2배)을 초과하는 도전자가 오면 교체한다', () => {
    const slots = [
      makeSlot('AAPL', 5.0),
      makeSlot('TSLA', 3.0), // 현재 감시 중
      makeSlot('NVDA', 4.0), // 4.0 > 3.0 * 1.2(3.6) -> 교체 성공!
    ];

    const { next, changed } = selectWatchedTickers({
      slots,
      currentlyWatched: ['AAPL', 'TSLA'],
      minTickRate: 1.0,
      watchCount: 2,
      hysteresisRatio: 1.2,
      isExcluded: () => false,
      nowMs: 1000,
    });

    expect(changed).toBe(true);
    expect(next).toEqual(['AAPL', 'NVDA']);
  });

  it('제외 대상(보유/진입 중)인 종목은 자격이 충분해도 제외한다', () => {
    const slots = [
      makeSlot('AAPL', 10.0),
      makeSlot('TSLA', 5.0),
      makeSlot('NVDA', 4.0),
    ];

    const { next } = selectWatchedTickers({
      slots,
      currentlyWatched: [],
      minTickRate: 1.0,
      watchCount: 2,
      hysteresisRatio: 1.2,
      isExcluded: (t) => t === 'AAPL',
      nowMs: 1000,
    });

    expect(next).toEqual(['TSLA', 'NVDA']);
  });
});
