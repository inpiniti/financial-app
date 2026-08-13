import { describe, expect, it } from 'vitest';
import {
  FILL_FAIL_LIMIT,
  Grid,
  REBRACKET_RETRY_MS,
  type GridConfig,
  type GridOrderFill,
  type GridOrderPort,
  type GridPosition,
} from './index';

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
  /** 매수 발주만 거절(현금 부족 거절 재현) — 매도는 정상 접수된다. */
  failBuyPlace = false;
  /** fetchFills가 throw하는 횟수(카운트다운) — 일시 오류 재현. */
  failFetchFillsTimes = 0;
  /** fetchPosition이 순서대로 돌려줄 값(소진되면 마지막 값 유지). */
  positionQueue: Array<GridPosition | null>;
  /** fetchPosition이 throw — 잔고 조회 일시 오류 재현. */
  failPosition = false;
  private seq = 0;
  private fills = new Map<string, GridOrderFill>();

  constructor(position: GridPosition | null = null) {
    this.positionQueue = [position];
  }

  async placeOrder(side: 'buy' | 'sell', qty: number, price: number): Promise<{ odno: string }> {
    if (this.failPlace) throw new Error('발주 거절(모의)');
    if (this.failBuyPlace && side === 'buy') throw new Error('매수 거절 — 주문가능금액 부족(모의)');
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
    if (this.failFetchFillsTimes > 0) {
      this.failFetchFillsTimes -= 1;
      throw new Error('체결 확인 거절(모의)');
    }
    return [...this.fills.values()];
  }

  async fetchPosition(): Promise<GridPosition | null> {
    if (this.failPosition) throw new Error('잔고 조회 거절(모의)');
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
  /** 마지막(살아 있는) 다리를 방향으로 찾는다 — 리브래킷 후에는 최신 발주가 그 방향의 다리다. */
  lastLeg(side: 'buy' | 'sell') {
    return this.placed.filter((p) => p.side === side && this.fills.has(p.odno)).at(-1);
  }
  legBySide(side: 'buy' | 'sell') {
    return this.placed.find((p) => p.side === side);
  }
  /**
   * KIS 일괄 취소 재현 — 주문이 미체결 목록에서 사라져 브로커가 "전량체결(추론·price null)"로
   * 합성한 상태(createKisBroker fetchFills의 목록 부재 경로와 같은 모양).
   */
  vanish(odno: string): void {
    const f = this.fills.get(odno);
    if (f) {
      f.filledQty = f.orderQty;
      f.filledPrice = null;
    }
  }
}

const baseConfig: GridConfig = { width: 0.1 };

describe('core/grid — 사다리 그리드: arm·수량 규칙', () => {
  it('arm — 진입 수량이 1단위가 되고, 매도=1단위 @중앙+step, 매수=2단위 @중앙−step을 건다', async () => {
    const port = new FakeGridPort({ qty: 10, avgPrice: 100 });
    const grid = new Grid({ port, clock: fakeClock(), config: baseConfig });

    await grid.arm();

    expect(grid.state).toBe('ARMED');
    // unit=10, step=100×0.1=10 → 매도 10주 @110, 매수 20주(10+unit) @90.
    expect(port.legBySide('sell')).toMatchObject({ qty: 10, price: 110 });
    expect(port.legBySide('buy')).toMatchObject({ qty: 20, price: 90 });
    expect(grid.view).toMatchObject({
      gridActive: true,
      centerPrice: 100,
      buyPrice: 90,
      sellPrice: 110,
      holdingQty: 10,
      unitQty: 10,
      nextSellQty: 10,
      nextBuyQty: 20,
    });
  });

  it('진입 lot 매도(+step) 체결 → 반대편 매수를 1회 취소하고 SOLD로 종료한다(전량 정리)', async () => {
    const port = new FakeGridPort({ qty: 10, avgPrice: 100 });
    const grid = new Grid({ port, clock: fakeClock(), config: baseConfig });
    await grid.arm();

    port.fill(port.legBySide('sell')!.odno, 110);
    const result = await grid.poll();

    expect(result).toEqual({ kind: 'sold', qty: 10, costPrice: 100, exitPrice: 110 });
    expect(grid.state).toBe('SOLD');
    // 반대편(매수) 취소가 정확히 1회.
    expect(port.canceled).toHaveLength(1);
    expect(port.canceled[0].odno).toBe(port.legBySide('buy')!.odno);
  });

  it('매수(−w) 체결 → 매도 취소, 매수가가 새 중앙값 — 매도=방금 산 수량, 매수=+1단위', async () => {
    const port = new FakeGridPort({ qty: 10, avgPrice: 100 });
    port.positionQueue = [{ qty: 10, avgPrice: 100 }, { qty: 30, avgPrice: 93.33 }];
    const grid = new Grid({ port, clock: fakeClock(), config: baseConfig });
    await grid.arm();

    const firstSellOdno = port.legBySide('sell')!.odno;
    port.fill(port.legBySide('buy')!.odno, 90);
    const result = await grid.poll();

    expect(result).toMatchObject({ kind: 'rebracket', position: { qty: 30 } });
    expect(grid.state).toBe('ARMED');
    // 옛 매도 취소 1회.
    expect(port.canceled.map((c) => c.odno)).toContain(firstSellOdno);
    // 새 중앙값 90(방금 매수 레벨) — %를 재계산: 매도 20주 @99(90×1.1), 매수 30주 @81(90×0.9).
    expect(port.lastLeg('sell')).toMatchObject({ qty: 20, price: 99 });
    expect(port.lastLeg('buy')).toMatchObject({ qty: 30, price: 81 });
    expect(grid.view).toMatchObject({ centerPrice: 90, buyPrice: 81, sellPrice: 99, holdingQty: 30 });
  });

  it('왕복 — 매수 후 한 칸 위 매도가 체결되면 그 lot의 실제 매수가 기준으로 stepSold 익절한다', async () => {
    // 100 진입(1단위) → 90에 2단위 매수 → 99(90×1.1)에 2단위 매도 → 진입 lot만 남는다.
    // % 간격이라 레벨이 조금씩 어긋나므로(100→99), 익절 기록은 lot에 저장된 매수가로 남는다.
    const port = new FakeGridPort({ qty: 1, avgPrice: 100 });
    const grid = new Grid({ port, clock: fakeClock(), config: baseConfig });
    await grid.arm();
    expect(port.legBySide('sell')).toMatchObject({ qty: 1, price: 110 });
    expect(port.legBySide('buy')).toMatchObject({ qty: 2, price: 90 });

    // 90 매수 2주 체결 → 중앙 90: 매도 2주 @99, 매수 3주 @81.
    port.fill(port.legBySide('buy')!.odno, 90);
    expect((await grid.poll()).kind).toBe('rebracket');
    expect(port.lastLeg('sell')).toMatchObject({ qty: 2, price: 99 });
    expect(port.lastLeg('buy')).toMatchObject({ qty: 3, price: 81 });

    // 99 매도 2주 체결 → 한 칸 익절(90에 산 lot) — 중앙 99: 매도 1주 @108.9, 매수 2주 @89.1.
    port.fill(port.lastLeg('sell')!.odno, 99);
    const result = await grid.poll();
    expect(result).toMatchObject({ kind: 'stepSold', qty: 2, costPrice: 90, exitPrice: 99 });
    expect(grid.state).toBe('ARMED');
    expect(port.lastLeg('sell')).toMatchObject({ qty: 1, price: 108.9 });
    expect(port.lastLeg('buy')).toMatchObject({ qty: 2, price: 89.1 });
    expect(grid.view).toMatchObject({ centerPrice: 99, holdingQty: 1 });

    // 108.9 매도 1주(진입 lot) 체결 → 전량 정리 SOLD — costPrice는 진입가 100(중앙값 유추가 아니다).
    port.fill(port.lastLeg('sell')!.odno, 108.9);
    const final = await grid.poll();
    expect(final).toEqual({ kind: 'sold', qty: 1, costPrice: 100, exitPrice: 108.9 });
    expect(grid.state).toBe('SOLD');
  });

  it('두 칸 하락 — 매수 수량이 1단위씩만 늘고(산술급수), 칸은 %라 주가 따라 좁아진다', async () => {
    const port = new FakeGridPort({ qty: 5, avgPrice: 100 });
    const grid = new Grid({ port, clock: fakeClock(), config: baseConfig });
    await grid.arm();

    // 90 매수 10주(2단위) 체결 → 중앙 90: 매수 15주(3단위) @81.
    port.fill(port.legBySide('buy')!.odno, 90);
    await grid.poll();
    expect(port.lastLeg('buy')).toMatchObject({ qty: 15, price: 81 });
    // 81 매수 15주 체결 → 중앙 81: 매도 15주 @89.1, 매수 20주(4단위) @72.9.
    port.fill(port.lastLeg('buy')!.odno, 81);
    await grid.poll();
    expect(port.lastLeg('sell')).toMatchObject({ qty: 15, price: 89.1 });
    expect(port.lastLeg('buy')).toMatchObject({ qty: 20, price: 72.9 });
    expect(grid.view.holdingQty).toBe(30); // 5+10+15 — 잔고 폴백(내부 계산).
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

  it('⑥ 현금이 부족하면 매수 다리를 살 수 있는 최대로 축소하고, 그 lot의 매도는 실제 산 수량만큼이다', async () => {
    const port = new FakeGridPort({ qty: 10, avgPrice: 100 });
    // 목표 매수 20주×$90=$1,800. 가용 $500 → floor(500/90)=5주.
    const grid = new Grid({ port, clock: fakeClock(), config: { width: 0.1, availableCashUsd: 500 } });

    await grid.arm();
    expect(port.legBySide('buy')).toMatchObject({ qty: 5, price: 90 });
    expect(port.legBySide('sell')).toMatchObject({ qty: 10, price: 110 });

    // 축소된 5주가 체결되면 lot=5 — 매도도 5주(정확히 그 매수만 되돌린다), 가격은 90×1.1=99.
    port.fill(port.legBySide('buy')!.odno, 90);
    await grid.poll();
    expect(port.lastLeg('sell')).toMatchObject({ qty: 5, price: 99 });
  });

  it('⑥ 현금이 0이면 매수 다리를 생략하고 매도(익절) 다리만 발주한다', async () => {
    const port = new FakeGridPort({ qty: 10, avgPrice: 100 });
    const grid = new Grid({ port, clock: fakeClock(), config: { width: 0.1, availableCashUsd: 0 } });

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

  it('D1 잔고를 끝내 못 읽으면 fallback(직전 체결가·수량)으로 사다리를 세운다', async () => {
    const port = new FakeGridPort(null); // 항상 null
    const grid = new Grid({ port, clock: fakeClock(), config: baseConfig, positionRetries: 2 });

    await grid.arm({ qty: 3, avgPrice: 200 });

    expect(grid.state).toBe('ARMED');
    expect(port.legBySide('sell')).toMatchObject({ qty: 3, price: 220 });
    expect(port.legBySide('buy')).toMatchObject({ qty: 6, price: 180 });
  });
});

describe('core/grid — 최신 현금 콜백(fetchAvailableCash)·다리별 격리·체결 확인 재시도', () => {
  it('리브래킷마다 콜백을 다시 불러 최신 현금으로 매수 수량을 판정한다', async () => {
    const port = new FakeGridPort({ qty: 10, avgPrice: 100 });
    port.positionQueue = [{ qty: 10, avgPrice: 100 }, { qty: 30, avgPrice: 93.33 }];
    // arm 때는 $2,000(전량 가능) → 리브래킷 때는 $300으로 줄었다(물타기로 현금 소진).
    const cashSeq = [2000, 300];
    const asked: number[] = [];
    const grid = new Grid({
      port,
      clock: fakeClock(),
      config: baseConfig,
      fetchAvailableCash: async (buyPrice) => {
        asked.push(buyPrice);
        return cashSeq.shift() ?? 0;
      },
    });
    await grid.arm();
    expect(port.legBySide('buy')).toMatchObject({ qty: 20, price: 90 });
    expect(grid.view.buyLegStatus).toBe('full');

    // 매수 체결 → 중앙 90, buyPrice 81 — 이번엔 현금 $300 → floor(300/81)=3주(< 목표 30주).
    port.fill(port.legBySide('buy')!.odno, 90);
    const result = await grid.poll();
    expect(result.kind).toBe('rebracket');
    expect(asked).toEqual([90, 81]); // 발주 직전 buyPrice로 매번 재조회.
    expect(port.lastLeg('buy')).toMatchObject({ qty: 3, price: 81 });
    expect(grid.view.buyLegStatus).toBe('reduced');
  });

  it('콜백이 null·throw면 config.availableCashUsd로 폴백해 판정한다', async () => {
    // null 반환 → 캡처값 $500으로 판정(floor(500/90)=5주 < 목표 20주).
    const p1 = new FakeGridPort({ qty: 10, avgPrice: 100 });
    const g1 = new Grid({
      port: p1,
      clock: fakeClock(),
      config: { width: 0.1, availableCashUsd: 500 },
      fetchAvailableCash: async () => null,
    });
    await g1.arm();
    expect(p1.legBySide('buy')).toMatchObject({ qty: 5 });
    expect(g1.view.buyLegStatus).toBe('reduced');

    // throw → 캡처값도 없으면 판정 생략(목표 전량 발주).
    const p2 = new FakeGridPort({ qty: 10, avgPrice: 100 });
    const g2 = new Grid({
      port: p2,
      clock: fakeClock(),
      config: baseConfig,
      fetchAvailableCash: async () => {
        throw new Error('조회 실패(모의)');
      },
    });
    await g2.arm();
    expect(p2.legBySide('buy')).toMatchObject({ qty: 20 });
    expect(g2.view.buyLegStatus).toBe('full');
  });

  it('현금 0 → skippedCash로 매도만 ARMED, 매도 체결은 정상 SOLD', async () => {
    const port = new FakeGridPort({ qty: 10, avgPrice: 100 });
    const grid = new Grid({
      port,
      clock: fakeClock(),
      config: baseConfig,
      fetchAvailableCash: async () => 0,
    });
    await grid.arm();

    expect(grid.state).toBe('ARMED');
    expect(grid.view.buyLegStatus).toBe('skippedCash');
    expect(port.legBySide('buy')).toBeUndefined();

    port.fill(port.legBySide('sell')!.odno, 110);
    const result = await grid.poll();
    expect(result).toMatchObject({ kind: 'sold' });
  });

  it('매수 발주만 거절 → FAULT 아님 — rejected로 표기하고 매도만 ARMED 유지', async () => {
    const port = new FakeGridPort({ qty: 10, avgPrice: 100 });
    port.failBuyPlace = true;
    const grid = new Grid({ port, clock: fakeClock(), config: baseConfig });
    await grid.arm();

    expect(grid.state).toBe('ARMED');
    expect(grid.view.buyLegStatus).toBe('rejected');
    expect(port.legBySide('sell')).toMatchObject({ qty: 10, price: 110 });
    expect(port.legBySide('buy')).toBeUndefined();

    // 매도 체결 → 정상 SOLD(매수 다리가 없어도 사이클이 완주한다).
    port.fill(port.legBySide('sell')!.odno, 110);
    const result = await grid.poll();
    expect(result).toMatchObject({ kind: 'sold', qty: 10 });
  });

  it('매도 발주 거절은 여전히 FAULT다(익절 다리 없는 방치가 진짜 위험) — 회귀', async () => {
    const port = new FakeGridPort({ qty: 10, avgPrice: 100 });
    port.failPlace = true;
    const grid = new Grid({ port, clock: fakeClock(), config: baseConfig });
    await grid.arm();

    expect(grid.state).toBe('FAULT');
    expect(grid.faultText).toContain('매도 발주 실패');
  });

  it(`fetchFills 일시 오류 ${FILL_FAIL_LIMIT - 1}회는 armed 유지·성공 시 리셋, ${FILL_FAIL_LIMIT}연속이면 FAULT`, async () => {
    const port = new FakeGridPort({ qty: 10, avgPrice: 100 });
    const grid = new Grid({ port, clock: fakeClock(), config: baseConfig });
    await grid.arm();

    // (상한−1)연속 실패 — 아직 armed(주문은 살아 있다).
    port.failFetchFillsTimes = FILL_FAIL_LIMIT - 1;
    for (let i = 0; i < FILL_FAIL_LIMIT - 1; i += 1) {
      expect(await grid.poll()).toEqual({ kind: 'armed' });
      expect(grid.state).toBe('ARMED');
    }
    // 성공 1회 — 카운터 리셋(직전 실패가 이월되지 않는다).
    expect(await grid.poll()).toEqual({ kind: 'armed' });

    // 리셋 후 상한까지 연속 실패 → 마지막 1회에서 FAULT.
    port.failFetchFillsTimes = FILL_FAIL_LIMIT;
    for (let i = 0; i < FILL_FAIL_LIMIT - 1; i += 1) {
      expect(await grid.poll()).toEqual({ kind: 'armed' });
    }
    const result = await grid.poll();
    expect(result.kind).toBe('fault');
    expect(grid.state).toBe('FAULT');
    expect(grid.faultText).toContain('체결 확인');
  });
});

describe('core/grid — 세션 전환·일괄 취소 방어(재발주)', () => {
  it('두 다리가 동시에 추론 체결로 사라지면 SOLD가 아니라 일괄 취소로 보고 같은 사다리로 재발주한다', async () => {
    const port = new FakeGridPort({ qty: 10, avgPrice: 100 });
    const grid = new Grid({ port, clock: fakeClock(), config: baseConfig });
    await grid.arm();

    port.vanish(port.legBySide('buy')!.odno);
    port.vanish(port.legBySide('sell')!.odno);
    const result = await grid.poll();

    expect(result).toMatchObject({ kind: 'rebracket', cause: 'reissue', position: { qty: 10, avgPrice: 100 } });
    expect(grid.state).toBe('ARMED');
    // 방어적 취소 2건(살아 있었다면 실제로 끊는다 — 이미 취소된 주문의 거절은 무시) + 재발주 2건.
    expect(port.canceled).toHaveLength(2);
    expect(port.placed.filter((p) => p.side === 'sell')).toHaveLength(2);
    expect(port.placed.filter((p) => p.side === 'buy')).toHaveLength(2);
    // 사다리 상태 불변 — 같은 가격·수량으로 다시 걸린다.
    expect(port.lastLeg('sell')).toMatchObject({ qty: 10, price: 110 });
    expect(port.lastLeg('buy')).toMatchObject({ qty: 20, price: 90 });
  });

  it('매도 단독 다리의 추론 소멸 — 잔고가 그대로면(취소) 2폴 유예 뒤 재발주, 잔고가 줄면(진짜 체결) SOLD', async () => {
    // ① 취소 케이스 — 잔고에 전량이 그대로 남아 있다.
    const p1 = new FakeGridPort({ qty: 10, avgPrice: 100 });
    const g1 = new Grid({ port: p1, clock: fakeClock(), config: { width: 0.1, availableCashUsd: 0 } });
    await g1.arm();
    expect(p1.legBySide('buy')).toBeUndefined(); // 매도만 ARMED.

    p1.vanish(p1.legBySide('sell')!.odno);
    expect((await g1.poll()).kind).toBe('armed'); // 1폴째 — 잔고 반영 지연 유예.
    const r1 = await g1.poll(); // 2폴째 — 잔고 불변 확정 → 취소로 판정.
    expect(r1).toMatchObject({ kind: 'rebracket', cause: 'reissue' });
    expect(g1.state).toBe('ARMED');
    expect(p1.placed.filter((p) => p.side === 'sell')).toHaveLength(2);

    // ② 진짜 체결 케이스 — 잔고가 비었다 → 기존대로 SOLD(체결가는 지정가로 폴백).
    const p2 = new FakeGridPort({ qty: 10, avgPrice: 100 });
    const g2 = new Grid({ port: p2, clock: fakeClock(), config: { width: 0.1, availableCashUsd: 0 } });
    await g2.arm();
    p2.vanish(p2.legBySide('sell')!.odno);
    p2.positionQueue = [null]; // 매도 체결로 잔고 소멸.
    const r2 = await g2.poll();
    expect(r2).toMatchObject({ kind: 'sold', qty: 10, exitPrice: 110 });
    expect(g2.state).toBe('SOLD');
  });

  it('사다리 중간의 매도 추론 소멸 — 잔고가 매도분만큼 줄었으면 stepSold(부분 매도)로 판정한다', async () => {
    // 진입 5주@100 → 90에 10주 매수 체결(보유 15) → 매도 다리 10주@99.
    const port = new FakeGridPort({ qty: 5, avgPrice: 100 });
    const grid = new Grid({ port, clock: fakeClock(), config: baseConfig });
    await grid.arm();
    port.fill(port.legBySide('buy')!.odno, 90);
    await grid.poll();
    expect(port.lastLeg('sell')).toMatchObject({ qty: 10, price: 99 });

    // 매도 10주가 추론 소멸 — 잔고가 15→5로 줄었다 = 진짜 체결.
    port.vanish(port.lastLeg('sell')!.odno);
    port.positionQueue = [{ qty: 5, avgPrice: 100 }];
    const result = await grid.poll();
    expect(result).toMatchObject({ kind: 'stepSold', qty: 10, costPrice: 90, exitPrice: 99 });
    expect(grid.state).toBe('ARMED'); // 진입 lot이 남아 사다리는 계속.
  });

  it('추론 소멸 검증 중 잔고 조회가 실패하면 판정을 다음 폴로 미룬다(armed 유지)', async () => {
    const port = new FakeGridPort({ qty: 10, avgPrice: 100 });
    const grid = new Grid({ port, clock: fakeClock(), config: { width: 0.1, availableCashUsd: 0 } });
    await grid.arm();

    port.vanish(port.legBySide('sell')!.odno);
    port.failPosition = true;
    expect((await grid.poll()).kind).toBe('armed');
    expect(grid.state).toBe('ARMED');
    expect(port.placed).toHaveLength(1); // 재발주 없음 — 오판 방지.
  });

  it(`재발주가 거절되면 FAULT 대신 ${REBRACKET_RETRY_MS / 1000}초 후 재시도한다(세션 간극 — 주문 API 닫힘)`, async () => {
    const clock = fakeClock();
    const port = new FakeGridPort({ qty: 10, avgPrice: 100 });
    const grid = new Grid({ port, clock, config: baseConfig });
    await grid.arm();

    port.vanish(port.legBySide('buy')!.odno);
    port.vanish(port.legBySide('sell')!.odno);
    port.failPlace = true;
    const r1 = await grid.poll();
    expect(r1.kind).toBe('rebracketDeferred');
    expect(grid.state).toBe('ARMED'); // FAULT가 아니다 — 새 세션이 열리면 접수된다.

    // 재시도 시각 전 — 발주 시도 없이 armed.
    const placedBefore = port.placed.length;
    expect((await grid.poll()).kind).toBe('armed');
    expect(port.placed.length).toBe(placedBefore);

    // 재시도 시각 도래 + API 열림 — 재발주 성공.
    clock.advance(REBRACKET_RETRY_MS);
    port.failPlace = false;
    const r2 = await grid.poll();
    expect(r2).toMatchObject({ kind: 'rebracket', cause: 'reissue', position: { qty: 10, avgPrice: 100 } });
    expect(grid.state).toBe('ARMED');
    expect(port.lastLeg('buy')).toBeDefined();
  });

  it('reissueBrackets — ARMED에서 두 다리를 취소하고 같은 사다리로 즉시 재발주한다(세션 전환 선제 재등록)', async () => {
    const port = new FakeGridPort({ qty: 10, avgPrice: 100 });
    const grid = new Grid({ port, clock: fakeClock(), config: baseConfig });
    await grid.arm();

    const result = await grid.reissueBrackets();

    expect(result).toMatchObject({ kind: 'rebracket', cause: 'reissue', position: { qty: 10, avgPrice: 100 } });
    expect(grid.state).toBe('ARMED');
    expect(port.canceled).toHaveLength(2); // 살아 있는 옛 두 다리를 실제로 취소.
    expect(port.placed).toHaveLength(4); // 초기 2 + 재등록 2.
    // ARMED가 아니면 아무것도 하지 않는다.
    const idlePort = new FakeGridPort({ qty: 10, avgPrice: 100 });
    const idleGrid = new Grid({ port: idlePort, clock: fakeClock(), config: baseConfig });
    expect((await idleGrid.reissueBrackets()).kind).toBe('idle');
    expect(idlePort.placed).toHaveLength(0);
  });
});
