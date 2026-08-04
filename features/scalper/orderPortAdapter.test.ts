import { describe, expect, it } from 'vitest';
import { AMEND_BACKOFF_MAX_MS, AMEND_FAIL_LIMIT, OrderPortAdapter } from './orderPortAdapter';
import { FakeBroker, fakeClock, flush } from './fakes';

describe('OrderPortAdapter — 동기 OrderPort ↔ async KIS 브리징', () => {
  it('buy는 OrderRef를 동기로 반환하고, 발주는 async로 나간다', async () => {
    const broker = new FakeBroker();
    const adapter = new OrderPortAdapter({ broker });
    adapter.setLimitPrice(203.5);

    const ref = adapter.buy({ ticker: 'AAPL', qty: 2 });
    expect(typeof ref).toBe('string');
    // 발주 직후에는 미체결이 동기로 반환된다.
    expect(adapter.checkFilled(ref)).toEqual({ filled: false });

    await flush();
    expect(broker.placed).toHaveLength(1);
    expect(broker.placed[0]).toMatchObject({ side: 'buy', pdno: 'AAPL', qty: 2, price: 203.5 });
  });

  it('checkFilled는 폴러(refreshFills)가 체결을 관찰한 뒤에만 filled를 동기 반환한다', async () => {
    const broker = new FakeBroker();
    const adapter = new OrderPortAdapter({ broker });
    adapter.setLimitPrice(100);

    const ref = adapter.buy({ ticker: 'AAPL', qty: 2 });
    await flush();

    // 아직 체결 안 됨 → refreshFills 해도 미체결.
    await adapter.refreshFills();
    expect(adapter.checkFilled(ref).filled).toBe(false);

    // 브로커가 체결 처리 → refreshFills 후 filled.
    broker.fill(broker.placed[0].odno, 101);
    await adapter.refreshFills();
    const fill = adapter.checkFilled(ref);
    expect(fill.filled).toBe(true);
    expect(fill.price).toBe(101);
    expect(fill.qty).toBe(2);
  });

  it('cancel은 발주 완료(odno 확정) 후 KIS 취소를 호출한다', async () => {
    const broker = new FakeBroker();
    const adapter = new OrderPortAdapter({ broker });
    adapter.setLimitPrice(100);

    const ref = adapter.buy({ ticker: 'AAPL', qty: 1 });
    await flush(); // odno 확정
    adapter.cancel(ref);
    await flush();

    expect(broker.canceled).toEqual([broker.placed[0].odno]);
  });

  it('발주 완료 전 cancel 요청도 odno 도착 시 취소로 이어진다', async () => {
    const broker = new FakeBroker();
    const adapter = new OrderPortAdapter({ broker });
    adapter.setLimitPrice(100);

    const ref = adapter.buy({ ticker: 'AAPL', qty: 1 });
    adapter.cancel(ref); // 아직 odno 없음
    await flush(); // 발주 완료 → 취소 발화

    expect(broker.canceled).toHaveLength(1);
    expect(broker.canceled[0]).toBe(broker.placed[0].odno);
  });

  it('취소 성공 시 cancelState가 confirmed가 된다(진짜 미체결 확정)', async () => {
    const broker = new FakeBroker();
    const adapter = new OrderPortAdapter({ broker });
    adapter.setLimitPrice(100);

    const ref = adapter.buy({ ticker: 'AAPL', qty: 1 });
    await flush();
    expect(adapter.cancelState(ref)).toBe('none');

    adapter.cancel(ref);
    expect(adapter.cancelState(ref)).toBe('pending'); // 요청 즉시엔 미확정
    await flush();
    expect(adapter.cancelState(ref)).toBe('confirmed');
  });

  it('취소 요청 이후 늦은 체결도 refreshFills가 관찰해 filled로 반영한다(레이스 방지)', async () => {
    const broker = new FakeBroker();
    const adapter = new OrderPortAdapter({ broker });
    adapter.setLimitPrice(100);

    const ref = adapter.sell({ ticker: 'AAPL', qty: 2 });
    await flush();
    const odno = broker.placed[0].odno;

    // core가 타임아웃으로 취소를 요청했지만, 취소가 거절될 만큼 이미 체결이 진행됐다.
    broker.failCancel = true; // 취소 거절(이미 체결 추정)
    adapter.cancel(ref);
    broker.fill(odno, 101); // 늦은 체결이 브로커에 반영됨
    await flush();

    // 취소 요청 주문이라도 관찰을 끊지 않으므로 늦은 체결이 잡힌다.
    await adapter.refreshFills();
    const fill = adapter.checkFilled(ref);
    expect(fill.filled).toBe(true);
    expect(fill.price).toBe(101);
    expect(adapter.hasFault()).toBe(false); // 체결로 확인됐으므로 FAULT 아님
  });

  it('④ 호가가 신선하면 매수 발주가는 매도1호가(ask1), 매도 발주가는 매수1호가(bid1)이다', async () => {
    const clock = fakeClock(10_000);
    const broker = new FakeBroker();
    const adapter = new OrderPortAdapter({ broker, clock });
    adapter.setLimitPrice(100); // 마지막 체결가(폴백용) — 호가가 신선하면 쓰이지 않아야 한다.
    adapter.setQuote(99.9, 100.1, clock.now()); // bid1=99.9, ask1=100.1

    adapter.buy({ ticker: 'AAPL', qty: 1 });
    adapter.sell({ ticker: 'AAPL', qty: 1 });
    await flush();

    const buy = broker.placed.find((p) => p.side === 'buy')!;
    const sell = broker.placed.find((p) => p.side === 'sell')!;
    expect(buy.price).toBe(100.1); // 매도1호가로 크로스 → 즉시 체결
    expect(sell.price).toBe(99.9); // 매수1호가로 크로스
  });

  it('⑤ 호가가 없거나 오래되면(10초 초과) 마지막 체결가로 폴백한다', async () => {
    const clock = fakeClock(0);
    const broker = new FakeBroker();
    const adapter = new OrderPortAdapter({ broker, clock });
    adapter.setLimitPrice(100);

    // (a) 호가 자체가 없음 → 폴백.
    adapter.buy({ ticker: 'AAPL', qty: 1 });
    await flush();
    expect(broker.placed.at(-1)!.price).toBe(100);

    // (b) 호가는 있지만 11초 지나 오래됨 → 폴백.
    adapter.setQuote(99.9, 100.1, clock.now());
    clock.advance(11_000);
    adapter.buy({ ticker: 'AAPL', qty: 1 });
    await flush();
    expect(broker.placed.at(-1)!.price).toBe(100);
  });

  it('⑥ previewOrderPrice는 주문을 내지 않고 resolveOrderPrice와 같은 규칙으로 표시용 가격·폴백 여부를 돌려준다', async () => {
    const clock = fakeClock(10_000);
    const broker = new FakeBroker();
    const adapter = new OrderPortAdapter({ broker, clock });
    adapter.setLimitPrice(100);
    adapter.setQuote(99.9, 100.1, clock.now());

    expect(adapter.previewOrderPrice('buy')).toEqual({ price: 100.1, fallback: false });
    expect(adapter.previewOrderPrice('sell')).toEqual({ price: 99.9, fallback: false });
    // 미리보기 호출 자체는 발주를 유발하지 않는다.
    expect(broker.placed).toHaveLength(0);
  });

  it('⑦ previewOrderPrice는 호가가 오래되면(10초 초과) 폴백을 표시한다', async () => {
    const clock = fakeClock(0);
    const broker = new FakeBroker();
    const adapter = new OrderPortAdapter({ broker, clock });
    adapter.setLimitPrice(100);
    adapter.setQuote(99.9, 100.1, clock.now());
    clock.advance(11_000);

    expect(adapter.previewOrderPrice('buy')).toEqual({ price: 100, fallback: true });
    expect(adapter.previewOrderPrice('sell')).toEqual({ price: 100, fallback: true });
  });

  it('취소가 거절됐고 체결도 확인 불가면 refreshFills가 FAULT로 승격한다', async () => {
    const broker = new FakeBroker();
    const adapter = new OrderPortAdapter({ broker });
    adapter.setLimitPrice(100);

    const ref = adapter.sell({ ticker: 'AAPL', qty: 2 });
    await flush();

    broker.failCancel = true; // 취소 거절
    adapter.cancel(ref);
    await flush(); // cancelState='rejected'

    // 체결은 끝내 관찰되지 않음(미체결로 남음) → 확인 불가 → FAULT.
    await adapter.refreshFills();
    expect(adapter.hasFault()).toBe(true);
    expect(adapter.takeFault()?.kind).toBe('CANCEL');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 매도 리프라이스(2026-08-04) — 매수1호가가 바뀔 때만 정정해 체결까지 따라간다.
// 무한 대기·매도 취소 금지·FAULT 인터록 정책은 그대로다.
// ─────────────────────────────────────────────────────────────────────────────
describe('OrderPortAdapter — 매도 리프라이스', () => {
  /** 매도 주문 1건을 발주 완료(odno 확정) 상태로 만들어 돌려준다. */
  async function sellPlaced(bid1: number, qty = 10) {
    const broker = new FakeBroker();
    const clock = fakeClock(1000);
    const adapter = new OrderPortAdapter({ broker, clock });
    adapter.setLimitPrice(bid1);
    adapter.setQuote(bid1, bid1 + 0.02, clock.now());
    const ref = adapter.sell({ ticker: 'AAPL', qty });
    await flush();
    return { broker, clock, adapter, ref };
  }

  it('① 매수1호가가 접수가와 같으면 정정하지 않는다 (유량 절감)', async () => {
    const { broker, adapter } = await sellPlaced(12.34);
    await adapter.repriceSell();
    await adapter.repriceSell();
    expect(broker.amended).toHaveLength(0);
  });

  it('② 매수1호가가 바뀌면 그 가격·잔량으로 정정하고 odno를 갈아끼운다', async () => {
    const { broker, clock, adapter } = await sellPlaced(12.34);
    const firstOdno = broker.placed[0].odno;

    adapter.setQuote(12.3, 12.36, clock.now());
    await adapter.repriceSell();

    expect(broker.amended).toHaveLength(1);
    expect(broker.amended[0]).toMatchObject({ from: firstOdno, qty: 10, price: 12.3 });
    // 새 odno로 교체됐으므로, 다음 정정은 새 번호를 원주문으로 쓴다.
    adapter.setQuote(12.25, 12.31, clock.now());
    await adapter.repriceSell();
    expect(broker.amended[1].from).toBe(broker.amended[0].to);
  });

  it('③ 매수1호가가 올라가도 따라간다 (하향 전용이 아니다)', async () => {
    const { broker, clock, adapter } = await sellPlaced(12.34);
    adapter.setQuote(12.5, 12.56, clock.now());
    await adapter.repriceSell();
    expect(broker.amended[0].price).toBe(12.5);
  });

  it('④ 호가가 오래되면(폴백 발주 중) 정정하지 않는다', async () => {
    const { broker, clock, adapter } = await sellPlaced(12.34);
    clock.advance(11_000); // quoteStaleMs(10초) 초과
    await adapter.repriceSell();
    expect(broker.amended).toHaveLength(0);
  });

  it('⑤ 매수 주문에는 리프라이스가 적용되지 않는다', async () => {
    const broker = new FakeBroker();
    const clock = fakeClock(1000);
    const adapter = new OrderPortAdapter({ broker, clock });
    adapter.setLimitPrice(100);
    adapter.setQuote(99.9, 100.1, clock.now());
    adapter.buy({ ticker: 'AAPL', qty: 2 });
    await flush();

    adapter.setQuote(99.5, 99.7, clock.now());
    await adapter.repriceSell();
    expect(broker.amended).toHaveLength(0);
  });

  it('⑥ 취소가 얽힌 주문은 정정하지 않는다', async () => {
    const { broker, clock, adapter, ref } = await sellPlaced(12.34);
    adapter.cancel(ref);
    await flush();
    adapter.setQuote(12.3, 12.36, clock.now());
    await adapter.repriceSell();
    expect(broker.amended).toHaveLength(0);
  });

  it('⑦ [사고 재현] 정정으로 옛 odno가 미체결 목록에서 사라져도 전량체결로 오판하지 않는다', async () => {
    const { broker, clock, adapter, ref } = await sellPlaced(12.34);
    adapter.setQuote(12.3, 12.36, clock.now());
    await adapter.repriceSell();

    // 정정 직후 폴이 돌아도 체결로 단정하면 안 된다(주문은 새 odno로 살아있다).
    await adapter.refreshFills();
    expect(adapter.checkFilled(ref).filled).toBe(false);

    // 새 odno가 진짜 체결되면 그때 filled가 된다.
    broker.fill(broker.amended[0].to, 12.3);
    await adapter.refreshFills();
    expect(adapter.checkFilled(ref).filled).toBe(true);
  });

  it('⑧ [사고 재현] 부분체결이 미체결로 취급돼 갇히지 않는다 — 잔량만 정정해 결국 전량 체결된다', async () => {
    const { broker, clock, adapter, ref } = await sellPlaced(12.34, 10);
    const first = broker.placed[0].odno;

    // 4주만 체결된 상태 — 예전엔 filledQty >= qty가 아니라 통째로 버려졌다.
    broker.fillPartial(first, 4, 12.34);
    await adapter.refreshFills();
    expect(adapter.checkFilled(ref).filled).toBe(false);

    // 호가가 내려가면 남은 6주로 정정한다.
    adapter.setQuote(12.3, 12.36, clock.now());
    await adapter.repriceSell();
    expect(broker.amended[0].qty).toBe(6);

    // 잔량 6주가 체결되면 누적 10주로 전량 체결 확정(오프셋이 없으면 여기서 4가 리셋돼 영영 못 채운다).
    broker.fill(broker.amended[0].to, 12.3);
    await adapter.refreshFills();
    const fill = adapter.checkFilled(ref);
    expect(fill.filled).toBe(true);
    expect(fill.qty).toBe(10);
  });

  it('⑨ 정정 거절은 FAULT로 올리지 않고 다음 기회에 재시도한다', async () => {
    const { broker, clock, adapter } = await sellPlaced(12.34);
    broker.failAmend = true;
    adapter.setQuote(12.3, 12.36, clock.now());
    await adapter.repriceSell();

    expect(adapter.hasFault()).toBe(false); // FAULT 인터록 무오염
    expect(broker.amended).toHaveLength(0);

    // 백오프가 지나고 정정이 회복되면 다시 시도한다.
    broker.failAmend = false;
    clock.advance(5000);
    adapter.setQuote(12.3, 12.36, clock.now());
    await adapter.repriceSell();
    expect(broker.amended).toHaveLength(1);
  });

  it('⑩ 연속 정정 실패가 상한을 넘으면 리프라이스만 중단하고 주문은 그대로 둔다', async () => {
    const { broker, clock, adapter, ref } = await sellPlaced(12.34);
    broker.failAmend = true;
    for (let i = 0; i < AMEND_FAIL_LIMIT; i++) {
      clock.advance(AMEND_BACKOFF_MAX_MS + 1000);
      adapter.setQuote(12.3, 12.36, clock.now());
      await adapter.repriceSell();
    }
    expect(adapter.hasFault()).toBe(false);

    // 이후에는 정정이 회복돼도 더 시도하지 않는다 — 주문은 살아 무한 대기로 복귀.
    broker.failAmend = false;
    clock.advance(AMEND_BACKOFF_MAX_MS + 1000);
    adapter.setQuote(12.2, 12.26, clock.now());
    await adapter.repriceSell();
    expect(broker.amended).toHaveLength(0);
    expect(adapter.checkFilled(ref).filled).toBe(false);
  });

  it('⑪ 전량 체결된 뒤에는 정정하지 않는다', async () => {
    const { broker, clock, adapter } = await sellPlaced(12.34);
    broker.fill(broker.placed[0].odno, 12.34);
    await adapter.refreshFills();

    adapter.setQuote(12.3, 12.36, clock.now());
    await adapter.repriceSell();
    expect(broker.amended).toHaveLength(0);
  });

  it('⑫ 매도 발주가는 내림 절사라 매수1호가 위로 올라가지 않는다', async () => {
    const broker = new FakeBroker();
    const clock = fakeClock(1000);
    const adapter = new OrderPortAdapter({ broker, clock });
    const bid1 = 12.345;
    adapter.setLimitPrice(bid1);
    adapter.setQuote(bid1, 12.36, clock.now());
    adapter.sell({ ticker: 'AAPL', qty: 2 });
    await flush();
    expect(broker.placed[0].price).toBeLessThanOrEqual(bid1);
    expect(broker.placed[0].price).toBe(12.34);
  });
});
