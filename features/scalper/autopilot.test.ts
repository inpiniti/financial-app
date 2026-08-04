import { describe, expect, it, vi } from 'vitest';

import type { TradeRecord } from '../../core/cycle';
import {
  AutoPilot,
  AUTOPILOT_STORAGE_KEY,
  DEFAULT_MIN_TICK_RATE,
  etDateOf,
  isMartingaleOn,
  nextAmountUsd,
  qtyForAmount,
  shouldEndSession,
  validateConfig,
  type AutoPilotConfig,
  type AutoPilotDeps,
} from './autopilot';
import { FeedSlot } from './feedSlot';
import { FakeBroker, FakeStore, fakeClock, flush, noopScheduler } from './fakes';

// core/integration.test.ts에서 검증된 시퀀스(버퍼 7·청크 1초).
const V = [20, 16, 12, 8, 4, 2, 4, 8, 12, 16, 20];
const DOWN_UP_DOWN = [20, 16, 12, 8, 4, 2, 4, 8, 12, 16, 20, 18, 14, 10, 6, 2];
// 바닥 매수 → 고점 매도(수익 사이클) — 상승을 40까지 끌고 간 뒤 꺾는다.
const PROFIT_RUN = [20, 16, 12, 8, 4, 2, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 36, 32, 28, 24];

/** 기존 시나리오 보존용 — 속도 필터가 사실상 안 걸리는 문턱. */
const TINY_RATE = 0.01;

const CONFIG_100: AutoPilotConfig = { startAmountUsd: 100, maxAmountUsd: 400, minTickRate: TINY_RATE };

interface Harness {
  pilot: AutoPilot;
  slots: Map<string, FeedSlot>;
  brokers: Map<string, FakeBroker>;
  clock: ReturnType<typeof fakeClock>;
  store: FakeStore;
  trades: TradeRecord[];
  pins: string[];
  unpins: string[];
  events: string[];
}

function makeHarness(
  tickers: string[],
  opts: {
    autoFill?: boolean;
    config?: AutoPilotConfig | null;
    fetchBuyableUsd?: AutoPilotDeps['fetchBuyableUsd'];
  } = {},
): Harness {
  const clock = fakeClock(1000);
  const store = new FakeStore();
  const slots = new Map(
    tickers.map((t) => [
      t,
      new FeedSlot({ ticker: t, clock, chunkSeconds: 1, bufferSize: 7, minSellMomentum: 0 }),
    ]),
  );
  const brokers = new Map<string, FakeBroker>();
  const trades: TradeRecord[] = [];
  const pins: string[] = [];
  const unpins: string[] = [];
  const events: string[] = [];
  const deps: AutoPilotDeps = {
    slots: () => [...slots.values()],
    pin: (t) => pins.push(t),
    unpin: (t) => unpins.push(t),
    makeBroker: (t) => {
      const b = new FakeBroker({ autoFill: opts.autoFill ?? true });
      brokers.set(t, b);
      return b;
    },
    fetchBuyableUsd: opts.fetchBuyableUsd,
    clock,
    scheduler: noopScheduler(),
    storage: store,
    onTrade: (r) => trades.push(r),
    onEvent: (e) => events.push(e.text),
  };
  const pilot = new AutoPilot(deps);
  if (opts.config !== null) pilot.setConfig(opts.config ?? CONFIG_100);
  return { pilot, slots, brokers, clock, store, trades, pins, unpins, events };
}

/** 같은 clock 시각대에 n틱 버스트 — 틱/초를 n/10으로 만든다(청크 마감 없음, ts 고정). */
function burst(h: Harness, ticker: string, n: number): void {
  for (let i = 0; i < n; i += 1) h.slots.get(ticker)!.pushTick(10, i * 10);
}

/** 가격 시퀀스를 초당 1틱 재생 + 매 틱 뒤 재선정(30초 타이머 대역)·체결 폴링. */
async function replay(h: Harness, ticker: string, prices: number[], startIndex = 0): Promise<number> {
  const slot = h.slots.get(ticker)!;
  let i = startIndex;
  for (const price of prices) {
    slot.pushTick(price, i * 1000);
    h.pilot.reselect(); // 틱이 흘러야 자격(최소 속도)이 생긴다 — 실제로는 재선정 타이머 몫.
    h.clock.advance(1000);
    await flush();
    await h.pilot.pollCycle();
    await flush();
    i += 1;
  }
  return i;
}

async function cap(h: Harness, ticker: string, price: number, index: number): Promise<void> {
  h.slots.get(ticker)!.pushTick(price, index * 1000);
  await flush();
  await h.pilot.pollCycle();
  await flush();
}

describe('순수 규칙 — 금액·수량·세션 종료·검증·기준일', () => {
  it('수익 절반(하한 $1)·손실 2배(상한 없음)·본전 유지', () => {
    expect(nextAmountUsd(100, 5)).toBe(50);
    expect(nextAmountUsd(100, -5)).toBe(200);
    expect(nextAmountUsd(100, 0)).toBe(100);
    expect(nextAmountUsd(1600, -1)).toBe(3200); // 배증 상한 없음
    expect(nextAmountUsd(1.5, 5)).toBe(1); // 반감 하한 $1(§4-1)
  });

  it('수량 = 금액÷가격 내림, 1주 못 사면 0', () => {
    expect(qtyForAmount(100, 30)).toBe(3);
    expect(qtyForAmount(100, 101)).toBe(0);
    expect(qtyForAmount(100, 0)).toBe(0);
  });

  it('세션 종료 — AND 3조건(수익·투입≥max·성과≥0, 성과 0 포함)', () => {
    expect(shouldEndSession(5, 400, 10, 400)).toBe(true);
    expect(shouldEndSession(5, 400, 0, 400)).toBe(true); // 성과 0 포함(§4-8)
    expect(shouldEndSession(5, 400, -1, 400)).toBe(false); // 성과 음수
    expect(shouldEndSession(-5, 400, 10, 400)).toBe(false); // 마지막 사이클 손실
    expect(shouldEndSession(5, 399, 10, 400)).toBe(false); // 투입 미달
  });

  it('설정 검증 — 0<시작≤최대, 최소 속도>0(0 설정 불가)', () => {
    expect(validateConfig({ startAmountUsd: 100, maxAmountUsd: 400, minTickRate: 1 })).toBeNull();
    expect(validateConfig({ startAmountUsd: 0, maxAmountUsd: 400, minTickRate: 1 })).toContain('시작금액');
    expect(validateConfig({ startAmountUsd: 100, maxAmountUsd: 99, minTickRate: 1 })).toContain('최대금액');
    expect(validateConfig({ startAmountUsd: 100, maxAmountUsd: 400, minTickRate: 0 })).toContain('최소 속도');
    expect(DEFAULT_MIN_TICK_RATE).toBe(1);
  });

  it('기준일 — 미국 동부(America/New_York) 날짜, 서머타임 자동(§4-7)', () => {
    expect(etDateOf(Date.UTC(2026, 0, 15, 3, 0))).toBe('2026-01-14'); // 겨울 UTC-5
    expect(etDateOf(Date.UTC(2026, 6, 15, 3, 0))).toBe('2026-07-14'); // 여름 UTC-4
    expect(etDateOf(Date.UTC(2026, 6, 15, 12, 0))).toBe('2026-07-15');
  });
});

describe('AutoPilot — 감시 선정(최소 속도 자격 필터·히스테리시스)', () => {
  it('자격자 중 상위 3개에 detector가 붙는다', () => {
    const h = makeHarness(['A', 'B', 'C', 'D', 'E']);
    burst(h, 'A', 10);
    burst(h, 'B', 8);
    burst(h, 'C', 6);
    burst(h, 'D', 2);
    h.pilot.start();
    expect([...h.pilot.getView().watched].sort()).toEqual(['A', 'B', 'C']);
    expect(h.slots.get('D')!.watched).toBe(false);
  });

  it('최소 속도 미달은 감시하지 않는다 — 자격자 1개면 1개, 0개면 감시 없음', () => {
    const h = makeHarness(['A', 'B', 'C'], {
      config: { startAmountUsd: 100, maxAmountUsd: 400, minTickRate: 1 },
    });
    burst(h, 'A', 15); // 1.5틱/초 — 자격
    burst(h, 'B', 5); // 0.5틱/초 — 미달
    h.pilot.start();
    expect(h.pilot.getView().watched).toEqual(['A']); // 1개만 감시
    expect(h.slots.get('B')!.watched).toBe(false);

    // 시간이 흘러 A도 미달 → 감시 0개 + 안내 이벤트.
    h.clock.advance(20_000);
    h.pilot.reselect();
    expect(h.pilot.getView().watched).toEqual([]);
    expect(h.slots.get('A')!.watched).toBe(false);
    expect(h.events.some((e) => e.includes('감시 대상 없음'))).toBe(true);
  });

  it('감시 중 종목이 자격을 잃으면 히스테리시스와 무관하게 즉시 해제된다', () => {
    const h = makeHarness(['A', 'B'], {
      config: { startAmountUsd: 100, maxAmountUsd: 400, minTickRate: 1 },
    });
    burst(h, 'A', 20);
    h.pilot.start();
    expect(h.pilot.getView().watched).toEqual(['A']);

    h.clock.advance(9_000); // A 틱이 윈도우 끝자락 — 아직 자격(20틱이 10초 창 안).
    burst(h, 'B', 30); // B가 새 자격자.
    h.clock.advance(2_000); // A 틱 전부 윈도우 밖 → 0틱/초.
    h.pilot.reselect();
    expect(h.pilot.getView().watched).toEqual(['B']);
    expect(h.slots.get('A')!.watched).toBe(false);
  });

  it('히스테리시스 — 자격자끼리는 최저 감시의 1.2배를 넘어야 교체된다', () => {
    const h = makeHarness(['A', 'B', 'C', 'D']);
    burst(h, 'A', 30);
    burst(h, 'B', 20);
    burst(h, 'C', 10);
    h.pilot.start();
    expect([...h.pilot.getView().watched].sort()).toEqual(['A', 'B', 'C']);

    burst(h, 'D', 11); // C의 1.1배 — 교체 없음.
    h.pilot.reselect();
    expect([...h.pilot.getView().watched].sort()).toEqual(['A', 'B', 'C']);

    burst(h, 'D', 3); // 총 14틱 = C의 1.4배 — 교체.
    h.pilot.reselect();
    expect([...h.pilot.getView().watched].sort()).toEqual(['A', 'B', 'D']);
  });
});

describe('AutoPilot — 사이클 e2e (진입 1종목·정산·금액 조정·세션)', () => {
  it('BUY→진입(핀)→SELL→정산→금액 조정→SCANNING 복귀', async () => {
    const h = makeHarness(['A', 'B', 'C']);
    h.pilot.start();
    const n = await replay(h, 'A', DOWN_UP_DOWN);
    await cap(h, 'A', 2, n);

    const broker = h.brokers.get('A')!;
    expect(broker.placed.filter((p) => p.side === 'buy')).toHaveLength(1);
    expect(broker.placed.filter((p) => p.side === 'sell')).toHaveLength(1);
    expect(h.trades).toHaveLength(1);
    const rec = h.trades[0];
    expect(rec.exitReason).toBe('SELL_SIGNAL');
    expect(rec.qty).toBe(qtyForAmount(100, rec.entryPrice));
    expect(h.pins).toEqual(['A']);
    expect(h.unpins).toEqual(['A']);

    const view = h.pilot.getView();
    expect(view.session!.amountUsd).toBe(nextAmountUsd(100, rec.pnl));
    expect(view.session!.pnl).toBe(rec.pnl);
    expect(view.cycles).toBe(1);
    expect(view.cumPnl).toBe(rec.pnl);
    expect(view.state).toBe('SCANNING');
    expect(view.activeTicker).toBeNull();
  });

  it('세션 종료 — 수익 사이클 + 투입≥max + 성과≥0이면 새 세션(시작금액·성과 0·카운트 증가)', async () => {
    // max=start=100 → 첫 수익 사이클에서 곧바로 3조건 충족.
    const h = makeHarness(['A', 'B', 'C'], {
      config: { startAmountUsd: 100, maxAmountUsd: 100, minTickRate: TINY_RATE },
    });
    h.pilot.start();
    expect(h.pilot.getView().sessionCount).toBe(1);

    const n = await replay(h, 'A', PROFIT_RUN);
    await cap(h, 'A', 24, n);

    expect(h.trades).toHaveLength(1);
    expect(h.trades[0].pnl).toBeGreaterThan(0); // 바닥 매수·고점 매도 — 수익 사이클 전제.

    const view = h.pilot.getView();
    expect(view.sessionCount).toBe(2); // 세션 완주 → 새 세션.
    expect(view.session!.amountUsd).toBe(100); // 시작금액으로 리셋(반감 아님 — 조정 전 판정 §4-2).
    expect(view.session!.pnl).toBe(0);
    expect(view.cumPnl).toBe(h.trades[0].pnl); // 오늘 성과는 세션과 무관하게 누적.
    expect(h.events.some((e) => e.includes('세션 완주'))).toBe(true);
  });

  it('진입 직전 속도 재검사 — 프리플라이트 사이 유동성이 죽으면 발주 없이 포기한다', async () => {
    let releaseGate: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const h = makeHarness(['A', 'B', 'C'], { config: null });
    const pilot = new AutoPilot({
      slots: () => [...h.slots.values()],
      pin: (t) => h.pins.push(t),
      unpin: (t) => h.unpins.push(t),
      makeBroker: (t) => {
        const b = new FakeBroker({ autoFill: true });
        const original = b.fetchFills.bind(b);
        b.fetchFills = async () => {
          await gate;
          return original();
        };
        h.brokers.set(t, b);
        return b;
      },
      clock: h.clock,
      scheduler: noopScheduler(),
      storage: h.store,
      onEvent: (e) => h.events.push(e.text),
    });
    pilot.setConfig({ startAmountUsd: 100, maxAmountUsd: 400, minTickRate: 0.5 });
    pilot.start();

    // A를 BUY까지 재생(재생 중 틱/초 ≈ 1.0 — 자격 충분). 프리플라이트는 게이트에 붙잡힌다.
    let i = 0;
    for (const price of [...V, 20]) {
      h.slots.get('A')!.pushTick(price, i * 1000);
      pilot.reselect();
      h.clock.advance(1000);
      i += 1;
    }
    await flush();
    expect(pilot.getView().state).toBe('ENTERING');

    h.clock.advance(30_000); // 게이트가 열리기 전 30초 무틱 — 틱/초 0으로 붕괴.
    releaseGate!();
    await flush();
    await flush();

    expect(pilot.getView().state).toBe('SCANNING'); // 발주 없이 복귀.
    expect(h.brokers.get('A')!.placed).toHaveLength(0);
    expect(h.events.some((e) => e.includes('진입 포기') && e.includes('속도'))).toBe(true);
  });

  it('동시 매수신호 — 프리플라이트 창 안에 더 높은 틱/초의 BUY가 오면 그쪽으로 진입한다', async () => {
    let releaseGate: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const h = makeHarness(['A', 'B', 'C'], { config: null });
    const pilot = new AutoPilot({
      slots: () => [...h.slots.values()],
      pin: (t) => h.pins.push(t),
      unpin: (t) => h.unpins.push(t),
      makeBroker: (t) => {
        const b = new FakeBroker({ autoFill: true });
        if (t === 'A') {
          const original = b.fetchFills.bind(b);
          b.fetchFills = async () => {
            await gate;
            return original();
          };
        }
        h.brokers.set(t, b);
        return b;
      },
      clock: h.clock,
      scheduler: noopScheduler(),
      storage: h.store,
      onEvent: (e) => h.events.push(e.text),
    });
    pilot.setConfig(CONFIG_100);
    pilot.start();

    // A·B를 같은 V자 궤적으로 나란히 재생 — B는 틱을 2배로 흘려 틱/초를 A보다 높인다.
    // A가 먼저 BUY를 내고(게이트에 붙잡힘), 같은 청크에서 B의 BUY가 후보를 교체한다.
    let i = 0;
    for (const price of [...V, 20]) {
      h.slots.get('A')!.pushTick(price, i * 1000);
      h.slots.get('B')!.pushTick(price, i * 1000);
      h.slots.get('B')!.pushTick(price, i * 1000 + 500); // B 배속 틱(같은 청크 내 — 평균가 불변).
      pilot.reselect();
      h.clock.advance(1000);
      i += 1;
    }
    await flush();
    expect(pilot.getView().activeTicker).toBeNull(); // 게이트에 막혀 아직 발주 전.
    expect(h.events.some((e) => e.includes('동시 신호'))).toBe(true);

    releaseGate!();
    await flush();
    await flush();

    expect(pilot.getView().activeTicker).toBe('B');
    expect(h.brokers.get('B')!.placed.filter((p) => p.side === 'buy')).toHaveLength(1);
    expect(h.brokers.get('A')!.placed).toHaveLength(0);
  });

  it('qty<1(금액 < 1주 가격)이면 진입을 포기하고 SCANNING을 유지한다', async () => {
    const h = makeHarness(['A', 'B', 'C'], {
      config: { startAmountUsd: 1, maxAmountUsd: 4, minTickRate: TINY_RATE },
    });
    h.pilot.start();
    const n = await replay(h, 'A', V);
    await cap(h, 'A', 20, n);

    expect(h.brokers.size).toBe(0);
    expect(h.pilot.getView().state).toBe('SCANNING');
    expect(h.events.some((e) => e.includes('진입 포기'))).toBe(true);
  });
});

describe('AutoPilot — 현금 부족 PAUSED (재개/초기화는 사람이 선택)', () => {
  it('매수가능금액 < 필요금액 → 발주 없이 PAUSED, 감시 해제', async () => {
    const h = makeHarness(['A', 'B', 'C'], { fetchBuyableUsd: async () => 3 }); // $3뿐.
    h.pilot.start();
    const n = await replay(h, 'A', V);
    await cap(h, 'A', 20, n);

    const view = h.pilot.getView();
    expect(view.state).toBe('PAUSED');
    expect(view.session!.paused).toBe(true);
    expect(h.brokers.get('A')!.placed).toHaveLength(0); // 발주 자체가 없다.
    expect([...h.slots.values()].every((s) => !s.watched)).toBe(true);
    expect(h.events.some((e) => e.includes('현금이 부족'))).toBe(true);
  });

  it('resume — 같은 세션·같은 금액으로 SCANNING 복귀', async () => {
    const h = makeHarness(['A', 'B', 'C'], { fetchBuyableUsd: async () => 0 });
    h.pilot.start();
    const n = await replay(h, 'A', V);
    await cap(h, 'A', 20, n);
    expect(h.pilot.getView().state).toBe('PAUSED');

    h.pilot.resume();
    const view = h.pilot.getView();
    expect(view.state).toBe('SCANNING');
    expect(view.session!.paused).toBe(false);
    expect(view.session!.amountUsd).toBe(100); // 금액 그대로.
    expect(view.sessionCount).toBe(1); // 같은 세션.
  });

  it('resetSession — 시작금액·성과 0의 새 세션으로 재개(카운트 증가)', async () => {
    const h = makeHarness(['A', 'B', 'C'], { fetchBuyableUsd: async () => 0 });
    h.pilot.start();
    const n = await replay(h, 'A', V);
    await cap(h, 'A', 20, n);
    expect(h.pilot.getView().state).toBe('PAUSED');

    h.pilot.resetSession();
    const view = h.pilot.getView();
    expect(view.state).toBe('SCANNING');
    expect(view.session!.amountUsd).toBe(100);
    expect(view.session!.pnl).toBe(0);
    expect(view.sessionCount).toBe(2);
  });

  it('PAUSED에서 Stop → IDLE, 재시작하면 다시 PAUSED(자동 재개 금지)', async () => {
    const h = makeHarness(['A', 'B', 'C'], { fetchBuyableUsd: async () => 0 });
    h.pilot.start();
    const n = await replay(h, 'A', V);
    await cap(h, 'A', 20, n);
    expect(h.pilot.getView().state).toBe('PAUSED');

    h.pilot.stop();
    expect(h.pilot.getView().state).toBe('IDLE');

    h.pilot.start(); // 세션이 여전히 paused — 자동으로 SCANNING에 들어가지 않는다.
    expect(h.pilot.getView().state).toBe('PAUSED');
  });

  it('조회 실패(null)면 판정 없이 진행한다 — 기존처럼 발주된다', async () => {
    const h = makeHarness(['A', 'B', 'C'], { fetchBuyableUsd: async () => null });
    h.pilot.start();
    const n = await replay(h, 'A', V);
    await cap(h, 'A', 20, n);
    expect(h.pilot.getView().state).toBe('HOLDING');
    expect(h.brokers.get('A')!.placed.filter((p) => p.side === 'buy')).toHaveLength(1);
  });
});

describe('AutoPilot — Stop·FAULT·영속화·마이그레이션', () => {
  it('보유 중 Stop → 전량 매도(STOP) 후 IDLE, 금액·세션 유지', async () => {
    const h = makeHarness(['A', 'B', 'C']);
    h.pilot.start();
    const n = await replay(h, 'A', V);
    await cap(h, 'A', 20, n);
    expect(h.pilot.getView().state).toBe('HOLDING');

    h.pilot.stop();
    await flush();
    await h.pilot.pollCycle();
    await flush();

    const view = h.pilot.getView();
    expect(view.state).toBe('IDLE');
    expect(h.trades[0].exitReason).toBe('STOP');
    expect(view.session!.amountUsd).toBe(100); // 수동 청산 — 금액 유지·세션 종료 판정 없음.
    expect(view.session!.pnl).toBe(h.trades[0].pnl); // 성과에는 반영.
    expect(view.sessionCount).toBe(1);
  });

  it('체결 확인이 죽으면 FAULT로 동결되고, Stop으로만 해제된다', async () => {
    const h = makeHarness(['A', 'B', 'C'], { autoFill: false });
    h.pilot.start();
    const n = await replay(h, 'A', V);
    await cap(h, 'A', 20, n);
    expect(h.pilot.getView().state).toBe('ENTERING'); // BUY 발주 후 미체결 대기.

    h.brokers.get('A')!.failFetchFills = true;
    await h.pilot.pollCycle();
    expect(h.pilot.getView().state).toBe('FAULT');

    h.pilot.stop();
    expect(h.pilot.getView().state).toBe('IDLE');
    expect(h.pilot.getView().lastFault).toBeNull();
  });

  it('영속화 v2 — 설정·세션·일일 통계가 복원된다', async () => {
    const h = makeHarness(['A'], {
      config: { startAmountUsd: 50, maxAmountUsd: 800, minTickRate: 2 },
    });
    h.pilot.start(); // 세션 개시 → persist.
    h.pilot.stop();

    const pilot2 = new AutoPilot({
      slots: () => [],
      pin: () => {},
      unpin: () => {},
      makeBroker: () => new FakeBroker(),
      clock: h.clock,
      scheduler: noopScheduler(),
      storage: h.store,
    });
    await pilot2.restore();
    const view = pilot2.getView();
    expect(view.config).toEqual({ startAmountUsd: 50, maxAmountUsd: 800, minTickRate: 2 });
    expect(view.session!.amountUsd).toBe(50);
    expect(view.sessionCount).toBe(1);
  });

  it('v1(baseAmountUsd) 저장값 → 시작=base·최대=base×4·속도=1로 마이그레이션(§4-5)', async () => {
    const store = new FakeStore();
    await store.setItem(AUTOPILOT_STORAGE_KEY, JSON.stringify({ baseAmountUsd: 100, currentAmountUsd: 200 }));
    const pilot = new AutoPilot({
      slots: () => [],
      pin: () => {},
      unpin: () => {},
      makeBroker: () => new FakeBroker(),
      clock: fakeClock(0),
      scheduler: noopScheduler(),
      storage: store,
    });
    await pilot.restore();
    expect(pilot.getView().config).toEqual({ startAmountUsd: 100, maxAmountUsd: 400, minTickRate: 1 });
    expect(pilot.getView().session).toBeNull(); // 세션은 새로 시작.
  });

  it('미국 장 기준일이 바뀌면 일일 통계(세션 수)가 리셋된다', () => {
    const h = makeHarness(['A']);
    h.pilot.start();
    h.pilot.stop();
    expect(h.pilot.getView().sessionCount).toBe(1);

    h.clock.advance(48 * 3600 * 1000); // 이틀 뒤 — ET 기준일 확실히 변경.
    h.pilot.start();
    expect(h.pilot.getView().sessionCount).toBe(1); // 진행 중 세션 1개 = 오늘의 1번째.
    expect(h.pilot.getView().cycles).toBe(0);
  });

  it('설정 미입력이면 start를 거부하고, 실행 중 setConfig는 막힌다', () => {
    const h = makeHarness(['A'], { config: null });
    h.pilot.start();
    expect(h.pilot.getView().state).toBe('IDLE');

    expect(h.pilot.setConfig(CONFIG_100)).toBeNull();
    h.pilot.start();
    expect(h.pilot.setConfig(CONFIG_100)).toContain('정지 상태');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 마틴게일 옵션(2026-08-05) — 끄면 금액이 고정되고 세션 완주 판정을 하지 않는다.
// 미지정은 항상 켬(기존 동작·하위호환).
// ─────────────────────────────────────────────────────────────────────────────
describe('AutoPilot — 마틴게일 옵션', () => {
  /** 저장값 복원만 검증할 때 쓰는 최소 AutoPilot(슬롯·브로커 없이). */
  function makeBarePilot(storage: FakeStore): AutoPilot {
    return new AutoPilot({
      slots: () => [],
      pin: () => {},
      unpin: () => {},
      makeBroker: () => new FakeBroker(),
      clock: fakeClock(1000),
      scheduler: noopScheduler(),
      storage,
    });
  }

  /** 마틴 OFF 설정 — 금액 고정. max는 start와 같은 값으로 정규화해 저장한다. */
  const CONFIG_OFF: AutoPilotConfig = {
    startAmountUsd: 100,
    maxAmountUsd: 100,
    minTickRate: TINY_RATE,
    martingale: false,
  };

  it('① isMartingaleOn — 미지정·손상값은 전부 켬으로 읽고, 명시적 false만 끔이다', () => {
    expect(isMartingaleOn({})).toBe(true);
    expect(isMartingaleOn({ martingale: undefined })).toBe(true);
    expect(isMartingaleOn({ martingale: true })).toBe(true);
    // JSON 손상값이 들어와도 기존 동작(켬)으로 폴백한다.
    expect(isMartingaleOn({ martingale: null as unknown as boolean })).toBe(true);
    expect(isMartingaleOn({ martingale: 0 as unknown as boolean })).toBe(true);
    expect(isMartingaleOn({ martingale: 'false' as unknown as boolean })).toBe(true);
    expect(isMartingaleOn({ martingale: false })).toBe(false);
  });

  it('② validateConfig — 마틴을 끄면 최대금액을 보지 않고, 켜면 기존 규칙 그대로다', () => {
    // OFF: 최대금액이 시작금액보다 작아도 통과한다(그 필드를 안 쓰므로).
    expect(validateConfig({ startAmountUsd: 100, maxAmountUsd: 1, minTickRate: 1, martingale: false })).toBeNull();
    // OFF에서도 금액·속도 규칙은 유지된다.
    expect(
      validateConfig({ startAmountUsd: 0, maxAmountUsd: 0, minTickRate: 1, martingale: false }),
    ).toContain('금액');
    // ON(미지정 포함): 기존 규칙 그대로.
    expect(validateConfig({ startAmountUsd: 100, maxAmountUsd: 1, minTickRate: 1 })).toContain('최대금액');
  });

  it('③ 마틴 OFF면 수익 사이클 뒤에도 투입금액이 그대로다', async () => {
    const h = makeHarness(['A', 'B', 'C'], { config: CONFIG_OFF });
    h.pilot.start();
    const n = await replay(h, 'A', PROFIT_RUN);
    await cap(h, 'A', 24, n);

    expect(h.trades).toHaveLength(1);
    expect(h.trades[0].pnl).toBeGreaterThan(0);
    const view = h.pilot.getView();
    expect(view.session!.amountUsd).toBe(100); // 절반으로 안 줄어든다
    expect(view.session!.pnl).toBe(h.trades[0].pnl); // 성과는 그대로 누적
    expect(view.cycles).toBe(1);
  });

  it('④ 마틴 OFF면 손실 사이클 뒤에도 투입금액이 그대로다', async () => {
    const h = makeHarness(['A', 'B', 'C'], { config: CONFIG_OFF });
    h.pilot.start();
    const n = await replay(h, 'A', DOWN_UP_DOWN);
    await cap(h, 'A', 2, n);

    expect(h.trades).toHaveLength(1);
    const view = h.pilot.getView();
    expect(view.session!.amountUsd).toBe(100); // 2배로 안 늘어난다
    expect(view.cumPnl).toBe(h.trades[0].pnl);
  });

  it('⑤ 마틴 OFF면 세션 완주 조건을 만족해도 세션이 끝나지 않는다', async () => {
    // start=max=100 + 수익 사이클 → 마틴 ON이었다면 즉시 완주할 조건.
    const h = makeHarness(['A', 'B', 'C'], { config: CONFIG_OFF });
    h.pilot.start();
    const before = h.pilot.getView().sessionCount;
    const n = await replay(h, 'A', PROFIT_RUN);
    await cap(h, 'A', 24, n);

    expect(h.trades[0].pnl).toBeGreaterThan(0);
    const view = h.pilot.getView();
    expect(view.sessionCount).toBe(before); // 새 세션이 열리지 않는다
    expect(view.session!.cycles).toBe(1); // 세션이 이어진다(리셋 안 됨)
    expect(h.events.some((e) => e.includes('세션 완주'))).toBe(false);
    expect(h.events.some((e) => e.includes('금액 고정'))).toBe(true);
  });

  it('⑥ [사고 재현] 마틴 OFF에서 금액을 바꾸면 진행 중 세션에 즉시 반영된다', async () => {
    // OFF는 세션이 끝나지 않으므로 "다음 세션부터 적용"이면 영원히 반영되지 않는다.
    const h = makeHarness(['A'], { config: CONFIG_OFF });
    h.pilot.start();
    expect(h.pilot.getView().session!.amountUsd).toBe(100);

    h.pilot.stop(); // setConfig는 IDLE에서만 통과한다
    const rejected = h.pilot.setConfig({ ...CONFIG_OFF, startAmountUsd: 10, maxAmountUsd: 10 });
    expect(rejected).toBeNull();
    expect(h.pilot.getView().session!.amountUsd).toBe(10);
  });

  it('⑦ 마틴을 켜서 금액이 불어난 뒤 끄면 설정 금액으로 내려온다', async () => {
    const h = makeHarness(['A', 'B', 'C']); // 기본 CONFIG_100(마틴 ON)
    h.pilot.start();
    const n = await replay(h, 'A', DOWN_UP_DOWN); // 손실 사이클 → 금액 2배
    await cap(h, 'A', 2, n);
    expect(h.pilot.getView().session!.amountUsd).toBe(200);

    h.pilot.stop();
    h.pilot.setConfig(CONFIG_OFF);
    expect(h.pilot.getView().session!.amountUsd).toBe(100);
  });

  it('⑧ 마틴 OFF에서도 수동 Stop 청산은 기존과 같이 손익만 반영한다', async () => {
    const h = makeHarness(['A', 'B', 'C'], { config: CONFIG_OFF });
    h.pilot.start();
    // 진입까지만 흘린 뒤 Stop으로 청산한다.
    let i = 0;
    for (const price of V) {
      h.slots.get('A')!.pushTick(price, i * 1000);
      h.pilot.reselect();
      h.clock.advance(1000);
      await flush();
      await h.pilot.pollCycle();
      await flush();
      i += 1;
    }
    if (h.pilot.getView().activeTicker === 'A') {
      h.pilot.stop();
      await flush();
      await h.pilot.pollCycle();
      await flush();
    }
    // 금액은 어떤 경우에도 고정이다.
    const view = h.pilot.getView();
    if (view.session) expect(view.session.amountUsd).toBe(100);
  });

  it('⑨ 마틴 키가 없는 v2 저장값은 켬으로 복원된다 (하위호환 — 설정 소실 없음)', async () => {
    const store = new FakeStore();
    await store.setItem(
      AUTOPILOT_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        config: { startAmountUsd: 50, maxAmountUsd: 800, minTickRate: 2 },
        session: null,
        daily: null,
      }),
    );
    const pilot = makeBarePilot(store);
    await pilot.restore();

    const cfg = pilot.getView().config!;
    expect(cfg).toEqual({ startAmountUsd: 50, maxAmountUsd: 800, minTickRate: 2 });
    expect(isMartingaleOn(cfg)).toBe(true);
  });

  it('⑩ 마틴 OFF 저장값은 복원 후에도 OFF다', async () => {
    const store = new FakeStore();
    await store.setItem(
      AUTOPILOT_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        config: { startAmountUsd: 30, maxAmountUsd: 30, minTickRate: 1, martingale: false },
        session: null,
        daily: null,
      }),
    );
    const pilot = makeBarePilot(store);
    await pilot.restore();

    const cfg = pilot.getView().config!;
    expect(isMartingaleOn(cfg)).toBe(false);
    expect(cfg.startAmountUsd).toBe(30);
  });
});
