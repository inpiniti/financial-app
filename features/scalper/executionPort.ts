// executionPort — core/execution의 ExecutionOrderPort를 ScalperBroker로 구현하는 얇은 글루.
//
// gridOrderPort와 같은 원칙(정확 지정가 — 진입용 공격적 호가 로직을 타지 않는다)에
// **정정(amend)** 이 추가된다 — 매매(Execution)의 현재가 추격은 취소→재발주가 아니라 정정이다
// (원자 교체: 무주문 공백·이중 주문 레이스 없음, REST 1회).
import type { ExecutionOrderFill, ExecutionOrderPort } from '../../core/execution';
import type { ScalperBroker } from './types';

/** ScalperBroker(+pdno) 하나를 매매 포트로 감싼다. broker는 makeBroker(ticker)로 종목당 하나 만든다. */
export function createExecutionPort(broker: ScalperBroker, pdno: string): ExecutionOrderPort {
  return {
    async placeOrder(side, qty, price) {
      return broker.placeOrder({ side, pdno, qty, price });
    },
    async amendOrder(odno, side, qty, price) {
      return broker.amendOrder({ pdno, odno, qty, price, side });
    },
    async cancelOrder(odno, qty) {
      await broker.cancelOrder({ pdno, odno, qty });
    },
    async fetchFills(): Promise<ExecutionOrderFill[]> {
      const fills = await broker.fetchFills();
      // BrokerFill과 ExecutionOrderFill은 같은 모양(odno·orderQty·filledQty·filledPrice) — 그대로 전달.
      return fills.map((f) => ({
        odno: f.odno,
        orderQty: f.orderQty,
        filledQty: f.filledQty,
        filledPrice: f.filledPrice,
      }));
    },
  };
}
