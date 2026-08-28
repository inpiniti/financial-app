import { describe, expect, it } from 'vitest';
import { ScalperManager } from './scalperManager';
import { FakeFeed, fakeClock } from './fakes';

function makeManager() {
  const feed = new FakeFeed();
  const clock = fakeClock(1000);
  return { manager: new ScalperManager({ realtime: feed, clock }), feed, clock };
}

describe('ScalperManager — 피드 허브(진단·ACK 이력)', () => {
  it('getSubscriptionStatus ① trKey별 구독 ACK 성공/실패를 독립적으로 보존한다(lastFeedEvent는 매번 덮어써짐)', () => {
    const { manager, feed, clock } = makeManager();

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
    expect(manager.lastFeedEvent?.text).toBe('구독 실패 · DNASAAPL · 구독 한도 초과'); // trKey를 같이 적는다(2026-08-28).
    expect(fillStatus?.success).toBe(true);
  });

  it('getSubscriptionStatus ② trKey가 없는 제어 프레임은 이력에 남기지 않는다', () => {
    const { manager, feed } = makeManager();

    feed.emitControl({ trId: 'HDFSCNT0', rtCd: '0' }); // trKey 없음
    expect(manager.getSubscriptionStatus('DNASAAPL')).toBeNull();
  });

  it('reportFeedError — 연결 오류가 진단 한 줄로 노출된다', () => {
    const { manager } = makeManager();
    manager.reportFeedError(new Error('WS 전송 실패'));
    expect(manager.lastFeedEvent?.text).toContain('연결 오류');
    expect(manager.lastFeedEvent?.text).toContain('WS 전송 실패');
  });
});

describe('ScalperManager — 보조 수신기(setAuxRoutes, 자동 단타 라우팅)', () => {
  it('WS 틱·호가가 aux 수신기로 흘러가고, null 해제 후엔 오지 않는다', () => {
    const { manager, feed } = makeManager();
    const ticks: Array<[string, number]> = [];
    const quotes: Array<[string, number, number]> = [];
    manager.setAuxRoutes(
      (symb, price) => ticks.push([symb, price]),
      (symb, bid1, ask1) => quotes.push([symb, bid1, ask1]),
    );

    feed.emit('AAPL', 150, 1000);
    feed.emitQuote('AAPL', 149.9, 150.1, 1000);
    expect(ticks).toEqual([['AAPL', 150]]);
    expect(quotes).toEqual([['AAPL', 149.9, 150.1]]);

    manager.setAuxRoutes(null, null);
    feed.emit('AAPL', 151, 2000);
    expect(ticks).toEqual([['AAPL', 150]]);
  });
});

describe('ScalperManager — 상세화면 구독 refcount(acquireFeed/releaseFeed)', () => {
  const TICK = 'HDFSCNT0';
  const QUOTE = 'HDFSASP0';
  const KEY = 'DNASAAPL';

  it('acquire로 구독되고 마지막 release에서 해제된다', () => {
    const { manager, feed } = makeManager();
    manager.acquireFeed(KEY, TICK);
    manager.acquireFeed(KEY, QUOTE);
    expect(feed.connected).toBe(true);
    expect(feed.subs.has(`${TICK}|${KEY}`)).toBe(true);
    expect(feed.subs.has(`${QUOTE}|${KEY}`)).toBe(true);

    manager.releaseFeed(KEY, TICK);
    manager.releaseFeed(KEY, QUOTE);
    expect(feed.subs.has(`${TICK}|${KEY}`)).toBe(false);
    expect(feed.subs.has(`${QUOTE}|${KEY}`)).toBe(false);
  });

  it('중복 acquire는 같은 수의 release가 와야만 해제된다', () => {
    const { manager, feed } = makeManager();
    manager.acquireFeed(KEY, QUOTE);
    manager.acquireFeed(KEY, QUOTE);
    manager.releaseFeed(KEY, QUOTE);
    expect(feed.subs.has(`${QUOTE}|${KEY}`)).toBe(true);
    manager.releaseFeed(KEY, QUOTE);
    expect(feed.subs.has(`${QUOTE}|${KEY}`)).toBe(false);
  });

  it('외부 프로브(자동 단타)가 쓰는 키는 acquire가 중복 구독하지 않고 release도 해제하지 않는다', () => {
    const { manager, feed } = makeManager();
    manager.setFeedUseProbe((trKey, trId) => trKey === KEY && trId === QUOTE);
    // 프로브 소유 구독을 흉내 — 자동 단타가 이미 구독해 둔 상태.
    feed.subscribe(KEY, QUOTE);
    manager.acquireFeed(KEY, QUOTE);
    manager.releaseFeed(KEY, QUOTE);
    expect(feed.subs.has(`${QUOTE}|${KEY}`)).toBe(true);
  });

  it('holdsFeed — 상세화면이 잡고 있는 동안 true, 전부 release하면 false', () => {
    const { manager } = makeManager();
    expect(manager.holdsFeed(KEY, TICK)).toBe(false);
    manager.acquireFeed(KEY, TICK);
    expect(manager.holdsFeed(KEY, TICK)).toBe(true);
    manager.releaseFeed(KEY, TICK);
    expect(manager.holdsFeed(KEY, TICK)).toBe(false);
  });

  it('subscribeFeedData 리스너로 틱·호가가 흘러오고 해지 후엔 오지 않는다', () => {
    const { manager, feed } = makeManager();
    const ticks: number[] = [];
    const quotes: Array<[number, number]> = [];
    const unsub = manager.subscribeFeedData('AAPL', {
      onTick: (price) => ticks.push(price),
      onQuote: (bid1, ask1) => quotes.push([bid1, ask1]),
    });

    feed.emit('AAPL', 150, 1000);
    feed.emitQuote('AAPL', 149.9, 150.1, 1000);
    expect(ticks).toEqual([150]);
    expect(quotes).toEqual([[149.9, 150.1]]);

    unsub();
    feed.emit('AAPL', 151, 2000);
    expect(ticks).toEqual([150]);
  });
});
