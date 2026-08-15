// 변곡점+그리드 조합(INFLECTION_GRID) — 진입 후 조건부 그리드+매매 경로의 통합 시나리오.
// 신호 생성은 기존 검증 시퀀스(버퍼 7·청크 1초 SG)를 그대로 쓴다 — 조합의 감지기 고정값(1초·21)은
// feedSlot.test.ts의 조합 모드 테스트가, 여기는 판단·실행 배선을 검증한다.
import { describe, expect, it } from 'vitest';

import type { TradeRecord } from '../../core/cycle';
import { AutoPilot, type AutoPilotConfig, type AutoPilotDeps, type InflectionGridConfig } from './autopilot';
import { FeedSlot } from './feedSlot';
import { FakeBroker, FakeStore, fakeClock, flush, noopScheduler } from './fakes';

// core/integration.test.ts에서 검증된 V자(버퍼 7·청크 1초) — 바닥 매수 신호.
const V = [20, 16, 12, 8, 4, 2, 4, 8, 12, 16, 20];

const TINY_RATE = 0.01;
const CONFIG: AutoPilotConfig = { startAmountUsd: 100, minTickRate: TINY_RATE };
const INFLECTION: InflectionGridConfig = { sellProfitPct: 0.02, buyDropPct: 0.03 };

interface Harness {
  pilot: AutoPilot;
  slots: Map<string, FeedSlot>;
  brokers: Map<string, FakeBroker>;
  clock: ReturnType<typeof fakeClock>;
  trades: TradeRecord[];
  events: string[];
  scheduler: ReturnType<typeof noopScheduler>;
}

function makeHarness(opts: { fetchBuyableUsd?: AutoPilotDeps['fetchBuyableUsd'] } = {}): Harness {
  const clock = fakeClock(1000);
  const slots = new Map([
    ['A', new FeedSlot({ ticker: 'A', clock, chunkSeconds: 1, bufferSize: 7, minSellMomentum: 0 })],
  ]);
  const brokers = new Map<string, FakeBroker>();
  const trades: TradeRecord[] = [];
  const events: string[] = [];
  const scheduler = noopScheduler();
  const pilot = new AutoPilot({
    slots: () => [...slots.values()],
    pin: () => {},
    unpin: () => {},
    makeBroker: (t) => {
      const b = new FakeBroker({ autoFill: true });
      brokers.set(t, b);
      return b;
    },
    fetchBuyableUsd: opts.fetchBuyableUsd,
    // 롤백 대비 실배선처럼 gridConfig도 함께 주입한다 — 조합이 우선해야 한다(OCO 두 다리가 나가면 안 된다).
    gridConfig: { buyWidth: 0.05, sellWidth: 0.02, buyMultiplier: 1 },
    inflectionConfig: INFLECTION,
    clock,
    scheduler,
    storage: new FakeStore(),
    onTrade: (r) => trades.push(r),
    onEvent: (e) => events.push(e.text),
  });
  pilot.setConfig(CONFIG);
  return { pilot, slots, brokers, clock, trades, events, scheduler };
}

/** 가격 시퀀스를 초당 1틱 재생 + 재선정·체결 폴링(기존 autopilot.test 하네스와 동일 리듬). */
async function replay(h: Harness, prices: number[], startIndex = 0): Promise<number> {
  const slot = h.slots.get('A')!;
  let i = startIndex;
  for (const price of prices) {
    slot.pushTick(price, i * 1000);
    h.pilot.reselect();
    h.clock.advance(1000);
    await flush();
    await h.pilot.pollCycle();
    await flush();
    i += 1;
  }
  return i;
}

/** 스케줄러에 등록된 타이머 콜백(재선정·폴·리프라이스) 전부 1회 발화 — 매매 추격(onPrice) 구동용. */
async function fireTimers(h: Harness): Promise<void> {
  for (const fn of h.scheduler.fired) fn();
  await flush();
  await flush();
}

/** V자 진입 → 조건부 그리드 인계까지 진행하고 다음 인덱스를 돌려준다. */
async function enter(h: Harness): Promise<number> {
  h.pilot.start();
  const i = await replay(h, V);
  expect(h.pilot.getView().activeTickers).toEqual(['A']);
  expect(h.pilot.getView().grids).toHaveLength(1);
  return i;
}

/** 현재 관리 평단 기준 상대 가격 시퀀스 생성 — 상승 꼭짓점/하락 바닥에서 SG 부호 전환 신호가 난다. */
function hill(avg: number, peakRatio: number, steps = 6): number[] {
  const out: number[] = [];
  for (let s = 1; s <= steps; s += 1) out.push(avg * (1 + ((peakRatio - 1) * s) / steps));
  for (let s = steps - 1; s >= 0; s -= 1) out.push(avg * (1 + ((peakRatio - 1) * s) / steps));
  return out.map((p) => Number(p.toFixed(4)));
}

function valley(avg: number, bottomRatio: number, steps = 6): number[] {
  const out: number[] = [];
  for (let s = 1; s <= steps; s += 1) out.push(avg * (1 - ((1 - bottomRatio) * s) / steps));
  for (let s = steps - 1; s >= 0; s -= 1) out.push(avg * (1 - ((1 - bottomRatio) * s) / steps));
  return out.map((p) => Number(p.toFixed(4)));
}

describe('변곡점+그리드 조합 — 인계', () => {
  it('진입 체결 후 조건부 그리드가 인계한다 — OCO 주문 없이 조건선만 세운다', async () => {
    const h = makeHarness();
    await enter(h);
    const broker = h.brokers.get('A')!;
    // 나간 주문은 진입 매수 1건뿐 — OCO 그리드였다면 매도·매수 두 다리가 더 나갔다.
    expect(broker.placed).toHaveLength(1);
    expect(broker.placed[0].side).toBe('buy');
    const g = h.pilot.getView().grids[0];
    expect(g.gridActive).toBe(true);
    expect(g.sellPrice).toBeCloseTo(g.avgPrice * 1.02);
    expect(g.buyPrice).toBeCloseTo(g.avgPrice * 0.97);
    expect(h.events.some((e) => e.includes('변곡점 그리드 인계'))).toBe(true);
  });
});

describe('변곡점+그리드 조합 — 매도(고점 변곡점 + 수익 조건)', () => {
  it('+2% 미만의 고점 변곡점은 판다는 신호가 와도 팔지 않는다(홀딩)', async () => {
    const h = makeHarness();
    let i = await enter(h);
    const broker = h.brokers.get('A')!;
    const avg = h.pilot.getView().grids[0].avgPrice;
    // 평단 +1.5%까지 올랐다 꺾인다 — 고점(SELL) 신호는 나지만 문턱(+2%) 미만.
    i = await replay(h, hill(avg, 1.015), i);
    expect(broker.placed).toHaveLength(1); // 매도 주문 없음
    expect(h.pilot.getView().activeTickers).toEqual(['A']); // 계속 보유
    expect(h.trades).toHaveLength(0);
  });

  it('+2% 이상의 고점 변곡점 → 전량 매도(현재가 추격 매매) → 정산·감시 복귀', async () => {
    const h = makeHarness();
    let i = await enter(h);
    const broker = h.brokers.get('A')!;
    const entryQty = h.pilot.getView().grids[0].holdingQty;
    const avg = h.pilot.getView().grids[0].avgPrice;
    i = await replay(h, hill(avg, 1.1), i); // +10% 꼭짓점 뒤 꺾임 — 고점 신호가 문턱 위에서 난다.
    expect(h.trades).toHaveLength(1);
    expect(h.trades[0].qty).toBe(entryQty);
    expect(h.trades[0].pnl).toBeGreaterThan(0);
    // 나간 주문 = 진입 매수 + 매매 매도(현재가 지정가) 딱 2건.
    expect(broker.placed).toHaveLength(2);
    expect(broker.placed[1].side).toBe('sell');
    expect(broker.placed[1].qty).toBe(entryQty);
    expect(broker.placed[1].price).toBeGreaterThanOrEqual(avg * 1.02); // 문턱 위에서만 판다
    expect(h.pilot.getView().activeTickers).toEqual([]); // 정산 후 감시 복귀
  });
});

describe('변곡점+그리드 조합 — 매수(상승 변곡점 + 낙폭 조건)', () => {
  it('낙폭이 −3%에 못 미치는 상승 변곡점은 물타지 않는다', async () => {
    const h = makeHarness();
    let i = await enter(h);
    const broker = h.brokers.get('A')!;
    const avg = h.pilot.getView().grids[0].avgPrice;
    i = await replay(h, valley(avg, 0.985), i); // −1.5% 바닥 반등 — BUY 신호는 나지만 낙폭 부족.
    expect(broker.placed).toHaveLength(1); // 물타기 없음
    expect(h.pilot.getView().grids[0].holdingQty).toBe(broker.placed[0].qty);
  });

  it('−3% 이하의 상승 변곡점 → 최초 진입 수량만큼 물타기 → 평단 하향', async () => {
    const h = makeHarness();
    let i = await enter(h);
    const broker = h.brokers.get('A')!;
    const entryQty = h.pilot.getView().grids[0].holdingQty;
    const avg = h.pilot.getView().grids[0].avgPrice;
    i = await replay(h, valley(avg, 0.85, 8), i); // 깊은 바닥(−15%) 반등 — 신호 시점 가격도 문턱(−3%) 아래다.
    expect(broker.placed).toHaveLength(2);
    expect(broker.placed[1].side).toBe('buy');
    expect(broker.placed[1].qty).toBe(entryQty); // 고정 수량 — 배수 아님
    expect(broker.placed[1].price).toBeLessThanOrEqual(avg * 0.97);
    const g = h.pilot.getView().grids[0];
    expect(g.holdingQty).toBe(entryQty * 2);
    expect(g.avgPrice).toBeLessThan(avg); // 평단 하향
    expect(g.sellPrice).toBeCloseTo(g.avgPrice * 1.02); // 조건선도 새 평단 기준
  });

  it('물타기 현금 부족이면 매수를 생략하고 계속 감시한다', async () => {
    let buyable = 10_000; // 진입은 넉넉히 — 진입 경로도 같은 조회를 본다.
    const h = makeHarness({ fetchBuyableUsd: async () => buyable });
    let i = await enter(h);
    const broker = h.brokers.get('A')!;
    const avg = h.pilot.getView().grids[0].avgPrice;
    buyable = 1; // 이제 물타기 살 돈이 없다.
    i = await replay(h, valley(avg, 0.85, 8), i); // 낙폭 문턱은 충족 — 현금 판정에서 생략돼야 한다.
    expect(broker.placed).toHaveLength(1); // 물타기 주문 없음
    expect(h.pilot.getView().activeTickers).toEqual(['A']); // 관리 유지(PAUSED 아님)
    expect(h.events.some((e) => e.includes('물타기 생략'))).toBe(true);
  });
});

describe('변곡점+그리드 조합 — 매매 추격 취소선', () => {
  it('매도 추격 중 +2% 아래로 좁아지면 주문을 취소하고 다음 변곡점을 기다린다', async () => {
    const h = makeHarness();
    let i = await enter(h);
    const broker = h.brokers.get('A')!;
    broker.autoFill = false; // 이후 매매 주문은 미체결로 둔다 — 추격·취소선 검증.
    const avg = h.pilot.getView().grids[0].avgPrice;
    i = await replay(h, hill(avg, 1.1), i); // 고점 신호 → 매도 매매 시작(미체결).
    expect(broker.placed).toHaveLength(2);
    expect(h.trades).toHaveLength(0);
    // 체결 없이 가격이 문턱 아래로 무너진다 — 빠른 틱(리프라이스 타이머)이 취소선을 판정한다.
    h.slots.get('A')!.pushTick(avg * 1.01, i * 1000);
    await fireTimers(h);
    await h.pilot.pollCycle();
    await flush();
    expect(broker.canceled).toHaveLength(1); // 잔량 취소
    expect(h.trades).toHaveLength(0); // 체결 없음 — 정산 없음
    expect(h.pilot.getView().activeTickers).toEqual(['A']); // 관리는 계속(다음 변곡점 대기)
    expect(h.events.some((e) => e.includes('추격 취소'))).toBe(true);
  });
});

describe('변곡점+그리드 조합 — Stop', () => {
  it('Stop은 STOP 매도를 내지 않고 관리만 놓는다(걸린 지정가가 없다)', async () => {
    const h = makeHarness();
    await enter(h);
    const broker = h.brokers.get('A')!;
    h.pilot.stop();
    await flush();
    expect(h.pilot.getView().state).toBe('IDLE');
    expect(h.pilot.getView().activeTickers).toEqual([]);
    expect(broker.placed).toHaveLength(1); // 진입 매수뿐 — STOP 매도 없음
  });
});
