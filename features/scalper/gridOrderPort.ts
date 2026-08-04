// gridOrderPort — core/grid의 GridOrderPort를 ScalperBroker로 구현하는 얇은 글루.
//
// ⚠ OrderPortAdapter(진입용)와 **다른 경로**다. OrderPortAdapter는 반대편 1호가를 크로스하는
//   "공격적 지정가"를 스스로 계산해 발주하지만, 그리드는 목표가 P×(1±w)를 **정확 지정가**로 그대로
//   발주해야 한다(D6). 그래서 그 어댑터를 재사용하지 않고, broker.placeOrder(price=목표가)를 직접 부른다.
//   broker(createKisBroker)는 placeOverseasOrder(ORD_DVSN=00, OVRS_ORD_UNPR=목표가)로 발주한다.
import type { GridOrderFill, GridOrderPort } from '../../core/grid';
import type { ScalperBroker } from './types';

/** ScalperBroker(+pdno) 하나를 그리드 포트로 감싼다. broker는 makeBroker(ticker)로 종목당 하나 만든다. */
export function createGridOrderPort(broker: ScalperBroker, pdno: string): GridOrderPort {
  return {
    async placeOrder(side, qty, price) {
      // 정확 지정가 — 진입용 공격적 호가 로직을 타지 않는다.
      return broker.placeOrder({ side, pdno, qty, price });
    },
    async cancelOrder(odno, qty) {
      await broker.cancelOrder({ pdno, odno, qty });
    },
    async fetchFills(): Promise<GridOrderFill[]> {
      const fills = await broker.fetchFills();
      // BrokerFill과 GridOrderFill은 같은 모양(odno·orderQty·filledQty·filledPrice) — 그대로 전달.
      return fills.map((f) => ({
        odno: f.odno,
        orderQty: f.orderQty,
        filledQty: f.filledQty,
        filledPrice: f.filledPrice,
      }));
    },
    async fetchPosition() {
      return broker.fetchPosition();
    },
  };
}
