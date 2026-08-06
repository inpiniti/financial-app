// SimExchange — 시뮬레이션 모드의 가상 체결소 (시뮬레이션 plan 2026-08-06 §A-2).
//
// 실시세(WS 틱)는 그대로 받되 주문만 가상으로 체결한다. 티커별로 ScalperBroker를 찍어내므로
// 오토파일럿·그리드·어댑터는 자기가 시뮬인지 모른다(브로커 교체만으로 전 경로 동일).
//
// 체결 규칙(사용자 확정 §2-1) — **전 주문 단일 규칙, 즉시 체결 없음**:
//   매수 @P → 발주 이후 현재가가 P보다 **낮은** 틱이 관찰돼야 체결(체결가 = P).
//   매도 @P → 발주 이후 현재가가 P보다 **높은** 틱이 관찰돼야 체결(체결가 = P).
//   지정가에 정확히 닿기만 한 것(= P와 같은 틱)은 체결로 보지 않는다 — 한 틱 뚫어야 인정.
//   진입(공격적 지정가)도 예외 없다: 매수 10을 걸면 9.9999가 찍혀야 체결된 것으로 본다.
//   → 실전 대비 보수적: 시뮬에서 좋게 나온 전략은 실전에서 더 나쁠 이유가 줄어든다.
//
// 부분체결은 시뮬하지 않는다(전량만) — 실물 브로커(createKisBroker)도 "미체결 목록 부재 → 전량"
// 추론이 주 경로라 정합적이다.
//
// ⚠ 영속화 없음: 앱을 재시작하면 가상 포지션·미체결 주문이 전부 사라진다(plan §5-1, 하루 실험 전제).

import type {
  BrokerAmendInput,
  BrokerCancelInput,
  BrokerFill,
  BrokerPlaceInput,
  ScalperBroker,
} from './types';

interface SimOrder {
  odno: string;
  ticker: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  filledQty: number;
  filledPrice: number | null;
}

interface SimPosition {
  qty: number;
  avgPrice: number;
}

export class SimExchange {
  /** 티커별 최근 체결가 — marketable 판정이 아니라 진단용(체결은 오직 onTick의 트레이드스루). */
  private readonly lastPrice = new Map<string, number>();
  /** 살아 있는(미취소) 주문 전부 — 체결돼도 fetchFills 스냅샷에 남는다(FakeBroker 계약과 동일). */
  private readonly orders = new Map<string, SimOrder>();
  private readonly posByTicker = new Map<string, SimPosition>();
  private seq = 0;

  /** WS 체결 틱 1개 주입 — 이 티커의 미체결 주문을 트레이드스루 규칙으로 판정한다. */
  onTick(symb: string, price: number): void {
    if (!Number.isFinite(price) || price <= 0) return;
    this.lastPrice.set(symb, price);
    for (const order of this.orders.values()) {
      if (order.ticker !== symb || order.filledQty >= order.qty) continue;
      const crossed = order.side === 'buy' ? price < order.price : price > order.price;
      if (!crossed) continue;
      order.filledQty = order.qty;
      order.filledPrice = order.price; // 체결가 = 지정가(보수적 — 더 유리한 체결을 가정하지 않는다)
      this.applyFill(order);
    }
  }

  /** 가상 잔고 스냅샷 — fetchHoldings 대용(수량 0은 이미 제거돼 있다). */
  positions(): ReadonlyMap<string, SimPosition> {
    return this.posByTicker;
  }

  /** 전체 초기화 — 모드 전환(실거래↔시뮬) 시 이전 실험의 잔재를 지운다. */
  reset(): void {
    this.orders.clear();
    this.posByTicker.clear();
    this.lastPrice.clear();
  }

  /** 티커 하나의 가상 브로커 — createKisBroker와 같은 자리(makeBroker)에 꽂는다. */
  makeBroker(ticker: string): ScalperBroker {
    return {
      placeOrder: async (input: BrokerPlaceInput) => {
        if (!Number.isFinite(input.price) || input.price <= 0) {
          throw new Error(`시뮬 발주 거절 — 잘못된 가격(${input.price})`);
        }
        if (!Number.isFinite(input.qty) || input.qty < 1) {
          throw new Error(`시뮬 발주 거절 — 잘못된 수량(${input.qty})`);
        }
        const odno = `SIM${++this.seq}`;
        this.orders.set(odno, {
          odno,
          ticker,
          side: input.side,
          qty: input.qty,
          price: input.price,
          filledQty: 0,
          filledPrice: null,
        });
        return { odno };
      },

      cancelOrder: async (input: BrokerCancelInput) => {
        const order = this.orders.get(input.odno);
        // KIS 거절 재현 — 이미 체결된(또는 모르는) 주문의 취소는 throw한다.
        // OCO 레이스("취소하려는데 이미 체결")가 시뮬에서도 정직하게 FAULT 경로로 흐르게 하는 장치.
        if (!order) throw new Error(`시뮬 취소 거절 — 없는 주문(${input.odno})`);
        if (order.filledQty >= order.qty) throw new Error('시뮬 취소 거절 — 이미 체결된 주문이에요');
        this.orders.delete(input.odno);
      },

      amendOrder: async (input: BrokerAmendInput) => {
        const prev = this.orders.get(input.odno);
        if (!prev) throw new Error(`시뮬 정정 거절 — 없는 주문(${input.odno})`);
        if (prev.filledQty >= prev.qty) throw new Error('시뮬 정정 거절 — 이미 체결된 주문이에요');
        // 실물처럼 새 odno 채번, 옛 주문은 목록에서 사라진다(잔량만 새 주문 — 부분체결 없으므로 전량).
        this.orders.delete(input.odno);
        const odno = `SIM${++this.seq}`;
        this.orders.set(odno, {
          odno,
          ticker,
          side: input.side,
          qty: input.qty,
          price: input.price,
          filledQty: 0,
          filledPrice: null,
        });
        return { odno };
      },

      fetchFills: async (): Promise<BrokerFill[]> => {
        const out: BrokerFill[] = [];
        for (const o of this.orders.values()) {
          if (o.ticker !== ticker) continue;
          out.push({ odno: o.odno, orderQty: o.qty, filledQty: o.filledQty, filledPrice: o.filledPrice });
        }
        return out;
      },

      fetchPosition: async () => {
        const pos = this.posByTicker.get(ticker);
        return pos ? { ...pos } : null;
      },
    };
  }

  /** 체결 1건을 가상 잔고에 반영 — 매수는 수량 가중평균, 매도는 차감(0이면 포지션 제거). */
  private applyFill(order: SimOrder): void {
    const pos = this.posByTicker.get(order.ticker);
    if (order.side === 'buy') {
      if (!pos) {
        this.posByTicker.set(order.ticker, { qty: order.qty, avgPrice: order.price });
      } else {
        const nextQty = pos.qty + order.qty;
        pos.avgPrice = (pos.qty * pos.avgPrice + order.qty * order.price) / nextQty;
        pos.qty = nextQty;
      }
      return;
    }
    if (!pos) return; // 없는 포지션 매도 — 시뮬에선 조용히 무시(그리드가 이런 주문을 내지 않는다).
    pos.qty -= order.qty;
    if (pos.qty <= 0) this.posByTicker.delete(order.ticker);
  }
}
