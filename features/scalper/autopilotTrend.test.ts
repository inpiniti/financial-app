// 추세 → 그리드 → 매매(TREND_MODE + trendConfig, 2026-08-18 도메인 문서) — 진입·무조건 청산·재진입 통합 시나리오.
// 신호는 FeedSlot 추세 모드(1분봉 합성 + 4선)가 만든다 — 판정 규칙 자체는 core/trend 테스트가, 여기는 배선을 본다.
import { describe, expect, it } from 'vitest';

import type { TradeRecord } from '../../core/cycle';
import { AutoPilot, type AutoPilotConfig, type AutoPilotDeps, TREND_CONFIG } from './autopilot';
import { FeedSlot } from './feedSlot';
import { FakeBroker, FakeStore, fakeClock, flush, noopScheduler } from './fakes';

const M = 60_000;
const TINY_RATE = 0.01;
const CONFIG: AutoPilotConfig = { startAmountUsd: 10_000, minTickRate: TINY_RATE };

/** 오름차순 122봉 시드(키 0..121, 종가 100..221) — 4선 2봉 연속 상승·종가>ma60. */
const risingSeed = () => Array.from({ length: 122 }, (_, i) => ({ minuteKey: i, close: 100 + i }));

interface Harness {
  pilot: AutoPilot;
  slots: Map<string, FeedSlot>;
  brokers: Map<string, FakeBroker>;
  clock: ReturnType<typeof fakeClock>;
  trades: TradeRecord[];
  events: string[];
  scheduler: ReturnType<typeof noopScheduler>;
}

function makeHarness(opts: { autoFill?: boolean; positions?: Record<string, { qty: number; avgPrice: number }> } = {}): Harness {
  const clock = fakeClock(1000);
  // 조합(inflection)도 함께 주입한 슬롯 — 추세가 우선해야 한다.
  const slots = new Map([['A', new FeedSlot({ ticker: 'A', clock, trend: true, trendBarMinutes: 1, inflection: true })]]);
  const brokers = new Map<string, FakeBroker>();
  const trades: TradeRecord[] = [];
  const events: string[] = [];
  const scheduler = noopScheduler();
  const pilot = new AutoPilot({
    slots: () => [...slots.values()],
    pin: () => {},
    unpin: () => {},
    makeBroker: (t) => {
      const b = new FakeBroker({ autoFill: opts.autoFill ?? true });
      const pos = opts.positions?.[t];
      if (pos) b.position = { ...pos };
      brokers.set(t, b);
      return b;
    },
    // 롤백 대비 실배선처럼 셋 다 주입 — 추세가 우선해야 한다(OCO 다리·물타기가 나가면 안 된다).
    gridConfig: { buyWidth: 0.05, sellWidth: 0.02, buyMultiplier: 1 },
    inflectionConfig: { sellProfitPct: 0.02, buyDropPct: 0.03 },
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

/** 분 키 `minute`의 첫 틱을 넣는다(직전 분 봉이 닫힌다) + 재선정·체결 폴. */
async function tick(h: Harness, price: number, minute: number): Promise<void> {
  h.slots.get('A')!.pushTick(price, minute * M);
  h.pilot.reselect();
  h.clock.advance(1000);
  await flush();
  await h.pilot.pollCycle();
  await flush();
  await h.pilot.pollCycle(); // HOLDING 확인 → 인계까지 한 번 더.
  await flush();
}

async function fireTimers(h: Harness): Promise<void> {
  for (const fn of h.scheduler.fired) fn();
  await flush();
  await flush();
}

/** 시드 → 시작 → 봉 마감 BUY → 진입 체결 → 추세 관리 인계. */
async function enter(h: Harness): Promise<void> {
  h.slots.get('A')!.seedTrend(risingSeed());
  h.pilot.start();
  await tick(h, 222, 122); // 키 122 진행 중 — 신호 없음
  expect(h.pilot.getView().activeTickers).toEqual([]);
  await tick(h, 223, 123); // 키 122 닫힘 → BUY
  expect(h.pilot.getView().activeTickers).toEqual(['A']);
  expect(h.pilot.getView().grids).toHaveLength(1);
}

describe('추세 → 그리드 → 매매 — 진입·인계', () => {
  it('봉 마감 BUY로 진입하고 추세 관리가 인계한다 — OCO 다리 없음, 조건선=평단', async () => {
    const h = makeHarness();
    await enter(h);
    const broker = h.brokers.get('A')!;
    expect(broker.placed).toHaveLength(1);
    expect(broker.placed[0].side).toBe('buy');
    const g = h.pilot.getView().grids[0];
    expect(g.gridActive).toBe(true);
    // 고저 틱이 아직 없으면 양끝은 평단으로 접힌다(주문선 없음).
    expect(g.rangeKind).toBe('dayRange');
    expect(g.sellPrice).toBe(g.avgPrice);
    expect(g.buyPrice).toBe(g.avgPrice);
    expect(h.events.some((e) => e.includes('추세 관리 인계'))).toBe(true);
    expect(h.events.some((e) => e.includes('변곡점 그리드 인계'))).toBe(false);
  });

  it('추세 게이지 양끝은 오늘 최저·최고(틱 HIGH/LOW) — 평단을 항상 포함한다', async () => {
    const h = makeHarness();
    await enter(h);
    const g0 = h.pilot.getView().grids[0];
    h.slots.get('A')!.pushTick(g0.avgPrice, 200 * M, { dayHigh: g0.avgPrice * 1.1, dayLow: g0.avgPrice * 0.9 });
    const g = h.pilot.getView().grids[0];
    expect(g.rangeKind).toBe('dayRange');
    expect(g.buyPrice).toBeCloseTo(g0.avgPrice * 0.9);
    expect(g.sellPrice).toBeCloseTo(g0.avgPrice * 1.1);
    // 저가가 평단보다 높게 와도(진입 직후 상승) 왼쪽 끝은 평단 이하로 클램프.
    h.slots.get('A')!.pushTick(g0.avgPrice * 1.05, 200 * M + 1000, { dayHigh: g0.avgPrice * 1.1, dayLow: g0.avgPrice * 1.02 });
    expect(h.pilot.getView().grids[0].buyPrice).toBe(g0.avgPrice);
  });

  it('보유 중 BUY 신호(봉 마감마다 반복)는 무시한다 — 물타기 없음, 평단 아래여도', async () => {
    const h = makeHarness();
    await enter(h);
    const broker = h.brokers.get('A')!;
    // 상승은 유지(4선 모두 ↑)하되 진입가보다 낮은 가격대로 — 그래도 BUY 신호만 나오고 주문은 없어야 한다.
    await tick(h, 224, 124);
    await tick(h, 225, 125);
    expect(h.slots.get('A')!.getView().lastSignal).toBe('BUY');
    expect(broker.placed).toHaveLength(1);
    expect(h.pilot.getView().grids[0].holdingQty).toBe(broker.placed[0].qty);
  });
});

describe('추세 → 그리드 → 매매 — 청산(분봉5선 꺾임, 무조건)', () => {
  it('손실 중이어도 5선이 꺾이면 전량 매도하고 정산·감시 복귀', async () => {
    const h = makeHarness();
    await enter(h);
    const broker = h.brokers.get('A')!;
    const qty = h.pilot.getView().grids[0].holdingQty;
    await tick(h, 150, 124); // 키 123 닫힘(223) — 여전히 상승, 급락 봉 124 진행
    expect(broker.placed).toHaveLength(1);
    await tick(h, 151, 125); // 키 124 닫힘(150) → ma5 꺾임 → SELL
    expect(broker.placed).toHaveLength(2);
    expect(broker.placed[1].side).toBe('sell');
    expect(broker.placed[1].qty).toBe(qty);
    expect(h.trades).toHaveLength(1);
    expect(h.trades[0].pnl).toBeLessThan(0); // 문턱 없이 손실 청산
    expect(h.pilot.getView().activeTickers).toEqual([]);
  });

  it('손절선(−5%) — 봉 마감 전 틱에서 즉시 전량 매도, exitReason=STOP_LOSS', async () => {
    const h = makeHarness();
    await enter(h);
    const broker = h.brokers.get('A')!;
    const g = h.pilot.getView().grids[0];
    const stop = g.avgPrice * (1 - TREND_CONFIG.stopLossPct);
    expect(h.events.some((e) => e.includes('손절선'))).toBe(true);
    // 같은 분(키 123 진행 중) 안에서 −4%는 아직 아무 일도 없다 — 봉도 안 닫혔고 손절선 미달.
    h.slots.get('A')!.pushTick(g.avgPrice * 0.96, 123 * M + 5_000);
    await fireTimers(h); // 리프라이스 틱(1초) — 손절 판정 경로
    expect(broker.placed).toHaveLength(1);
    // −5% 아래 틱 → 봉 마감 없이 즉시 매도.
    h.slots.get('A')!.pushTick(stop * 0.999, 123 * M + 10_000);
    await fireTimers(h);
    expect(broker.placed).toHaveLength(2);
    expect(broker.placed[1].side).toBe('sell');
    expect(broker.placed[1].qty).toBe(g.holdingQty);
    expect(h.events.some((e) => e.includes('손절선 도달'))).toBe(true);
    await h.pilot.pollCycle();
    await flush();
    expect(h.trades).toHaveLength(1);
    expect(h.trades[0].exitReason).toBe('STOP_LOSS');
    expect(h.pilot.getView().activeTickers).toEqual([]);
  });

  it('손절 매도가 진행 중이면 봉 마감 SELL은 겹쳐 나가지 않는다(주문은 항상 1개)', async () => {
    const h = makeHarness();
    await enter(h);
    const broker = h.brokers.get('A')!;
    broker.autoFill = false;
    const g = h.pilot.getView().grids[0];
    h.slots.get('A')!.pushTick(g.avgPrice * 0.9, 123 * M + 10_000);
    await fireTimers(h);
    expect(broker.placed).toHaveLength(2);
    await tick(h, g.avgPrice * 0.9, 124); // 키 123 닫힘(급락) → 다음 봉에서 SELL이 떠도
    await tick(h, g.avgPrice * 0.9, 125);
    expect(broker.placed).toHaveLength(2); // 매도 주문은 여전히 하나
  });

  it('매도 추격에는 취소선이 없다 — 미체결 중 가격이 더 빠져도 취소하지 않는다', async () => {
    const h = makeHarness();
    await enter(h);
    const broker = h.brokers.get('A')!;
    broker.autoFill = false;
    await tick(h, 150, 124);
    await tick(h, 151, 125); // SELL → 매도 매매 시작(미체결)
    expect(broker.placed).toHaveLength(2);
    expect(broker.placed[1].side).toBe('sell');
    h.clock.advance(2000); // 재정정 스로틀(1초) 경과
    h.slots.get('A')!.pushTick(120, 125 * M + 5_000); // 더 빠진다
    await fireTimers(h);
    await h.pilot.pollCycle();
    await flush();
    expect(broker.canceled).toHaveLength(0);
    expect(h.trades).toHaveLength(0);
    expect(h.pilot.getView().activeTickers).toEqual(['A']);
    // 추격은 계속된다 — 정정으로 현재가를 따라간다.
    expect(broker.amended.length).toBeGreaterThan(0);
  });

  it('매도 정산 뒤 4선이 다시 2봉 연속 상승하면 재진입한다 — buy/sell/buy', async () => {
    const h = makeHarness();
    await enter(h);
    const broker = h.brokers.get('A')!;
    await tick(h, 150, 124);
    await tick(h, 151, 125); // SELL·정산
    expect(h.trades).toHaveLength(1);
    await tick(h, 400, 126); // 키 125 닫힘(151) — ma5 아직 하락(SELL, 미보유라 무시)
    await tick(h, 401, 127); // 키 126 닫힘(400) — 4선 ↑ 첫 봉(prevAllUp=false)
    expect(h.pilot.getView().activeTickers).toEqual([]);
    await tick(h, 402, 128); // 키 127 닫힘(401) — 2봉 연속 ↑ → BUY → 재진입
    expect(h.pilot.getView().activeTickers).toEqual(['A']);
    // 사이클마다 브로커가 새로 만들어진다 — 첫 브로커엔 buy/sell, 재진입 브로커엔 buy.
    expect(broker.placed.map((p) => p.side)).toEqual(['buy', 'sell']);
    const second = h.brokers.get('A')!;
    expect(second).not.toBe(broker);
    expect(second.placed.map((p) => p.side)).toEqual(['buy']);
  });

  it('진입 미체결(BUYING) 중 SELL은 무시된다 — 매도 주문 없음', async () => {
    const h = makeHarness({ autoFill: false });
    h.slots.get('A')!.seedTrend(risingSeed());
    h.pilot.start();
    await tick(h, 222, 122);
    await tick(h, 223, 123); // BUY → 매수 주문(미체결)
    const broker = h.brokers.get('A')!;
    expect(broker.placed).toHaveLength(1);
    await tick(h, 150, 124);
    await tick(h, 151, 125); // SELL — 보유 전이라 무시
    expect(broker.placed.filter((p) => p.side === 'sell')).toHaveLength(0);
    expect(h.pilot.getView().grids).toHaveLength(0);
  });
});

describe('추세 → 그리드 → 매매 — 입양·Stop', () => {
  it('입양 포지션도 추세 규칙으로 등록되고 SELL에 매도된다', async () => {
    const h = makeHarness({ positions: { A: { qty: 7, avgPrice: 200 } } });
    h.slots.get('A')!.seedTrend(risingSeed());
    h.pilot.start();
    expect(await h.pilot.adoptPosition('A')).toBeNull();
    expect(h.pilot.getView().grids[0]).toMatchObject({ ticker: 'A', holdingQty: 7, avgPrice: 200, sellPrice: 200 });
    expect(h.events.some((e) => e.includes('추세 관리 등록'))).toBe(true);
    const broker = h.brokers.get('A')!;
    await tick(h, 150, 122);
    await tick(h, 151, 123); // 키 122 닫힘(150) → SELL
    expect(broker.placed).toHaveLength(1);
    expect(broker.placed[0]).toMatchObject({ side: 'sell', qty: 7 });
    expect(h.trades).toHaveLength(1);
  });

  it('Stop은 STOP 매도를 내지 않고 관리만 놓는다', async () => {
    const h = makeHarness();
    await enter(h);
    const broker = h.brokers.get('A')!;
    h.pilot.stop();
    await flush();
    expect(h.pilot.getView().state).toBe('IDLE');
    expect(h.pilot.getView().activeTickers).toEqual([]);
    expect(broker.placed).toHaveLength(1);
  });
});
