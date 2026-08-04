// 통합(틱 재생): 틱 → Resampler → TrendDetector → RunCycle 전 체인을 공개 인터페이스로만 엮는다.
// 실제 오케스트레이터는 5단계지만, 코어 계약이 함께 동작함을 여기서 증명한다.
import { describe, expect, it } from 'vitest';
import { Resampler } from './resample';
import { TrendDetector } from './detector';
import {
  RunCycle,
  type CancelState,
  type FillResult,
  type OrderPort,
  type OrderRef,
  type TradeRecord,
} from './cycle';

function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

class AutoFillPort implements OrderPort {
  buys = 0;
  sells = 0;
  lastSellQty = 0;
  private fills = new Map<OrderRef, FillResult>();
  private seq = 0;
  constructor(private price: number) {}
  setPrice(p: number) {
    this.price = p;
  }
  buy(req: { ticker: string; qty: number }): OrderRef {
    this.buys++;
    const ref = `b${this.seq++}`;
    this.fills.set(ref, { filled: true, price: this.price, qty: req.qty });
    return ref;
  }
  sell(req: { ticker: string; qty: number }): OrderRef {
    this.sells++;
    this.lastSellQty = req.qty;
    const ref = `s${this.seq++}`;
    this.fills.set(ref, { filled: true, price: this.price, qty: req.qty });
    return ref;
  }
  cancel(): void {}
  cancelState(): CancelState {
    return 'none'; // 즉시 전량 체결이라 취소 경로를 타지 않는다.
  }
  checkFilled(ref: OrderRef): FillResult {
    return this.fills.get(ref) ?? { filled: false };
  }
}

interface ChainResult {
  port: AutoFillPort;
  trades: TradeRecord[];
  cycle: RunCycle;
}

/** 가격 배열을 초당 1틱으로 흘려 전 체인을 구동한다. run=false면 start를 호출하지 않는다. */
function runChain(prices: number[], opts: { bufferSize: number; run: boolean }): ChainResult {
  const resampler = new Resampler({ chunkSeconds: 1, bufferSize: opts.bufferSize });
  const detector = new TrendDetector();
  const port = new AutoFillPort(prices[0]);
  const clock = fakeClock();
  const trades: TradeRecord[] = [];
  const cycle = new RunCycle({ ticker: 'AAPL', qty: 2, port, clock, onTrade: (r) => trades.push(r) });
  if (opts.run) cycle.start();

  const emit = (value: number) => {
    port.setPrice(value);
    if (resampler.warmedUp) {
      const res = detector.detect(resampler.buffer);
      if (res.signal) {
        cycle.onSignal(res.signal, {
          price: value,
          slope: res.slope!,
          accel: res.accel!,
          ts: clock.now(),
        });
      }
    }
    cycle.poll();
  };

  prices.forEach((p, i) => {
    const closed = resampler.addTick({ price: p, ts: i * 1000 });
    if (closed !== null) emit(closed);
    clock.advance(1000);
  });
  const last = resampler.flush();
  if (last !== null) emit(last);

  return { port, trades, cycle };
}

const V = [20, 16, 12, 8, 4, 2, 4, 8, 12, 16, 20];
const DOWN_UP_DOWN = [20, 16, 12, 8, 4, 2, 4, 8, 12, 16, 20, 18, 14, 10, 6, 2];

describe('통합 — 틱 재생 전 체인', () => {
  it('① V자 가격에서 BUY 1회만 발생해 진입한다', () => {
    const { port, cycle } = runChain(V, { bufferSize: 7, run: true });
    expect(port.buys).toBe(1);
    expect(port.sells).toBe(0);
    expect(cycle.state).toBe('HOLDING');
    expect(cycle.position?.qty).toBe(2);
  });

  it('② 역V자(하락-상승-하락)에서 SELL 발생·전량 매도 후 DONE', () => {
    const { port, trades, cycle } = runChain(DOWN_UP_DOWN, { bufferSize: 7, run: true });
    expect(port.buys).toBe(1);
    expect(port.sells).toBe(1);
    expect(port.lastSellQty).toBe(2); // 전량
    expect(cycle.state).toBe('DONE');
    expect(trades).toHaveLength(1);
    expect(trades[0].exitReason).toBe('SELL_SIGNAL');
  });

  it('③ 워밍업 중(버퍼 미충족)에는 어떤 신호·주문도 없다', () => {
    // 버퍼 11인데 자료는 그보다 적게 → 끝까지 워밍업, 무판정
    const short = V.slice(0, 6); // 6개 < 11
    const { port, cycle } = runChain(short, { bufferSize: 11, run: true });
    expect(port.buys).toBe(0);
    expect(port.sells).toBe(0);
    expect(cycle.state).toBe('WATCH_BUY');
  });

  it('④ Run 없이(IDLE)는 명백한 변곡점에도 주문이 0회다', () => {
    const { port, cycle } = runChain(DOWN_UP_DOWN, { bufferSize: 7, run: false });
    expect(port.buys).toBe(0);
    expect(port.sells).toBe(0);
    expect(cycle.state).toBe('IDLE');
  });
});
