// 포지션 관리자 — 인터페이스(onSignal·tick·poll·release)와 결과값만 본다. 규칙은 스크립트 가짜(PositionRule)로 주입해
// 배선(매매·부분체결·수동청산·정산·격리)만 검증한다. 추세/서킷 규칙 자체는 core/trend·core/circuit 테스트 몫.
import { describe, expect, it } from 'vitest';

import type { CircuitExitRule, CircuitHeartbeatResult } from '../../core/circuit';
import type { ConditionalDecision, ConditionalGridView, ConditionalPosition } from '../../core/conditional';
import { FakeBroker, fakeClock, flush } from './fakes';
import { PositionManager, type PositionManagerDeps, type PositionRule, type PriceView } from './positionManager';

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

function harness(opts: Partial<PositionManagerDeps> & { autoFill?: boolean; qty?: number; avgPrice?: number } = {}) {
  const clock = fakeClock(1_000);
  const broker = new FakeBroker({ autoFill: opts.autoFill ?? true });
  const rule = new FakeRule(opts.qty, opts.avgPrice);
  broker.position = { qty: rule.view.qty, avgPrice: rule.view.avgPrice };
  const events: string[] = [];
  let priceView: PriceView | null = { price: 100, lastTradeAt: 1_000 };
  const pm = new PositionManager({
    ticker: 'A',
    rule,
    broker,
    clock,
    price: () => priceView,
    regularSession: () => true,
    entry: { entryTs: 500, entrySnapshot: { price: 100, slope: 0.1, accel: 0, ts: 500 } },
    feeRate: 0.001,
    onEvent: (t) => events.push(t),
    ...opts,
  });
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
    expect(h.events.some((e) => e.includes('매매 발주 실패'))).toBe(true);
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
    expect(h.events.some((e) => e.includes('물타기 생략'))).toBe(true);
    buyable = null; // 조회 불가 → fail-open
    h.rule.nextDecide = { side: 'buy', qty: 5 };
    h.pm.onSignal('BUY', 96);
    await flush();
    expect(h.broker.placed.map((p) => p.side)).toEqual(['buy']);
    h.broker.position = { qty: 15, avgPrice: 98.67 };
    const r = await h.pm.poll();
    expect(r.kind).toBe('holding');
    expect(h.rule.positions.at(-1)).toEqual({ qty: 15, avgPrice: 98.67 });
    expect(h.events.some((e) => e.includes('물타기 체결'))).toBe(true);
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
