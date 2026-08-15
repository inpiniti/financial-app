import { describe, expect, it } from 'vitest';

import { Execution, type ExecutionOrderFill, type ExecutionOrderPort } from './index';

function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** 가짜 매매 포트 — FakeBroker와 같은 의미론(정정=새 odno 채번·옛 odno 소멸, 취소=목록 제거). */
class FakePort implements ExecutionOrderPort {
  placed: Array<{ side: 'buy' | 'sell'; qty: number; price: number; odno: string }> = [];
  amended: Array<{ from: string; to: string; qty: number; price: number }> = [];
  canceled: string[] = [];
  autoFill = false;
  failPlace = false;
  failAmend = false;
  failCancel = false;
  failFetch = false;
  private seq = 0;
  private readonly fills = new Map<string, ExecutionOrderFill>();

  async placeOrder(side: 'buy' | 'sell', qty: number, price: number): Promise<{ odno: string }> {
    if (this.failPlace) throw new Error('발주 거절(모의)');
    const odno = `O${++this.seq}`;
    this.placed.push({ side, qty, price, odno });
    this.fills.set(odno, {
      odno,
      orderQty: qty,
      filledQty: this.autoFill ? qty : 0,
      filledPrice: this.autoFill ? price : null,
    });
    return { odno };
  }

  async amendOrder(odno: string, _side: 'buy' | 'sell', qty: number, price: number): Promise<{ odno: string }> {
    if (this.failAmend) throw new Error('정정 거절(모의)');
    const next = `O${++this.seq}`;
    this.amended.push({ from: odno, to: next, qty, price });
    this.fills.delete(odno);
    this.fills.set(next, {
      odno: next,
      orderQty: qty,
      filledQty: this.autoFill ? qty : 0,
      filledPrice: this.autoFill ? price : null,
    });
    return { odno: next };
  }

  async cancelOrder(odno: string): Promise<void> {
    if (this.failCancel) throw new Error('취소 거절(모의)');
    this.canceled.push(odno);
    this.fills.delete(odno);
  }

  async fetchFills(): Promise<ExecutionOrderFill[]> {
    if (this.failFetch) throw new Error('체결 확인 거절(모의)');
    return [...this.fills.values()];
  }

  fill(odno: string, price: number): void {
    const f = this.fills.get(odno);
    if (f) {
      f.filledQty = f.orderQty;
      f.filledPrice = price;
    }
  }

  fillPartial(odno: string, qty: number, price: number): void {
    const f = this.fills.get(odno);
    if (f) {
      f.filledQty = Math.min(qty, f.orderQty);
      f.filledPrice = price;
    }
  }

  /** "목록 부재→전량체결" 추론 재현 — 체결가 없는 전량체결. */
  fillWithoutPrice(odno: string): void {
    const f = this.fills.get(odno);
    if (f) {
      f.filledQty = f.orderQty;
      f.filledPrice = null;
    }
  }
}

function make(
  side: 'buy' | 'sell',
  qty: number,
  opts: { abort?: (p: number) => boolean; port?: FakePort } = {},
) {
  const port = opts.port ?? new FakePort();
  const clock = fakeClock(0);
  const exec = new Execution({
    port,
    clock,
    side,
    qty,
    shouldAbort: opts.abort ?? (() => false),
  });
  return { exec, port, clock };
}

describe('Execution — 현재가 지정가 발주·체결', () => {
  it('start는 현재가를 KIS 자릿수로 절사해 정확 지정가 1건을 낸다', async () => {
    const { exec, port } = make('sell', 10);
    await exec.start(100.123456);
    expect(exec.state).toBe('WORKING');
    expect(port.placed).toEqual([{ side: 'sell', qty: 10, price: 100.12, odno: 'O1' }]);
  });

  it('전량 체결 → DONE(체결가·수량 실측)', async () => {
    const { exec, port } = make('sell', 10);
    port.autoFill = true;
    await exec.start(100);
    const r = await exec.poll();
    expect(r).toEqual({ kind: 'done', result: { filledQty: 10, fillPrice: 100, priceConfirmed: true } });
    expect(exec.state).toBe('DONE');
  });

  it('발주 실패는 즉시 FAULT(아직 주문이 없어 안전)', async () => {
    const { exec, port } = make('buy', 5);
    port.failPlace = true;
    await exec.start(50);
    expect(exec.state).toBe('FAULT');
  });
});

describe('Execution — 현재가 추격(정정)', () => {
  it('가격이 바뀌면 스로틀(기본 1초) 경과 후 잔량을 새 현재가로 정정한다', async () => {
    const { exec, port, clock } = make('sell', 10);
    await exec.start(100);
    await exec.onPrice(101); // 스로틀 이내 — 정정 없음
    expect(port.amended).toHaveLength(0);
    clock.advance(1000);
    await exec.onPrice(101);
    expect(port.amended).toEqual([{ from: 'O1', to: 'O2', qty: 10, price: 101 }]);
    expect(exec.orderPrice).toBe(101);
    // 같은 가격이면 스로틀이 지나도 정정하지 않는다.
    clock.advance(1000);
    await exec.onPrice(101);
    expect(port.amended).toHaveLength(1);
  });

  it('부분 체결 후 추격 — 잔량만 정정하고 총 체결은 가중평균으로 합산한다', async () => {
    const { exec, port, clock } = make('buy', 10);
    await exec.start(100);
    port.fillPartial('O1', 4, 100);
    await exec.poll(); // 부분 체결 관찰
    clock.advance(1000);
    await exec.onPrice(99);
    expect(port.amended).toEqual([{ from: 'O1', to: 'O2', qty: 6, price: 99 }]);
    port.fill('O2', 99);
    const r = await exec.poll();
    expect(r.kind).toBe('done');
    if (r.kind === 'done') {
      expect(r.result.filledQty).toBe(10);
      expect(r.result.fillPrice).toBeCloseTo((4 * 100 + 6 * 99) / 10);
      expect(r.result.priceConfirmed).toBe(true);
    }
  });

  it('정정 거절 1회는 견딘다(주문은 옛 가격에 살아 있다) — 연속 한도 도달 시 FAULT', async () => {
    const { exec, port, clock } = make('sell', 10);
    await exec.start(100);
    port.failAmend = true;
    clock.advance(1000);
    await exec.onPrice(101);
    expect(exec.state).toBe('WORKING'); // 1회 — 유지
    clock.advance(1000);
    await exec.onPrice(102);
    clock.advance(1000);
    await exec.onPrice(103);
    expect(exec.state).toBe('FAULT'); // 3회 연속 — 동결
  });

  it('추론 체결(체결가 미실측)은 지정가로 대체하고 priceConfirmed=false를 남긴다', async () => {
    const { exec, port } = make('sell', 10);
    await exec.start(100);
    port.fillWithoutPrice('O1');
    const r = await exec.poll();
    expect(r.kind).toBe('done');
    if (r.kind === 'done') {
      expect(r.result.fillPrice).toBe(100); // 다리 지정가 폴백
      expect(r.result.priceConfirmed).toBe(false); // 호출부의 잔고 검증 트리거
    }
  });
});

describe('Execution — 취소선(shouldAbort)', () => {
  it('취소선 도달 → 잔량 취소 → CANCELLED(체결 0)', async () => {
    const { exec, port } = make('sell', 10, { abort: (p) => p < 102 });
    await exec.start(103);
    await exec.onPrice(101.5);
    expect(port.canceled).toEqual(['O1']);
    expect(exec.state).toBe('CANCELLED');
    expect(exec.result.filledQty).toBe(0);
  });

  it('부분 체결 후 취소선 도달 → 잔량만 취소하고 체결분을 보고한다', async () => {
    const { exec, port } = make('sell', 10, { abort: (p) => p < 102 });
    await exec.start(103);
    port.fillPartial('O1', 3, 103);
    await exec.poll();
    await exec.onPrice(101);
    expect(exec.state).toBe('CANCELLED');
    expect(exec.result).toEqual({ filledQty: 3, fillPrice: 103, priceConfirmed: true });
  });

  it('취소 거절(이미 체결 추정) → 재취소 없이 폴이 체결을 확정하면 DONE(구제)', async () => {
    const { exec, port } = make('sell', 10, { abort: (p) => p < 102 });
    await exec.start(103);
    port.failCancel = true;
    await exec.onPrice(101); // 취소 거절 — 모호 상태 진입(재발사 금지)
    expect(exec.state).toBe('WORKING');
    await exec.onPrice(101); // 재취소를 쏘지 않는다
    expect(port.canceled).toHaveLength(0);
    port.fill('O1', 103);
    const r = await exec.poll();
    expect(r.kind).toBe('done');
  });

  it('취소 거절 후 체결도 확인되지 않으면 한도 폴에서 FAULT(모호 — 사람 호출)', async () => {
    const { exec, port } = make('sell', 10, { abort: (p) => p < 102 });
    await exec.start(103);
    port.failCancel = true;
    await exec.onPrice(101);
    await exec.poll();
    await exec.poll();
    const r = await exec.poll();
    expect(r.kind).toBe('fault');
    expect(exec.state).toBe('FAULT');
  });
});

describe('Execution — 장애 허용·종료', () => {
  it('체결 확인 실패는 연속 한도(3회)까지 견딘다', async () => {
    const { exec, port } = make('sell', 10);
    await exec.start(100);
    port.failFetch = true;
    expect((await exec.poll()).kind).toBe('working');
    expect((await exec.poll()).kind).toBe('working');
    expect((await exec.poll()).kind).toBe('fault');
  });

  it('release — 잔량을 최선껏 취소하고 CANCELLED(취소 거절도 그대로 종료)', async () => {
    const a = make('sell', 10);
    await a.exec.start(100);
    await a.exec.release();
    expect(a.port.canceled).toEqual(['O1']);
    expect(a.exec.state).toBe('CANCELLED');

    const b = make('sell', 10);
    await b.exec.start(100);
    b.port.failCancel = true;
    await b.exec.release();
    expect(b.exec.state).toBe('CANCELLED'); // 거절이어도 종료 — 잔여 주문은 호출부가 안내
  });
});
