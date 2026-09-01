// 포지션 관리자 — 인터페이스(onSignal·tick·poll·release)와 결과값만 본다. 규칙은 스크립트 가짜(PositionRule)로 주입해
// 배선(매매·부분체결·수동청산·정산·격리)만 검증한다. 추세/서킷 규칙 자체는 core/trend·core/circuit 테스트 몫.
import { describe, expect, it } from 'vitest';

import type { CircuitExitRule, CircuitHeartbeatResult } from '../../core/circuit';
import type { ConditionalDecision, ConditionalGridView, ConditionalPosition } from '../../core/conditional';
import { FakeBroker, fakeClock, flush } from './fakes';
import {
  RulePositionManager,
  TREND_CONFIG,
  makePositionManager,
  resolvePositionMode,
  type PositionManagerDeps,
  type PositionRule,
  type PriceView,
  type RulePositionManagerOptions,
} from './positionManager';

/** 스크립트 규칙 — 테스트가 다음 decide/onPrice 결과를 직접 꽂는다. */
class FakeRule implements PositionRule {
  view: ConditionalGridView;
  nextDecide: ConditionalDecision | null = null;
  nextOnPrice: ConditionalDecision | null = null;
  abort = false;
  positions: ConditionalPosition[] = [];
  constructor(qty = 10, avgPrice = 100) {
    this.view = { qty, avgPrice, entryQty: qty, sellLine: avgPrice * 1.02, buyLine: avgPrice * 0.97 };
  }
  decide(): ConditionalDecision | null {
    const d = this.nextDecide;
    this.nextDecide = null;
    return d;
  }
  onPrice(): ConditionalDecision | null {
    const d = this.nextOnPrice;
    this.nextOnPrice = null;
    return d;
  }
  shouldAbort(): boolean {
    return this.abort;
  }
  setPosition(p: ConditionalPosition): void {
    this.positions.push(p);
    this.view = { ...this.view, qty: p.qty, avgPrice: p.avgPrice };
  }
}

type HarnessOpts = Partial<PositionManagerDeps> &
  Partial<Pick<RulePositionManagerOptions, 'manualExitCheckMs' | 'stopLossPct'>> & {
    circuit?: CircuitExitRule;
    autoFill?: boolean;
    qty?: number;
    avgPrice?: number;
  };

function harness(opts: HarnessOpts = {}) {
  const clock = fakeClock(1_000);
  const broker = new FakeBroker({ autoFill: opts.autoFill ?? true });
  const rule = new FakeRule(opts.qty, opts.avgPrice);
  broker.position = { qty: rule.view.qty, avgPrice: rule.view.avgPrice };
  const events: string[] = [];
  let priceView: PriceView | null = { price: 100, lastTradeAt: 1_000 };
  const { circuit, manualExitCheckMs, stopLossPct, autoFill: _af, qty: _q, avgPrice: _a, ...depOverrides } = opts;
  const pm = RulePositionManager.withRule(
    {
      ticker: 'A',
      broker,
      clock,
      price: () => priceView,
      regularSession: () => true,
      entry: { entryTs: 500, entrySnapshot: { price: 100, slope: 0.1, accel: 0, ts: 500 } },
      adopted: false,
      feeRate: 0.001,
      onEvent: (t: string) => events.push(t),
      ...depOverrides,
    },
    rule,
    { label: '테스트 규칙', gauge: 'orders', circuit, manualExitCheckMs, stopLossPct },
  );
  return { pm, rule, broker, clock, events, setPrice: (p: number | null) => (priceView = p === null ? null : { price: p, lastTradeAt: clock.now() }) };
}

const sell = (qty = 10): ConditionalDecision => ({ side: 'sell', qty });

describe('PositionManager — 매도 경로', () => {
  it('SELL 신호 → 매매 시작 → 체결 폴 → sold(SELL_SIGNAL) 기록(평단→체결가 손익·수수료)', async () => {
    const h = harness();
    h.rule.nextDecide = sell();
    h.pm.onSignal('SELL', 103);
    expect(h.pm.busy).toBe(true); // 발주 중 점유(동기)
    await flush();
    expect(h.broker.placed.map((p) => [p.side, p.qty, p.price])).toEqual([['sell', 10, 103]]);
    const r = await h.pm.poll();
    expect(r.kind).toBe('sold');
    if (r.kind !== 'sold') return;
    expect(r.record.exitReason).toBe('SELL_SIGNAL');
    expect(r.record.entryTs).toBe(500);
    expect(r.record.grossPnl).toBeCloseTo(30);
    expect(r.record.fees).toBeCloseTo(0.001 * (1000 + 1030));
    expect(h.pm.busy).toBe(false);
    expect(h.events.some((e) => e.includes('전량 매도 매매 시작'))).toBe(true);
  });

  it('손절 틱(rule.onPrice) → canStart일 때만 매도 시작, sold(STOP_LOSS)', async () => {
    const h = harness({ stopLossPct: 0.07 });
    h.rule.nextOnPrice = sell();
    await h.pm.tick({ canStart: false }); // PAUSED 등 — 새 매매 없음
    expect(h.broker.placed).toHaveLength(0);
    expect(h.rule.nextOnPrice).not.toBeNull(); // canStart=false면 규칙(onPrice)을 묻지도 않는다
    h.rule.nextOnPrice = sell();
    h.setPrice(93);
    await h.pm.tick({ canStart: true });
    await flush();
    expect(h.broker.placed).toHaveLength(1);
    expect(h.events.some((e) => e.includes('손절선 도달') && e.includes('−7%'))).toBe(true);
    const r = await h.pm.poll();
    expect(r.kind === 'sold' && r.record.exitReason).toBe('STOP_LOSS');
  });

  it('서킷 heartbeat 결정 → 정지 중 지정가로 매도 시작, sold(CIRCUIT)', async () => {
    let hb: CircuitHeartbeatResult = { events: [], decision: null, reason: null };
    const circuit = { heartbeat: () => hb } as unknown as CircuitExitRule;
    const h = harness({ circuit, manualExitCheckMs: 120_000 });
    await h.pm.tick({ canStart: true });
    expect(h.broker.placed).toHaveLength(0);
    hb = { events: [], decision: { side: 'sell', qty: 10, limitPrice: 88, chaseAfterTradeAt: 5_000 }, reason: 'CIRCUIT' };
    await h.pm.tick({ canStart: true });
    await flush();
    expect(h.broker.placed[0]?.price).toBe(88);
    expect(h.events.some((e) => e.includes('정지 중 지정가'))).toBe(true);
    const r = await h.pm.poll();
    expect(r.kind === 'sold' && r.record.exitReason).toBe('CIRCUIT');
  });

  it('발주 실패는 격리하지 않는다 — 사유를 지우고 다음 신호에서 다시 시도', async () => {
    const h = harness();
    h.broker.failPlaceOrder = true;
    h.rule.nextOnPrice = sell();
    await h.pm.tick({ canStart: true });
    await flush();
    expect(h.pm.busy).toBe(false);
    expect(h.pm.isolated).toBe(false);
    expect(h.events.some((e) => e.includes('매도 발주 실패'))).toBe(true);
    h.broker.failPlaceOrder = false;
    h.rule.nextDecide = sell();
    h.pm.onSignal('SELL', 103);
    await flush();
    const r = await h.pm.poll();
    expect(r.kind === 'sold' && r.record.exitReason).toBe('SELL_SIGNAL'); // 손절 사유가 새지 않는다
  });

  it('취소선 → 추격 취소(부분 체결 없음)면 holding으로 남고 다음 신호를 받는다', async () => {
    const h = harness({ autoFill: false });
    h.rule.nextDecide = sell();
    h.pm.onSignal('SELL', 103);
    await flush();
    h.rule.abort = true;
    await h.pm.tick({ canStart: true }); // exec.onPrice → 취소
    const r = await h.pm.poll();
    expect(r.kind).toBe('holding');
    expect(h.broker.canceled).toHaveLength(1);
    expect(h.pm.busy).toBe(false);
    expect(h.events.some((e) => e.includes('추격 취소'))).toBe(true);
  });

  it('추론 체결(체결가 미실측)인데 잔고가 그대로면 정산하지 않고 isolated', async () => {
    const h = harness({ autoFill: false });
    h.rule.nextDecide = sell();
    h.pm.onSignal('SELL', 103);
    await flush();
    h.broker.fillWithoutPrice(h.broker.placed[0]!.odno);
    h.broker.position = { qty: 10, avgPrice: 100 }; // 잔고 그대로 — 일괄 취소 의심
    const r = await h.pm.poll();
    expect(r.kind).toBe('isolated');
    expect(h.pm.isolated).toBe(true);
    expect(h.pm.faultText).toContain('일괄 취소 의심');
    // 격리 뒤에는 새 매매를 받지 않는다.
    h.rule.nextDecide = sell();
    h.pm.onSignal('SELL', 103);
    await flush();
    expect(h.broker.placed).toHaveLength(1);
  });
});

describe('PositionManager — 매수(물타기)·부분 체결·수동청산', () => {
  it('BUY 결정 → 현금 부족이면 생략, 충분하면 매수 → 체결 후 잔고로 포지션 갱신(holding)', async () => {
    let buyable: number | null = 100; // 필요 $500 > 100 → 생략
    const h = harness({ fetchBuyableUsd: async () => buyable });
    h.rule.nextDecide = { side: 'buy', qty: 5 };
    h.pm.onSignal('BUY', 100);
    await flush();
    expect(h.broker.placed).toHaveLength(0);
    expect(h.events.some((e) => e.includes('매수 생략'))).toBe(true);
    buyable = null; // 조회 불가 → fail-open
    h.rule.nextDecide = { side: 'buy', qty: 5 };
    h.pm.onSignal('BUY', 96);
    await flush();
    expect(h.broker.placed.map((p) => p.side)).toEqual(['buy']);
    h.broker.position = { qty: 15, avgPrice: 98.67 };
    const r = await h.pm.poll();
    expect(r.kind).toBe('holding');
    expect(h.rule.positions.at(-1)).toEqual({ qty: 15, avgPrice: 98.67 });
    expect(h.events.some((e) => e.includes('매수 체결'))).toBe(true);
  });

  it('부분 체결 뒤 취소 — 체결분을 잔고(폴백=가중평균)로 반영, 잔고 0이면 정산', async () => {
    const h = harness({ autoFill: false });
    h.rule.nextDecide = sell();
    h.pm.onSignal('SELL', 103);
    await flush();
    h.broker.fillPartial(h.broker.placed[0]!.odno, 4, 103);
    expect((await h.pm.poll()).kind).toBe('holding'); // 부분 체결 관측(working)
    h.rule.abort = true;
    await h.pm.tick({ canStart: true }); // 취소선 → 잔량 취소
    h.broker.position = null; // 잔고 조회 불가 → 합산 폴백 6주
    h.broker.failFetchPosition = true;
    const r = await h.pm.poll();
    expect(r.kind).toBe('holding');
    expect(h.rule.positions.at(-1)).toEqual({ qty: 6, avgPrice: 100 });
  });

  it('수동청산 — 주기마다 잔고 재확인, 2회 연속 없음이면 sold(MANUAL, 현재가 기록)', async () => {
    const h = harness({ manualExitCheckMs: 120_000 });
    h.broker.position = null;
    expect((await h.pm.poll()).kind).toBe('holding'); // 아직 주기 전
    h.clock.advance(120_000);
    h.setPrice(101);
    expect((await h.pm.poll()).kind).toBe('holding'); // 1회 — 판단 보류
    h.clock.advance(120_000);
    const r = await h.pm.poll();
    expect(r.kind).toBe('sold');
    if (r.kind !== 'sold') return;
    expect(r.record.exitReason).toBe('MANUAL');
    expect(r.record.exitPrice).toBe(101);
    expect(h.events.some((e) => e.includes('잔고에서 사라졌어요'))).toBe(true);
  });

  it('수동청산 감지는 잔고가 있으면 카운터를 되돌리고, 외부 부분 매도는 포지션에 반영한다', async () => {
    const h = harness({ manualExitCheckMs: 120_000 });
    h.broker.position = null;
    h.clock.advance(120_000);
    await h.pm.poll(); // 1회 없음
    h.broker.position = { qty: 7, avgPrice: 100 }; // 다시 보임(외부 부분 매도)
    h.clock.advance(120_000);
    expect((await h.pm.poll()).kind).toBe('holding');
    expect(h.rule.positions.at(-1)).toEqual({ qty: 7, avgPrice: 100 });
    h.broker.position = null;
    h.clock.advance(120_000);
    expect((await h.pm.poll()).kind).toBe('holding'); // 카운터 리셋됐으니 다시 1회
  });

  it('release — 추격 중 매매는 취소 요청, 이후 신호·틱으로 새 매매를 시작하지 않는다', async () => {
    const h = harness({ autoFill: false });
    h.rule.nextDecide = sell();
    h.pm.onSignal('SELL', 103);
    await flush();
    h.pm.release();
    await flush();
    expect(h.broker.canceled).toHaveLength(1);
    h.rule.nextDecide = sell();
    h.pm.onSignal('SELL', 104);
    h.rule.nextOnPrice = sell();
    await h.pm.tick({ canStart: true });
    await flush();
    expect(h.broker.placed).toHaveLength(1);
  });

  it('mayStart가 false를 돌려주면 비동기 발주 직전에 접는다(Stop/FAULT 경합)', async () => {
    let may = true;
    const h = harness({ mayStart: () => may, fetchBuyableUsd: async () => null });
    h.rule.nextDecide = { side: 'buy', qty: 5 };
    h.pm.onSignal('BUY', 96);
    may = false; // 현금 조회(await) 사이에 Stop
    await flush();
    expect(h.broker.placed).toHaveLength(0);
    expect(h.pm.busy).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 모드 팩토리 · 어댑터
// ---------------------------------------------------------------------------

describe('resolvePositionMode — 모드 판정 한 곳(추세 > 변곡점 > OCO, 주입 = 활성)', () => {
  it('셋 다 주입되면 추세, 추세 없으면 변곡점, 둘 다 없으면 OCO, 아무것도 없으면 null', () => {
    const grid = { buyWidth: 0.05, sellWidth: 0.02, buyMultiplier: 1 };
    const inflection = { sellProfitPct: 0.02, buyDropPct: 0.03 };
    expect(resolvePositionMode({ grid, inflection, trend: TREND_CONFIG })).toBe('trend');
    expect(resolvePositionMode({ grid, inflection })).toBe('inflection');
    expect(resolvePositionMode({ grid })).toBe('oco');
    expect(resolvePositionMode({})).toBeNull();
    expect(resolvePositionMode(undefined)).toBeNull();
  });
});

function adapterDeps(broker: FakeBroker, clock: ReturnType<typeof fakeClock>, events: string[], extra: Partial<PositionManagerDeps> = {}): PositionManagerDeps {
  return {
    ticker: 'A',
    broker,
    clock,
    price: () => ({ price: 100, lastTradeAt: clock.now(), dayLow: 95, dayHigh: 108 }),
    regularSession: () => true,
    entry: null,
    adopted: true,
    onEvent: (t) => events.push(t),
    ...extra,
  };
}

describe('makePositionManager — 규칙형 어댑터(추세·변곡점)', () => {
  it('추세: arm이 규칙+서킷을 조립하고 인계 문구(손절선)를 내며, 게이지는 오늘 고저(dayRange)', async () => {
    const clock = fakeClock(1_000);
    const broker = new FakeBroker({ autoFill: true });
    const events: string[] = [];
    const pm = makePositionManager('trend', { trend: TREND_CONFIG }, adapterDeps(broker, clock, events));
    expect(pm.label).toBe('추세 관리');
    expect(await pm.arm(null)).toEqual({ ok: false, reason: '포지션을 확인할 수 없어 추세 관리를 시작하지 못했어요' });
    expect(await pm.arm({ qty: 10, avgPrice: 100 })).toEqual({ ok: true });
    expect(events.at(-1)).toContain('추세 관리 등록 · 10주 · 평단 100.00');
    // 2026-08-21 순수 상태기계 — TREND_CONFIG.stopLossPct=0이라 인계 문구에 손절선이 없다.
    expect(events.at(-1)).not.toContain('손절선');
    // 손절선 자체는 규칙이 여전히 지원한다(주입하면 문구에 나온다) — 아래 별도 테스트가 동작을 지킨다.
    const g = pm.gaugeView();
    expect(g.rangeKind).toBe('dayRange');
    expect([g.buyPrice, g.sellPrice, g.holdingQty]).toEqual([95, 108, 10]);
    expect(pm.restingOrders).toBe(false);
  });

  it('변곡점: 조건부 그리드 규칙 — 게이지는 조건선(orders), 인계 문구에 매도선·매수선', async () => {
    const clock = fakeClock(1_000);
    const broker = new FakeBroker({ autoFill: true });
    const events: string[] = [];
    const pm = makePositionManager('inflection', { inflection: { sellProfitPct: 0.02, buyDropPct: 0.03 } }, adapterDeps(broker, clock, events));
    expect(pm.label).toBe('변곡점 그리드');
    expect(await pm.arm({ qty: 10, avgPrice: 100 })).toEqual({ ok: true });
    expect(events.at(-1)).toContain('변곡점 그리드 등록 · 10주 · 평단 100.00 · 매도선 102.00(+2.0%) · 매수선 97.00(−3.0%)');
    const g = pm.gaugeView();
    expect(g.rangeKind).toBe('orders');
    expect([g.buyPrice, g.sellPrice]).toEqual([97, 102]);
  });
});

describe('OcoGridPositionManager — OCO 매도그리드 어댑터(롤백 보존)', () => {
  const grid = { buyWidth: 0.1, sellWidth: 0.1, buyMultiplier: 1 };

  it('arm — 두 지정가(매도 +10%·매수 −10%)를 걸고 restingOrders=true, 게이지는 주문선', async () => {
    const clock = fakeClock(1_000);
    const broker = new FakeBroker({ autoFill: false });
    const events: string[] = [];
    const pm = makePositionManager('oco', { grid }, adapterDeps(broker, clock, events, { buyLegDelayMs: 0 }));
    expect(pm.label).toBe('그리드');
    expect(pm.restingOrders).toBe(false);
    expect(await pm.arm({ qty: 5, avgPrice: 100 })).toEqual({ ok: true });
    expect(pm.restingOrders).toBe(true);
    expect(broker.placed.map((p) => [p.side, p.qty, p.price]).sort()).toEqual([
      ['buy', 5, 90],
      ['sell', 5, 110],
    ]);
    expect(events.at(-1)).toContain('그리드 관리 등록 · 5주 · 평단 $100.00');
    const g = pm.gaugeView();
    expect([g.buyPrice, g.sellPrice, g.gridActive, g.rangeKind]).toEqual([90, 110, true, undefined]);
    expect(await pm.poll()).toEqual({ kind: 'holding' });
  });

  it('매도 다리 체결 → poll이 sold(TradeRecord, SELL_SIGNAL)를 돌려준다', async () => {
    const clock = fakeClock(1_000);
    const broker = new FakeBroker({ autoFill: false });
    const events: string[] = [];
    const pm = makePositionManager('oco', { grid }, adapterDeps(broker, clock, events, { buyLegDelayMs: 0, feeRate: 0 }));
    await pm.arm({ qty: 5, avgPrice: 100 });
    const sell = broker.placed.find((p) => p.side === 'sell')!;
    broker.fill(sell.odno, 110);
    broker.position = null;
    const r = await pm.poll();
    expect(r.kind).toBe('sold');
    if (r.kind !== 'sold') return;
    expect(r.record.exitReason).toBe('SELL_SIGNAL');
    expect(r.record.grossPnl).toBeCloseTo(50);
  });

  it('잔고가 없어 arm이 FAULT면 실패 사유를 돌려주고(격리 아님), 신호·틱은 무시한다', async () => {
    const clock = fakeClock(1_000);
    const broker = new FakeBroker({ autoFill: false });
    const pm = makePositionManager('oco', { grid }, adapterDeps(broker, clock, [], { buyLegDelayMs: 0 }));
    const r = await pm.arm(null); // seed 없음 + broker.position null → Grid FAULT
    expect(r.ok).toBe(false);
    expect(pm.isolated).toBe(false);
    pm.onSignal('SELL', 120);
    await pm.tick({ canStart: true });
    expect(broker.placed).toHaveLength(0);
  });
});
