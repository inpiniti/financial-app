import { describe, expect, it, vi } from 'vitest';

import type { TradeRecord } from '../../core/cycle';
import { FILL_FAIL_LIMIT } from '../../core/grid';
import {
  AutoPilot,
  AUTOPILOT_STORAGE_KEY,
  DEFAULT_MAX_GRIDS,
  DEFAULT_MIN_TICK_RATE,
  etDateOf,
  fixedEntryQtyOf,
  GRID_BUY_LEG_DELAY_MS,
  MAX_GRIDS_LIMIT,
  maxGridsOf,
  qtyForAmount,
  validateConfig,
  type AutoPilotConfig,
  type AutoPilotDeps,
  type GridExitConfig,
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

const CONFIG_100: AutoPilotConfig = { startAmountUsd: 100, minTickRate: TINY_RATE };

/**
 * 다중 그리드 시나리오용 — 기본값(DEFAULT_MAX_GRIDS = 1, 2026-08-12 사용자 확정)은 한 종목만 열기 때문에
 * "두 종목이 동시에 열린다"를 보는 테스트는 그리드 수를 명시해야 한다.
 */
const CONFIG_MULTI: AutoPilotConfig = { ...CONFIG_100, maxConcurrentGrids: 3 };

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
    gridConfig?: GridExitConfig;
    /** 그리드 매수 다리 지연(ms). 기본 0 — 기존 시나리오는 즉시 발주를 전제한다. */
    gridBuyLegDelayMs?: number;
    /** 티커별 잔고 심 — makeBroker가 브로커를 만들 때마다 심어 준다(입양 테스트용). */
    positions?: Record<string, { qty: number; avgPrice: number }>;
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
      // ⚠ makeBroker는 진입·입양마다 **새** 브로커를 만든다 — 잔고 심은 여기서 매번 다시 붙여야 한다.
      b.position = opts.positions?.[t] ?? null;
      brokers.set(t, b);
      return b;
    },
    fetchBuyableUsd: opts.fetchBuyableUsd,
    positionManagement: opts.gridConfig ? { grid: opts.gridConfig } : undefined,
    gridBuyLegDelayMs: opts.gridBuyLegDelayMs ?? 0,
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

/** 같은 clock 시각대에 n틱 버스트 — 틱/초를 n/10으로 만든다(10초 윈도우, 청크 마감 없음, ts 고정). */
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

describe('순수 규칙 — 수량·검증·기준일', () => {
  it('수량 = 금액÷가격 내림, 1주 못 사면 0', () => {
    expect(qtyForAmount(100, 30)).toBe(3);
    expect(qtyForAmount(100, 101)).toBe(0);
    expect(qtyForAmount(100, 0)).toBe(0);
  });

  it('설정 검증 — 진입금액>0, 최소 속도>0(0 설정 불가)', () => {
    expect(validateConfig({ startAmountUsd: 100, minTickRate: 1 })).toBeNull();
    expect(validateConfig({ startAmountUsd: 0, minTickRate: 1 })).toContain('금액');
    expect(validateConfig({ startAmountUsd: 100, minTickRate: 0 })).toContain('최소 속도');
    expect(DEFAULT_MIN_TICK_RATE).toBe(1);
  });

  it('고정 진입 수량 — 미지정·0·손상값은 null(금액 계산), 양수는 정수 절사, 검증은 1 이상 정수만', () => {
    expect(fixedEntryQtyOf(null)).toBeNull();
    expect(fixedEntryQtyOf({})).toBeNull();
    expect(fixedEntryQtyOf({ entryQty: 0 })).toBeNull();
    expect(fixedEntryQtyOf({ entryQty: NaN })).toBeNull();
    expect(fixedEntryQtyOf({ entryQty: 1 })).toBe(1);
    expect(fixedEntryQtyOf({ entryQty: 3.7 })).toBe(3);
    // 검증: 미지정·0은 통과(옛 저장값 보존), 소수·음수는 문구.
    expect(validateConfig({ startAmountUsd: 100, minTickRate: 1, entryQty: 0 })).toBeNull();
    expect(validateConfig({ startAmountUsd: 100, minTickRate: 1, entryQty: 2 })).toBeNull();
    expect(validateConfig({ startAmountUsd: 100, minTickRate: 1, entryQty: 1.5 })).toContain('진입 수량');
    expect(validateConfig({ startAmountUsd: 100, minTickRate: 1, entryQty: -1 })).toContain('진입 수량');
  });

  it('동시 그리드 수 — 미지정·손상값은 기본값, 상한은 클램프, 검증은 범위만 본다', () => {
    // 미지정(기존 저장값)은 조용히 기본값으로 읽힌다 — 설정 소실 없음.
    expect(maxGridsOf(null)).toBe(DEFAULT_MAX_GRIDS);
    expect(maxGridsOf({})).toBe(DEFAULT_MAX_GRIDS);
    expect(maxGridsOf({ maxConcurrentGrids: 0 })).toBe(DEFAULT_MAX_GRIDS);
    expect(maxGridsOf({ maxConcurrentGrids: NaN })).toBe(DEFAULT_MAX_GRIDS);
    expect(maxGridsOf({ maxConcurrentGrids: 2 })).toBe(2);
    expect(maxGridsOf({ maxConcurrentGrids: 99 })).toBe(MAX_GRIDS_LIMIT);
    // 검증: 미지정은 통과, 범위 밖은 문구.
    expect(validateConfig({ startAmountUsd: 100, minTickRate: 1, maxConcurrentGrids: 3 })).toBeNull();
    expect(validateConfig({ startAmountUsd: 100, minTickRate: 1, maxConcurrentGrids: 0 })).toContain('동시 그리드');
    expect(validateConfig({ startAmountUsd: 100, minTickRate: 1, maxConcurrentGrids: 99 })).toContain('동시 그리드');
  });

  it('기준일 — 미국 동부(America/New_York) 날짜, 서머타임 자동(§4-7)', () => {
    expect(etDateOf(Date.UTC(2026, 0, 15, 3, 0))).toBe('2026-01-14'); // 겨울 UTC-5
    expect(etDateOf(Date.UTC(2026, 6, 15, 3, 0))).toBe('2026-07-14'); // 여름 UTC-4
    expect(etDateOf(Date.UTC(2026, 6, 15, 12, 0))).toBe('2026-07-15');
  });
});

describe('AutoPilot — 감시 선정(최소 속도 자격 필터·히스테리시스)', () => {
  it('감시(호가 예열) 목록은 자격자 중 상위 3개 — 감지기는 리스트 전 종목에 붙는다(2026-08-10)', () => {
    const h = makeHarness(['A', 'B', 'C', 'D', 'E']);
    burst(h, 'A', 10);
    burst(h, 'B', 8);
    burst(h, 'C', 6);
    burst(h, 'D', 2);
    h.pilot.start();
    expect([...h.pilot.getView().watched].sort()).toEqual(['A', 'B', 'C']);
    // 감시 밖(D)·무자격(E) 종목도 감지기는 붙어 있다 — 사다리 앵커가 감시 교체와 무관하게 쌓인다.
    expect(h.slots.get('D')!.watched).toBe(true);
    expect(h.slots.get('E')!.watched).toBe(true);
  });

  it('최소 속도 미달은 감시(호가 예열) 목록에 들지 않는다 — 자격자 1개면 1개, 0개면 안내 이벤트', () => {
    const h = makeHarness(['A', 'B', 'C'], {
      config: { startAmountUsd: 100, minTickRate: 1 },
    });
    burst(h, 'A', 15); // 1.5틱/초 — 자격
    burst(h, 'B', 5); // 0.5틱/초 — 미달
    h.pilot.start();
    expect(h.pilot.getView().watched).toEqual(['A']); // 감시 목록은 1개
    expect(h.slots.get('B')!.watched).toBe(true); // 하지만 감지기는 붙어 있다

    // 시간이 흘러 A도 미달 → 감시 목록 0개 + 안내 이벤트(감지기는 그대로).
    h.clock.advance(20_000);
    h.pilot.reselect();
    expect(h.pilot.getView().watched).toEqual([]);
    expect(h.slots.get('A')!.watched).toBe(true);
    expect(h.events.some((e) => e.includes('감시 대상 없음'))).toBe(true);
  });

  it('감시 중 종목이 자격을 잃으면 감시 목록에서 즉시 빠진다 — 감지기는 유지(사다리 앵커 보존)', () => {
    const h = makeHarness(['A', 'B'], {
      config: { startAmountUsd: 100, minTickRate: 1 },
    });
    burst(h, 'A', 20);
    h.pilot.start();
    expect(h.pilot.getView().watched).toEqual(['A']);

    h.clock.advance(9_000); // A 틱이 윈도우 끝자락 — 아직 자격(20틱이 10초 창 안).
    burst(h, 'B', 30); // B가 새 자격자.
    h.clock.advance(2_000); // A 틱 전부 윈도우(10초) 밖 → 0틱/초.
    h.pilot.reselect();
    expect(h.pilot.getView().watched).toEqual(['B']);
    expect(h.slots.get('A')!.watched).toBe(true); // 감시 이탈 ≠ 감지 중단
  });

  it('감시 교체·재선정이 반복돼도 이미 부착된 감지기를 재부착하지 않는다 — 사다리 앵커 리셋 방지', () => {
    const h = makeHarness(['A', 'B']);
    burst(h, 'A', 10);
    h.pilot.start();
    const slotB = h.slots.get('B')!;
    expect(slotB.watched).toBe(true);
    const spy = vi.spyOn(slotB, 'attachDetector');

    burst(h, 'B', 30); // B가 자격을 얻어 감시 목록에 새로 들어온다.
    h.pilot.reselect();
    h.pilot.reselect(); // 반복 재선정.
    expect(h.pilot.getView().watched).toContain('B');
    expect(spy).not.toHaveBeenCalled(); // 이미 부착돼 있으므로 재부착(=앵커 리셋) 없음.
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

describe('AutoPilot — 사이클 e2e (진입 1종목·정산)', () => {
  it('BUY→진입(핀)→SELL→정산→SCANNING 복귀', async () => {
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
    expect(view.cycles).toBe(1);
    expect(view.cumPnl).toBe(rec.pnl);
    expect(view.state).toBe('SCANNING');
    expect(view.activeTicker).toBeNull();
  });

  it('수익 사이클 뒤에도 진입금액은 설정 고정값 그대로다(배증·반감 없음)', async () => {
    const h = makeHarness(['A', 'B', 'C']);
    h.pilot.start();
    const n = await replay(h, 'A', PROFIT_RUN);
    await cap(h, 'A', 24, n);

    expect(h.trades).toHaveLength(1);
    expect(h.trades[0].pnl).toBeGreaterThan(0); // 바닥 매수·고점 매도 — 수익 사이클 전제.

    const view = h.pilot.getView();
    expect(view.config!.startAmountUsd).toBe(100); // 설정값 불변.
    expect(view.cumPnl).toBe(h.trades[0].pnl);
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
    pilot.setConfig({ startAmountUsd: 100, minTickRate: 0.5 });
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

  it('동시 매수신호 — 슬롯이 남아 있으면 두 종목 모두 각자 진입한다(다중 그리드)', async () => {
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
    pilot.setConfig(CONFIG_MULTI);
    pilot.start();

    // A·B를 같은 V자 궤적으로 나란히 재생 — A의 프리플라이트만 게이트에 붙잡힌다.
    // 예전(단일 사이클)에는 둘 중 하나만 살아남았지만, 이제는 슬롯이 남아 있으므로 둘 다 진입한다.
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
    // B는 게이트가 없어 이미 진입했고, A는 프리플라이트 대기 중이다.
    expect(pilot.getView().activeTickers).toEqual(['B']);
    expect(pilot.getView().state).toBe('ENTERING'); // A가 아직 대기 중.

    releaseGate!();
    await flush();
    await flush();

    expect([...pilot.getView().activeTickers].sort()).toEqual(['A', 'B']);
    expect(h.brokers.get('A')!.placed.filter((p) => p.side === 'buy')).toHaveLength(1);
    expect(h.brokers.get('B')!.placed.filter((p) => p.side === 'buy')).toHaveLength(1);
  });

  it('qty<1(금액 < 1주 가격)이면 진입을 포기하고 SCANNING을 유지한다', async () => {
    const h = makeHarness(['A', 'B', 'C'], {
      config: { startAmountUsd: 1, minTickRate: TINY_RATE },
    });
    h.pilot.start();
    const n = await replay(h, 'A', V);
    await cap(h, 'A', 20, n);

    expect(h.brokers.size).toBe(0);
    expect(h.pilot.getView().state).toBe('SCANNING');
    expect(h.events.some((e) => e.includes('진입 포기'))).toBe(true);
  });
});

describe('AutoPilot — 현금 부족 PAUSED (재개는 사람이 선택)', () => {
  it('매수가능금액 < 필요금액 → 발주 없이 PAUSED, 감시 해제', async () => {
    const h = makeHarness(['A', 'B', 'C'], { fetchBuyableUsd: async () => 3 }); // $3뿐.
    h.pilot.start();
    const n = await replay(h, 'A', V);
    await cap(h, 'A', 20, n);

    const view = h.pilot.getView();
    expect(view.state).toBe('PAUSED');
    expect(view.paused).toBe(true);
    expect(h.brokers.get('A')!.placed).toHaveLength(0); // 발주 자체가 없다.
    expect([...h.slots.values()].every((s) => !s.watched)).toBe(true);
    expect(h.events.some((e) => e.includes('현금이 부족'))).toBe(true);
  });

  it('resume — SCANNING 복귀', async () => {
    const h = makeHarness(['A', 'B', 'C'], { fetchBuyableUsd: async () => 0 });
    h.pilot.start();
    const n = await replay(h, 'A', V);
    await cap(h, 'A', 20, n);
    expect(h.pilot.getView().state).toBe('PAUSED');

    h.pilot.resume();
    const view = h.pilot.getView();
    expect(view.state).toBe('SCANNING');
    expect(view.paused).toBe(false);
    expect(view.config!.startAmountUsd).toBe(100); // 설정 금액 그대로.
  });

  it('PAUSED에서 Stop → IDLE, 재시작하면 다시 PAUSED(자동 재개 금지)', async () => {
    const h = makeHarness(['A', 'B', 'C'], { fetchBuyableUsd: async () => 0 });
    h.pilot.start();
    const n = await replay(h, 'A', V);
    await cap(h, 'A', 20, n);
    expect(h.pilot.getView().state).toBe('PAUSED');

    h.pilot.stop();
    expect(h.pilot.getView().state).toBe('IDLE');

    h.pilot.start(); // 여전히 paused — 자동으로 SCANNING에 들어가지 않는다.
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
  it('보유 중 Stop → 전량 매도(STOP) 후 IDLE, 통계 반영', async () => {
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
    expect(view.cycles).toBe(1);
    expect(view.cumPnl).toBe(h.trades[0].pnl); // 오늘 성과에는 반영.
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

  it('영속화 v4 — 진입 설정은 저장하지 않는다(정본은 lib/appSettings), 일시정지·일일 통계만', async () => {
    const h = makeHarness(['A'], {
      config: { startAmountUsd: 50, minTickRate: 2 },
    });
    h.pilot.start(); // persist.
    h.pilot.stop();

    const raw = JSON.parse((await h.store.getItem(AUTOPILOT_STORAGE_KEY))!);
    expect(raw.version).toBe(4);
    expect(raw.config).toBeUndefined();
    const pilot2 = makeBarePilot(h.store);
    await pilot2.restore();
    const view = pilot2.getView();
    expect(view.config).toBeNull(); // 부팅 때 정본(appSettings)이 applySettings로 내려준다.
    expect(view.paused).toBe(false);
  });

  it('영속화 v3(옛) — 동봉된 진입 설정은 폴백으로 승계하고 v4로 다시 저장한다', async () => {
    const store = new FakeStore();
    await store.setItem(
      AUTOPILOT_STORAGE_KEY,
      JSON.stringify({ version: 3, config: { startAmountUsd: 50, minTickRate: 2 }, paused: true, daily: null }),
    );
    const pilot = makeBarePilot(store);
    await pilot.restore();
    expect(pilot.getView().config).toEqual({ startAmountUsd: 50, minTickRate: 2 });
    expect(pilot.getView().paused).toBe(true);
    const raw = JSON.parse((await store.getItem(AUTOPILOT_STORAGE_KEY))!);
    expect(raw.version).toBe(4);
    expect(raw.config).toBeUndefined();
  });

  it('applySettings — 그리드·매수취소는 실행 중에도 즉시, 진입 설정은 IDLE에서만(거절 사유 반환)', async () => {
    const h = makeHarness(['A'], { config: { startAmountUsd: 50, minTickRate: 2 } });
    h.pilot.start();
    const err = h.pilot.applySettings({
      config: { startAmountUsd: 99, minTickRate: 3 },
      grid: { buyWidth: 0.04, sellWidth: 0.01, buyMultiplier: 1 },
      buyCancelAfterMs: 5000,
    });
    expect(err).toBe('설정은 정지 상태에서 바꿀 수 있어요');
    expect(h.pilot.getView().config).toEqual({ startAmountUsd: 50, minTickRate: 2 });
    expect(h.pilot.gridSettings).toEqual({ buyWidth: 0.04, sellWidth: 0.01, buyMultiplier: 1 });
    expect(h.events.some((e) => e.includes('매수 미체결 취소 5초'))).toBe(true);
    h.pilot.stop();
    expect(h.pilot.applySettings({ config: { startAmountUsd: 99, minTickRate: 3 } })).toBeNull();
    expect(h.pilot.getView().config).toEqual({ startAmountUsd: 99, minTickRate: 3 });
  });

  it('영속화 — PAUSED 상태가 재시작 후에도 복원된다(자동 재개 금지)', async () => {
    const h = makeHarness(['A', 'B', 'C'], { fetchBuyableUsd: async () => 0 });
    h.pilot.start();
    const n = await replay(h, 'A', V);
    await cap(h, 'A', 20, n);
    expect(h.pilot.getView().state).toBe('PAUSED'); // persist됨.

    const pilot2 = makeBarePilot(h.store);
    await pilot2.restore();
    expect(pilot2.getView().paused).toBe(true);
    pilot2.setConfig({ startAmountUsd: 50, minTickRate: 2 }); // 부팅 때 정본(appSettings)이 내려주는 역할.
    pilot2.start();
    expect(pilot2.getView().state).toBe('PAUSED'); // 복원 후에도 사람이 재개해야 한다.
  });

  it('v2(세션) 저장값 → 세션 전용 키를 버리고 설정·paused·일일 통계만 승계한다', async () => {
    const store = new FakeStore();
    await store.setItem(
      AUTOPILOT_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        config: { startAmountUsd: 30, maxAmountUsd: 120, minTickRate: 2, martingale: false, maxConcurrentGrids: 2 },
        session: { amountUsd: 480, pnl: -5, cycles: 3, paused: true },
        daily: { date: '2026-08-07', sessionCount: 4, cycles: 9, cumPnl: 12.5 },
      }),
    );
    const pilot = makeBarePilot(store);
    await pilot.restore();

    const view = pilot.getView();
    expect(view.config).toEqual({ startAmountUsd: 30, minTickRate: 2, maxConcurrentGrids: 2 });
    expect(view.paused).toBe(true); // session.paused 승계 — 입금 대기 중이던 상태를 잃지 않는다.
    // v4로 다시 저장됐다(세션 키·설정값 소멸 — 설정 정본은 appSettings).
    const raw = JSON.parse((await store.getItem(AUTOPILOT_STORAGE_KEY))!);
    expect(raw.version).toBe(4);
    expect(raw.session).toBeUndefined();
    expect(raw.config).toBeUndefined();
  });

  it('v1(baseAmountUsd) 저장값 → 진입금액=base·속도=1로 마이그레이션', async () => {
    const store = new FakeStore();
    await store.setItem(AUTOPILOT_STORAGE_KEY, JSON.stringify({ baseAmountUsd: 100, currentAmountUsd: 200 }));
    const pilot = makeBarePilot(store);
    await pilot.restore();
    expect(pilot.getView().config).toEqual({ startAmountUsd: 100, minTickRate: 1 });
    expect(pilot.getView().paused).toBe(false);
  });

  it('미국 장 기준일이 바뀌면 일일 통계(사이클·손익)가 리셋된다', async () => {
    const h = makeHarness(['A', 'B', 'C']);
    h.pilot.start();
    const n = await replay(h, 'A', DOWN_UP_DOWN);
    await cap(h, 'A', 2, n);
    h.pilot.stop();
    expect(h.pilot.getView().cycles).toBe(1);

    h.clock.advance(48 * 3600 * 1000); // 이틀 뒤 — ET 기준일 확실히 변경.
    h.pilot.start();
    expect(h.pilot.getView().cycles).toBe(0);
    expect(h.pilot.getView().cumPnl).toBe(0);
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

describe('AutoPilot — 매도 관리 그리드 인계(D5·GRID_EXIT)', () => {
  /** 자동체결 없이 진입 buy만 발주된 상태까지 재생하고, 진입 체결을 수동으로 만든다. */
  async function enterAndFill(h: Harness, ticker: string, position: { qty: number; avgPrice: number }) {
    h.pilot.start();
    await replay(h, ticker, DOWN_UP_DOWN);
    const broker = h.brokers.get(ticker)!;
    // 진입 buy가 발주됐다(아직 미체결 — autoFill=false).
    const entry = broker.placed.find((p) => p.side === 'buy');
    expect(entry).toBeDefined();
    // 잔고(D1) 심 세팅 — 그리드는 이 값으로 브래킷을 세운다.
    broker.position = position;
    // 진입 체결을 수동으로 만든다 → 다음 폴에서 HOLDING → 그리드 인계.
    broker.fill(entry!.odno, position.avgPrice);
    await flush();
    await h.pilot.pollCycle();
    await flush();
    return broker;
  }

  it('진입 체결 → 그리드가 매수(−10%)·매도(+10%) 두 주문을 건다', async () => {
    const h = makeHarness(['A', 'B', 'C'], { autoFill: false, gridConfig: { buyWidth: 0.1, sellWidth: 0.1, buyMultiplier: 1 } });
    const broker = await enterAndFill(h, 'A', { qty: 5, avgPrice: 100 });

    // 그리드 두 다리: 매도 5주@110, 매수 5주@90 (진입 buy 1건 + 그리드 buy 1건 = buy 2건).
    expect(broker.placed.filter((p) => p.side === 'sell')).toEqual([
      { side: 'sell', pdno: 'A', qty: 5, price: 110, odno: expect.any(String) },
    ]);
    const gridBuy = broker.placed.filter((p) => p.side === 'buy').at(-1);
    expect(gridBuy).toMatchObject({ pdno: 'A', qty: 5, price: 90 });

    const view = h.pilot.getView();
    expect(view.state).toBe('HOLDING');
    expect(view.grid).toMatchObject({
      ticker: 'A',
      avgPrice: 100,
      buyPrice: 90,
      sellPrice: 110,
      holdingQty: 5,
      buyMultiplier: 1,
      gridActive: true,
    });
  });

  it('매도(+10%) 체결 → 매수 취소(OCO) → 정산 → SCANNING 복귀', async () => {
    const h = makeHarness(['A', 'B', 'C'], { autoFill: false, gridConfig: { buyWidth: 0.1, sellWidth: 0.1, buyMultiplier: 1 } });
    const broker = await enterAndFill(h, 'A', { qty: 5, avgPrice: 100 });

    const gridSell = broker.placed.find((p) => p.side === 'sell')!;
    const gridBuy = broker.placed.filter((p) => p.side === 'buy').at(-1)!;
    // 매도 다리만 체결.
    broker.fill(gridSell.odno, 110);
    await flush();
    await h.pilot.pollCycle();
    await flush();

    // 반대편 매수 취소(OCO) 1회.
    expect(broker.canceled).toContain(gridBuy.odno);
    // 정산 — 평단 100 → 매도 110, 5주 → +$50.
    expect(h.trades).toHaveLength(1);
    expect(h.trades[0]).toMatchObject({ ticker: 'A', qty: 5, entryPrice: 100, exitPrice: 110, exitReason: 'SELL_SIGNAL' });
    expect(h.trades[0].pnl).toBe(50);
    // 포지션 0 → 변곡점 스캔 복귀.
    const view = h.pilot.getView();
    expect(view.state).toBe('SCANNING');
    expect(view.activeTicker).toBeNull();
    expect(view.grid).toBeNull();
    expect(h.unpins).toContain('A');
  });

  it('매수(−10%) 체결 → 잔고 재조회로 리브래킷(수량↑·평단↓), 관리 지속', async () => {
    const h = makeHarness(['A', 'B', 'C'], { autoFill: false, gridConfig: { buyWidth: 0.1, sellWidth: 0.1, buyMultiplier: 1 } });
    const broker = await enterAndFill(h, 'A', { qty: 5, avgPrice: 100 });

    const firstSell = broker.placed.find((p) => p.side === 'sell')!;
    const gridBuy = broker.placed.filter((p) => p.side === 'buy').at(-1)!;
    // 매수 다리 체결 → 리브래킷 전에 잔고가 10주·평단 95로 갱신됐다고 가정.
    broker.position = { qty: 10, avgPrice: 95 };
    broker.fill(gridBuy.odno, 90);
    await flush();
    await h.pilot.pollCycle();
    await flush();

    // 옛 매도 취소(OCO).
    expect(broker.canceled).toContain(firstSell.odno);
    // 리브래킷 — 새 평단 95 기준(95×1.1=104.5, 95×0.9=85.5), 여전히 관리 중.
    const view = h.pilot.getView();
    expect(view.state).toBe('HOLDING');
    expect(view.grid).toMatchObject({ avgPrice: 95, buyPrice: 85.5, sellPrice: 104.5, holdingQty: 10 });
    expect(h.trades).toHaveLength(0); // 아직 청산 아님.
    // 새 매도/매수 다리가 다시 걸렸다.
    expect(broker.placed.filter((p) => p.side === 'sell')).toHaveLength(2);
  });

  it('급락 방어 — 매수 다리는 지연 후 min(평단, 현재가) 앵커로 건다(매도는 즉시)', async () => {
    const h = makeHarness(['A', 'B', 'C'], {
      autoFill: false,
      gridConfig: { buyWidth: 0.1, sellWidth: 0.1, buyMultiplier: 1 },
      gridBuyLegDelayMs: GRID_BUY_LEG_DELAY_MS,
    });
    const broker = await enterAndFill(h, 'A', { qty: 5, avgPrice: 100 });

    // 매도(익절)는 즉시 걸렸고, 매수는 아직 없다(pending) — 진입 buy 1건뿐.
    expect(broker.placed.filter((p) => p.side === 'sell')).toHaveLength(1);
    expect(broker.placed.filter((p) => p.side === 'buy')).toHaveLength(1);
    expect(h.pilot.getView().grid).toMatchObject({ buyLegStatus: 'pending', gridActive: true, sellPrice: 110 });

    // 지연 경과 + 폴 — 슬롯 마지막 틱(2)이 평단(100)보다 훨씬 아래(장대음봉 재현)
    // → min 앵커 2×0.9=1.8에 매수가 걸린다(평단 앵커였다면 90 — 시장가 위라 접수 즉시 체결됐을 가격).
    h.clock.advance(GRID_BUY_LEG_DELAY_MS);
    await h.pilot.pollCycle();
    await flush();
    const gridBuy = broker.placed.filter((p) => p.side === 'buy').at(-1)!;
    expect(gridBuy).toMatchObject({ pdno: 'A', qty: 5, price: 1.8 });
    expect(h.pilot.getView().grid).toMatchObject({ buyPrice: 1.8, sellPrice: 110, buyLegStatus: 'full' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 다중 그리드(2026-08-05) — 진입 뒤에도 변곡점 감시가 계속 돌고, 보유 종목만 후보에서 빠진다.
// 진입금액은 항상 설정 고정값이다.
// ─────────────────────────────────────────────────────────────────────────────
describe('AutoPilot — 다중 그리드', () => {
  /** 신호가 나지 않는 배경 궤적(단조 상승 — 하락→상승 전환이 없어 BUY가 안 뜬다). 틱/초 자격만 만들어 준다. */
  const RISING = Array.from({ length: 20 }, (_, i) => 10 + i);

  /** 여러 종목을 같은 시각축으로 나란히 재생한다(길이는 가장 긴 궤적 기준, 짧은 쪽은 마지막 값 유지). */
  async function replayMulti(h: Harness, paths: Record<string, number[]>): Promise<void> {
    const len = Math.max(...Object.values(paths).map((p) => p.length));
    for (let i = 0; i < len; i += 1) {
      for (const [ticker, prices] of Object.entries(paths)) {
        h.slots.get(ticker)!.pushTick(prices[Math.min(i, prices.length - 1)], i * 1000);
      }
      h.pilot.reselect();
      h.clock.advance(1000);
      await flush();
      await h.pilot.pollCycle();
      await flush();
    }
  }

  it('진입해도 감시가 멈추지 않고, 보유 종목만 감시 후보에서 빠진다', async () => {
    const h = makeHarness(['A', 'B', 'C']);
    h.pilot.start();
    // A만 V자(BUY 발생 후 보유 유지), B·C는 단조 상승(신호 없음 — 감시 자격만 유지).
    // ⚠ A에 DOWN_UP_DOWN을 쓰면 마지막 하락 구간에서 SELL이 나 청산돼 버린다(그리드 미주입 하네스).
    const bg = RISING.slice(0, V.length);
    await replayMulti(h, { A: V, B: bg, C: bg });

    const view = h.pilot.getView();
    expect(view.activeTickers).toContain('A');
    // ★ 예전에는 여기서 watched가 ['A'] 하나로 접혔다. 이제는 A가 빠지고 나머지가 계속 감시된다.
    expect(view.watched).not.toContain('A');
    expect([...view.watched].sort()).toEqual(['B', 'C']);
    expect(h.slots.get('B')!.watched).toBe(true);
    expect(h.slots.get('C')!.watched).toBe(true);
  });

  it('이미 보유 중인 종목은 다시 사지 않는다 — 같은 종목의 BUY 신호는 무시된다', async () => {
    const h = makeHarness(['A', 'B']);
    h.pilot.start();
    // DOWN_UP_DOWN을 두 번 흘려 A에서 BUY 신호가 다시 나게 한다(그리드 미사용이라 SELL로 청산될 수 있어
    // 매수 발주 건수로 검증한다 — 보유 중 재진입이 있었다면 2건 이상이 된다).
    await replay(h, 'A', V);
    expect(h.pilot.getView().activeTickers).toEqual(['A']);
    const before = h.brokers.get('A')!.placed.filter((p) => p.side === 'buy').length;
    // 보유 중 같은 궤적을 한 번 더 — BUY 신호가 또 떠도 진입은 없어야 한다.
    await replay(h, 'A', V, 20);
    expect(h.brokers.get('A')!.placed.filter((p) => p.side === 'buy')).toHaveLength(before);
  });

  it('동시 그리드 상한이 1이면 두 번째 종목은 진입하지 않는다', async () => {
    const h = makeHarness(['A', 'B'], {
      config: { startAmountUsd: 100, minTickRate: TINY_RATE, maxConcurrentGrids: 1 },
    });
    h.pilot.start();
    await replayMulti(h, { A: V, B: V });

    const view = h.pilot.getView();
    expect(view.maxGrids).toBe(1);
    expect(view.activeTickers).toHaveLength(1); // 슬롯 만석 — 둘 중 하나만.
  });

  it('상한이 3이면 두 종목이 나란히 진입한다', async () => {
    const h = makeHarness(['A', 'B'], {
      config: { startAmountUsd: 100, minTickRate: TINY_RATE, maxConcurrentGrids: 3 },
    });
    h.pilot.start();
    await replayMulti(h, { A: V, B: V });

    expect([...h.pilot.getView().activeTickers].sort()).toEqual(['A', 'B']);
    expect(h.brokers.get('A')!.placed.filter((p) => p.side === 'buy')).toHaveLength(1);
    expect(h.brokers.get('B')!.placed.filter((p) => p.side === 'buy')).toHaveLength(1);
  });

  it('두 종목이 각자 그리드를 연다 — 게이지가 종목별로 따로 뜬다', async () => {
    const h = makeHarness(['A', 'B'], {
      autoFill: false,
      gridConfig: { buyWidth: 0.1, sellWidth: 0.1, buyMultiplier: 1 },
      config: CONFIG_MULTI,
    });
    h.pilot.start();

    // A 진입 → 체결 → 그리드 인계.
    await replay(h, 'A', DOWN_UP_DOWN);
    const ba = h.brokers.get('A')!;
    ba.position = { qty: 5, avgPrice: 100 };
    ba.fill(ba.placed.find((p) => p.side === 'buy')!.odno, 100);
    await flush();
    await h.pilot.pollCycle();
    await flush();

    // B 진입 → 체결 → 그리드 인계(A의 그리드는 그대로 관리 중).
    await replay(h, 'B', DOWN_UP_DOWN);
    const bb = h.brokers.get('B')!;
    bb.position = { qty: 4, avgPrice: 50 };
    bb.fill(bb.placed.find((p) => p.side === 'buy')!.odno, 50);
    await flush();
    await h.pilot.pollCycle();
    await flush();

    const view = h.pilot.getView();
    expect([...view.activeTickers].sort()).toEqual(['A', 'B']);
    expect(view.grids.map((g) => g.ticker).sort()).toEqual(['A', 'B']);
    expect(view.grids.find((g) => g.ticker === 'A')).toMatchObject({
      avgPrice: 100,
      buyPrice: 90,
      sellPrice: 110,
      holdingQty: 5,
      gridActive: true,
    });
    expect(view.grids.find((g) => g.ticker === 'B')).toMatchObject({
      avgPrice: 50,
      buyPrice: 45,
      sellPrice: 55,
      holdingQty: 4,
      gridActive: true,
    });
  });

  it('진입금액은 설정 고정값 — 손실 사이클 뒤에도 다음 진입 수량은 그대로다(배증 없음)', async () => {
    const h = makeHarness(['A', 'B']);
    h.pilot.start();
    // A: 손실 사이클.
    const n = await replay(h, 'A', DOWN_UP_DOWN);
    await cap(h, 'A', 2, n);
    expect(h.trades[0].pnl).toBeLessThan(0);

    // B: 다음 진입. 항상 설정 진입금액(100) 기준이어야 한다.
    await replay(h, 'B', V);
    const buy = h.brokers.get('B')!.placed.find((p) => p.side === 'buy')!;
    expect(buy.qty).toBe(qtyForAmount(100, buy.price));
    expect(buy.qty).not.toBe(qtyForAmount(200, buy.price));
  });

  it('진입 수량을 지정하면 가격·진입금액과 무관하게 딱 그 수량만 산다(2026-08-18)', async () => {
    // 진입금액 $1 · 바닥가 2 → 금액 계산이면 0주(진입 포기)지만, 고정 1주면 1주를 산다.
    const h = makeHarness(['A', 'B'], { config: { startAmountUsd: 1, minTickRate: TINY_RATE, entryQty: 1 } });
    h.pilot.start();
    await replay(h, 'A', V);
    const buy = h.brokers.get('A')!.placed.find((p) => p.side === 'buy')!;
    expect(buy.qty).toBe(1);
    expect(qtyForAmount(1, buy.price)).toBe(0);
    expect(h.events.some((e) => e.includes('고정 수량 1주'))).toBe(true);
  });

  it('진입 수량을 지정하면 진입금액이 커도 그 수량만 산다(금액 계산으로 늘리지 않음)', async () => {
    // 진입금액 $100 · 바닥가 2 → 금액 계산이면 50주, 고정 2주면 2주.
    const h = makeHarness(['A'], { config: { ...CONFIG_100, entryQty: 2 } });
    h.pilot.start();
    await replay(h, 'A', V);
    const buy = h.brokers.get('A')!.placed.find((p) => p.side === 'buy')!;
    expect(buy.qty).toBe(2);
    expect(qtyForAmount(100, buy.price)).toBeGreaterThan(2);
  });

  it('[사고 재현] setGridConfig — 폭·배율을 바꾸면 다음에 여는 그리드부터 그 값으로 발주한다', async () => {
    // 매니저가 모듈 스코프 싱글턴이라 설정 탭에서 폭을 바꿔도 앱 재시작 전에는 반영되지 않던 버그.
    const h = makeHarness(['A', 'B'], {
      autoFill: false,
      gridConfig: { buyWidth: 0.1, sellWidth: 0.1, buyMultiplier: 1 },
      config: CONFIG_MULTI,
    });
    h.pilot.start();

    // A는 기본값(±10%·배율 1)으로 인계된다.
    await replay(h, 'A', DOWN_UP_DOWN);
    const ba = h.brokers.get('A')!;
    ba.position = { qty: 10, avgPrice: 100 };
    ba.fill(ba.placed.find((p) => p.side === 'buy')!.odno, 100);
    await flush();
    await h.pilot.pollCycle();
    await flush();
    expect(h.pilot.getView().grids.find((g) => g.ticker === 'A')).toMatchObject({ buyPrice: 90, sellPrice: 110 });

    // 실행 중에 설정을 바꾼다(설정 탭 저장 → managerProvider가 포커스에서 흘려 넣는 경로).
    h.pilot.applySettings({ grid: { buyWidth: 0.05, sellWidth: 0.05, buyMultiplier: 0.5 } });
    expect(h.pilot.gridSettings).toEqual({ buyWidth: 0.05, sellWidth: 0.05, buyMultiplier: 0.5 });

    // B는 새 값(±5%·배율 0.5)으로 열린다.
    await replay(h, 'B', DOWN_UP_DOWN);
    const bb = h.brokers.get('B')!;
    bb.position = { qty: 10, avgPrice: 200 };
    bb.fill(bb.placed.find((p) => p.side === 'buy')!.odno, 200);
    await flush();
    await h.pilot.pollCycle();
    await flush();

    const view = h.pilot.getView();
    expect(view.grids.find((g) => g.ticker === 'B')).toMatchObject({
      avgPrice: 200,
      buyPrice: 190, // 200 × 0.95
      sellPrice: 210, // 200 × 1.05
      buyMultiplier: 0.5,
    });
    // 매수 다리는 floor(10 × 0.5) = 5주(= 총 15주). 배율 1이었다면 10주(총 20주)였다.
    const gridBuyB = bb.placed.filter((p) => p.side === 'buy').at(-1)!;
    expect(gridBuyB).toMatchObject({ qty: 5, price: 190 });
    // ★ 이미 걸린 A의 그리드는 옛 폭 그대로다(주문이 이미 접수돼 있다).
    expect(view.grids.find((g) => g.ticker === 'A')).toMatchObject({ buyPrice: 90, sellPrice: 110 });
  });

  it('FAULT로 놓친 물량을 잔고에서 다시 그리드에 태운다(adoptPosition)', async () => {
    const h = makeHarness(['A', 'B'], {
      autoFill: false,
      gridConfig: { buyWidth: 0.1, sellWidth: 0.1, buyMultiplier: 1 },
      // 계좌에 7주 @ $100이 있다 — 진입 인계도, 그 뒤 재등록도 이 잔고를 읽는다.
      positions: { A: { qty: 7, avgPrice: 100 } },
    });
    h.pilot.start();

    // A에 진입해 그리드까지 인계된 상태를 만든다.
    await replay(h, 'A', DOWN_UP_DOWN);
    const ba = h.brokers.get('A')!;
    ba.fill(ba.placed.find((p) => p.side === 'buy')!.odno, 100);
    await flush();
    await h.pilot.pollCycle();
    await flush();
    expect(h.pilot.getView().grids).toHaveLength(1);

    // 체결 확인이 계속 죽으면(연속 상한) 그 그리드만 격리된다 — 전역 FAULT가 아니다.
    ba.failFetchFills = true;
    for (let i = 0; i < FILL_FAIL_LIMIT; i += 1) await h.pilot.pollCycle();
    expect(h.pilot.getView().state).not.toBe('FAULT');
    expect(h.pilot.getView().grids[0].faultText).toContain('체결 확인');
    // Stop으로 관리를 놓는다. 앱은 A를 잊지만 계좌에는 7주가 남아 있다.
    h.pilot.stop();
    expect(h.pilot.getView().state).toBe('IDLE');
    expect(h.pilot.getView().grids).toHaveLength(0);
    expect(h.unpins).toContain('A'); // 핀은 반드시 풀려야 한다(워치리스트 영구 오염 방지).

    // 사람이 계좌를 확인하고 다시 시작 → 잔고 보유분을 등록한다.
    ba.failFetchFills = false;
    h.pilot.start();
    const rejected = await h.pilot.adoptPosition('A');
    expect(rejected).toBeNull();

    const view = h.pilot.getView();
    expect(view.activeTickers).toEqual(['A']);
    // 잔고의 수량·평단(7주 @ $100)을 그대로 읽어 ±10% 브래킷을 세운다.
    expect(view.grids).toHaveLength(1);
    expect(view.grids[0]).toMatchObject({
      ticker: 'A',
      avgPrice: 100,
      buyPrice: 90,
      sellPrice: 110,
      holdingQty: 7,
      gridActive: true,
    });
    // 새 그리드의 두 다리가 실제로 발주됐다(등록 후 브로커가 새로 만들어진다).
    const adopted = h.brokers.get('A')!;
    expect(adopted.placed.filter((p) => p.side === 'sell')).toEqual([
      { side: 'sell', pdno: 'A', qty: 7, price: 110, odno: expect.any(String) },
    ]);
    expect(adopted.placed.filter((p) => p.side === 'buy').at(-1)).toMatchObject({ qty: 7, price: 90 });
    expect(h.events.some((e) => e.includes('그리드 관리 등록'))).toBe(true);
  });

  it('잔고가 비어 있으면 등록에 실패하되 전역 FAULT로 번지지 않는다', async () => {
    const h = makeHarness(['A'], { autoFill: false, gridConfig: { buyWidth: 0.1, sellWidth: 0.1, buyMultiplier: 1 } });
    h.pilot.start();
    // positions 미주입 → 잔고 조회가 null. 계좌 상태가 달라진 것뿐이라 그 종목만 포기해야 한다.
    expect(await h.pilot.adoptPosition('A')).toContain('실패');
    expect(h.pilot.getView().state).not.toBe('FAULT');
    expect(h.pilot.getView().activeTickers).toEqual([]);
    expect(h.unpins).toContain('A'); // 슬롯·핀을 반드시 반납한다.
  });

  it('입양 포지션도 +폭 매도가 체결되면 정상 정산된다(진입 사이클이 없어도)', async () => {
    const h = makeHarness(['A'], {
      autoFill: false,
      gridConfig: { buyWidth: 0.1, sellWidth: 0.1, buyMultiplier: 1 },
      positions: { A: { qty: 3, avgPrice: 200 } },
    });
    h.pilot.start();

    // 진입 없이 곧장 잔고 보유분을 등록한다.
    expect(await h.pilot.adoptPosition('A')).toBeNull();

    const broker = h.brokers.get('A')!;
    const sell = broker.placed.find((p) => p.side === 'sell')!;
    broker.fill(sell.odno, 220);
    await flush();
    await h.pilot.pollCycle();
    await flush();

    // 평단 200 → 매도 220, 3주 → +$60. 진입 스냅샷이 없어도 기록이 남는다.
    expect(h.trades).toHaveLength(1);
    expect(h.trades[0]).toMatchObject({ ticker: 'A', qty: 3, entryPrice: 200, exitPrice: 220 });
    expect(h.trades[0].pnl).toBe(60);
    expect(h.pilot.getView().activeTickers).toEqual([]);
    expect(h.unpins).toContain('A');
  });

  it('등록 거절 — 이미 관리 중이거나 슬롯이 꽉 찼거나 정지 상태면 문구를 돌려준다', async () => {
    const h = makeHarness(['A', 'B'], {
      autoFill: false,
      gridConfig: { buyWidth: 0.1, sellWidth: 0.1, buyMultiplier: 1 },
      config: { startAmountUsd: 100, minTickRate: TINY_RATE, maxConcurrentGrids: 1 },
      positions: { A: { qty: 2, avgPrice: 50 }, B: { qty: 5, avgPrice: 20 } },
    });
    // 정지 상태.
    expect(await h.pilot.adoptPosition('A')).toContain('시작');

    h.pilot.start();
    expect(await h.pilot.adoptPosition('A')).toBeNull();

    // 같은 종목 재등록 거절.
    expect(await h.pilot.adoptPosition('A')).toContain('이미 관리 중');
    // 상한 1이라 다른 종목도 거절.
    expect(await h.pilot.adoptPosition('B')).toContain('꽉 찼어요');
  });

  it('[사고 방지] 그리드가 살아 있는데 현금이 모자라면 PAUSED로 가지 않고 신규 진입만 쉰다', async () => {
    // 첫 진입은 통과, 두 번째부터 현금 부족.
    let calls = 0;
    const h = makeHarness(['A', 'B'], {
      fetchBuyableUsd: async () => (calls++ === 0 ? 1_000_000 : 1),
      config: CONFIG_MULTI,
    });
    h.pilot.start();
    const n = await replay(h, 'A', V);
    await cap(h, 'A', 20, n);
    expect(h.pilot.getView().state).toBe('HOLDING'); // A 보유 중.

    await replay(h, 'B', V);

    const view = h.pilot.getView();
    // ★ PAUSED로 갔다면 폴 타이머가 꺼져 A의 포지션이 방치된다 — 그래서 절대 PAUSED가 아니어야 한다.
    expect(view.state).toBe('HOLDING');
    expect(view.paused).toBe(false);
    expect(view.activeTickers).toEqual(['A']);
    expect(h.brokers.get('B')!.placed).toHaveLength(0);
    expect(h.events.some((e) => e.includes('신규 진입을'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 그리드 단위 격리 + 매수 다리 현금 판정(2026-08-08) — 한 종목 오류가 전체 자동매매를
// 멈추지 않아야 하고(사용자가 화면을 안 보고 있다), 현금이 소진되면 매도만 걸고 UI에 알린다.
// ─────────────────────────────────────────────────────────────────────────────
describe('AutoPilot — 그리드 격리·현금 소진 매도 전용', () => {
  /** A·B 두 종목을 진입→체결→그리드 인계까지 만든다. */
  async function armTwoGrids(h: Harness) {
    h.pilot.start();
    await replay(h, 'A', DOWN_UP_DOWN);
    const ba = h.brokers.get('A')!;
    ba.position = { qty: 5, avgPrice: 100 };
    ba.fill(ba.placed.find((p) => p.side === 'buy')!.odno, 100);
    await flush();
    await h.pilot.pollCycle();
    await flush();

    await replay(h, 'B', DOWN_UP_DOWN);
    const bb = h.brokers.get('B')!;
    bb.position = { qty: 4, avgPrice: 50 };
    bb.fill(bb.placed.find((p) => p.side === 'buy')!.odno, 50);
    await flush();
    await h.pilot.pollCycle();
    await flush();

    expect(h.pilot.getView().grids.map((g) => g.ticker).sort()).toEqual(['A', 'B']);
    return { ba, bb };
  }

  it('그리드 하나가 멈춰도 전역 FAULT로 번지지 않는다 — 다른 종목은 계속 정산까지 간다', async () => {
    const h = makeHarness(['A', 'B'], {
      autoFill: false,
      gridConfig: { buyWidth: 0.1, sellWidth: 0.1, buyMultiplier: 1 },
      config: CONFIG_MULTI,
    });
    const { ba, bb } = await armTwoGrids(h);

    // A: 매도 체결 후 OCO 취소가 거절 → A 그리드만 격리.
    ba.failCancel = true;
    ba.fill(ba.placed.find((p) => p.side === 'sell')!.odno, 110);
    await h.pilot.pollCycle();
    await flush();

    const mid = h.pilot.getView();
    expect(mid.state).not.toBe('FAULT'); // ★ 예전에는 여기서 전역 동결 + 폴 타이머 정지였다.
    expect(mid.lastFault).toBeNull();
    expect(mid.activeTickers).toContain('A'); // 격리 유지 — UI가 사유를 보여준다.
    expect(mid.grids.find((g) => g.ticker === 'A')!.faultText).toContain('취소 실패');
    expect(mid.grids.find((g) => g.ticker === 'B')!.faultText).toBeNull();
    expect(h.events.some((e) => e.includes('A 그리드가 멈췄어요'))).toBe(true);

    // B: 매도 체결 → 여전히 정상 정산된다(폴이 계속 돈다).
    bb.fill(bb.placed.find((p) => p.side === 'sell')!.odno, 55);
    await h.pilot.pollCycle();
    await flush();
    expect(h.trades.some((t) => t.ticker === 'B')).toBe(true);

    // Stop — 격리된 A는 주문을 계좌에 남긴 채 관리를 놓고 IDLE로 마감한다(좀비 없음).
    h.pilot.stop();
    await flush();
    expect(h.pilot.getView().state).toBe('IDLE');
    expect(h.unpins).toContain('A');
    expect(h.events.some((e) => e.includes('계좌에 남아 있어요'))).toBe(true);
  });

  it('리브래킷 때 최신 현금을 다시 조회한다 — 소진됐으면 매수 생략(skippedCash) + 매도만', async () => {
    // 조회 순서: ① 진입 사전판정(commitBuy) ② 그리드 arm ③ 리브래킷 — 물타기 후엔 $0.
    const cashSeq = [100_000, 100_000, 0];
    const h = makeHarness(['A'], {
      autoFill: false,
      gridConfig: { buyWidth: 0.1, sellWidth: 0.1, buyMultiplier: 1 },
      fetchBuyableUsd: async () => cashSeq.shift() ?? 0,
    });
    h.pilot.start();
    await replay(h, 'A', DOWN_UP_DOWN);
    const ba = h.brokers.get('A')!;
    ba.position = { qty: 5, avgPrice: 100 };
    ba.fill(ba.placed.find((p) => p.side === 'buy')!.odno, 100);
    await flush();
    await h.pilot.pollCycle();
    await flush();
    expect(h.pilot.getView().grids[0]).toMatchObject({ buyLegStatus: 'full', gridActive: true });

    // 그리드 매수(−10%) 체결 → 리브래킷. 이번 현금 조회는 $0 → 매수 생략.
    ba.position = { qty: 10, avgPrice: 95 };
    ba.fill(ba.placed.filter((p) => p.side === 'buy').at(-1)!.odno, 90);
    await flush();
    await h.pilot.pollCycle();
    await flush();

    const view = h.pilot.getView();
    expect(view.state).not.toBe('FAULT');
    expect(view.grids[0]).toMatchObject({ buyLegStatus: 'skippedCash', gridActive: true, holdingQty: 10 });
    // 리브래킷 발주는 매도만 — 매수 발주 건수가 늘지 않았다(진입 1 + 그리드 1 = 2건 유지).
    expect(ba.placed.filter((p) => p.side === 'buy')).toHaveLength(2);
    expect(ba.placed.filter((p) => p.side === 'sell')).toHaveLength(2);
    expect(h.events.some((e) => e.includes('매수는 생략'))).toBe(true);

    // 매도(+10%) 체결 → 정상 정산(매도 전용 상태에서도 사이클 완주).
    ba.fill(ba.placed.filter((p) => p.side === 'sell').at(-1)!.odno, 104.5);
    await h.pilot.pollCycle();
    await flush();
    expect(h.trades).toHaveLength(1);
    expect(h.pilot.getView().activeTickers).toEqual([]);
  });

  it('그리드 매수 발주가 거절돼도 전역 FAULT 없이 매도만 관리한다(rejected)', async () => {
    const h = makeHarness(['A'], { autoFill: false, gridConfig: { buyWidth: 0.1, sellWidth: 0.1, buyMultiplier: 1 } });
    h.pilot.start();
    await replay(h, 'A', DOWN_UP_DOWN);
    const ba = h.brokers.get('A')!;
    ba.position = { qty: 10, avgPrice: 95 };
    ba.fill(ba.placed.find((p) => p.side === 'buy')!.odno, 95);
    // 그리드 인계 발주에서 매수만 거절되게 — 매도(sell)는 정상.
    const origPlace = ba.placeOrder.bind(ba);
    ba.placeOrder = async (input) => {
      if (input.side === 'buy') throw new Error('주문가능금액 부족(모의)');
      return origPlace(input);
    };
    await flush();
    await h.pilot.pollCycle();
    await flush();

    const view = h.pilot.getView();
    expect(view.state).not.toBe('FAULT');
    expect(view.grids[0]).toMatchObject({ buyLegStatus: 'rejected', gridActive: true });
    expect(ba.placed.filter((p) => p.side === 'sell')).toHaveLength(1); // 매도 다리는 걸려 있다.
  });
});

describe('AutoPilot — 세션 전환(정규장↔주간거래) 그리드 주문 재등록', () => {
  // KST 10:00 경계 — epoch 기준 01:00 UTC(1970-01-01). fakeClock(1000)은 09:00:01 KST(정규장 쪽)다.
  const DAYTIME_EPOCH = Date.UTC(1970, 0, 1, 1, 0, 30);

  it('세션 경계를 넘으면 ARMED 그리드의 두 다리를 취소하고 같은 포지션으로 재발주한다', async () => {
    const h = makeHarness(['A'], {
      autoFill: false,
      gridConfig: { buyWidth: 0.1, sellWidth: 0.1, buyMultiplier: 1 },
      positions: { A: { qty: 10, avgPrice: 100 } },
    });
    h.pilot.start();
    expect(await h.pilot.adoptPosition('A')).toBeNull();
    const broker = h.brokers.get('A')!;
    expect(broker.placed).toHaveLength(2);

    // 기준점 폴(정규장) → 경계 통과 → 다음 폴에서 전환 감지.
    await h.pilot.pollCycle();
    expect(broker.placed).toHaveLength(2); // 기준점만 잡는다 — 재등록 없음.
    h.clock.set(DAYTIME_EPOCH);
    await h.pilot.pollCycle();
    await flush();

    // 옛 두 다리 취소 + 새 두 다리 발주(같은 가격·수량 — 포지션 불변).
    expect(broker.canceled).toHaveLength(2);
    expect(broker.placed).toHaveLength(4);
    expect(broker.placed.filter((p) => p.side === 'sell').at(-1)).toMatchObject({ qty: 10, price: 110 });
    expect(broker.placed.filter((p) => p.side === 'buy').at(-1)).toMatchObject({ qty: 10, price: 90 });
    expect(h.events.some((e) => e.includes('세션 전환'))).toBe(true);
    expect(h.pilot.getView().grids[0]).toMatchObject({ gridActive: true, holdingQty: 10 });

    // 같은 경계는 한 번만 — 추가 폴에 재등록 반복 없음.
    await h.pilot.pollCycle();
    expect(broker.placed).toHaveLength(4);
  });

  it('경계 직전 매도 체결은 재등록으로 덮지 않고 먼저 정산한다', async () => {
    const h = makeHarness(['A'], {
      autoFill: false,
      gridConfig: { buyWidth: 0.1, sellWidth: 0.1, buyMultiplier: 1 },
      positions: { A: { qty: 10, avgPrice: 100 } },
    });
    h.pilot.start();
    expect(await h.pilot.adoptPosition('A')).toBeNull();
    const broker = h.brokers.get('A')!;
    await h.pilot.pollCycle(); // 기준점(정규장).

    // 경계 직전 +10% 매도 체결 — 전환 감지 폴이 재등록 전에 이 체결을 먼저 정산해야 한다.
    broker.fill(broker.placed.find((p) => p.side === 'sell')!.odno, 110);
    h.clock.set(DAYTIME_EPOCH);
    await h.pilot.pollCycle();
    await flush();

    expect(h.trades).toHaveLength(1);
    expect(h.pilot.getView().activeTickers).toEqual([]);
    expect(broker.placed).toHaveLength(2); // 재발주 없음 — 이미 팔린 포지션이다.
  });
});
