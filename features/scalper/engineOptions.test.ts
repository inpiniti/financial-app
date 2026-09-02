// 엔진 옵션(2026-09-03 ADR 0012) — 진입 필터(정배열·5선 상승·4선 모두 상승, AND)와 (k−1)배 물타기를 세 엔진에 얹는 배선.
// 규칙 자체(필터 판정·데코레이터)는 core/martingale 테스트가, 여기는 슬롯 게이트·포지션 관리자·설정 파싱을 본다.

import { describe, expect, it } from 'vitest';

import { DEFAULT_ENTRY_FILTERS, NO_ENTRY_FILTERS, evaluateMartingaleBars } from '../../core/martingale';
import { FeedSlot } from './feedSlot';
import { FakeBroker, fakeClock, flush } from './fakes';
import { MODEL_CONFIG, SLOPE_POSITION_CONFIG, makePositionManager, type PositionManagerDeps } from './positionManager';

const M = 60_000;
/** 2026-08-27 10:00 ET(EDT). */
const T0 = Date.UTC(2026, 7, 27, 14, 0);

/** 122봉 시드 — rising이면 정배열·4선 상승(마지막 봉만 살짝 눌러 5선 아래), falling이면 역배열·4선 하락. */
function seed(endMs: number, kind: 'rising' | 'falling') {
  const endKey = Math.floor(endMs / M);
  return Array.from({ length: 122 }, (_, i) => ({
    minuteKey: endKey - 122 + i,
    close: kind === 'rising' ? 100 + i - (i === 121 ? 3 : 0) : 300 - i,
  }));
}

describe('5선 돌파 엔진 + 진입 필터', () => {
  it('정배열 필터: 역배열(하락 추세)에서의 5선 반등 돌파는 신호가 아니다 — 필터 없으면 신호', () => {
    const clock = fakeClock(T0);
    const strict = new FeedSlot({ ticker: 'A', clock, martingale: true, entryFilters: { ordered: true, ma5Up: false, allUp: false } });
    const loose = new FeedSlot({ ticker: 'B', clock, martingale: true, entryFilters: NO_ENTRY_FILTERS });
    const got: Record<string, string[]> = { A: [], B: [] };
    strict.attachDetector((s, ctx) => got[ctx.ticker].push(s));
    loose.attachDetector((s, ctx) => got[ctx.ticker].push(s));
    strict.seedTrend(seed(T0, 'falling'));
    loose.seedTrend(seed(T0, 'falling'));
    strict.pushTick(200, T0 + 10_000); // 5선(≈181) 위로 반등 돌파 — 하지만 역배열
    loose.pushTick(200, T0 + 10_000);
    expect(got.B).toEqual(['BUY']);
    expect(got.A).toEqual([]);
    const ev = strict.getView().martingaleLive!;
    expect(ev.crossUp).toBe(true);
    expect(ev.ordered).toBe(false);
    expect(ev.filtersPass).toBe(false);
    expect(ev.entry).toBe(false);
  });

  it('기본(미주입)은 5선 상승 필터 — 2026-09-02 규칙 그대로', () => {
    expect(DEFAULT_ENTRY_FILTERS).toEqual({ ordered: false, ma5Up: true, allUp: false });
    const closes = seed(T0, 'rising').map((b) => b.close);
    const ev = evaluateMartingaleBars([...closes, 230]);
    expect(ev.entry).toBe(true);
    expect(ev.ordered).toBe(true);
    expect(ev.allUp).toBe(true);
  });
});

describe('기울기 엔진 + 진입 필터', () => {
  function slopeHarness(filters: { ordered: boolean; ma5Up: boolean; allUp: boolean }) {
    const clock = fakeClock(T0);
    const slot = new FeedSlot({ ticker: 'A', clock, slope: true, entryFilters: filters });
    const signals: string[] = [];
    slot.attachDetector((s) => signals.push(s));
    return { clock, slot, signals };
  }
  /** 100 근처에서 끝나는 122봉 시드 — rising: 87.9→100(정배열·4선 상승), falling: 112.1→100(역배열). 램프(≈100~102)와 가격대를 맞춘다. */
  function seedNear100(endMs: number, kind: 'rising' | 'falling') {
    const endKey = Math.floor(endMs / M);
    return Array.from({ length: 122 }, (_, i) => ({
      minuteKey: endKey - 122 + i,
      close: kind === 'rising' ? 100 - (121 - i) * 0.1 : 100 + (121 - i) * 0.1,
    }));
  }
  /** 직전 10초 창 100 × 5틱(T0+0~4s) 뒤 T0+14s에 현재 창 틱 — 기울기 = (p−100)%. */
  function ramp(h: ReturnType<typeof slopeHarness>, p: number) {
    for (let i = 0; i < 5; i += 1) {
      h.clock.set(T0 + i * 1_000);
      h.slot.pushTick(100, T0 + i * 1_000);
    }
    h.clock.set(T0 + 14_000);
    h.slot.pushTick(p, T0 + 14_000);
  }

  it('필터가 켜졌는데 1분봉 시드가 없으면(판정 불가) BUY를 내지 않는다 — fail-closed, SELL은 그대로', () => {
    const h = slopeHarness({ ordered: true, ma5Up: false, allUp: false });
    ramp(h, 102); // +2% → BUY 전환이지만 4선 판정 불가
    expect(h.signals).toEqual([]);
    expect(h.slot.getView().entryFilterPass).toBe(false);
    h.clock.set(T0 + 15_000);
    h.slot.pushTick(98, T0 + 15_000); // 아래로 → SELL(미보유면 오토파일럿이 무시)
    expect(h.signals).toEqual(['SELL']);
  });

  it('시드가 정배열이면 BUY가 나가고, 역배열이면 막힌다', () => {
    const ok = slopeHarness({ ordered: true, ma5Up: false, allUp: false });
    ok.slot.seedTrend(seedNear100(T0, 'rising'));
    ramp(ok, 102);
    expect(ok.signals).toEqual(['BUY']);
    expect(ok.slot.getView().entryFilterPass).toBe(true);

    const bad = slopeHarness({ ordered: true, ma5Up: false, allUp: false });
    bad.slot.seedTrend(seedNear100(T0, 'falling'));
    ramp(bad, 102);
    expect(bad.signals).toEqual([]);
    expect(bad.slot.getView().entryFilterPass).toBe(false);
  });

  it('필터가 꺼져 있으면(기본) 봉을 쌓지 않고 게이트도 없다', () => {
    const h = slopeHarness(NO_ENTRY_FILTERS);
    ramp(h, 102);
    expect(h.signals).toEqual(['BUY']);
    expect(h.slot.getView().entryFilterPass).toBeNull();
  });
});

describe('모델 엔진 + 진입 필터(emitSignal 게이트)', () => {
  it('BUY는 필터를 통과해야 나가고, SELL은 그대로 나간다', () => {
    const clock = fakeClock(T0);
    const slot = new FeedSlot({ ticker: 'A', clock, model: true, entryFilters: { ordered: false, ma5Up: false, allUp: true } });
    const signals: string[] = [];
    slot.attachDetector((s) => signals.push(s));
    slot.seedTrend(seed(T0 - 20 * M, 'falling')); // 4선 하락
    slot.pushTick(280, T0);
    expect(slot.emitSignal('BUY', 280)).toBe(false);
    expect(signals).toEqual([]);
    expect(slot.emitSignal('SELL', 280)).toBe(true);
    expect(signals).toEqual(['SELL']);
    // 상승 시드로 바꾸면 통과.
    const slot2 = new FeedSlot({ ticker: 'B', clock, model: true, entryFilters: { ordered: false, ma5Up: false, allUp: true } });
    const got: string[] = [];
    slot2.attachDetector((s) => got.push(s));
    slot2.seedTrend(seed(T0 - 20 * M, 'rising'));
    slot2.pushTick(230, T0);
    expect(slot2.emitSignal('BUY', 230)).toBe(true);
    expect(got).toEqual(['BUY']);
  });
});

describe('(k−1)배 물타기 옵션 — 기울기 엔진에 데코레이터로', () => {
  function pm(averagingDown: boolean) {
    const clock = fakeClock(T0);
    const broker = new FakeBroker({ autoFill: true });
    broker.position = { qty: 10, avgPrice: 100 };
    const events: string[] = [];
    let slope: number | null = 2;
    const deps: PositionManagerDeps = {
      ticker: 'A',
      broker,
      clock,
      price: () => ({ price: 96, lastTradeAt: clock.now(), dayLow: 90, dayHigh: 110 }),
      regularSession: () => false,
      entry: { entryTs: clock.now(), entrySnapshot: { price: 100, slope: 0, accel: 0, ts: clock.now() } },
      adopted: false,
      feeRate: 0,
      onEvent: (t) => events.push(t),
      slopeRate: () => slope,
    };
    const manager = makePositionManager('slope', { slope: SLOPE_POSITION_CONFIG, model: MODEL_CONFIG, averagingDown }, deps);
    return { manager, broker, events, setSlope: (s: number | null) => (slope = s) };
  }

  it('켜면 보유 중 BUY(기울기 재돌파)에서 평단 −4%면 보유량 ×3을 사고, 틱 판정(기울기 < 1%)은 그대로 전량 매도', async () => {
    const h = pm(true);
    await h.manager.arm({ qty: 10, avgPrice: 100 });
    expect(h.events.at(-1)).toContain('물타기');
    h.manager.onSignal('BUY', 96);
    await flush();
    expect(h.broker.placed).toHaveLength(1);
    expect(h.broker.placed[0]).toMatchObject({ side: 'buy', qty: 30 });
    h.broker.position = { qty: 40, avgPrice: 97 };
    await h.manager.poll();
    h.setSlope(0.5);
    await h.manager.tick({ canStart: true });
    await flush();
    expect(h.broker.placed).toHaveLength(2);
    expect(h.broker.placed[1]).toMatchObject({ side: 'sell', qty: 40 });
  });

  it('끄면 BUY 신호를 무시한다', async () => {
    const h = pm(false);
    await h.manager.arm({ qty: 10, avgPrice: 100 });
    expect(h.events.at(-1)).toContain('물타기 없어요');
    h.manager.onSignal('BUY', 96);
    await flush();
    expect(h.broker.placed).toHaveLength(0);
  });
});
