import { describe, expect, it } from 'vitest';
import { Grid, type GridConfig, type GridOrderFill, type GridOrderPort, type GridPosition } from './index';

function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

/** 가짜 그리드 포트 — 발주/취소/체결/잔고를 결정론적으로 재생한다. */
class FakeGridPort implements GridOrderPort {
  placed: Array<{ side: 'buy' | 'sell'; qty: number; price: number; odno: string }> = [];
  canceled: Array<{ odno: string; qty: number }> = [];
  failCancel = false;
  failPlace = false;
  /** fetchPosition이 순서대로 돌려줄 값(소진되면 마지막 값 유지). */
  positionQueue: Array<GridPosition | null>;
  private seq = 0;
  private fills = new Map<string, GridOrderFill>();

  constructor(position: GridPosition | null = null) {
    this.positionQueue = [position];
  }

  async placeOrder(side: 'buy' | 'sell', qty: number, price: number): Promise<{ odno: string }> {
    if (this.failPlace) throw new Error('발주 거절(모의)');
    const odno = `O${++this.seq}`;
    this.placed.push({ side, qty, price, odno });
    this.fills.set(odno, { odno, orderQty: qty, filledQty: 0, filledPrice: null });
    return { odno };
  }

  async cancelOrder(odno: string, qty: number): Promise<void> {
    if (this.failCancel) throw new Error('취소 거절(모의)');
    this.canceled.push({ odno, qty });
    this.fills.delete(odno);
  }

  async fetchFills(): Promise<GridOrderFill[]> {
    return [...this.fills.values()];
  }

  async fetchPosition(): Promise<GridPosition | null> {
    return this.positionQueue.length > 1 ? this.positionQueue.shift()! : this.positionQueue[0];
  }

  // ---- 테스트 헬퍼 ----
  fill(odno: string, price: number): void {
    const f = this.fills.get(odno);
    if (f) {
      f.filledQty = f.orderQty;
      f.filledPrice = price;
    }
  }
  legBySide(side: 'buy' | 'sell') {
    return this.placed.find((p) => p.side === side);
  }
}

const baseConfig: GridConfig = { width: 0.1, buyMultiplier: 1 };

describe('core/grid — ±w OCO 지정가 그리드', () => {
  it('③ arm은 두 주문을 발주한다 — 매수가=avg×0.9·매도가=avg×1.1·매수수량=N·매도수량=N', async () => {
    const port = new FakeGridPort({ qty: 10, avgPrice: 100 });
    const grid = new Grid({ port, clock: fakeClock(), config: baseConfig });

    await grid.arm();

    expect(grid.state).toBe('ARMED');
    const buy = port.legBySide('buy');
    const sell = port.legBySide('sell');
    expect(buy).toMatchObject({ side: 'buy', qty: 10, price: 90 });
    expect(sell).toMatchObject({ side: 'sell', qty: 10, price: 110 });
    expect(grid.view).toMatchObject({
      gridActive: true,
      avgPrice: 100,
      buyPrice: 90,
      sellPrice: 110,
      holdingQty: 10,
      buyMultiplier: 1,
    });
  });

  it('① 매도(+w) 체결 → 반대편 매수를 1회 취소하고 SOLD로 종료한다', async () => {
    const port = new FakeGridPort({ qty: 10, avgPrice: 100 });
    const grid = new Grid({ port, clock: fakeClock(), config: baseConfig });
    await grid.arm();

    port.fill(port.legBySide('sell')!.odno, 110);
    const result = await grid.poll();

    expect(result).toEqual({ kind: 'sold', qty: 10, avgPrice: 100, exitPrice: 110 });
    expect(grid.state).toBe('SOLD');
    // 반대편(매수) 취소가 정확히 1회.
    expect(port.canceled).toHaveLength(1);
    expect(port.canceled[0].odno).toBe(port.legBySide('buy')!.odno);
  });

  it('② 매수(−w) 체결 → 매도 취소 후 새 수량·평단으로 리브래킷한다', async () => {
    const port = new FakeGridPort({ qty: 10, avgPrice: 100 });
    // 매수 체결 후 잔고 재조회 값: 20주·평단 95.
    port.positionQueue = [{ qty: 10, avgPrice: 100 }, { qty: 20, avgPrice: 95 }];
    const grid = new Grid({ port, clock: fakeClock(), config: baseConfig });
    await grid.arm();

    const firstSellOdno = port.legBySide('sell')!.odno;
    port.fill(port.legBySide('buy')!.odno, 90);
    const result = await grid.poll();

    expect(result).toEqual({ kind: 'rebracket', position: { qty: 20, avgPrice: 95 } });
    expect(grid.state).toBe('ARMED');
    // 옛 매도 취소 1회.
    expect(port.canceled.map((c) => c.odno)).toContain(firstSellOdno);
    // 새 브래킷 — 평단 95 기준 재계산: 95×0.9=85.5, 95×1.1=104.5.
    expect(grid.view).toMatchObject({ avgPrice: 95, buyPrice: 85.5, sellPrice: 104.5, holdingQty: 20 });
    // 리브래킷 후 두 주문이 새로 발주됨(총 발주 4건: 초기 2 + 리브래킷 2).
    expect(port.placed.filter((p) => p.side === 'sell')).toHaveLength(2);
    expect(port.placed.filter((p) => p.side === 'buy')).toHaveLength(2);
  });

  it('④ OCO 취소가 거절되면 FAULT로 동결한다', async () => {
    const port = new FakeGridPort({ qty: 10, avgPrice: 100 });
    const grid = new Grid({ port, clock: fakeClock(), config: baseConfig });
    await grid.arm();

    port.failCancel = true;
    port.fill(port.legBySide('sell')!.odno, 110);
    const result = await grid.poll();

    expect(result.kind).toBe('fault');
    expect(grid.state).toBe('FAULT');
  });

  it('⑤ buyMultiplier=2 → 매수수량 = N×2, 매도수량 = N', async () => {
    const port = new FakeGridPort({ qty: 10, avgPrice: 100 });
    const grid = new Grid({ port, clock: fakeClock(), config: { width: 0.1, buyMultiplier: 2 } });

    await grid.arm();

    expect(port.legBySide('buy')).toMatchObject({ qty: 20, price: 90 });
    expect(port.legBySide('sell')).toMatchObject({ qty: 10, price: 110 });
    expect(grid.view.buyMultiplier).toBe(2);
  });

  it('⑥ 현금이 부족하면 매수 다리를 살 수 있는 최대로 축소한다', async () => {
    const port = new FakeGridPort({ qty: 10, avgPrice: 100 });
    // buyPrice=90, 매수 필요 10주×90=$900. 가용 $500 → floor(500/90)=5주.
    const grid = new Grid({ port, clock: fakeClock(), config: { width: 0.1, buyMultiplier: 1, availableCashUsd: 500 } });

    await grid.arm();

    expect(port.legBySide('buy')).toMatchObject({ qty: 5, price: 90 });
    expect(port.legBySide('sell')).toMatchObject({ qty: 10, price: 110 });
  });

  it('⑥ 현금이 0이면 매수 다리를 생략하고 매도(익절) 다리만 발주한다', async () => {
    const port = new FakeGridPort({ qty: 10, avgPrice: 100 });
    const grid = new Grid({ port, clock: fakeClock(), config: { width: 0.1, buyMultiplier: 1, availableCashUsd: 0 } });

    await grid.arm();

    expect(grid.state).toBe('ARMED');
    expect(port.legBySide('buy')).toBeUndefined();
    expect(port.legBySide('sell')).toMatchObject({ qty: 10, price: 110 });

    // 매도만 있는 상태에서 매도 체결 → 취소할 반대편이 없어도 정상 SOLD.
    port.fill(port.legBySide('sell')!.odno, 110);
    const result = await grid.poll();
    expect(result).toMatchObject({ kind: 'sold' });
    expect(port.canceled).toHaveLength(0);
  });

  it('D1 잔고 반영 지연 — fetchPosition이 처음엔 null이어도 재시도로 잡는다', async () => {
    const port = new FakeGridPort();
    port.positionQueue = [null, null, { qty: 8, avgPrice: 50 }];
    const grid = new Grid({ port, clock: fakeClock(), config: baseConfig, positionRetries: 3 });

    await grid.arm();

    expect(grid.state).toBe('ARMED');
    expect(port.legBySide('sell')).toMatchObject({ qty: 8, price: 55 });
  });

  it('D1 잔고를 끝내 못 읽으면 fallback(직전 체결가·수량)으로 브래킷을 세운다', async () => {
    const port = new FakeGridPort(null); // 항상 null
    const grid = new Grid({ port, clock: fakeClock(), config: baseConfig, positionRetries: 2 });

    await grid.arm({ qty: 3, avgPrice: 200 });

    expect(grid.state).toBe('ARMED');
    expect(port.legBySide('sell')).toMatchObject({ qty: 3, price: 220 });
    expect(port.legBySide('buy')).toMatchObject({ qty: 3, price: 180 });
  });
});
