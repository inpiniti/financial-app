// 기울기 단타 모드 배선(2026-09-02 ADR 0011) — ① 기울기 +1% 돌파 BUY → 진입(세션 무관, 추격 게이트 없음)
// ② 보유 중 기울기 < +1% → 즉시 전량 매도 → 정산 ③ 청산 판정 타이머가 100ms로 돈다.
import { describe, expect, it } from 'vitest';

import type { TradeRecord } from '../../core/cycle';
import { SLOPE_EXIT_TICK_MS } from '../../core/slope';
import { AutoPilot, type AutoPilotConfig, type AutoPilotDeps, MARTINGALE_POSITION_CONFIG, MODEL_CONFIG, SLOPE_POSITION_CONFIG } from './autopilot';
import { FeedSlot } from './feedSlot';
import { FakeBroker, FakeStore, fakeClock, flush, noopScheduler } from './fakes';

/** 2026-08-27 22:00 ET — 주간거래(세션 조건이 없음을 겸해 본다). */
const T0 = Date.UTC(2026, 7, 28, 2, 0);
const CONFIG: AutoPilotConfig = { startAmountUsd: 10_000, minTickRate: 0.01 };

function makeHarness(opts: { autoFill?: boolean } = {}) {
  const clock = fakeClock(T0);
  const slot = new FeedSlot({ ticker: 'A', clock, slope: true, martingale: true, model: true });
  const brokers = new Map<string, FakeBroker>();
  const trades: TradeRecord[] = [];
  const events: string[] = [];
  const base = noopScheduler();
  const intervals: number[] = [];
  const scheduler = {
    ...base,
    setInterval: (fn: () => void, ms: number) => {
      intervals.push(ms);
      return base.setInterval(fn, ms);
    },
  };
  const pilot = new AutoPilot({
    slots: () => [slot],
    pin: () => {},
    unpin: () => {},
    makeBroker: (t) => {
      const b = new FakeBroker({ autoFill: opts.autoFill ?? true });
      brokers.set(t, b);
      return b;
    },
    positionManagement: { slope: SLOPE_POSITION_CONFIG, martingale: MARTINGALE_POSITION_CONFIG, model: MODEL_CONFIG },
    clock,
    scheduler,
    storage: new FakeStore(),
    onTrade: (r) => trades.push(r),
    onEvent: (e) => events.push(e.text),
  } satisfies AutoPilotDeps);
  pilot.setConfig(CONFIG);
  return { pilot, slot, brokers, clock, trades, events, scheduler: base, intervals };
}
type Harness = ReturnType<typeof makeHarness>;

async function tick(h: Harness, price: number, atMs: number): Promise<void> {
  h.clock.set(atMs);
  h.slot.pushTick(price, atMs);
  h.pilot.reselect();
  await flush();
  await h.pilot.pollCycle();
  await flush();
  await h.pilot.pollCycle();
  await flush();
}

/**
 * 직전 봉 재료 — T0+0~4초에 100 틱 5개(후보 선정도 겸함). 창은 지금 기준 슬라이딩 10초라 현재 봉 틱은 T0+14~19초에 넣는다
 * (feedSlotSlope.test.ts와 같은 배치) — 그때 기울기 = (현재 창 평균 − 100)%.
 */
async function warm(h: Harness): Promise<void> {
  for (let i = 0; i < 5; i += 1) await tick(h, 100, T0 + i * 1_000);
}

describe('기울기 단타 모드 — 진입·청산', () => {
  it('기울기가 +1% 이상으로 올라서는 틱에 진입하고, +1% 아래로 내려오는 틱에 손익 무관 전량 매도한다', async () => {
    const h = makeHarness();
    h.pilot.start();
    await warm(h);
    expect(h.pilot.getView().activeTickers).toEqual([]);
    await tick(h, 101.5, T0 + 14_000); // 현재 봉 평균 101.5 → +1.5% → BUY → 진입
    expect(h.pilot.getView().activeTickers).toEqual(['A']);
    const broker = h.brokers.get('A')!;
    expect(broker.placed).toHaveLength(1);
    expect(broker.placed[0]).toMatchObject({ side: 'buy' });
    expect(h.events.some((e) => e.includes('기울기 관리 인계'))).toBe(true);
    const qty = broker.placed[0].qty;
    broker.position = { qty, avgPrice: 101.5 }; // 체결 뒤 잔고(FakeBroker는 채우지 않는다).
    // 더 오르는 동안(기울기 유지) 안 판다 — 익절 없음.
    await tick(h, 103, T0 + 15_000); // 평균 102.25 → +2.25%
    expect(broker.placed).toHaveLength(1);
    // 급락해도 기울기가 +1% 위면 안 판다 — 손절 없음: 평균 (101.5+103+99)/3 ≈ 101.17 → +1.17%
    await tick(h, 99, T0 + 16_000);
    expect(broker.placed).toHaveLength(1);
    // 한 틱 더 내려 +1% 아래로 → 슬롯 SELL → 전량 매도.
    await tick(h, 97, T0 + 17_000); // 평균 100.125 → +0.125%
    expect(broker.placed).toHaveLength(2);
    expect(broker.placed[1]).toMatchObject({ side: 'sell', qty });
    await h.pilot.pollCycle();
    await flush();
    expect(h.trades).toHaveLength(1);
    expect(h.trades[0].exitReason).toBe('SELL_SIGNAL');
    expect(h.pilot.getView().activeTickers).toEqual([]);
  });

  it('틱이 끊겨도 빠른 틱(100ms 타이머 → cond.tick)이 창 슬라이딩으로 기울기 하락을 잡아 판다', async () => {
    const h = makeHarness();
    h.pilot.start();
    await warm(h);
    await tick(h, 101.5, T0 + 14_000);
    const broker = h.brokers.get('A')!;
    broker.position = { qty: broker.placed[0].qty, avgPrice: 101.5 };
    expect(broker.placed).toHaveLength(1);
    // 틱 없이 25초 경과 — 직전 봉이 비어 기울기 null. 리프라이스 타이머(100ms)가 cond.tick을 돌리면 매도.
    h.clock.advance(25_000);
    for (const fn of h.scheduler.fired) fn();
    await flush();
    await flush();
    expect(broker.placed).toHaveLength(2);
    expect(broker.placed[1]).toMatchObject({ side: 'sell' });
    expect(h.events.some((e) => e.includes('체결 끊김'))).toBe(true);
  });

  it('매수는 신호 시점 현재가 지정가 — 매도1호가가 위에 있어도 크로스하지 않고, 미체결이어도 호가를 따라 정정하지 않는다', async () => {
    const h = makeHarness({ autoFill: false });
    h.pilot.start();
    await warm(h);
    h.slot.pushQuote(101.4, 103); // 매도1호가 103 — 물타기 모드였다면 103에 걸었다
    await tick(h, 101.5, T0 + 14_000); // 신호가 101.5
    const broker = h.brokers.get('A')!;
    expect(broker.placed).toHaveLength(1);
    expect(broker.placed[0]).toMatchObject({ side: 'buy', price: 101.5 });
    // 호가가 더 달아나도 정정하지 않는다 — 미체결 정리는 매수 미체결 취소 설정 몫.
    h.slot.pushQuote(104, 105);
    h.clock.advance(2_000);
    for (const fn of h.scheduler.fired) fn();
    await flush();
    await flush();
    expect(broker.amended).toHaveLength(0);
  });

  it('보유 중 청산 판정 타이머는 SLOPE_EXIT_TICK_MS(100ms)로 등록된다', async () => {
    const h = makeHarness();
    h.pilot.start();
    await warm(h);
    await tick(h, 101.5, T0 + 14_000);
    expect(h.intervals).toContain(SLOPE_EXIT_TICK_MS);
  });
});
