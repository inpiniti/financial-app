import { describe, expect, it } from 'vitest';
import { Grid } from '../../core/grid';
import { createGridOrderPort } from './gridOrderPort';
import { FakeBroker } from './fakes';

describe('gridOrderPort — ScalperBroker 글루(정확 지정가)', () => {
  it('목표가를 정확 지정가로 그대로 발주하고 pdno를 전달한다(공격적 호가 로직 없음)', async () => {
    const broker = new FakeBroker();
    const port = createGridOrderPort(broker, 'AAPL');

    await port.placeOrder('sell', 10, 110);
    await port.placeOrder('buy', 10, 90);

    expect(broker.placed).toEqual([
      { side: 'sell', pdno: 'AAPL', qty: 10, price: 110, odno: expect.any(String) },
      { side: 'buy', pdno: 'AAPL', qty: 10, price: 90, odno: expect.any(String) },
    ]);
  });

  it('fetchPosition은 브로커 잔고를 그대로 전달한다', async () => {
    const broker = new FakeBroker();
    broker.position = { qty: 7, avgPrice: 42 };
    const port = createGridOrderPort(broker, 'AAPL');

    await expect(port.fetchPosition()).resolves.toEqual({ qty: 7, avgPrice: 42 });
  });

  it('Grid와 결합해 실제 브로커 발주까지 동작한다(정확 지정가 브래킷)', async () => {
    const broker = new FakeBroker();
    broker.position = { qty: 10, avgPrice: 100 };
    const grid = new Grid({
      port: createGridOrderPort(broker, 'AAPL'),
      clock: { now: () => 0 },
      config: { width: 0.1, buyMultiplier: 1 },
    });

    await grid.arm();

    expect(broker.placed.find((p) => p.side === 'buy')).toMatchObject({ pdno: 'AAPL', qty: 10, price: 90 });
    expect(broker.placed.find((p) => p.side === 'sell')).toMatchObject({ pdno: 'AAPL', qty: 10, price: 110 });
  });
});
