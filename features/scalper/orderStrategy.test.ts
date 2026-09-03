// 주문 전략(2026-09-03 ADR 0013) — 매수·매도 각각 quote / lastChase / lastCancel의 배선.
// 매도는 RulePositionManager(Execution), 매수 진입은 AutoPilot(OrderPortAdapter 리프라이스·자동 취소)를 본다.

import { describe, expect, it } from 'vitest';

import type { TradeRecord } from '../../core/cycle';
import { AutoPilot, type AutoPilotConfig, type AutoPilotDeps, MARTINGALE_POSITION_CONFIG, MODEL_CONFIG, SLOPE_POSITION_CONFIG } from './autopilot';
import { FeedSlot } from './feedSlot';
import { FakeBroker, FakeStore, fakeClock, flush, noopScheduler } from './fakes';
import { DEFAULT_ORDER_STRATEGY, type OrderStrategy } from './orderStrategy';
import { makePositionManager, type PositionManagerDeps } from './positionManager';

const T0 = Date.UTC(2026, 7, 27, 14, 0);

// ---------------------------------------------------------------------------
// 매도 — RulePositionManager (기울기 어댑터로 — 틱 판정 한 갈래라 전략 차이만 남는다)
// ---------------------------------------------------------------------------
function sellHarness(strategy: OrderStrategy, opts: { autoFill?: boolean } = {}) {
  const clock = fakeClock(T0);
  const broker = new FakeBroker({ autoFill: opts.autoFill ?? false });
  broker.position = { qty: 10, avgPrice: 100 };
  const events: string[] = [];
  let price = 100;
  let slope: number | null = 0.5; // 이미 청산 조건(기울기 < 1%)
  let current = strategy;
  const deps: PositionManagerDeps = {
    ticker: 'A',
    broker,
    clock,
    price: () => ({ price, lastTradeAt: clock.now(), dayLow: 90, dayHigh: 110 }),
    quote: () => ({ bid1: price - 0.2, ask1: price + 0.2, at: clock.now() }),
    regularSession: () => false,
    entry: { entryTs: clock.now(), entrySnapshot: { price: 100, slope: 0, accel: 0, ts: clock.now() } },
    adopted: false,
    feeRate: 0,
    onEvent: (t) => events.push(t),
    slopeRate: () => slope,
    orderStrategy: () => current,
  };
  const pm = makePositionManager('slope', { slope: SLOPE_POSITION_CONFIG, model: MODEL_CONFIG }, deps);
  return {
    pm,
    broker,
    clock,
    events,
    setPrice: (p: number) => (price = p),
    setStrategy: (s: OrderStrategy) => (current = s),
  };
}

describe('매도 전략', () => {
  it('quote: 매수1호가에 걸고, 호가가 바뀌면 그 호가로 정정한다', async () => {
    const h = sellHarness({ ...DEFAULT_ORDER_STRATEGY, sell: 'quote' });
    await h.pm.arm({ qty: 10, avgPrice: 100 });
    await h.pm.tick({ canStart: true });
    await flush();
    expect(h.broker.placed).toHaveLength(1);
    expect(h.broker.placed[0].price).toBeCloseTo(99.8, 6); // bid1 = 100 − 0.2
    h.setPrice(98);
    h.clock.advance(2_000);
    await h.pm.tick({ canStart: true });
    await flush();
    expect(h.broker.amended.at(-1)?.price).toBeCloseTo(97.8, 6);
  });

  it('lastChase: 현재가에 걸고, 틱마다 현재가로 정정한다(호가 무시)', async () => {
    const h = sellHarness({ ...DEFAULT_ORDER_STRATEGY, sell: 'lastChase' });
    await h.pm.arm({ qty: 10, avgPrice: 100 });
    await h.pm.tick({ canStart: true });
    await flush();
    expect(h.broker.placed[0].price).toBe(100);
    h.setPrice(98.5);
    h.clock.advance(2_000);
    await h.pm.tick({ canStart: true });
    await flush();
    expect(h.broker.amended.at(-1)?.price).toBe(98.5);
  });

  it('lastCancel: 현재가에 걸고 정정하지 않다가 시간이 지나면 취소하고, 다음 판정이 새 현재가로 다시 낸다', async () => {
    const h = sellHarness({ ...DEFAULT_ORDER_STRATEGY, sell: 'lastCancel', sellCancelAfterMs: 3_000 });
    await h.pm.arm({ qty: 10, avgPrice: 100 });
    await h.pm.tick({ canStart: true });
    await flush();
    expect(h.broker.placed).toHaveLength(1);
    expect(h.broker.placed[0].price).toBe(100);
    // 가격이 움직여도 정정 없음.
    h.setPrice(98);
    h.clock.advance(2_000);
    await h.pm.tick({ canStart: true });
    await flush();
    expect(h.broker.amended).toHaveLength(0);
    expect(h.broker.canceled).toHaveLength(0);
    // 3초 경과 → 취소.
    h.clock.advance(1_500);
    await h.pm.tick({ canStart: true });
    await flush();
    expect(h.broker.canceled).toHaveLength(1);
    expect(h.events.some((e) => e.includes('매도 미체결 3초'))).toBe(true);
    // 폴이 취소를 확정하면 매매가 비고, 다음 틱 판정이 새 현재가(98)로 다시 낸다.
    const r = await h.pm.poll();
    expect(r.kind).toBe('holding');
    await h.pm.tick({ canStart: true });
    await flush();
    expect(h.broker.placed).toHaveLength(2);
    expect(h.broker.placed[1].price).toBe(98);
  });

  it('전략은 실행 중에도 즉시 바뀐다 — quote로 걸린 주문이 lastChase로 바뀌면 다음 틱부터 현재가로 정정', async () => {
    const h = sellHarness({ ...DEFAULT_ORDER_STRATEGY, sell: 'quote' });
    await h.pm.arm({ qty: 10, avgPrice: 100 });
    await h.pm.tick({ canStart: true });
    await flush();
    expect(h.broker.placed[0].price).toBeCloseTo(99.8, 6);
    h.setStrategy({ ...DEFAULT_ORDER_STRATEGY, sell: 'lastChase' });
    h.setPrice(99);
    h.clock.advance(2_000);
    await h.pm.tick({ canStart: true });
    await flush();
    expect(h.broker.amended.at(-1)?.price).toBe(99);
  });

  it('미주입(옛 하네스)이면 매도는 1호가 크로스·추격 그대로', async () => {
    const h = sellHarness(DEFAULT_ORDER_STRATEGY);
    h.setStrategy(null as unknown as OrderStrategy);
    await h.pm.arm({ qty: 10, avgPrice: 100 });
    await h.pm.tick({ canStart: true });
    await flush();
    expect(h.broker.placed[0].price).toBeCloseTo(99.8, 6);
  });
});

// ---------------------------------------------------------------------------
// 매수 — AutoPilot 진입(5선 돌파 엔진)
// ---------------------------------------------------------------------------
const M = 60_000;
const BASE = Math.floor(T0 / M);
const CONFIG: AutoPilotConfig = { startAmountUsd: 10_000, minTickRate: 0.01 };
const risingSeed = () =>
  Array.from({ length: 122 }, (_, i) => ({ minuteKey: BASE - 122 + i, close: 100 + i - (i === 121 ? 3 : 0) }));

function buyHarness(strategy: OrderStrategy) {
  const clock = fakeClock(BASE * M);
  const slot = new FeedSlot({ ticker: 'A', clock, martingale: true, model: true });
  const brokers = new Map<string, FakeBroker>();
  const events: string[] = [];
  const scheduler = noopScheduler();
  const pilot = new AutoPilot({
    slots: () => [slot],
    pin: () => {},
    unpin: () => {},
    makeBroker: (t) => {
      const b = new FakeBroker({ autoFill: false });
      brokers.set(t, b);
      return b;
    },
    positionManagement: { model: MODEL_CONFIG, martingale: MARTINGALE_POSITION_CONFIG },
    clock,
    scheduler,
    storage: new FakeStore(),
    onTrade: (_r: TradeRecord) => {},
    onEvent: (e) => events.push(e.text),
    orderStrategy: strategy,
  } satisfies AutoPilotDeps);
  pilot.setConfig(CONFIG);
  return { pilot, slot, brokers, clock, events, scheduler };
}
type BuyHarness = ReturnType<typeof buyHarness>;

async function enter(h: BuyHarness): Promise<FakeBroker> {
  h.slot.seedTrend(risingSeed());
  h.pilot.start();
  h.slot.pushQuote(221, 223);
  h.clock.set(BASE * M);
  h.slot.pushTick(216, BASE * M); // 5선 아래 — 후보 선정만
  h.pilot.reselect();
  h.clock.advance(5_000);
  h.slot.pushTick(230, BASE * M + 5_000); // 돌파 → 진입 발주(미체결)
  await flush();
  await h.pilot.pollCycle();
  await flush();
  const broker = h.brokers.get('A')!;
  expect(broker.placed).toHaveLength(1);
  return broker;
}

async function fastTicks(h: BuyHarness): Promise<void> {
  for (const fn of h.scheduler.fired) fn();
  await flush();
  await flush();
}

describe('매수 전략(진입)', () => {
  it('quote: 매도1호가에 걸고, 호가가 달아나면 그 호가로 정정한다', async () => {
    const h = buyHarness({ ...DEFAULT_ORDER_STRATEGY, buy: 'quote' });
    const broker = await enter(h);
    expect(broker.placed[0].price).toBe(223);
    h.slot.pushQuote(229, 231);
    h.clock.advance(2_000);
    await fastTicks(h);
    expect(broker.amended.at(-1)?.price).toBe(231);
  });

  it('lastChase: 신호가에 걸고, 현재가가 바뀌면 그 가격으로 정정한다(호가 무시)', async () => {
    const h = buyHarness({ ...DEFAULT_ORDER_STRATEGY, buy: 'lastChase' });
    const broker = await enter(h);
    expect(broker.placed[0].price).toBe(230);
    h.slot.pushQuote(240, 241); // 호가가 달아나도
    h.clock.advance(2_000);
    h.slot.pushTick(232, BASE * M + 7_000); // 현재가 232
    await fastTicks(h);
    expect(broker.amended.at(-1)?.price).toBe(232);
  });

  it('lastCancel: 신호가에 걸고 정정하지 않다가 시간이 지나면 취소한다', async () => {
    const h = buyHarness({ ...DEFAULT_ORDER_STRATEGY, buy: 'lastCancel', buyCancelAfterMs: 3_000 });
    const broker = await enter(h);
    expect(broker.placed[0].price).toBe(230);
    h.slot.pushQuote(240, 241);
    h.clock.advance(2_000);
    h.slot.pushTick(235, BASE * M + 7_000);
    await fastTicks(h);
    expect(broker.amended).toHaveLength(0);
    expect(broker.canceled).toHaveLength(0);
    h.clock.advance(2_000);
    await fastTicks(h);
    await fastTicks(h);
    expect(broker.canceled).toHaveLength(1);
  });

  it('lastCancel이 아니면 미체결 취소 시간은 무시한다(체결까지 따라간다)', async () => {
    const h = buyHarness({ ...DEFAULT_ORDER_STRATEGY, buy: 'quote', buyCancelAfterMs: 1_000 });
    const broker = await enter(h);
    h.clock.advance(5_000);
    await fastTicks(h);
    await fastTicks(h);
    expect(broker.canceled).toHaveLength(0);
  });

  it('applySettings로 실행 중 전략을 바꾸면 이벤트가 남고 다음 틱부터 적용된다', async () => {
    const h = buyHarness({ ...DEFAULT_ORDER_STRATEGY, buy: 'quote' });
    const broker = await enter(h);
    expect(h.pilot.applySettings({ orderStrategy: { ...DEFAULT_ORDER_STRATEGY, buy: 'lastChase' } })).toBeNull();
    expect(h.events.some((e) => e.includes('주문 전략 적용 · 매수 현재가 추종'))).toBe(true);
    h.clock.advance(2_000);
    h.slot.pushTick(233, BASE * M + 7_000);
    await fastTicks(h);
    expect(broker.amended.at(-1)?.price).toBe(233);
  });
});
