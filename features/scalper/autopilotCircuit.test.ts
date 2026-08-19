// 서킷 도메인 — CIRCUIT_MODE=true 경로(정지 중 지정가 매도 · 재개 뒤 추격 · exitReason=CIRCUIT).
// 스위치는 모듈 상수라 vi.mock으로 켠다. 관측 모드(false)는 autopilotTrend.test.ts가 본다.
import { describe, expect, it, vi } from 'vitest';

vi.mock('./circuitMode', () => ({ CIRCUIT_MODE: true }));

import type { TradeRecord } from '../../core/cycle';
import { AutoPilot, type AutoPilotConfig, type AutoPilotDeps, TREND_CONFIG } from './autopilot';
import { FeedSlot } from './feedSlot';
import { FakeBroker, FakeStore, fakeClock, flush, noopScheduler } from './fakes';

const M = 60_000;
const CONFIG: AutoPilotConfig = { startAmountUsd: 10_000, minTickRate: 0.01 };
const risingSeed = () => Array.from({ length: 122 }, (_, i) => ({ minuteKey: i, close: 100 + i }));
const ET_REGULAR = Date.UTC(2026, 7, 18, 14, 0, 0);

function makeHarness() {
  const clock = fakeClock(1000);
  const slots = new Map([['A', new FeedSlot({ ticker: 'A', clock, trend: true, trendBarMinutes: 1 })]]);
  const brokers = new Map<string, FakeBroker>();
  const trades: TradeRecord[] = [];
  const events: string[] = [];
  const scheduler = noopScheduler();
  const pilot = new AutoPilot({
    slots: () => [...slots.values()],
    pin: () => {},
    unpin: () => {},
    makeBroker: (t) => {
      const b = new FakeBroker({ autoFill: false });
      brokers.set(t, b);
      return b;
    },
    gridConfig: { buyWidth: 0.05, sellWidth: 0.02, buyMultiplier: 1 },
    trendConfig: TREND_CONFIG,
    clock,
    scheduler,
    storage: new FakeStore(),
    onTrade: (r) => trades.push(r),
    onEvent: (e) => events.push(e.text),
  } satisfies AutoPilotDeps);
  pilot.setConfig(CONFIG);
  return { pilot, slots, brokers, clock, trades, events, scheduler };
}
type H = ReturnType<typeof makeHarness>;

async function fire(h: H): Promise<void> {
  for (const fn of h.scheduler.fired) fn();
  await flush();
  await flush();
}
async function trades(h: H, n: number, price: number, barMinute: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    h.clock.advance(1000);
    h.slots.get('A')!.pushTick(price, barMinute * M + i * 1000, { volume: 100 });
    await fire(h);
  }
}
async function quiet(h: H, seconds: number): Promise<void> {
  for (let i = 0; i < seconds; i++) {
    h.clock.advance(1000);
    await fire(h);
  }
}
/** 정지 1회: 직전가 price로 n건 체결 뒤 46초 무체결(감지). 반환 없음. */
async function halt(h: H, price: number, n: number, barMinute: number): Promise<void> {
  h.clock.advance(300_000); // 직전 정지 5분
  await trades(h, n, price, barMinute);
  await quiet(h, 46);
}

async function enter(h: H): Promise<FakeBroker> {
  h.slots.get('A')!.seedTrend(risingSeed());
  h.pilot.start();
  const push = async (p: number, m: number) => {
    h.slots.get('A')!.pushTick(p, m * M);
    h.pilot.reselect();
    h.clock.advance(1000);
    await flush();
    await h.pilot.pollCycle();
    await flush();
  };
  await push(222, 122);
  await push(223, 123);
  const broker = h.brokers.get('A')!;
  broker.fill(broker.placed[0].odno, 223); // 진입 체결
  await h.pilot.pollCycle();
  await flush();
  await h.pilot.pollCycle();
  await flush();
  expect(h.pilot.getView().grids).toHaveLength(1);
  broker.position = { qty: h.pilot.getView().grids[0].holdingQty, avgPrice: 223 };
  h.clock.set(ET_REGULAR);
  return broker;
}

describe('서킷 CIRCUIT_MODE=true — 하킷 2연속 → 정지 중 지정가 매도 → 재개 단일가 체결', () => {
  it('상킷·하킷 1회는 홀드, 하킷 2연속에서 직전가 −12% 지정가로 즉시 발주하고 정지 중엔 정정하지 않는다', async () => {
    const h = makeHarness();
    const broker = await enter(h);
    const qty = h.pilot.getView().grids[0].holdingQty;
    await trades(h, 40, 240, 123); // 활발
    await quiet(h, 46); // #1 상킷(240 > 223 시작가) — 첫 정지
    await halt(h, 260, 3, 124); // #2 상킷, 창 2초 → 서킷 상태
    await halt(h, 250, 3, 125); // #3 하킷 1회 — 홀드
    expect(broker.placed).toHaveLength(1);
    await halt(h, 230, 3, 126); // #4 하킷 2연속 → 매도
    expect(broker.placed).toHaveLength(2);
    expect(broker.placed[1]).toMatchObject({ side: 'sell', qty });
    expect(broker.placed[1].price).toBeCloseTo(230 * 0.88, 2);
    expect(h.events.some((e) => e.includes('하킷 2연속') && e.includes('정지 중 지정가 매도'))).toBe(true);
    // 정지 중(체결 없음) 리프라이스 틱이 돌아도 정정 없음
    await quiet(h, 5);
    expect(broker.amended).toHaveLength(0);
    // 재개 첫 체결(단일가 225 — 지정가 202.4 위) → 잔량이 있으면 그때부터 추격, 여기선 체결로 정산
    h.clock.advance(300_000);
    h.slots.get('A')!.pushTick(225, 127 * M, { volume: 500 });
    broker.fill(broker.placed[1].odno, 225); // 재개 경매에서 지정가 위 단일가로 체결(체결이 첫 틱보다 먼저)
    await h.pilot.pollCycle();
    await flush();
    await h.pilot.pollCycle();
    await flush();
    expect(h.trades).toHaveLength(1);
    expect(h.trades[0].exitReason).toBe('CIRCUIT');
    expect(h.trades[0].exitPrice).toBe(225);
    expect(h.pilot.getView().activeTickers).toEqual([]);
  }, 30_000);

  it('서킷 상태에서는 봉 마감 SELL(ma5)을 무시한다', async () => {
    const h = makeHarness();
    const broker = await enter(h);
    await trades(h, 40, 240, 123);
    await quiet(h, 46);
    await halt(h, 260, 3, 124); // 서킷 상태
    // 다음 봉으로 넘어가며 직전 봉(260)이 닫히고, 다다음 봉 첫 틱으로 215 봉을 닫아 종가<ma5 를 만든다 — 정상이면 SELL이 나가야 하지만 서킷 상태라 무시
    h.clock.advance(300_000);
    h.slots.get('A')!.pushTick(215, 130 * M, { volume: 100 }); // 손절선(207.39) 위, ma5 아래
    await fire(h);
    h.slots.get('A')!.pushTick(215, 131 * M, { volume: 100 }); // 130 봉(215) 마감 → 종가<ma5 → 정상이면 SELL
    await fire(h);
    await h.pilot.pollCycle();
    await flush();
    expect(broker.placed).toHaveLength(1);
    expect(h.pilot.getView().activeTickers).toEqual(['A']);
  }, 30_000);

  it('재개 뒤 미체결이면 재개 체결이 관측된 뒤부터 현재가로 정정(추격)한다', async () => {
    const h = makeHarness();
    const broker = await enter(h);
    await trades(h, 40, 240, 123);
    await quiet(h, 46);
    await halt(h, 260, 3, 124);
    await halt(h, 250, 3, 125);
    await halt(h, 230, 3, 126);
    expect(broker.placed).toHaveLength(2);
    // 재개: 경매가가 지정가(202.4) 아래(195)로 열려 미체결 → 재개 체결 관측 후 추격 정정
    h.clock.advance(300_000);
    h.slots.get('A')!.pushTick(195, 127 * M, { volume: 500 });
    await fire(h);
    h.clock.advance(1500);
    h.slots.get('A')!.pushTick(196, 127 * M + 1500, { volume: 100 });
    await fire(h);
    expect(broker.amended.length).toBeGreaterThanOrEqual(1);
    expect(broker.amended[0].price).toBeCloseTo(195, 2); // 재개 첫 체결(195) 관측 직후 그 가격으로 첫 정정
    expect(broker.amended[broker.amended.length - 1].price).toBeCloseTo(196, 2);
  }, 30_000);
});
