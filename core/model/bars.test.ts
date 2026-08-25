// 모델 봉 저장소 — 덧붙이기·중복 갱신·거래일 전환·표본 창 밖 배제.

import { describe, expect, it } from 'vitest';
import { ModelDayBars, type OhlcvBar } from './bars';

const at = (iso: string): number => Math.floor(Date.parse(iso) / 60_000);

const bar = (iso: string, close: number, volume = 100): OhlcvBar => ({
  minuteKey: at(iso),
  open: close,
  high: close,
  low: close,
  close,
  volume,
});

describe('ModelDayBars', () => {
  it('오름차순으로 쌓이고 dayOpen·누적 거래대금이 그날 첫 봉부터 잡힌다', () => {
    const d = new ModelDayBars(5);
    d.merge([bar('2026-08-18T09:35:00-04:00', 11), bar('2026-08-18T09:30:00-04:00', 10)]);
    expect(d.bars.map((b) => b.close)).toEqual([10, 11]);
    expect(d.dayOpen).toBe(10);
    expect(d.cumDollarVolume).toBeCloseTo(10 * 100 + 11 * 100, 6);
  });

  it('같은 키가 다시 오면 새 값으로 갈아끼운다 — 마감 직후 미완성 봉이 확정값으로 덮인다', () => {
    const d = new ModelDayBars(5);
    d.merge([bar('2026-08-18T09:30:00-04:00', 10, 50)]);
    d.merge([bar('2026-08-18T09:30:00-04:00', 12, 80)]);
    expect(d.size).toBe(1);
    expect(d.bars[0].close).toBe(12);
    expect(d.cumDollarVolume).toBeCloseTo(12 * 80, 6);
  });

  it('봉 키는 봉 주기 버킷으로 정규화된다 — 1분 키로 와도 5분 버킷에 붙는다', () => {
    const d = new ModelDayBars(5);
    d.merge([bar('2026-08-18T09:32:00-04:00', 10)]);
    expect(d.bars[0].minuteKey).toBe(at('2026-08-18T09:30:00-04:00'));
  });

  it('주간거래(오버나이트) 봉도 담는다 — 새벽 04:00 ET 전까지는 같은 거래일이다(2026-08-25)', () => {
    const d = new ModelDayBars(5);
    d.merge([
      bar('2026-08-18T09:30:00-04:00', 11),
      bar('2026-08-18T21:00:00-04:00', 10), // 주간거래 — 이제 담는다(표시용 참고 판정).
      bar('2026-08-19T03:55:00-04:00', 9), // 새벽 03:55 — 아직 18일 거래일.
    ]);
    expect(d.bars.map((b) => b.close)).toEqual([11, 10, 9]);
    d.merge([bar('2026-08-19T04:00:00-04:00', 20)]); // 04:00 — 새 거래일, 통째로 비운다.
    expect(d.bars.map((b) => b.close)).toEqual([20]);
    expect(d.dayOpen).toBe(20);
  });

  it('거래일이 바뀌면 통째로 비운다 — 전일 봉이 지표 창에 섞이지 않는다', () => {
    const d = new ModelDayBars(5);
    d.merge([bar('2026-08-18T15:00:00-04:00', 10)]);
    expect(d.size).toBe(1);
    d.merge([bar('2026-08-19T09:30:00-04:00', 20)]);
    expect(d.size).toBe(1);
    expect(d.dayOpen).toBe(20);
    expect(d.cumDollarVolume).toBeCloseTo(20 * 100, 6);
  });

  it('한 번에 두 날짜가 섞여 오면 마지막 봉의 거래일만 남긴다', () => {
    const d = new ModelDayBars(5);
    d.merge([bar('2026-08-18T15:00:00-04:00', 10), bar('2026-08-19T09:30:00-04:00', 20)]);
    expect(d.bars.map((b) => b.close)).toEqual([20]);
  });

  it('비유한값·0 이하 종가는 버린다', () => {
    const d = new ModelDayBars(5);
    d.merge([
      { ...bar('2026-08-18T09:30:00-04:00', 1), close: 0 },
      { ...bar('2026-08-18T09:35:00-04:00', 1), close: Number.NaN },
      bar('2026-08-18T09:40:00-04:00', 5),
    ]);
    expect(d.size).toBe(1);
    expect(d.bars[0].close).toBe(5);
  });
});
