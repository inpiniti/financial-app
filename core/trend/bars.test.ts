import { describe, expect, it } from 'vitest';

import { kstToMinuteKey, MinuteBarBuilder, minuteKeyOf } from './bars';

const M = 60_000;

describe('kstToMinuteKey', () => {
  it('KST 2026-08-18 23:30 → UTC 14:30의 분 키', () => {
    const expected = Math.floor(Date.UTC(2026, 7, 18, 14, 30, 0) / M);
    expect(kstToMinuteKey('20260818', '233000')).toBe(expected);
  });

  it('자정 넘김 — KST 08:05는 전날 UTC 23:05', () => {
    const expected = Math.floor(Date.UTC(2026, 7, 17, 23, 5, 0) / M);
    expect(kstToMinuteKey('20260818', '080500')).toBe(expected);
  });

  it('형식이 어긋나면 null', () => {
    expect(kstToMinuteKey('2026818', '233000')).toBeNull();
    expect(kstToMinuteKey('20260818', '2330')).toBeNull();
  });
});

describe('MinuteBarBuilder — 틱 → 봉', () => {
  it('같은 분의 틱은 마감 없이 종가만 갱신한다', () => {
    const b = new MinuteBarBuilder();
    expect(b.pushTick(10, 0)).toBeNull();
    expect(b.pushTick(11, 30_000)).toBeNull();
    expect(b.pushTick(12, 59_999)).toBeNull();
    expect(b.size).toBe(0);
    expect(b.inProgress).toEqual({ minuteKey: 0, close: 12 });
  });

  it('다음 분 첫 틱에 직전 봉이 닫히고 close=마지막 체결가', () => {
    const b = new MinuteBarBuilder();
    b.pushTick(10, 0);
    b.pushTick(12, 40_000);
    const closed = b.pushTick(13, M);
    expect(closed).toEqual({ minuteKey: 0, close: 12 });
    expect(b.closes).toEqual([12]);
    expect(b.inProgress).toEqual({ minuteKey: 1, close: 13 });
  });

  it('3분 공백이면 봉은 1개만 닫힌다(빈 분 없음)', () => {
    const b = new MinuteBarBuilder();
    b.pushTick(10, 0);
    const closed = b.pushTick(20, 4 * M);
    expect(closed).toEqual({ minuteKey: 0, close: 10 });
    expect(b.size).toBe(1);
    expect(b.pushTick(21, 5 * M)).toEqual({ minuteKey: 4, close: 20 });
    expect(b.closes).toEqual([10, 20]);
  });

  it('시계 역행(과거 키) 틱은 무시한다', () => {
    const b = new MinuteBarBuilder();
    b.pushTick(10, 5 * M);
    expect(b.pushTick(9, 3 * M)).toBeNull();
    expect(b.inProgress).toEqual({ minuteKey: 5, close: 10 });
  });

  it('비유한·0 이하 가격은 무시', () => {
    const b = new MinuteBarBuilder();
    expect(b.pushTick(Number.NaN, 0)).toBeNull();
    expect(b.pushTick(0, 0)).toBeNull();
    expect(b.inProgress).toBeNull();
  });

  it('링 상한을 넘으면 앞이 잘린다', () => {
    const b = new MinuteBarBuilder(3);
    for (let i = 0; i < 6; i += 1) b.pushTick(i + 1, i * M);
    // 0..4 닫힘(5개) → 마지막 3개만
    expect(b.closes).toEqual([3, 4, 5]);
  });
});

describe('MinuteBarBuilder — seed 정합', () => {
  it('seed 마지막 키 이하의 라이브 봉·진행 중 버킷은 폐기되고 그 뒤 것만 살아남는다', () => {
    const b = new MinuteBarBuilder();
    // 라이브: 키 8, 9 닫힘, 10 진행 중
    b.pushTick(80, 8 * M);
    b.pushTick(90, 9 * M);
    b.pushTick(100, 10 * M);
    // seed는 키 1..10 (10이 마지막)
    const seeded = b.seed(Array.from({ length: 10 }, (_, i) => ({ minuteKey: i + 1, close: (i + 1) * 10 })));
    expect(seeded).toBe(10);
    expect(b.closes).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(b.inProgress).toBeNull();
    // 다음 틱(키 11)은 새 진행 버킷 — 키 10 이하 옛 틱은 버린다.
    expect(b.pushTick(105, 10 * M + 30_000)).toBeNull();
    expect(b.inProgress).toBeNull();
    b.pushTick(110, 11 * M);
    expect(b.inProgress).toEqual({ minuteKey: 11, close: 110 });
  });

  it('seed 이전에 쌓인 라이브 봉 중 seed 마지막 키보다 큰 것만 생존한다', () => {
    const b = new MinuteBarBuilder();
    b.pushTick(1, 5 * M);
    b.pushTick(2, 6 * M);
    b.pushTick(3, 7 * M); // 5, 6 닫힘, 7 진행 중
    b.seed([
      { minuteKey: 3, close: 30 },
      { minuteKey: 5, close: 50 },
    ]);
    expect(b.closes).toEqual([30, 50, 2]);
    expect(b.inProgress).toEqual({ minuteKey: 7, close: 3 });
  });

  it('seed 안의 중복 키는 마지막 값, 순서는 오름차순으로 정렬된다', () => {
    const b = new MinuteBarBuilder();
    b.seed([
      { minuteKey: 3, close: 3 },
      { minuteKey: 1, close: 1 },
      { minuteKey: 3, close: 33 },
      { minuteKey: 2, close: 2 },
    ]);
    expect(b.closes).toEqual([1, 2, 33]);
  });

  it('빈 seed는 아무것도 바꾸지 않는다', () => {
    const b = new MinuteBarBuilder();
    b.pushTick(1, 0);
    b.pushTick(2, M);
    expect(b.seed([])).toBe(0);
    expect(b.closes).toEqual([1]);
    expect(b.inProgress).toEqual({ minuteKey: 1, close: 2 });
  });

  it('minuteKeyOf는 epoch ms를 분으로 내림', () => {
    expect(minuteKeyOf(119_999)).toBe(1);
    expect(minuteKeyOf(120_000)).toBe(2);
  });
});
