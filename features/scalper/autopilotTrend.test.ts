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

/**
 * 오름차순 122봉 시드(키 0..121) — **마지막 봉(121)에만 눌림**을 넣어 다음 봉이 "4선 상승 플립"이 되게 한다.
 * 2026-08-21 순수 상태기계: BUY는 allUp(t) ∧ ¬allUp(t−1)인 엣지라, 계속 오르기만 하는 시드로는 신호가 나지 않는다.
 * 눌림 폭(6·step)은 ma5만 꺾고(close[121] < close[116]) ma20/60/120은 상승을 유지한다.
 */
const flipSeed = (step = 1) =>
  Array.from({ length: 122 }, (_, i) => ({ minuteKey: i, close: 100 + i * step - (i === 121 ? 6 * step : 0) }));

/** 종가 100..221(마지막 봉만 215로 눌림) — 다음 봉이 닫히면 플립 BUY. */
const risingSeed = () => flipSeed(1);

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
    positionManagement: {
      grid: { buyWidth: 0.05, sellWidth: 0.02, buyMultiplier: 1 },
      inflection: { sellProfitPct: 0.02, buyDropPct: 0.03 },
      trend: TREND_CONFIG,
    },
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

  it('챱 차단 없음(2026-08-21) — 밴드폭이 아주 좁은 완만한 상승도 플립이면 진입한다', async () => {
    const h = makeHarness();
    // 아주 완만한 상승 — 최근 20봉 밴드폭 ≈ 0.2%. 옛 규칙(밴드폭 <1.5% 차단)이면 막혔다.
    h.slots.get('A')!.seedTrend(flipSeed(0.01));
    h.pilot.start();
    await tick(h, 101.22, 122);
    await tick(h, 101.23, 123); // 키 122 닫힘 → 플립 BUY
    expect(h.pilot.getView().activeTickers).toEqual(['A']);
    expect(h.events.some((e) => e.includes('BUY 무시'))).toBe(false);
  });

  it('감시 요건 없음(2026-08-21) — 감시 목록 밖이어도 BUY면 진입한다', async () => {
    const h = makeHarness();
    h.slots.get('A')!.seedTrend(risingSeed());
    h.pilot.start(); // start 시점 reselect는 틱이 없어 감시가 비어 있다.
    h.slots.get('A')!.pushTick(222, 122 * M); // reselect 없이 봉만 진행 — 감시 목록은 빈 채
    h.slots.get('A')!.pushTick(223, 123 * M); // 키 122 닫힘 → 플립 BUY
    await flush();
    expect(h.pilot.getView().watched).toEqual([]);
    await h.pilot.pollCycle();
    await flush();
    expect(h.pilot.getView().activeTickers).toEqual(['A']);
  });

  it('BUY 폐기 이벤트는 종목당 10분에 1번만 남는다(스로틀) — 남은 폐기 사유는 틱속도', async () => {
    const h = makeHarness();
    h.pilot.setConfig({ startAmountUsd: 10_000, minTickRate: 1_000 }); // 어떤 틱속도로도 못 넘는 문턱
    h.slots.get('A')!.seedTrend(risingSeed());
    h.pilot.start();
    await tick(h, 222, 122);
    await tick(h, 223, 123); // 플립 BUY → 속도 미달로 폐기 — 이벤트 1건
    expect(h.pilot.getView().activeTickers).toEqual([]);
    expect(h.events.some((e) => e.includes('BUY 무시') && e.includes('속도'))).toBe(true);
    // 눌림 → 재플립으로 BUY를 한 번 더 만든다(엣지라 같은 상승 중에는 재발화하지 않는다).
    await tick(h, 215, 124); // 키 123 닫힘(223) — 아직 상승
    await tick(h, 224, 125); // 키 124 닫힘(215) — 눌림(allUp 깨짐)
    await tick(h, 225, 126); // 키 125 닫힘(224) — 다시 플립 → BUY → 같은 사유 재폐기(스로틀)
    expect(h.events.filter((e) => e.includes('BUY 무시')).length).toBe(1);
  });

  it('추격 진입 게이트 — 매도1호가가 신호가 +1%를 넘으면 진입하지 않는다', async () => {
    const h = makeHarness();
    h.slots.get('A')!.seedTrend(risingSeed());
    h.pilot.start();
    await tick(h, 222, 122);
    // 신호가는 봉을 닫는 새 틱(223) — ask1이 그보다 +3% 위(얇은 호가 추격 상황).
    h.slots.get('A')!.pushQuote(222, 230);
    await tick(h, 223, 123); // 키 122 닫힘 → BUY 신호 → 게이트가 막는다
    expect(h.pilot.getView().activeTickers).toEqual([]);
    expect(h.brokers.has('A')).toBe(false); // 브로커 생성(발주 준비) 전에 포기
    expect(h.events.some((e) => e.includes('추격 상한'))).toBe(true);
  });

  it('추격 진입 게이트 — 매도1호가가 신호가 +1% 이내면 그대로 진입한다', async () => {
    const h = makeHarness();
    h.slots.get('A')!.seedTrend(risingSeed());
    h.pilot.start();
    await tick(h, 222, 122);
    h.slots.get('A')!.pushQuote(222, 224); // +0.45% — 허용
    await tick(h, 223, 123);
    expect(h.pilot.getView().activeTickers).toEqual(['A']);
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

  it('보유 중 상승이 이어져도 BUY는 재발화하지 않는다(엣지) — 물타기 없음', async () => {
    const h = makeHarness();
    await enter(h);
    const broker = h.brokers.get('A')!;
    // 상승 유지(4선 모두 ↑) — 옛 규칙은 봉마다 BUY를 재발화했지만 이제 플립이 아니라 신호가 없다.
    await tick(h, 224, 124);
    await tick(h, 225, 125);
    expect(h.slots.get('A')!.getView().trend?.signal ?? null).toBeNull();
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

  it('손절선 없음 — 파는 기준은 4선 꺾임 하나뿐이되, 봉 마감을 기다리지 않는다(2026-08-22)', async () => {
    const h = makeHarness();
    await enter(h);
    const broker = h.brokers.get('A')!;
    const g = h.pilot.getView().grids[0];
    expect(TREND_CONFIG.stopLossPct).toBe(0);
    expect(h.events.some((e) => e.includes('손절선'))).toBe(false);
    // 같은 분(키 123 진행 중) 안에서 −30%가 나면 그 자리에서 4선이 꺾인다 → 봉이 닫히기 전에 매도.
    // 2026-08-21까지는 여기서 기다렸다(봉 마감 판정만) — 최대 한 봉(5분) 늦게 팔던 자리다.
    h.slots.get('A')!.pushTick(g.avgPrice * 0.7, 123 * M + 10_000);
    await fireTimers(h);
    expect(broker.placed).toHaveLength(2);
    expect(broker.placed[1].side).toBe('sell');
    await h.pilot.pollCycle();
    await flush();
    expect(h.trades).toHaveLength(1);
    expect(h.trades[0].exitReason).not.toBe('STOP_LOSS'); // 손절선이 아니라 SELL 신호로 나갔다.
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

  it('매도 정산 뒤 4선이 다시 플립하면 재진입한다 — buy/sell/buy', async () => {
    const h = makeHarness();
    await enter(h);
    const broker = h.brokers.get('A')!;
    await tick(h, 150, 124);
    await tick(h, 151, 125); // SELL·정산
    expect(h.trades).toHaveLength(1);
    await tick(h, 400, 126); // 키 125 닫힘(151) — 아직 하락(SELL, 미보유라 무시)
    expect(h.pilot.getView().activeTickers).toEqual([]);
    await tick(h, 401, 127); // 키 126 닫힘(400) — 4선 ↑ 플립 → BUY → 재진입(옛 규칙보다 한 봉 빠르다)
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

// ---- 서킷(LULD 정지) 관측·외부 청산 기록 (2026-08-19 서킷 도메인 문서) ----
// CIRCUIT_MODE=false(관측 단계): 정지·재개·서킷 상태 이벤트만 남기고 주문은 내지 않는다.

/** 정규장(ET 10:00) 시각으로 시계를 옮긴다 — 서킷 감지는 정규장 게이트 뒤에 있다. */
const ET_REGULAR = Date.UTC(2026, 7, 18, 14, 0, 0); // 2026-08-18 10:00 ET(EDT)

/** 1초 간격 체결 n건(슬롯 시계 기준). */
async function trades(h: Harness, n: number, price: number, barMinute: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    h.clock.advance(1000);
    h.slots.get('A')!.pushTick(price, barMinute * M + i * 1000, { volume: 100 });
    await fireTimers(h);
  }
}

/** 무체결 n초 — 매초 리프라이스 틱만 돈다. */
async function quiet(h: Harness, seconds: number): Promise<void> {
  for (let i = 0; i < seconds; i++) {
    h.clock.advance(1000);
    await fireTimers(h);
  }
}

describe('서킷 관측 — 정지·재개·서킷 상태 이벤트(주문 없음)', () => {
  it('활발한 뒤 45초 무체결 → 정지 감지 #1, 재개 뒤 창 3초 재정지 → #2 서킷 상태, 주문은 나가지 않는다', async () => {
    const h = makeHarness();
    await enter(h);
    const broker = h.brokers.get('A')!;
    broker.position = { qty: h.pilot.getView().grids[0].holdingQty, avgPrice: 223 };
    h.clock.set(ET_REGULAR);
    await trades(h, 40, 230, 123);
    await quiet(h, 46);
    expect(h.events.some((e) => e.includes("정지 감지 #1") && e.includes("첫 정지"))).toBe(true);
    // 300초 정지 뒤 재개(위 갭) → 3초 거래 → 다시 정지
    h.clock.advance(300_000);
    await trades(h, 3, 250, 123);
    expect(h.events.some((e) => e.includes('재개 · 첫 체결 250.00'))).toBe(true);
    await quiet(h, 46);
    expect(h.events.some((e) => e.includes('정지 감지 #2') && e.includes('재개 창 2초') && e.includes('서킷 상태'))).toBe(true);
    // 관측 모드 — 매도 주문 없음, 관리 유지
    expect(broker.placed).toHaveLength(1);
    expect(h.pilot.getView().activeTickers).toEqual(['A']);
  });

  it('정규장 밖(프리마켓)에서는 무체결이어도 정지를 감지하지 않는다', async () => {
    const h = makeHarness();
    await enter(h);
    h.brokers.get('A')!.position = { qty: 1, avgPrice: 223 };
    h.clock.set(Date.UTC(2026, 7, 18, 12, 0, 0)); // 08:00 ET
    await trades(h, 40, 230, 123);
    await quiet(h, 60);
    expect(h.events.some((e) => e.includes('정지 감지'))).toBe(false);
  });
});

describe('외부(수동) 청산 기록 — 잔고 재확인', () => {
  it('보유 중 잔고가 2회 연속(2분 간격) 비어 있으면 MANUAL로 정산하고 관리를 놓는다', async () => {
    const h = makeHarness();
    await enter(h);
    const broker = h.brokers.get('A')!;
    broker.position = null; // 앱 밖에서 팔림(잔고 없음)
    h.clock.advance(120_000);
    await h.pilot.pollCycle();
    await flush();
    expect(h.trades).toHaveLength(0); // 1회로는 끊지 않는다
    h.clock.advance(120_000);
    await h.pilot.pollCycle();
    await flush();
    expect(h.trades).toHaveLength(1);
    expect(h.trades[0].exitReason).toBe('MANUAL');
    expect(h.events.some((e) => e.includes('앱 밖(수동) 매도'))).toBe(true);
    expect(h.pilot.getView().activeTickers).toEqual([]);
  });

  it('잔고가 살아 있으면 정산하지 않는다(외부 부분 매도는 수량만 반영)', async () => {
    const h = makeHarness();
    await enter(h);
    const broker = h.brokers.get('A')!;
    const qty = h.pilot.getView().grids[0].holdingQty;
    broker.position = { qty, avgPrice: 223 };
    h.clock.advance(120_000);
    await h.pilot.pollCycle();
    h.clock.advance(120_000);
    await h.pilot.pollCycle();
    await flush();
    expect(h.trades).toHaveLength(0);
    broker.position = { qty: Math.max(1, qty - 1), avgPrice: 223 };
    h.clock.advance(120_000);
    await h.pilot.pollCycle();
    await flush();
    expect(h.pilot.getView().grids[0].holdingQty).toBe(Math.max(1, qty - 1));
  });
});

describe('추세 → 그리드 → 매매 — 사용자 요청 전량 매도(2026-08-22)', () => {
  it('sellNow는 신호를 기다리지 않고 전량을 매매로 넘긴다 — 청산 사유 USER_SELL', async () => {
    const h = makeHarness();
    await enter(h);
    const broker = h.brokers.get('A')!;
    const g = h.pilot.getView().grids[0];
    expect(broker.placed).toHaveLength(1); // 진입 매수뿐 — 4선은 아직 안 꺾였다.

    expect(h.pilot.sellNow('A')).toBeNull();
    await flush();
    expect(broker.placed).toHaveLength(2);
    expect(broker.placed[1].side).toBe('sell');
    expect(broker.placed[1].qty).toBe(g.holdingQty); // 전량

    await h.pilot.pollCycle();
    await flush();
    expect(h.trades).toHaveLength(1);
    expect(h.trades[0].exitReason).toBe('USER_SELL');
    expect(h.pilot.getView().activeTickers).toEqual([]);
    expect(h.events.some((e) => e.includes('사용자 매도 요청'))).toBe(true);
  });

  it('이미 매도 주문이 나가 있으면 두 번째 요청은 문구를 돌려준다(중복 발주 금지)', async () => {
    const h = makeHarness();
    await enter(h);
    h.brokers.get('A')!.autoFill = false; // 매도가 안 붙게 — 추격 중 상태를 만든다.
    expect(h.pilot.sellNow('A')).toBeNull();
    await flush();
    expect(h.pilot.sellNow('A')).toContain('이미 매도 주문이 나가 있어요');
    expect(h.brokers.get('A')!.placed.filter((o) => o.side === 'sell')).toHaveLength(1);
  });

  it('관리 중이 아니거나 시작 전이면 사유 문구 — 아무 주문도 내지 않는다', async () => {
    const h = makeHarness();
    expect(h.pilot.sellNow('A')).toContain('자동 트레이딩을 먼저 시작해 주세요');
    await enter(h);
    expect(h.pilot.sellNow('ZZZ')).toContain('관리 중이 아니에요');
    expect(h.brokers.get('A')!.placed).toHaveLength(1);
  });
});
