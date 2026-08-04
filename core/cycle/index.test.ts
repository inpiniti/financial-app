import { describe, expect, it } from 'vitest';
import {
  RunCycle,
  type CancelState,
  type FillResult,
  type OrderPort,
  type OrderRef,
  type SignalSnapshot,
  type TradeRecord,
} from './index';

// ---- 가짜 시계 ----
function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

// ---- 가짜 주문 포트 ----
type Call =
  | { type: 'buy'; ticker: string; qty: number; ref: OrderRef }
  | { type: 'sell'; ticker: string; qty: number; ref: OrderRef }
  | { type: 'cancel'; ref: OrderRef };

class FakePort implements OrderPort {
  calls: Call[] = [];
  private seq = 0;
  private fills = new Map<OrderRef, FillResult>();
  private cancels = new Map<OrderRef, CancelState>();
  /** 주문 즉시 체결 여부(테스트 기본 시나리오용). */
  autoFill: boolean;
  fillPrice: number;

  constructor(opts: { autoFill?: boolean; fillPrice?: number } = {}) {
    this.autoFill = opts.autoFill ?? false;
    this.fillPrice = opts.fillPrice ?? 100;
  }

  private place(type: 'buy' | 'sell', req: { ticker: string; qty: number }): OrderRef {
    const ref = `${type}-${this.seq++}`;
    this.calls.push({ type, ticker: req.ticker, qty: req.qty, ref });
    if (this.autoFill) {
      this.fills.set(ref, { filled: true, price: this.fillPrice, qty: req.qty });
    } else {
      this.fills.set(ref, { filled: false });
    }
    return ref;
  }
  buy(req: { ticker: string; qty: number }): OrderRef {
    return this.place('buy', req);
  }
  sell(req: { ticker: string; qty: number }): OrderRef {
    return this.place('sell', req);
  }
  cancel(ref: OrderRef): void {
    this.calls.push({ type: 'cancel', ref });
    // 취소는 요청 즉시 확정되지 않는다(async KIS 취소를 흉내) — 테스트가 confirmCancel/rejectCancel로 확정한다.
    this.cancels.set(ref, 'pending');
  }
  cancelState(ref: OrderRef): CancelState {
    return this.cancels.get(ref) ?? 'none';
  }
  checkFilled(ref: OrderRef): FillResult {
    return this.fills.get(ref) ?? { filled: false };
  }
  /** 특정 주문을 수동 체결 처리(타임아웃 시나리오에서 사용). */
  fill(ref: OrderRef, price: number, qty: number) {
    this.fills.set(ref, { filled: true, price, qty });
  }
  /** 취소 성공 확정(진짜 미체결) — KIS가 취소를 받아들인 상황. */
  confirmCancel(ref: OrderRef) {
    this.cancels.set(ref, 'confirmed');
    this.fills.delete(ref);
  }
  /** 취소 거절 확정(이미 체결 추정) — KIS가 취소를 거절한 상황. */
  rejectCancel(ref: OrderRef) {
    this.cancels.set(ref, 'rejected');
  }
  count(type: Call['type']) {
    return this.calls.filter((c) => c.type === type).length;
  }
  lastRef(type: 'buy' | 'sell'): OrderRef {
    const found = [...this.calls].reverse().find((c) => c.type === type);
    return found && found.type !== 'cancel' ? found.ref : '';
  }
}

const snap = (price: number, slope: number, accel: number, ts: number): SignalSnapshot => ({
  price,
  slope,
  accel,
  ts,
});

function makeCycle(port: FakePort, clock: { now: () => number }, onTrade?: (r: TradeRecord) => void) {
  return new RunCycle({
    ticker: 'AAPL',
    qty: 3,
    port,
    clock,
    fillTimeoutMs: 5000,
    onTrade,
  });
}

describe('RunCycle — Run 없이(IDLE)', () => {
  it('start 전에는 BUY 신호가 와도 주문 포트를 호출하지 않는다', () => {
    const port = new FakePort();
    const cycle = makeCycle(port, fakeClock());
    cycle.onSignal('BUY', snap(100, 0, 0, 0));
    cycle.poll();
    expect(cycle.state).toBe('IDLE');
    expect(port.calls).toHaveLength(0);
  });
});

describe('RunCycle — 정상 1사이클', () => {
  it('start → BUY 진입 → SELL 전량 청산 → DONE, 거래 기록 발행', () => {
    const port = new FakePort({ autoFill: true, fillPrice: 0 }); // price는 아래서 개별 지정
    const clock = fakeClock(1000);
    const trades: TradeRecord[] = [];
    const cycle = makeCycle(port, clock, (r) => trades.push(r));

    cycle.start();
    expect(cycle.state).toBe('WATCH_BUY');

    // BUY 변곡점 — 진입가 50
    port.fillPrice = 50;
    cycle.onSignal('BUY', snap(50, 0.1, 0.2, 1000));
    expect(cycle.state).toBe('BUYING');
    expect(port.count('buy')).toBe(1);

    clock.advance(100);
    cycle.poll(); // 체결 확인 → HOLDING
    expect(cycle.state).toBe('HOLDING');
    expect(cycle.position?.entryPrice).toBe(50);
    expect(cycle.position?.qty).toBe(3);

    // SELL 변곡점 — 청산가 60
    port.fillPrice = 60;
    clock.advance(100);
    cycle.onSignal('SELL', snap(60, -0.1, -0.3, 1200));
    expect(cycle.state).toBe('SELLING');
    expect(port.count('sell')).toBe(1);

    clock.advance(100);
    cycle.poll(); // 체결 → DONE
    expect(cycle.state).toBe('DONE');

    expect(trades).toHaveLength(1);
    const t = trades[0];
    expect(t.ticker).toBe('AAPL');
    expect(t.qty).toBe(3);
    expect(t.entryPrice).toBe(50);
    expect(t.exitPrice).toBe(60);
    expect(t.pnl).toBe((60 - 50) * 3);
    expect(t.exitReason).toBe('SELL_SIGNAL');
    expect(t.entrySnapshot.slope).toBe(0.1);
  });

  it('1 Run = 1사이클: DONE 이후 신호·poll은 추가 주문을 내지 않는다', () => {
    const port = new FakePort({ autoFill: true, fillPrice: 50 });
    const clock = fakeClock();
    const cycle = makeCycle(port, clock);
    cycle.start();
    cycle.onSignal('BUY', snap(50, 0.1, 0, 0));
    cycle.poll();
    cycle.onSignal('SELL', snap(55, -0.1, 0, 0));
    cycle.poll();
    expect(cycle.state).toBe('DONE');
    const callsAfter = port.calls.length;

    cycle.onSignal('BUY', snap(40, 0.2, 0, 0));
    cycle.onSignal('SELL', snap(70, -0.2, 0, 0));
    cycle.poll();
    expect(port.calls.length).toBe(callsAfter);
  });

  it('보유 중(HOLDING) BUY 신호는 무시된다 — 인스턴스당 1포지션', () => {
    const port = new FakePort({ autoFill: true, fillPrice: 50 });
    const cycle = makeCycle(port, fakeClock());
    cycle.start();
    cycle.onSignal('BUY', snap(50, 0.1, 0, 0));
    cycle.poll();
    expect(cycle.state).toBe('HOLDING');
    cycle.onSignal('BUY', snap(48, 0.3, 0, 0));
    expect(port.count('buy')).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 무한 대기 — 자동 타임아웃 취소 제거. 체결될 때까지 취소하지 않고 계속 기다린다.
// (실기기 사고: 취소가 KIS에 거절됐는데 주문은 미체결로 살아있음 → 자동 타임아웃 취소를 없앴다.)
// ─────────────────────────────────────────────────────────────────────────────
describe('RunCycle — 무한 대기(자동 타임아웃 취소 없음)', () => {
  it('BUYING: 시간이 아무리 지나도(폴 다수) 취소 0회·상태 유지, 체결 도착 시 HOLDING', () => {
    const port = new FakePort({ autoFill: false });
    const clock = fakeClock(0);
    const cycle = makeCycle(port, clock);
    cycle.start();

    cycle.onSignal('BUY', snap(50, 0.1, 0, 0));
    const buyRef = port.lastRef('buy');
    expect(cycle.state).toBe('BUYING');

    // 예전 타임아웃(5000ms)의 몇 배가 지나도록 여러 번 폴 — 취소는 절대 발동하지 않는다.
    for (let i = 0; i < 10; i++) {
      clock.advance(5000);
      cycle.poll();
    }
    expect(cycle.state).toBe('BUYING');
    expect(port.count('cancel')).toBe(0);

    // 뒤늦게 체결이 도착하면 정상 보유 전환.
    port.fill(buyRef, 50, 3);
    cycle.poll();
    expect(cycle.state).toBe('HOLDING');
    expect(cycle.position?.entryPrice).toBe(50);
  });

  it('SELLING: 시간이 아무리 지나도 취소 0회·상태 유지, 체결 도착 시 DONE + 기록', () => {
    const port = new FakePort({ autoFill: false });
    const clock = fakeClock(0);
    const trades: TradeRecord[] = [];
    const cycle = makeCycle(port, clock, (r) => trades.push(r));
    cycle.start();

    cycle.onSignal('BUY', snap(50, 0.1, 0, 0));
    port.fill(port.lastRef('buy'), 50, 3);
    cycle.poll();
    expect(cycle.state).toBe('HOLDING');

    cycle.onSignal('SELL', snap(60, -0.1, 0, 0));
    const sellRef = port.lastRef('sell');
    expect(cycle.state).toBe('SELLING');

    for (let i = 0; i < 10; i++) {
      clock.advance(5000);
      cycle.poll();
    }
    expect(cycle.state).toBe('SELLING');
    expect(port.count('cancel')).toBe(0);

    port.fill(sellRef, 61, 3);
    cycle.poll();
    expect(cycle.state).toBe('DONE');
    expect(trades).toHaveLength(1);
    expect(trades[0].exitPrice).toBe(61);
    expect(trades[0].exitReason).toBe('SELL_SIGNAL');
  });
});

describe('RunCycle — 안전 인터록(fault)', () => {
  it('fault()는 취소·주문 없이 동결하고, 이후 onSignal·poll에 무반응한다', () => {
    const port = new FakePort({ autoFill: false });
    const cycle = makeCycle(port, fakeClock());
    cycle.start();
    cycle.onSignal('BUY', snap(50, 0.1, 0, 0)); // BUYING(미체결)
    expect(cycle.state).toBe('BUYING');
    const callsBefore = port.calls.length;

    cycle.fault();
    expect(cycle.state).toBe('FAULT');
    expect(port.count('cancel')).toBe(0); // 취소 시도 없음

    // 동결 — 신호·폴 모두 무반응, 추가 주문 없음.
    cycle.onSignal('BUY', snap(40, 0.2, 0, 0));
    cycle.onSignal('SELL', snap(70, -0.2, 0, 0));
    cycle.poll();
    expect(cycle.state).toBe('FAULT');
    expect(port.calls.length).toBe(callsBefore);
  });

  it('FAULT에서 stop()은 주문 없이 DONE으로 빠져나온다(그다음 start로 재개 가능)', () => {
    const port = new FakePort({ autoFill: false });
    const cycle = makeCycle(port, fakeClock());
    cycle.start();
    cycle.onSignal('BUY', snap(50, 0.1, 0, 0));
    cycle.fault();
    expect(cycle.state).toBe('FAULT');

    cycle.stop();
    expect(cycle.state).toBe('DONE');
    expect(port.count('cancel')).toBe(0);

    cycle.start();
    expect(cycle.state).toBe('WATCH_BUY'); // 사용자 재실행으로만 감시 재개
  });
});

describe('RunCycle — Stop', () => {
  it('감시 중(WATCH_BUY) Stop → 즉시 DONE, 주문 없음', () => {
    const port = new FakePort();
    const cycle = makeCycle(port, fakeClock());
    cycle.start();
    cycle.stop();
    expect(cycle.state).toBe('DONE');
    expect(port.calls).toHaveLength(0);
  });

  it('매수 대기 중(BUYING) Stop → 취소 1회 시도, 취소 성공 확인 후 DONE, 포지션 없음', () => {
    const port = new FakePort({ autoFill: false });
    const cycle = makeCycle(port, fakeClock());
    cycle.start();
    cycle.onSignal('BUY', snap(50, 0.1, 0, 0));
    const buyRef = port.lastRef('buy');

    cycle.stop();
    // 취소를 1회 시도하되, 결과 확인 전까지는 종료하지 않는다(늦은 체결/거절 레이스 방지).
    expect(port.count('cancel')).toBe(1);
    expect(cycle.state).toBe('BUYING');

    // 취소 성공(진짜 미체결) 확인 → 매수 없이 종료.
    port.confirmCancel(buyRef);
    cycle.poll();
    expect(cycle.state).toBe('DONE');
    expect(cycle.position).toBeNull();
    expect(port.count('cancel')).toBe(1); // 재취소 없음
  });

  it('매수 대기 중(BUYING) Stop 후 취소 요청 사이 늦은 체결 → 실제로 매수됐으므로 HOLDING', () => {
    const port = new FakePort({ autoFill: false });
    const cycle = makeCycle(port, fakeClock());
    cycle.start();
    cycle.onSignal('BUY', snap(50, 0.1, 0, 0));
    const buyRef = port.lastRef('buy');

    cycle.stop();
    expect(cycle.state).toBe('BUYING');

    // 취소가 확정되기 전에 체결이 관찰되면(취소가 사실상 거절된 상황) 보유로 전환한다 — 미체결 단정 금지.
    port.fill(buyRef, 50, 3);
    cycle.poll();
    expect(cycle.state).toBe('HOLDING');
    expect(cycle.position).not.toBeNull();
  });

  it('매도 진행 중(SELLING) Stop → 취소하지 않고 그 매도 체결로 STOP 종료', () => {
    const port = new FakePort({ autoFill: false });
    const clock = fakeClock();
    const trades: TradeRecord[] = [];
    const cycle = makeCycle(port, clock, (r) => trades.push(r));
    cycle.start();
    cycle.onSignal('BUY', snap(50, 0.1, 0, 0));
    port.fill(port.lastRef('buy'), 50, 3);
    cycle.poll();
    expect(cycle.state).toBe('HOLDING');

    // 신호 매도로 SELLING 진입(미체결).
    cycle.onSignal('SELL', snap(60, -0.1, 0, 0));
    const sellRef = port.lastRef('sell');
    expect(cycle.state).toBe('SELLING');

    // 이 매도가 미체결인 채 Stop — 취소하지 않고(그 매도가 곧 청산) 체결을 기다린다.
    cycle.stop();
    expect(port.count('cancel')).toBe(0);
    expect(cycle.state).toBe('SELLING');

    port.fill(sellRef, 59, 3);
    cycle.poll();
    expect(cycle.state).toBe('DONE');
    expect(trades[0].exitReason).toBe('STOP'); // Stop으로 사유 승격
  });

  it('보유 중(HOLDING) Stop → 전량 매도 후 DONE, STOP 사유 기록', () => {
    const port = new FakePort({ autoFill: true, fillPrice: 50 });
    const clock = fakeClock();
    const trades: TradeRecord[] = [];
    const cycle = makeCycle(port, clock, (r) => trades.push(r));
    cycle.start();
    cycle.onSignal('BUY', snap(50, 0.1, 0, 0));
    cycle.poll();
    expect(cycle.state).toBe('HOLDING');

    port.fillPrice = 55;
    cycle.stop();
    expect(cycle.state).toBe('SELLING');
    expect(port.count('sell')).toBe(1);
    expect(port.calls.find((c) => c.type === 'sell')).toMatchObject({ qty: 3 });

    cycle.poll(); // 체결 → DONE
    expect(cycle.state).toBe('DONE');
    expect(trades).toHaveLength(1);
    expect(trades[0].exitReason).toBe('STOP');
    expect(trades[0].exitPrice).toBe(55);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// 거래 수수료(2026-08-05) — pnl을 순손익으로 만든다. 미주입·0이면 기존 동작과 완전히 동일.
// ─────────────────────────────────────────────────────────────────────────────
describe('RunCycle — 거래 수수료', () => {
  /** 사이클 1회를 완주시켜 거래 기록을 얻는다(기본 진입 50 / 청산 60 / 3주). */
  function runCycle(feeRate: number | undefined, entry = 50, exit = 60, qty = 3): TradeRecord {
    const port = new FakePort({ autoFill: false });
    const clock = fakeClock(0);
    const trades: TradeRecord[] = [];
    const cycle = new RunCycle({
      ticker: 'AAPL',
      qty,
      port,
      clock,
      feeRate,
      onTrade: (r) => trades.push(r),
    });
    cycle.start();
    cycle.onSignal('BUY', snap(entry, 0.1, 0, 0));
    port.fill(port.lastRef('buy'), entry, qty);
    cycle.poll();
    cycle.onSignal('SELL', snap(exit, -0.1, 0, 0));
    port.fill(port.lastRef('sell'), exit, qty);
    cycle.poll();
    return trades[0];
  }

  it('① 수수료율을 주면 매수·매도 대금에 각각 부과해 pnl에서 뺀다', () => {
    const r = runCycle(0.0025);
    expect(r.grossPnl).toBe(30); // (60-50)*3
    expect(r.fees).toBeCloseTo(0.825, 10); // 0.0025 * (50*3 + 60*3)
    expect(r.pnl).toBeCloseTo(29.175, 10);
  });

  it('② 수수료율 미주입이면 pnl은 총손익과 같고 fees는 0이다 (기존 동작 보존)', () => {
    const r = runCycle(undefined);
    expect(r.pnl).toBe(30);
    expect(r.grossPnl).toBe(30);
    expect(r.fees).toBe(0);
  });

  it('③ 음수·NaN·무한대 수수료율은 0으로 처리한다 (NaN pnl 차단)', () => {
    for (const bad of [-0.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = runCycle(bad);
      expect(r.fees).toBe(0);
      expect(r.pnl).toBe(30);
      expect(Number.isFinite(r.pnl)).toBe(true);
    }
  });

  it('④ 손실 사이클에서도 수수료는 손실을 키운다(부호 무관 차감)', () => {
    const r = runCycle(0.0025, 50, 48, 2);
    expect(r.grossPnl).toBe(-4);
    expect(r.fees!).toBeGreaterThan(0);
    expect(r.pnl).toBeLessThan(r.grossPnl!);
  });
});
