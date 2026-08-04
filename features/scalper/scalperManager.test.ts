import { describe, expect, it, vi } from 'vitest';
import {
  INSTANCES_STORAGE_KEY,
  MAX_INSTANCES,
  ScalperManager,
  type ScalperManagerDeps,
} from './scalperManager';
import { readTodayTrades } from './tradeStore';
import { FakeBroker, FakeFeed, FakeStore, fakeClock, flush, noopScheduler } from './fakes';
import type { ScalperInstance } from './scalperInstance';

const V = [20, 16, 12, 8, 4, 2, 4, 8, 12, 16, 20];
const DOWN_UP_DOWN = [20, 16, 12, 8, 4, 2, 4, 8, 12, 16, 20, 18, 14, 10, 6, 2];

interface Harness {
  manager: ScalperManager;
  feed: FakeFeed;
  store: FakeStore;
  clock: ReturnType<typeof fakeClock>;
  brokers: Map<string, FakeBroker>;
  keepAwake: { activate: ReturnType<typeof vi.fn>; deactivate: ReturnType<typeof vi.fn> };
}

function makeManager(opts: { autoFill?: boolean } = {}): Harness {
  const feed = new FakeFeed();
  const store = new FakeStore();
  const clock = fakeClock(1000);
  const brokers = new Map<string, FakeBroker>();
  const keepAwake = { activate: vi.fn(), deactivate: vi.fn() };
  const deps: ScalperManagerDeps = {
    realtime: feed,
    storage: store,
    clock,
    scheduler: noopScheduler(),
    keepAwake,
    chunkSeconds: 1,
    bufferSize: 7,
    fillTimeoutMs: 5000,
    throttleMs: 0,
    makeBroker: (config) => {
      const b = new FakeBroker({ autoFill: opts.autoFill });
      brokers.set(config.ticker, b);
      return b;
    },
  };
  return { manager: new ScalperManager(deps), feed, store, clock, brokers, keepAwake };
}

/** 특정 티커로 틱을 흘리며 해당 인스턴스의 체결 폴링을 함께 돌린다. */
async function feedTicker(
  feed: FakeFeed,
  inst: ScalperInstance,
  symb: string,
  prices: number[],
): Promise<void> {
  for (let i = 0; i < prices.length; i++) {
    feed.emit(symb, prices[i], i * 1000);
    await flush();
    await inst.pollCycle();
    await flush();
  }
  feed.emit(symb, prices[prices.length - 1], prices.length * 1000);
  await flush();
  await inst.pollCycle();
  await flush();
}

describe('ScalperManager — 멀티 인스턴스', () => {
  it('② WS 틱이 티커별로 올바른 인스턴스에 라우팅된다', async () => {
    const { manager, feed } = makeManager();
    const a = manager.add({ ticker: 'AAPL', qty: 1 });
    const b = manager.add({ ticker: 'MSFT', qty: 1 });

    feed.emit('AAPL', 150, 1000);
    expect(a.getView().price).toBe(150);
    expect(b.getView().price).toBeNull();

    feed.emit('MSFT', 300, 1000);
    expect(b.getView().price).toBe(300);
    expect(a.getView().price).toBe(150); // A는 영향 없음
  });

  it('① 2개 인스턴스가 독립 사이클을 돈다 (A 진입 중 B 무관)', async () => {
    const { manager, feed, brokers } = makeManager({ autoFill: true });
    const a = manager.add({ ticker: 'AAPL', qty: 2 });
    const b = manager.add({ ticker: 'MSFT', qty: 1 });
    manager.startAll();
    expect(feed.connected).toBe(true);

    // AAPL만 V자 → A 진입. MSFT는 틱이 없어 감시 상태 유지.
    await feedTicker(feed, a, 'AAPL', V);

    expect(a.state).toBe('HOLDING');
    expect(b.state).toBe('WATCH_BUY');
    expect(brokers.get('AAPL')!.placed.filter((p) => p.side === 'buy')).toHaveLength(1);
    expect(brokers.get('MSFT')!.placed).toHaveLength(0);
  });

  it('④ 상한(MAX_INSTANCES) 초과 add는 명확한 에러로 거부한다', () => {
    const { manager } = makeManager();
    for (let i = 0; i < MAX_INSTANCES; i += 1) {
      manager.add({ ticker: `TK${i}`, qty: 1 });
    }
    expect(manager.size).toBe(MAX_INSTANCES);
    expect(() => manager.add({ ticker: 'NVDA', qty: 1 })).toThrow(new RegExp(`최대 ${MAX_INSTANCES}개`));
    expect(manager.size).toBe(MAX_INSTANCES);
  });

  it('⑦ 재시작 복원 — 저장된 구성 로드, 상태는 IDLE부터', async () => {
    const { manager, store } = makeManager();
    manager.add({ ticker: 'AAPL', qty: 2, id: 'x' });
    manager.add({ ticker: 'MSFT', qty: 1, id: 'y' });
    // 영속화 확인
    expect(store.map.get(INSTANCES_STORAGE_KEY)).toBeTruthy();

    // 새 매니저(앱 재시작)로 복원.
    const feed2 = new FakeFeed();
    const restored = new ScalperManager({
      realtime: feed2,
      storage: store,
      clock: fakeClock(1000),
      scheduler: noopScheduler(),
      makeBroker: () => new FakeBroker(),
    });
    await restored.restore();

    expect(restored.size).toBe(2);
    expect(restored.get('x')?.ticker).toBe('AAPL');
    expect(restored.get('x')?.state).toBe('IDLE');
    expect(restored.get('y')?.state).toBe('IDLE');
    expect(feed2.subscribed.has('DNASAAPL')).toBe(true);
    expect(feed2.subscribed.has('DNASMSFT')).toBe(true);
  });

  it('③ 매니저 경유 거래 기록이 instanceId를 포함해 저장된다', async () => {
    const { manager, feed, store, clock } = makeManager({ autoFill: true });
    // 이 테스트는 "기록 저장"을 검증한다 — 오토런 자동 재시작이 끼어들지 않게 끈다.
    const a = manager.add({ ticker: 'AAPL', qty: 2, id: 'inst-A', autoRun: false });
    manager.startAll();

    await feedTicker(feed, a, 'AAPL', DOWN_UP_DOWN);
    await flush();

    expect(a.state).toBe('DONE');
    const today = await readTodayTrades(store, clock);
    expect(today).toHaveLength(1);
    expect(today[0].instanceId).toBe('inst-A');
  });

  it('keep-awake: 실행 중 인스턴스가 생기면 활성, 전부 종료되면 해제', async () => {
    const { manager, feed, keepAwake } = makeManager({ autoFill: true });
    // keep-awake 해제는 "전부 종료" 시점을 검증한다 — 오토런 재시작이 끼어들지 않게 끈다.
    const a = manager.add({ ticker: 'AAPL', qty: 2, autoRun: false });
    manager.startAll();
    expect(keepAwake.activate).toHaveBeenCalled();
    expect(keepAwake.deactivate).not.toHaveBeenCalled();

    await feedTicker(feed, a, 'AAPL', DOWN_UP_DOWN); // 진입→청산→DONE
    expect(a.state).toBe('DONE');
    expect(keepAwake.deactivate).toHaveBeenCalled();
  });

  it('안전 인터록 발동이 매니저 진단(lastFeedEvent)에 노출된다', async () => {
    const { manager, feed, brokers } = makeManager({ autoFill: true });
    const a = manager.add({ ticker: 'AAPL', qty: 2, id: 'inst-A' });
    manager.startAll();
    brokers.get('AAPL')!.failFetchFills = true; // 체결확인 장애

    await feedTicker(feed, a, 'AAPL', V); // BUY 신호 → 프리플라이트 실패 → FAULT

    expect(a.state).toBe('FAULT');
    expect(manager.lastFeedEvent?.text).toContain('자동매매 중단');
    expect(manager.lastFeedEvent?.text).toContain('inst-A');
  });

  it('getSubscriptionStatus ① trKey별 구독 ACK 성공/실패를 독립적으로 보존한다(lastFeedEvent는 매번 덮어써짐)', () => {
    const { manager, feed, clock } = makeManager();
    manager.add({ ticker: 'AAPL', qty: 1, id: 'inst-A' });

    expect(manager.getSubscriptionStatus('DNASAAPL')).toBeNull(); // 아직 응답 없음

    clock.advance(1);
    feed.emitControl({ trId: 'HDFSCNT0', trKey: 'DNASAAPL', rtCd: '0' });
    clock.advance(1);
    // 체결가·호가는 **같은 trKey 문자열**(DNASAAPL)을 쓰고 trId로만 구분된다(공식 샘플 검증) —
    // 같은 키에 대한 두 ACK가 서로 덮어쓰지 않는지가 이 테스트의 핵심.
    feed.emitControl({ trId: 'HDFSASP0', trKey: 'DNASAAPL', rtCd: '1', msg1: '구독 한도 초과' });

    const fillStatus = manager.getSubscriptionStatus('DNASAAPL');
    expect(fillStatus?.success).toBe(true);
    const quoteStatus = manager.getSubscriptionStatus('DNASAAPL', 'HDFSASP0');
    expect(quoteStatus?.success).toBe(false);
    expect(quoteStatus?.message).toBe('구독 한도 초과');
    // 마지막 이벤트는 호가 실패로 덮어써졌지만, 체결가(trId별) 이력은 그대로 남아 있다(핵심 회귀 방지).
    expect(manager.lastFeedEvent?.text).toContain('구독 실패');
    expect(fillStatus?.success).toBe(true);
  });

  it('getSubscriptionStatus ② trKey가 없는 제어 프레임은 이력에 남기지 않는다', () => {
    const { manager, feed } = makeManager();
    manager.add({ ticker: 'AAPL', qty: 1 });

    feed.emitControl({ trId: 'HDFSCNT0', rtCd: '0' }); // trKey 없음
    expect(manager.getSubscriptionStatus('DNASAAPL')).toBeNull();
  });

  it('updateQty ① IDLE에서 수정 → getConfig 반영·persist·다음 Run 사이클 매수 수량이 새 값', async () => {
    const { manager, feed, store, brokers } = makeManager({ autoFill: true });
    const a = manager.add({ ticker: 'AAPL', qty: 2, id: 'inst-A' });
    expect(a.state).toBe('IDLE');

    manager.updateQty('inst-A', 5);

    expect(manager.getConfig('inst-A')?.qty).toBe(5);
    expect(a.qty).toBe(5);
    const persisted = JSON.parse(store.map.get(INSTANCES_STORAGE_KEY)!);
    expect(persisted.find((c: { id: string }) => c.id === 'inst-A').qty).toBe(5);

    manager.startAll();
    await feedTicker(feed, a, 'AAPL', V);
    expect(a.state).toBe('HOLDING');
    const buys = brokers.get('AAPL')!.placed.filter((p) => p.side === 'buy');
    expect(buys).toHaveLength(1);
    expect(buys[0].qty).toBe(5); // 소급 아님 — 새 값이 그대로 다음 Run에 쓰인다.
  });

  it('updateQty ② 실행 중(WATCH_BUY)에는 throw하고 기존 값을 유지한다', () => {
    const { manager } = makeManager();
    const a = manager.add({ ticker: 'AAPL', qty: 2, id: 'inst-A' });
    manager.startAll();
    expect(a.state).toBe('WATCH_BUY');

    expect(() => manager.updateQty('inst-A', 9)).toThrow(/실행 중에는 수량을 바꿀 수 없어요/);
    expect(manager.getConfig('inst-A')?.qty).toBe(2);
    expect(a.qty).toBe(2);
  });

  it('updateQty ③ 재시작 복원 시 새 수량이 로드된다', async () => {
    const { manager, store } = makeManager();
    manager.add({ ticker: 'AAPL', qty: 2, id: 'inst-A' });
    manager.updateQty('inst-A', 7);

    const feed2 = new FakeFeed();
    const restored = new ScalperManager({
      realtime: feed2,
      storage: store,
      clock: fakeClock(1000),
      scheduler: noopScheduler(),
      makeBroker: () => new FakeBroker(),
    });
    await restored.restore();

    expect(restored.getConfig('inst-A')?.qty).toBe(7);
    expect(restored.get('inst-A')?.qty).toBe(7);
  });

  it('updateQty — FAULT 상태에서는 허용된다', async () => {
    const { manager, feed, brokers } = makeManager({ autoFill: true });
    const a = manager.add({ ticker: 'AAPL', qty: 2, id: 'inst-A' });
    manager.startAll();
    brokers.get('AAPL')!.failFetchFills = true;
    await feedTicker(feed, a, 'AAPL', V); // BUY 신호 → 프리플라이트 실패 → FAULT
    expect(a.state).toBe('FAULT');

    expect(() => manager.updateQty('inst-A', 3)).not.toThrow();
    expect(manager.getConfig('inst-A')?.qty).toBe(3);
    expect(a.state).toBe('FAULT'); // 인터록 상태는 그대로 유지된다.
  });

  it('오토런 ① 기본값은 켜짐, setAutoRun(false)는 config·view·persist에 반영된다', async () => {
    const { manager, store } = makeManager();
    const a = manager.add({ ticker: 'AAPL', qty: 2, id: 'inst-A' });
    expect(a.getView().autoRun).toBe(true); // 기본 켜짐

    manager.setAutoRun('inst-A', false);
    expect(a.getView().autoRun).toBe(false);
    expect(manager.getConfig('inst-A')?.autoRun).toBe(false);
    const persisted = JSON.parse(store.map.get(INSTANCES_STORAGE_KEY)!);
    expect(persisted.find((c: { id: string }) => c.id === 'inst-A').autoRun).toBe(false);
  });

  it('오토런 ② 재시작 복원 시 autoRun 설정이 로드된다', async () => {
    const { manager, store } = makeManager();
    manager.add({ ticker: 'AAPL', qty: 2, id: 'inst-A' });
    manager.setAutoRun('inst-A', false);

    const feed2 = new FakeFeed();
    const restored = new ScalperManager({
      realtime: feed2,
      storage: store,
      clock: fakeClock(1000),
      scheduler: noopScheduler(),
      makeBroker: () => new FakeBroker(),
    });
    await restored.restore();

    expect(restored.get('inst-A')?.getView().autoRun).toBe(false);
  });

  it('오토런 ③ 자연 완료되면 수량을 조정해 자동 재시작하고 진단·persist에 반영된다', async () => {
    const { manager, feed, store } = makeManager({ autoFill: true });
    const a = manager.add({ ticker: 'AAPL', qty: 4, id: 'inst-A' });
    manager.startAll();

    // DOWN_UP_DOWN → 자연 완료(SELL_SIGNAL) → 오토런이 수량을 조정(절반 또는 2배)해 자동 재시작.
    // (체결가는 틱값이라 손익 부호가 시퀀스에 좌우되므로 여기서는 "재시작 배선"을 검증한다.
    //  절반/2배 반올림·상한 규칙 자체는 instance 단위 테스트가 결정론적으로 검증한다.)
    await feedTicker(feed, a, 'AAPL', DOWN_UP_DOWN);

    expect(a.qty).not.toBe(4); // 손익에 따라 조정됨(2 또는 8)
    expect([2, 8]).toContain(a.qty);
    expect(['WATCH_BUY', 'BUYING', 'HOLDING']).toContain(a.state); // 자동 재시작(감시 재개)
    // 재시작 수량이 config·persist에 반영된다.
    expect(manager.getConfig('inst-A')?.qty).toBe(a.qty);
    const persisted = JSON.parse(store.map.get(INSTANCES_STORAGE_KEY)!);
    expect(persisted.find((c: { id: string }) => c.id === 'inst-A').qty).toBe(a.qty);
    expect(manager.lastFeedEvent?.text).toContain('재시작');
  });

  it('WS 단일 연결 멀티플렉스 — 같은 티커 인스턴스가 남아 있으면 구독을 유지한다', () => {
    const { manager, feed } = makeManager();
    manager.add({ ticker: 'AAPL', qty: 1, id: 'a1' });
    manager.add({ ticker: 'AAPL', qty: 2, id: 'a2' });
    expect(feed.subscribed.has('DNASAAPL')).toBe(true);

    manager.remove('a1');
    expect(feed.subscribed.has('DNASAAPL')).toBe(true); // a2가 여전히 사용

    manager.remove('a2');
    expect(feed.subscribed.has('DNASAAPL')).toBe(false); // 마지막 사용자 제거 → 해제
  });
});
