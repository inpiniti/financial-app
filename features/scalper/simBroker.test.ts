import { describe, expect, it } from 'vitest';

import { SimExchange } from './simBroker';

// 체결 규칙(사용자 확정): 매수 @P → tick < P 관찰 시 체결(체결가 P), 매도 @P → tick > P.
// 지정가와 같은 틱은 미체결 — "한 틱 뚫어야 인정". 즉시 체결 특례 없음(진입도 동일).
describe('SimExchange — 트레이드스루 체결 규칙', () => {
  it('매수 @10 — 10.1·10.0 틱에는 미체결, 9.9999 틱에서 체결(체결가 10)', async () => {
    const ex = new SimExchange();
    const broker = ex.makeBroker('A');
    ex.onTick('A', 10.05);
    const { odno } = await broker.placeOrder({ side: 'buy', pdno: 'A', qty: 3, price: 10 });

    ex.onTick('A', 10.1);
    ex.onTick('A', 10.0); // 정확히 닿음 — 미체결.
    expect((await broker.fetchFills())[0]).toMatchObject({ odno, filledQty: 0, filledPrice: null });

    ex.onTick('A', 9.9999);
    expect((await broker.fetchFills())[0]).toMatchObject({ odno, filledQty: 3, filledPrice: 10 });
    expect(await broker.fetchPosition()).toEqual({ qty: 3, avgPrice: 10 });
  });

  it('매도 @11 — 11.0 틱에는 미체결, 11.01 틱에서 체결(체결가 11)', async () => {
    const ex = new SimExchange();
    const broker = ex.makeBroker('A');
    // 포지션을 먼저 만든다(매수 5주 @10 체결).
    await broker.placeOrder({ side: 'buy', pdno: 'A', qty: 5, price: 10 });
    ex.onTick('A', 9.9);

    const { odno } = await broker.placeOrder({ side: 'sell', pdno: 'A', qty: 5, price: 11 });
    ex.onTick('A', 11.0);
    expect((await broker.fetchFills()).find((f) => f.odno === odno)).toMatchObject({ filledQty: 0 });

    ex.onTick('A', 11.01);
    expect((await broker.fetchFills()).find((f) => f.odno === odno)).toMatchObject({ filledQty: 5, filledPrice: 11 });
    expect(await broker.fetchPosition()).toBeNull(); // 전량 매도 — 포지션 소멸.
    expect(ex.positions().has('A')).toBe(false);
  });

  it('티커가 다르면 서로의 주문·포지션에 영향이 없다', async () => {
    const ex = new SimExchange();
    const a = ex.makeBroker('A');
    const b = ex.makeBroker('B');
    await a.placeOrder({ side: 'buy', pdno: 'A', qty: 1, price: 10 });
    await b.placeOrder({ side: 'buy', pdno: 'B', qty: 1, price: 20 });

    ex.onTick('A', 9); // A만 체결.
    expect((await a.fetchFills())[0].filledQty).toBe(1);
    expect((await b.fetchFills())[0].filledQty).toBe(0);
    expect(await a.fetchPosition()).toEqual({ qty: 1, avgPrice: 10 });
    expect(await b.fetchPosition()).toBeNull();
  });

  it('물타기 매수 — 가중평균 평단으로 합산된다', async () => {
    const ex = new SimExchange();
    const broker = ex.makeBroker('A');
    await broker.placeOrder({ side: 'buy', pdno: 'A', qty: 5, price: 100 });
    ex.onTick('A', 99);
    await broker.placeOrder({ side: 'buy', pdno: 'A', qty: 5, price: 90 });
    ex.onTick('A', 89.5);
    expect(await broker.fetchPosition()).toEqual({ qty: 10, avgPrice: 95 });
  });

  it('취소 — 미체결은 성공(목록에서 사라짐), 기체결은 throw(KIS 거절 재현)', async () => {
    const ex = new SimExchange();
    const broker = ex.makeBroker('A');
    const open = await broker.placeOrder({ side: 'buy', pdno: 'A', qty: 1, price: 10 });
    await broker.cancelOrder({ pdno: 'A', odno: open.odno, qty: 1 });
    expect(await broker.fetchFills()).toHaveLength(0);

    const filled = await broker.placeOrder({ side: 'buy', pdno: 'A', qty: 1, price: 10 });
    ex.onTick('A', 9);
    await expect(broker.cancelOrder({ pdno: 'A', odno: filled.odno, qty: 1 })).rejects.toThrow('이미 체결');
  });

  it('정정 — 새 odno 채번, 옛 주문은 목록에서 사라지고 새 가격으로 판정된다', async () => {
    const ex = new SimExchange();
    const broker = ex.makeBroker('A');
    const first = await broker.placeOrder({ side: 'sell', pdno: 'A', qty: 2, price: 12 });
    const next = await broker.amendOrder({ pdno: 'A', odno: first.odno, qty: 2, price: 11, side: 'sell' });
    expect(next.odno).not.toBe(first.odno);

    const fills = await broker.fetchFills();
    expect(fills).toHaveLength(1);
    expect(fills[0].odno).toBe(next.odno);

    ex.onTick('A', 11.5); // 옛 가격(12)은 못 넘지만 새 가격(11)은 넘는다.
    expect((await broker.fetchFills())[0]).toMatchObject({ filledQty: 2, filledPrice: 11 });
  });

  it('reset — 주문·포지션·시세 캐시가 전부 사라진다(모드 전환 위생)', async () => {
    const ex = new SimExchange();
    const broker = ex.makeBroker('A');
    await broker.placeOrder({ side: 'buy', pdno: 'A', qty: 1, price: 10 });
    ex.onTick('A', 9);
    expect(ex.positions().size).toBe(1);

    ex.reset();
    expect(ex.positions().size).toBe(0);
    expect(await broker.fetchFills()).toHaveLength(0);
  });

  it('잘못된 발주(가격·수량 0 이하)는 throw — 유령 주문을 만들지 않는다', async () => {
    const ex = new SimExchange();
    const broker = ex.makeBroker('A');
    await expect(broker.placeOrder({ side: 'buy', pdno: 'A', qty: 1, price: 0 })).rejects.toThrow('가격');
    await expect(broker.placeOrder({ side: 'buy', pdno: 'A', qty: 0, price: 10 })).rejects.toThrow('수량');
    expect(await broker.fetchFills()).toHaveLength(0);
  });
});
