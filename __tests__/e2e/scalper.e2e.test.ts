// 7단계 — 통합(종단) 테스트.
// core/kis/lib/features(scalper) 87개 단위 테스트가 이미 각 모듈을 검증했다 — 여기서는 그 바깥 경계에서
// "합성 WS 프레임 → 실물 파싱·리샘플·판정·사이클 → 실물 REST 글루 → 가짜 fetch" 전 체인을 검증한다.
// 가짜는 kis 경계 바로 바깥(fetch·WebSocket)에만 심는다 — core/kis/features/scalper 소스는 전부 실물 그대로 통과.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readTodayTrades } from '../../features/scalper/tradeStore';
import {
  DOWN_UP_DOWN,
  INV_V_SHAPE,
  V_SHAPE,
  advanceAndPoll,
  advanceAndReprice,
  flush,
  makeHarness,
  priceFrame,
  quoteFrame,
  startAndOpen,
  tick,
  tickSeries,
  tickSeriesWithQuote,
  type Harness,
} from './harness';

// 실전(live)·미국(NASD) TR ID — docs/koreainvestment/주문.md·정정취소주문.md TR ID 표 그대로(독립 출처).
const BUY_TR_ID = 'TTTT1002U';
const SELL_TR_ID = 'TTTT1006U';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('7단계 종단 — 변곡점 단타 체인 (WS 프레임 → 실물 파싱/판정/사이클 → REST 글루 → 가짜 fetch)', () => {
  it('① V자 가격 시퀀스에서 BUY 주문이 정확히 1회 발주된다(TR ID·PDNO·수량 검증)', async () => {
    const h = makeHarness({ autoFillOrders: true });
    const inst = h.manager.add({ ticker: 'AAPL', qty: 2 });
    startAndOpen(h);

    await tickSeries(h, 'AAPL', V_SHAPE);

    const buys = h.api.placed.filter((p) => p.side === 'buy');
    expect(buys).toHaveLength(1);
    expect(buys[0].trId).toBe(BUY_TR_ID);
    expect(buys[0].pdno).toBe('AAPL');
    expect(buys[0].qty).toBe(2);
    expect(inst.state).toBe('HOLDING');
  });

  it('② 이후 역V자에서 SELL 발주·전량 매도·DONE', async () => {
    const h = makeHarness({ autoFillOrders: true });
    const inst = h.manager.add({ ticker: 'AAPL', qty: 2, autoRun: false });
    startAndOpen(h);

    await tickSeries(h, 'AAPL', DOWN_UP_DOWN);

    const buys = h.api.placed.filter((p) => p.side === 'buy');
    const sells = h.api.placed.filter((p) => p.side === 'sell');
    expect(buys).toHaveLength(1);
    expect(sells).toHaveLength(1);
    expect(sells[0].trId).toBe(SELL_TR_ID);
    expect(sells[0].pdno).toBe('AAPL');
    expect(sells[0].qty).toBe(2); // 전량 매도
    expect(inst.state).toBe('DONE');
  });

  it('④-호가 공격적 지정가: 실시간호가 수신 중이면 매수 발주가=매도1호가, 매도 발주가=매수1호가', async () => {
    const h = makeHarness({ autoFillOrders: true });
    h.manager.add({ ticker: 'AAPL', qty: 2, autoRun: false });
    startAndOpen(h);

    // bid1=99.9, ask1=100.1을 매 틱 흘리며 하락-상승-하락(BUY 1회 후 SELL 1회) 시퀀스를 태운다.
    await tickSeriesWithQuote(h, 'AAPL', DOWN_UP_DOWN, 99.9, 100.1);

    const buy = h.api.placed.find((p) => p.side === 'buy')!;
    const sell = h.api.placed.find((p) => p.side === 'sell')!;
    // 발주 바디 OVRS_ORD_UNPR 검증(가짜 fetch가 Number로 파싱해 저장) — 체결가(정수 시퀀스)가 아니라 호가를 썼다.
    expect(buy.price).toBe(100.1); // 매도1호가(ask1)로 크로스
    expect(sell.price).toBe(99.9); // 매수1호가(bid1)로 크로스
    expect(DOWN_UP_DOWN.includes(buy.price)).toBe(false); // 마지막 체결가였다면 정수였을 것
  });

  it('③ Run 없이 틱만 흘리면 주문 fetch 0회', async () => {
    const h = makeHarness();
    const inst = h.manager.add({ ticker: 'AAPL', qty: 1 });
    // instance.start()(Run)는 호출하지 않고 WS 연결만 직접 연다 — "Run 없이 틱만 수신"을 그대로 흉내낸다.
    h.realtime.connect();
    h.socket().open();

    await tickSeries(h, 'AAPL', DOWN_UP_DOWN); // 변곡점이 뚜렷한 시퀀스인데도

    expect(h.api.placed).toHaveLength(0);
    expect(inst.state).toBe('IDLE');
  });

  it('④ 감시 중 Stop → 주문 없이 종료', async () => {
    const h = makeHarness();
    const inst = h.manager.add({ ticker: 'AAPL', qty: 1 });
    startAndOpen(h);

    // V자의 하락 구간만 흘려 아직 BUY 변곡점 전(계속 하강 중)에 Stop.
    await tick(h, 'AAPL', 20);
    await tick(h, 'AAPL', 16);
    await tick(h, 'AAPL', 12);
    await tick(h, 'AAPL', 8);
    expect(inst.state).toBe('WATCH_BUY');

    inst.stop();
    await advanceAndPoll(h, 100);

    expect(inst.state).toBe('DONE');
    expect(h.api.placed).toHaveLength(0);
  });

  it('⑤ 워밍업(버퍼 미충족) 중 무판정', async () => {
    const h = makeHarness({ bufferSize: 7 });
    const inst = h.manager.add({ ticker: 'AAPL', qty: 1 });
    startAndOpen(h);

    // 버퍼 크기(7)보다 적은 4개만 흘린다.
    await tick(h, 'AAPL', 20);
    await tick(h, 'AAPL', 16);
    await tick(h, 'AAPL', 12);
    await tick(h, 'AAPL', 8);

    const view = inst.getView();
    expect(view.warmedUp).toBe(false);
    expect(view.lastSignal).toBeNull();
    expect(h.api.placed).toHaveLength(0);
    expect(inst.state).toBe('WATCH_BUY');
  });

  it('⑥ 매수 미체결 → 시간이 지나도 취소 0회(무한 대기) → 뒤늦은 체결 시 HOLDING', async () => {
    const h = makeHarness(); // autoFillOrders 기본 false — 의도적으로 미체결 유지
    const inst = h.manager.add({ ticker: 'AAPL', qty: 2 });
    startAndOpen(h);

    // 첫 BUY 변곡점이 발생해 BUYING으로 전이될 때까지만 V자를 흘린다.
    for (const p of V_SHAPE) {
      await tick(h, 'AAPL', p);
      if (inst.state === 'BUYING') break;
    }
    expect(inst.state).toBe('BUYING');
    const buys1 = h.api.placed.filter((p) => p.side === 'buy');
    expect(buys1).toHaveLength(1);
    const firstOdno = buys1[0].odno;
    expect(h.api.canceled).toHaveLength(0);

    // 체결내역은 계속 미체결 — 예전 타임아웃의 몇 배가 지나도 자동 취소는 발동하지 않는다.
    await advanceAndPoll(h, 30000);
    expect(h.api.canceled).toHaveLength(0); // 취소 0회
    expect(inst.state).toBe('BUYING'); // 계속 체결 대기

    // 뒤늦게 체결이 도착하면 정상 보유 전환.
    h.api.setFilled(firstOdno, 2, 100);
    await advanceAndPoll(h, 100);
    expect(inst.state).toBe('HOLDING');
    expect(h.api.canceled).toHaveLength(0);
  });

  it('⑦ 매도 미체결 → 시간이 지나도 취소 0회(무한 대기) → 뒤늦은 체결 시 DONE', async () => {
    const h = makeHarness();
    const inst = h.manager.add({ ticker: 'AAPL', qty: 2, autoRun: false });
    startAndOpen(h);

    // 진입까지는 즉시 체결시켜 HOLDING으로 만든다.
    for (const p of V_SHAPE) {
      await tick(h, 'AAPL', p);
      if (inst.state === 'BUYING') break;
    }
    const buyOdno = h.api.placed.find((p) => p.side === 'buy')!.odno;
    h.api.setFilled(buyOdno, 2, 100);
    await advanceAndPoll(h, 100);
    expect(inst.state).toBe('HOLDING');

    // 첫 SELL 변곡점(역V자) → SELLING, 미체결 유지.
    for (const p of INV_V_SHAPE) {
      await tick(h, 'AAPL', p);
      if (inst.state === 'SELLING') break;
    }
    expect(inst.state).toBe('SELLING');
    const sells1 = h.api.placed.filter((p) => p.side === 'sell');
    expect(sells1).toHaveLength(1);
    const firstSellOdno = sells1[0].odno;

    // 오랜 시간 폴이 지나도 매도를 취소하지 않는다(무한 대기).
    await advanceAndPoll(h, 30000);
    expect(h.api.canceled).toHaveLength(0);
    expect(inst.state).toBe('SELLING'); // 포지션 유지, 계속 체결 대기

    // 뒤늦게 매도 체결이 도착하면 사이클을 정상 완료한다.
    h.api.setFilled(firstSellOdno, 2, 110);
    await advanceAndPoll(h, 100);
    expect(inst.state).toBe('DONE');
    expect(h.api.canceled).toHaveLength(0);
  });

  it('⑧ 2개 인스턴스(다른 티커) 동시 — WS 프레임이 티커별로 올바르게 라우팅되고 각자 독립 사이클·기록에 instanceId 구분', async () => {
    const h = makeHarness({ autoFillOrders: true });
    const aapl = h.manager.add({ ticker: 'AAPL', qty: 2, id: 'inst-AAPL', autoRun: false });
    const msft = h.manager.add({ ticker: 'MSFT', qty: 3, id: 'inst-MSFT', autoRun: false });
    startAndOpen(h);

    // 두 티커를 스케일이 다른 값으로 교차 흘려 라우팅 오류가 있으면 가격/수량이 명백히 어긋나도록 한다.
    const msftPrices = DOWN_UP_DOWN.map((p) => p * 10);
    for (let i = 0; i < DOWN_UP_DOWN.length; i++) {
      await tick(h, 'AAPL', DOWN_UP_DOWN[i]);
      await tick(h, 'MSFT', msftPrices[i]);
    }
    // 마지막 청크를 닫기 위한 캡 틱.
    await tick(h, 'AAPL', DOWN_UP_DOWN[DOWN_UP_DOWN.length - 1]);
    await tick(h, 'MSFT', msftPrices[msftPrices.length - 1]);

    expect(aapl.state).toBe('DONE');
    expect(msft.state).toBe('DONE');

    const aaplOrders = h.api.placed.filter((p) => p.pdno === 'AAPL');
    const msftOrders = h.api.placed.filter((p) => p.pdno === 'MSFT');
    expect(aaplOrders.filter((p) => p.side === 'buy')).toHaveLength(1);
    expect(aaplOrders.filter((p) => p.side === 'sell')).toHaveLength(1);
    expect(msftOrders.filter((p) => p.side === 'buy')).toHaveLength(1);
    expect(msftOrders.filter((p) => p.side === 'sell')).toHaveLength(1);
    // 티커별 수량이 섞이지 않았는가(라우팅 검증의 핵심).
    expect(aaplOrders.every((p) => p.qty === 2)).toBe(true);
    expect(msftOrders.every((p) => p.qty === 3)).toBe(true);
    // 가격대도 섞이지 않았는가(AAPL은 원 시퀀스 값, MSFT는 ×10 스케일 시퀀스 값에서만 나와야 한다).
    expect(aaplOrders.every((p) => DOWN_UP_DOWN.includes(p.price))).toBe(true);
    expect(msftOrders.every((p) => msftPrices.includes(p.price))).toBe(true);

    const today = await readTodayTrades(h.store, h.clock);
    expect(today).toHaveLength(2);
    const byInstance = new Map(today.map((t) => [t.instanceId, t]));
    expect(byInstance.get('inst-AAPL')?.ticker).toBe('AAPL');
    expect(byInstance.get('inst-MSFT')?.ticker).toBe('MSFT');
  });

  it('⑨ 기록-조회 정합: 사이클 완료 후 readTodayTrades가 진입·청산가·pnl이 맞는 기록을 반환한다', async () => {
    const h = makeHarness({ autoFillOrders: true });
    const inst = h.manager.add({ ticker: 'AAPL', qty: 2, id: 'inst-1', autoRun: false });
    startAndOpen(h);

    await tickSeries(h, 'AAPL', DOWN_UP_DOWN);
    expect(inst.state).toBe('DONE');

    const buyOrder = h.api.placed.find((p) => p.side === 'buy')!;
    const sellOrder = h.api.placed.find((p) => p.side === 'sell')!;

    const today = await readTodayTrades(h.store, h.clock);
    expect(today).toHaveLength(1);
    const record = today[0];
    expect(record.instanceId).toBe('inst-1');
    expect(record.ticker).toBe('AAPL');
    expect(record.qty).toBe(2);
    expect(record.entryPrice).toBe(buyOrder.price);
    expect(record.exitPrice).toBe(sellOrder.price);
    expect(record.pnl).toBe((sellOrder.price - buyOrder.price) * 2);
    expect(record.exitReason).toBe('SELL_SIGNAL');
  });
});

describe('7단계 종단 — BUY 게이트(거래량 스파이크·체결강도, 2026-08-03)', () => {
  it('게이트 켬 + 평범한 거래량(EVOL 균일) → V자에서도 매수하지 않는다', async () => {
    const h = makeHarness({ autoFillOrders: true, minBuyMomentum: 0, minVolumeSpikeRatio: 1.5 });
    const inst = h.manager.add({ ticker: 'AAPL', qty: 2, autoRun: false });
    startAndOpen(h);

    // 기본 프레임 EVOL='1' 균일 — 스파이크 배율 ≈ 1이라 게이트(1.5배)가 계속 막는다.
    await tickSeries(h, 'AAPL', V_SHAPE);

    expect(h.api.placed.filter((p) => p.side === 'buy')).toHaveLength(0);
    expect(inst.state).toBe('WATCH_BUY');
  });

  it('게이트 켬 + 변곡 부근 거래량 스파이크(EVOL 급증) → 매수가 발주된다', async () => {
    const h = makeHarness({ autoFillOrders: true, minBuyMomentum: 0, minVolumeSpikeRatio: 1.5 });
    const inst = h.manager.add({ ticker: 'AAPL', qty: 2 });
    startAndOpen(h);

    // 상승 구간(틱 8 이후)에 평소(1)의 10배 체결량 — 게이트 통과.
    await tickSeries(h, 'AAPL', V_SHAPE, 1000, (i) => (i >= 8 ? { EVOL: '10' } : {}));

    expect(h.api.placed.filter((p) => p.side === 'buy')).toHaveLength(1);
    expect(inst.state).toBe('HOLDING');
  });

  it('체결강도 게이트 — STRN 미달이면 매수 없음, 문턱 이상이면 매수', async () => {
    const weak = makeHarness({ autoFillOrders: true, minBuyMomentum: 0, minStrength: 120 });
    weak.manager.add({ ticker: 'AAPL', qty: 2, autoRun: false });
    startAndOpen(weak);
    // 기본 STRN='100' < 120 — 게이트가 막는다.
    await tickSeries(weak, 'AAPL', V_SHAPE);
    expect(weak.api.placed.filter((p) => p.side === 'buy')).toHaveLength(0);
    vi.unstubAllGlobals();

    const strong = makeHarness({ autoFillOrders: true, minBuyMomentum: 0, minStrength: 120 });
    strong.manager.add({ ticker: 'AAPL', qty: 2 });
    startAndOpen(strong);
    await tickSeries(strong, 'AAPL', V_SHAPE, 1000, () => ({ STRN: '150' }));
    expect(strong.api.placed.filter((p) => p.side === 'buy')).toHaveLength(1);
  });

  it('게이트 기본값(0=끔) — 기존 ①과 동일하게 V자에서 즉시 매수한다(하위호환)', async () => {
    const h = makeHarness({ autoFillOrders: true });
    const inst = h.manager.add({ ticker: 'AAPL', qty: 2 });
    startAndOpen(h);
    await tickSeries(h, 'AAPL', V_SHAPE);
    expect(h.api.placed.filter((p) => p.side === 'buy')).toHaveLength(1);
    expect(inst.state).toBe('HOLDING');
  });
});

describe('7단계 종단 — 매도 리프라이스(2026-08-04)', () => {
  /** V자로 매수·체결까지 몰아 HOLDING을 만든 뒤, 역V로 매도를 발주시켜 SELLING을 만든다. */
  async function toSelling(h: Harness, bid1: number, ask1: number) {
    h.manager.add({ ticker: 'AAPL', qty: 2, autoRun: false });
    startAndOpen(h);
    await tickSeriesWithQuote(h, 'AAPL', DOWN_UP_DOWN, bid1, ask1);
    const inst = h.manager.getInstances()[0];
    expect(inst.state).toBe('SELLING');
    return inst;
  }

  it('① [사고 재현] 매수1호가가 흘러내려도 정정이 따라가 결국 체결된다', async () => {
    // autoFill을 끄면 최초 매도 지정가는 영원히 안 붙는다(= 지금 겪는 씹힘).
    const h = makeHarness({ autoFillOrders: false });
    h.manager.add({ ticker: 'AAPL', qty: 2, autoRun: false });
    startAndOpen(h);

    // 매수는 손으로 체결시켜 HOLDING → 역V로 매도 발주.
    for (const p of DOWN_UP_DOWN) {
      h.clock.advance(1000);
      h.socket().serverSend(quoteFrame('AAPL', 9.9, 10.1));
      h.socket().serverSend(priceFrame('AAPL', p));
      await flush();
      const buy = h.api.placed.find((o) => o.side === 'buy');
      if (buy && !h.api.isFilled(buy.odno)) h.api.setFilled(buy.odno, buy.qty, buy.price);
      for (const inst of h.manager.getInstances()) await inst.pollCycle();
      await flush();
      if (h.manager.getInstances()[0].state === 'SELLING') break;
    }
    const inst = h.manager.getInstances()[0];
    expect(inst.state).toBe('SELLING');
    expect(h.api.amended).toHaveLength(0);

    // 매수1호가가 계속 흘러내린다 → 매 리프라이스 틱마다 정정이 따라간다.
    for (const bid of [9.8, 9.7, 9.6]) {
      h.socket().serverSend(quoteFrame('AAPL', bid, bid + 0.2));
      await flush();
      await advanceAndReprice(h);
    }
    expect(h.api.amended.length).toBeGreaterThanOrEqual(3);
    expect(h.api.amended[h.api.amended.length - 1].price).toBe(9.6);
    // 정정만으로는 사이클이 끝나지 않는다(취소도 하지 않는다).
    expect(inst.state).toBe('SELLING');
    expect(h.api.canceled).toHaveLength(0);

    // 마지막으로 살아있는 매도 주문이 체결되면 정상 완료.
    const live = h.api.liveOrder('sell')!;
    h.api.setFilled(live.odno, live.qty, live.price);
    await advanceAndPoll(h, 1000);
    expect(inst.state).toBe('DONE');
  });

  it('② [사고 재현] 정정으로 옛 ODNO가 미체결 목록에서 사라져도 가짜 DONE이 되지 않는다', async () => {
    const h = makeHarness({ autoFillOrders: false });
    h.manager.add({ ticker: 'AAPL', qty: 2, autoRun: false });
    startAndOpen(h);
    for (const p of DOWN_UP_DOWN) {
      h.clock.advance(1000);
      h.socket().serverSend(quoteFrame('AAPL', 9.9, 10.1));
      h.socket().serverSend(priceFrame('AAPL', p));
      await flush();
      const buy = h.api.placed.find((o) => o.side === 'buy');
      if (buy && !h.api.isFilled(buy.odno)) h.api.setFilled(buy.odno, buy.qty, buy.price);
      for (const inst of h.manager.getInstances()) await inst.pollCycle();
      await flush();
      if (h.manager.getInstances()[0].state === 'SELLING') break;
    }
    const inst = h.manager.getInstances()[0];

    h.socket().serverSend(quoteFrame('AAPL', 9.5, 9.7));
    await flush();
    await advanceAndReprice(h);
    expect(h.api.amended).toHaveLength(1);
    // 옛 ODNO는 미체결 목록에서 빠졌다(정정으로 대체) — 체결이 아니다.
    expect(h.api.isSuperseded(h.api.amended[0].from)).toBe(true);

    // 폴을 여러 번 돌려도 체결로 오판하면 안 된다.
    for (let i = 0; i < 3; i++) await advanceAndPoll(h, 2000);
    expect(inst.state).toBe('SELLING');
  });

  it('③ 매수1호가가 그대로면 정정 호출이 0회다 (유량 절감)', async () => {
    const h = makeHarness({ autoFillOrders: false });
    h.manager.add({ ticker: 'AAPL', qty: 2, autoRun: false });
    startAndOpen(h);
    for (const p of DOWN_UP_DOWN) {
      h.clock.advance(1000);
      h.socket().serverSend(quoteFrame('AAPL', 9.9, 10.1));
      h.socket().serverSend(priceFrame('AAPL', p));
      await flush();
      const buy = h.api.placed.find((o) => o.side === 'buy');
      if (buy && !h.api.isFilled(buy.odno)) h.api.setFilled(buy.odno, buy.qty, buy.price);
      for (const inst of h.manager.getInstances()) await inst.pollCycle();
      await flush();
      if (h.manager.getInstances()[0].state === 'SELLING') break;
    }

    // 같은 호가를 계속 흘리며 리프라이스를 여러 번 돌려도 order-rvsecncl은 나가지 않는다.
    for (let i = 0; i < 10; i++) {
      h.socket().serverSend(quoteFrame('AAPL', 9.9, 10.1));
      await flush();
      await advanceAndReprice(h);
    }
    expect(h.api.amended).toHaveLength(0);
  });
});
