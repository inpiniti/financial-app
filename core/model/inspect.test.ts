// 모델 판정 들여다보기 — 화면·챗봇이 엔진과 **같은 답**을 말하는지.
// (2026-08-22 사고: 화면이 자기 방식으로 다시 계산해 엔진과 다른 판정을 보여 줬다.)

import { describe, expect, it } from 'vitest';
import { describeReject, inspectModel } from './inspect';
import type { GbdtModel } from './gbdt';
import type { OhlcvBar } from './bars';

const at = (iso: string): number => Math.floor(Date.parse(iso) / 60_000);

const bar = (iso: string, close: number, volume = 100_000): OhlcvBar => ({
  minuteKey: at(iso),
  open: close,
  high: close,
  low: close,
  close,
  volume,
});

/** 트리 0개 = 항상 sigmoid(0)=0.5. 임계값을 움직여 신호/미달을 만든다. */
const model = (threshold: number): GbdtModel =>
  ({ kind: 'test', threshold, sigmoid: 1, trees: [], features: [] }) as unknown as GbdtModel;

/** 정규장 5분봉 n개(09:30 ET부터). 거래대금이 $2M을 넘도록 넉넉히. */
const mainSessionBars = (n: number, close = 10): OhlcvBar[] =>
  Array.from({ length: n }, (_, i) => {
    const key = at('2026-08-18T09:30:00-04:00') + i * 5;
    return { minuteKey: key, open: close, high: close, low: close, close, volume: 100_000 };
  });

describe('inspectModel', () => {
  it('정규장·유동성·가격을 통과하고 확률이 임계값 이상이면 BUY', () => {
    const r = inspectModel(model(0.4), { bars: mainSessionBars(10), barMinutes: 5 });
    expect(r.reject).toBeNull();
    expect(r.signal).toBe('BUY');
    expect(r.prob).toBeCloseTo(0.5, 6);
    expect(r.dayBars).toBe(10);
    expect(r.dayOpen).toBe(10);
    expect(r.etDate).toBe('2026-08-18');
    expect(describeReject(r)).toBeNull();
  });

  it('확률이 임계값에 못 미치면 사유가 prob — 확률은 그대로 알려 준다', () => {
    const r = inspectModel(model(0.9), { bars: mainSessionBars(10), barMinutes: 5 });
    expect(r.signal).toBeNull();
    expect(r.reject).toBe('prob');
    expect(describeReject(r)).toContain('50.0%');
    expect(describeReject(r)).toContain('90.0%');
  });

  it('봉이 없으면 판정 불가 — 빈 값으로 답하고 터지지 않는다', () => {
    const r = inspectModel(model(0.4), { bars: [], barMinutes: 5 });
    expect(r.reject).toBe('bars');
    expect(r.dayBars).toBe(0);
    expect(r.dayOpen).toBeNull();
    expect(r.etDate).toBeNull();
    expect(describeReject(r)).toContain('봉이 모자라');
  });

  it('정규장 밖 봉이면 session — 참고 확률은 주되 신호는 내지 않는다(2026-08-25)', () => {
    const pre = [bar('2026-08-18T08:00:00-04:00', 10), bar('2026-08-18T08:05:00-04:00', 10)];
    const r = inspectModel(model(0.4), { bars: pre, barMinutes: 5 });
    expect(r.reject).toBe('session');
    expect(r.signal).toBeNull();
    expect(r.prob).not.toBeNull(); // 게이트에 걸려도 확률은 계산한다 — 화면·챗봇 표시용
    expect(describeReject(r)).toContain('정규장');
  });

  it('그날 거래대금이 $2M 미만이면 liquidity', () => {
    const thin = mainSessionBars(10).map((b) => ({ ...b, volume: 1 }));
    const r = inspectModel(model(0.4), { bars: thin, barMinutes: 5 });
    expect(r.reject).toBe('liquidity');
    expect(r.cumDollarVolume).toBeLessThan(2_000_000);
  });

  it('주가가 $1 이하면 price', () => {
    const penny = mainSessionBars(10, 0.9).map((b) => ({ ...b, volume: 10_000_000 }));
    const r = inspectModel(model(0.4), { bars: penny, barMinutes: 5 });
    expect(r.reject).toBe('price');
  });

  it('일봉은 판정일보다 앞선 날짜만 쓴다 — 오늘 진행 중 일봉이 섞여 와도 무시한다', () => {
    const bars = mainSessionBars(10);
    // 오늘(08-18) 일봉이 섞여 있어도 전일(08-15)·전전일(08-14)이 전일 계열로 잡혀야 한다.
    const r = inspectModel(model(0.4), {
      bars,
      dailyCloses: [
        { date: '2026-08-14', close: 8 },
        { date: '2026-08-15', close: 9 },
        { date: '2026-08-18', close: 10 },
      ],
      barMinutes: 5,
    });
    expect(r.etDate).toBe('2026-08-18');
    expect(r.signal).toBe('BUY'); // 일봉 유무와 무관하게 판정은 난다
  });

  it('주간거래(오버나이트) 봉도 판정에 담는다 — 참고 확률은 주되 정규장이 아니라 신호는 없다(2026-08-25)', () => {
    const overnight = [bar('2026-08-18T21:00:00-04:00', 10), bar('2026-08-18T22:00:00-04:00', 10)];
    const r = inspectModel(model(0.4), { bars: overnight, barMinutes: 5 });
    expect(r.dayBars).toBe(2);
    expect(r.reject).toBe('session');
    expect(r.prob).not.toBeNull();
  });
});
