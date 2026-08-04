import { describe, expect, it } from 'vitest';
import type { TradeRecord } from '../../core/cycle';
import { ScalperInstance, nextAutoRunQty, type ScalperInstanceDeps } from './scalperInstance';
import type { AutoRunNote } from './types';
import { FakeBroker, fakeClock, flush, noopScheduler } from './fakes';

// core/integration.test.ts에서 검증된 시퀀스(버퍼 7): BUY 1회 / BUY→SELL.
const V = [20, 16, 12, 8, 4, 2, 4, 8, 12, 16, 20];
const DOWN_UP_DOWN = [20, 16, 12, 8, 4, 2, 4, 8, 12, 16, 20, 18, 14, 10, 6, 2];

interface Harness {
  inst: ScalperInstance;
  broker: FakeBroker;
  clock: ReturnType<typeof fakeClock>;
  trades: Array<{ id: string; rec: TradeRecord }>;
  /** fired[0]=폴 타이머, fired[1]=리프라이스 타이머 (등록 순서 고정). */
  scheduler: ReturnType<typeof noopScheduler>;
}

function makeInstance(
  opts: { autoFill?: boolean; ticker?: string; extraDeps?: Partial<ScalperInstanceDeps> } = {},
): Harness {
  const broker = new FakeBroker({ autoFill: opts.autoFill });
  const clock = fakeClock(1000);
  const scheduler = noopScheduler();
  const trades: Array<{ id: string; rec: TradeRecord }> = [];
  const deps: ScalperInstanceDeps = {
    broker,
    clock,
    scheduler,
    chunkSeconds: 1,
    bufferSize: 7,
    fillTimeoutMs: 5000,
    throttleMs: 0,
    // 이 하네스는 사이클 메커닉(진입·청산·오토런)을 검증한다 — 매도 확인 단계 이전의 "전환 즉시 매도"를 가정하므로
    // 매도 문턱 0(끔)을 명시해 의미를 보존한다. 매도 확인 단계 자체는 core/detector 틱 재생 테스트에서 검증한다.
    minSellMomentum: 0,
    onTrade: (id, rec) => trades.push({ id, rec }),
    ...opts.extraDeps,
  };
  // 이 하네스의 기존 테스트들은 "사이클 메커닉"을 검증한다(오토런은 별도 describe에서 검증) —
  // 자연 완료 후 자동 재시작이 끼어들지 않도록 오토런은 끈다.
  const inst = new ScalperInstance(
    { id: 'inst-1', ticker: opts.ticker ?? 'AAPL', qty: 2, autoRun: false },
    deps,
  );
  return { inst, broker, clock, trades, scheduler };
}

/** 가격을 초당 1틱으로 흘리고, 매 틱 뒤 체결 폴링을 돌린다(폴 타이머와 동일 동선). */
async function replayWithPoll(inst: ScalperInstance, prices: number[], stepMs = 1000): Promise<void> {
  for (let i = 0; i < prices.length; i++) {
    inst.pushTick(prices[i], i * stepMs);
    await flush();
    await inst.pollCycle();
    await flush();
  }
  // 마지막 청크를 닫기 위한 캡 틱(직전 값 반복 — 이 값은 새 청크로만 남는다).
  inst.pushTick(prices[prices.length - 1], prices.length * stepMs);
  await flush();
  await inst.pollCycle();
  await flush();
}

describe('ScalperInstance — 러너 (틱→리샘플→판정→주문→기록)', () => {
  it('③ 진입은 1회만·전량 매도·거래 기록(instanceId 포함) 발행', async () => {
    const { inst, broker, trades } = makeInstance({ autoFill: true });
    inst.start();
    await replayWithPoll(inst, DOWN_UP_DOWN);

    const buys = broker.placed.filter((p) => p.side === 'buy');
    const sells = broker.placed.filter((p) => p.side === 'sell');
    expect(buys).toHaveLength(1);
    expect(sells).toHaveLength(1);
    expect(sells[0].qty).toBe(2); // 전량
    expect(inst.state).toBe('DONE');

    expect(trades).toHaveLength(1);
    expect(trades[0].id).toBe('inst-1');
    expect(trades[0].rec.exitReason).toBe('SELL_SIGNAL');
    expect(trades[0].rec.qty).toBe(2);
  });

  it('⑤ Stop → 보유 중이면 매도 후 종료(exitReason=STOP)', async () => {
    const { inst, broker, trades } = makeInstance({ autoFill: true });
    inst.start();
    await replayWithPoll(inst, V);
    expect(inst.state).toBe('HOLDING');

    inst.stop();
    expect(inst.state).toBe('SELLING');
    await flush();
    await inst.pollCycle();
    await flush();

    expect(inst.state).toBe('DONE');
    expect(broker.placed.filter((p) => p.side === 'sell')).toHaveLength(1);
    expect(trades).toHaveLength(1);
    expect(trades[0].rec.exitReason).toBe('STOP');
  });

  it('⑥ 매수 미체결 → 시간이 지나도 취소 0회(무한 대기), 뒤늦은 체결 시 HOLDING', async () => {
    const { inst, broker, clock } = makeInstance({ autoFill: false });
    inst.start();
    await replayWithPoll(inst, V); // BUY 발주됐지만 미체결 → BUYING 유지
    expect(inst.state).toBe('BUYING');
    expect(broker.placed.filter((p) => p.side === 'buy')).toHaveLength(1);
    expect(broker.canceled).toHaveLength(0);

    // 예전 타임아웃(5000ms)의 몇 배가 지나도록 여러 번 폴 → 자동 취소는 절대 발동하지 않는다.
    for (let i = 0; i < 5; i++) {
      clock.advance(6000);
      await flush();
      await inst.pollCycle();
      await flush();
    }
    expect(broker.canceled).toHaveLength(0);
    expect(inst.state).toBe('BUYING'); // 계속 체결 대기

    // 뒤늦게 체결이 도착하면 정상 보유 전환.
    broker.fill(broker.placed[0].odno, 4);
    await inst.pollCycle();
    await flush();
    expect(inst.state).toBe('HOLDING');
  });

  it('⑦ 매도 미체결 → 시간이 지나도 취소 0회(무한 대기), 뒤늦은 체결 시 정상 DONE + 기록', async () => {
    const { inst, broker, clock, trades } = makeInstance({ autoFill: false });
    inst.start();

    // BUY 변곡점까지 흘려 BUYING 진입 후, 매수는 즉시 체결시켜 HOLDING을 만든다.
    let ts = 0;
    for (const p of DOWN_UP_DOWN) {
      inst.pushTick(p, ts);
      ts += 1000;
      await flush();
      await inst.pollCycle();
      await flush();
      if (inst.state === 'BUYING') {
        broker.fill(broker.placed[0].odno, 4); // 진입가 4로 체결
        await inst.pollCycle();
        await flush();
      }
      if (inst.state === 'SELLING') break;
    }
    expect(inst.state).toBe('SELLING');
    const sellOdno = broker.placed.find((p) => p.side === 'sell')!.odno;

    // 매도 미체결로 시간이 지나도 취소하지 않는다(무한 대기).
    for (let i = 0; i < 5; i++) {
      clock.advance(6000);
      await flush();
      await inst.pollCycle();
      await flush();
    }
    expect(broker.canceled).toHaveLength(0);
    expect(inst.state).toBe('SELLING');

    // 뒤이어 늦은 체결이 관찰되면 사이클을 정상 완료한다.
    broker.fill(sellOdno, 9); // 청산가 9로 늦은 체결
    await inst.pollCycle();
    await flush();

    expect(inst.state).toBe('DONE');
    expect(trades).toHaveLength(1);
    expect(trades[0].rec.exitReason).toBe('SELL_SIGNAL');
    expect(trades[0].rec.exitPrice).toBe(9);
    expect(trades[0].rec.entryPrice).toBe(4);
  });

  it('⑧ 매 틱마다 리스너를 발행하지 않는다(수치는 스로틀)', () => {
    const broker = new FakeBroker();
    const clock = fakeClock(0); // 시각 고정 → 스로틀 창 안
    const deps: ScalperInstanceDeps = {
      broker,
      clock,
      scheduler: noopScheduler(),
      chunkSeconds: 1,
      bufferSize: 7,
      throttleMs: 1000,
    };
    const inst = new ScalperInstance({ id: 'inst-1', ticker: 'AAPL', qty: 1 }, deps);
    const views: unknown[] = [];
    inst.subscribe((v) => views.push(v));

    // 단조 증가 → 변곡점 없음. 30틱을 같은 시각에 흘려도 발행은 스로틀로 1회뿐.
    const prices = Array.from({ length: 30 }, (_, i) => i + 1);
    prices.forEach((p, i) => inst.pushTick(p, i * 1000));

    expect(views.length).toBe(1);
    expect(views.length).toBeLessThan(prices.length);
  });

  it('⑨ tickCount는 pushTick 호출 횟수만큼, lastTickAt은 clock 기준으로 누적된다', () => {
    const broker = new FakeBroker();
    const clock = fakeClock(1000);
    const deps: ScalperInstanceDeps = {
      broker,
      clock,
      scheduler: noopScheduler(),
      chunkSeconds: 1,
      bufferSize: 7,
      throttleMs: 1000,
    };
    const inst = new ScalperInstance({ id: 'inst-1', ticker: 'AAPL', qty: 1 }, deps);

    expect(inst.getView().tickCount).toBe(0);
    expect(inst.getView().lastTickAt).toBeNull();

    inst.pushTick(10, 0);
    expect(inst.getView().tickCount).toBe(1);
    expect(inst.getView().lastTickAt).toBe(1000); // clock.now() 시점(주입된 clock 기준, ts 인자 아님)

    clock.advance(500);
    inst.pushTick(11, 1000);
    expect(inst.getView().tickCount).toBe(2);
    expect(inst.getView().lastTickAt).toBe(1500);
  });

  it('⑩ sampleCount는 리샘플러 버퍼에 실제로 쌓인 개수를 반영한다(시간 근사치 아님)', () => {
    const broker = new FakeBroker();
    const clock = fakeClock(0);
    const deps: ScalperInstanceDeps = {
      broker,
      clock,
      scheduler: noopScheduler(),
      chunkSeconds: 1,
      bufferSize: 7,
      throttleMs: 0,
    };
    const inst = new ScalperInstance({ id: 'inst-1', ticker: 'AAPL', qty: 1 }, deps);

    expect(inst.getView().sampleCount).toBe(0);

    // 첫 틱은 청크를 여는 틱이라 아직 마감되지 않는다(core/resample 계약).
    inst.pushTick(0, 0);
    expect(inst.getView().sampleCount).toBe(0);

    // 이후 매 틱이 직전 청크를 마감시킨다(chunkSeconds=1 → 1s 간격 틱마다 청크 1개 마감).
    for (let i = 1; i <= 7; i++) {
      inst.pushTick(i, i * 1000);
      expect(inst.getView().sampleCount).toBe(i);
    }
    expect(inst.getView().warmedUp).toBe(true);

    // 버퍼(7) 이후로는 링버퍼가 캡되어 더 늘지 않는다.
    inst.pushTick(8, 8000);
    expect(inst.getView().sampleCount).toBe(7);
  });

  it('⑪ pushQuote는 bid1/ask1/quoteCount를 뷰에 갱신하고, 유효하지 않은 값(0 이하)은 null로 남긴다', () => {
    const broker = new FakeBroker();
    const clock = fakeClock(1000);
    const deps: ScalperInstanceDeps = { broker, clock, scheduler: noopScheduler() };
    const inst = new ScalperInstance({ id: 'inst-1', ticker: 'AAPL', qty: 1 }, deps);

    expect(inst.getView().quoteCount).toBe(0);
    expect(inst.getView().bid1).toBeNull();
    expect(inst.getView().ask1).toBeNull();

    inst.pushQuote(99.9, 100.1, clock.now(), 500, 700);
    let view = inst.getView();
    expect(view.quoteCount).toBe(1);
    expect(view.bid1).toBe(99.9);
    expect(view.ask1).toBe(100.1);
    expect(view.bidVol1).toBe(500);
    expect(view.askVol1).toBe(700);
    expect(view.lastQuoteAt).toBe(1000);

    // 두 번째 수신 — 카운트가 누적되고, 유효하지 않은 값(0)은 null로 유지한다.
    clock.advance(200);
    inst.pushQuote(0, 100.2, clock.now());
    view = inst.getView();
    expect(view.quoteCount).toBe(2);
    expect(view.bid1).toBeNull();
    expect(view.ask1).toBe(100.2);
    expect(view.bidVol1).toBeUndefined(); // 이번 호출엔 잔량 인자를 넘기지 않음
  });

  it('⑫ previewOrderPrice는 resolveOrderPrice와 동일한 규칙(호가 신선도 10초)을 재현한다', () => {
    const broker = new FakeBroker();
    const clock = fakeClock(0);
    const deps: ScalperInstanceDeps = { broker, clock, scheduler: noopScheduler() };
    const inst = new ScalperInstance({ id: 'inst-1', ticker: 'AAPL', qty: 1 }, deps);

    // 호가가 없으면 아직 체결가(limitPrice)도 없어(0) 폴백값이 0이지만, fallback 플래그는 true다.
    expect(inst.previewOrderPrice('buy')).toEqual({ price: 0, fallback: true });

    inst.pushTick(100, 0); // limitPrice=100으로 갱신
    inst.pushQuote(99.9, 100.1, clock.now());
    expect(inst.previewOrderPrice('buy')).toEqual({ price: 100.1, fallback: false }); // 매도1호가
    expect(inst.previewOrderPrice('sell')).toEqual({ price: 99.9, fallback: false }); // 매수1호가

    clock.advance(11_000); // 호가 신선도(10초) 초과 → 폴백
    expect(inst.previewOrderPrice('buy')).toEqual({ price: 100, fallback: true });
    expect(inst.previewOrderPrice('sell')).toEqual({ price: 100, fallback: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 워밍업 게이트 회귀 — 버퍼(7)가 가득 차기 전 홀수 길이(5)에서 조기 판정/신호가 켜지지 않아야 한다.
// (isValidWindow는 5도 유효 창으로 보지만, pushTick은 resampler.warmedUp(버퍼 가득 참)으로 한 번 더 게이트한다.)
// ─────────────────────────────────────────────────────────────────────────────
describe('ScalperInstance — 워밍업 게이트(버퍼 가득 차기 전 조기 판정 금지)', () => {
  it('버퍼가 가득 차기 전(홀수 5개 시점)에는 신호·warmedUp이 발생하지 않고, 가득 찬 뒤에만 판정을 시작한다', () => {
    const broker = new FakeBroker();
    const clock = fakeClock(0);
    const deps: ScalperInstanceDeps = {
      broker,
      clock,
      scheduler: noopScheduler(),
      chunkSeconds: 1,
      bufferSize: 7,
      throttleMs: 0,
    };
    const inst = new ScalperInstance({ id: 'inst-1', ticker: 'AAPL', qty: 1 }, deps);
    inst.start();

    // 첫 틱은 청크를 여는 틱이라 아직 마감되지 않는다(core/resample 계약, 테스트 ⑩와 동일 패턴).
    inst.pushTick(20, 0);
    expect(inst.getView().sampleCount).toBe(0);

    // 이후 매 틱이 직전 청크를 마감한다. i=5 시점(홀수, 버퍼 7 중 5)에서는 아직 안 가득 찼다.
    for (let i = 1; i <= 5; i++) inst.pushTick(20 - i * 2, i * 1000);
    const midway = inst.getView();
    expect(midway.sampleCount).toBe(5);
    expect(midway.warmedUp).toBe(false); // isValidWindow는 5도 유효로 보지만, 버퍼가 안 가득 찼으니 판정 금지
    expect(midway.slope).toBeNull();
    expect(midway.accel).toBeNull();
    expect(midway.lastSignal).toBeNull();
    expect(inst.state).toBe('WATCH_BUY'); // 신호가 없으니 진입도 없다

    // 버퍼(7)를 가득 채우면 그제서야 판정이 시작된다.
    inst.pushTick(8, 6000);
    inst.pushTick(6, 7000);
    const filled = inst.getView();
    expect(filled.sampleCount).toBe(7);
    expect(filled.warmedUp).toBe(true);
    expect(filled.slope).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Run 시 버퍼 초기화 — 무조건 리셋 금지(실기기 제보 "데이터 모으는 중 0/31"). 신선하면 이어서 사용.
// ─────────────────────────────────────────────────────────────────────────────
describe('ScalperInstance — Run 시 버퍼 신선도 조건부 리셋', () => {
  function warmedInstance() {
    const broker = new FakeBroker();
    const clock = fakeClock(0);
    const deps: ScalperInstanceDeps = {
      broker,
      clock,
      scheduler: noopScheduler(),
      chunkSeconds: 1,
      bufferSize: 7,
      throttleMs: 0,
      bufferStaleMs: 30000,
    };
    const inst = new ScalperInstance({ id: 'inst-1', ticker: 'AAPL', qty: 1 }, deps);
    // 버퍼(7)를 가득 채운다 — 첫 틱은 청크를 여는 틱이라 마감 안 됨.
    inst.pushTick(20, 0);
    for (let i = 1; i <= 7; i++) inst.pushTick(20 - i, i * 1000);
    return { inst, clock };
  }

  it('신선한 버퍼(마지막 틱이 최근)면 Run 시 리셋하지 않고 이어서 쓴다', () => {
    const { inst, clock } = warmedInstance();
    expect(inst.getView().warmedUp).toBe(true);
    expect(inst.getView().sampleCount).toBe(7);

    // 마지막 틱 이후 5초만 지남(< 30초) → 신선.
    clock.advance(5000);
    inst.start();

    expect(inst.getView().warmedUp).toBe(true); // 유지 — 즉시 판정 가능
    expect(inst.getView().sampleCount).toBe(7);
    expect(inst.state).toBe('WATCH_BUY');
  });

  it('오래된 버퍼(마지막 틱이 오래 전)면 Run 시 리셋해 처음부터 워밍업한다', () => {
    const { inst, clock } = warmedInstance();
    expect(inst.getView().warmedUp).toBe(true);

    // 마지막 틱 이후 40초 지남(> 30초) → 끊겼던 데이터로 보고 리셋.
    clock.advance(40000);
    inst.start();

    expect(inst.getView().warmedUp).toBe(false);
    expect(inst.getView().sampleCount).toBe(0);
    expect(inst.state).toBe('WATCH_BUY');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 안전 인터록(FAULT) — 실계좌 3중 매수 사고 재현·방지. "죽은 체결확인으로는 절대 사지/취소하지 않는다".
// ─────────────────────────────────────────────────────────────────────────────
describe('ScalperInstance — 안전 인터록(FAULT)', () => {
  it('① [사고 재현] 체결확인이 죽어 있으면 BUY 신호에도 발주하지 않고 FAULT (프리플라이트)', async () => {
    const { inst, broker } = makeInstance({ autoFill: true });
    broker.failFetchFills = true; // 주문체결내역 APTR0058 상시 거절
    inst.start();

    await replayWithPoll(inst, V); // V자 → BUY 변곡점 발생

    expect(broker.placed).toHaveLength(0); // 주문 fetch 0회 — 아예 사지 않는다
    expect(inst.state).toBe('FAULT');
    expect(inst.getView().lastFault?.text).toMatch(/체결 확인이 안 돼요/);
  });

  it('② 발주 성공 후 체결확인이 죽으면 타임아웃이 지나도 cancel 0회 + FAULT', async () => {
    const { inst, broker, clock } = makeInstance({ autoFill: false });
    inst.start();
    await replayWithPoll(inst, V); // 프리플라이트 통과 → BUY 발주, 미체결로 BUYING
    expect(inst.state).toBe('BUYING');
    expect(broker.placed.filter((p) => p.side === 'buy')).toHaveLength(1);

    broker.failFetchFills = true; // 이제 체결확인 장애
    clock.advance(6000); // 미체결 취소 타임아웃 경과
    await flush();
    await inst.pollCycle();
    await flush();

    expect(broker.canceled).toHaveLength(0); // 타임아웃이어도 취소하지 않는다(확인 불가)
    expect(inst.state).toBe('FAULT');
    expect(inst.getView().lastFault?.text).toMatch(/체결 확인이 안 돼요/);
  });

  it('③ Stop 시 취소가 거절되면 FAULT(새 문구)로 승격하고 재주문하지 않는다', async () => {
    const { inst, broker } = makeInstance({ autoFill: false });
    broker.failCancel = true; // 취소 거절(미체결 주문이 계좌에 남아있을 수 있음)
    inst.start();
    await replayWithPoll(inst, V);
    expect(inst.state).toBe('BUYING');

    // 미체결 상태에서 사용자 Stop → 유일한 취소 경로가 발동한다(자동 타임아웃 취소는 없음).
    inst.stop();
    await flush(); // async 취소 거절이 정착(cancelState='rejected')
    await inst.pollCycle(); // 취소 거절 + 체결 미확인 → CANCEL FAULT로 승격
    await flush();

    expect(broker.canceled).toHaveLength(0); // 거절돼 실제 취소는 안 됨
    expect(inst.state).toBe('FAULT');
    expect(inst.getView().lastFault?.text).toMatch(/취소가 안 됐어요/);
    expect(inst.getView().lastFault?.text).toMatch(/미체결 주문이 계좌에 남아있을 수 있어요/);

    const buysBefore = broker.placed.filter((p) => p.side === 'buy').length;
    await replayWithPoll(inst, V); // 이후 BUY 신호가 와도
    expect(broker.placed.filter((p) => p.side === 'buy').length).toBe(buysBefore); // 재주문 없음
  });

  it('④ 발주 자체가 실패하면 조용히 삼키지 않고 FAULT로 노출한다', async () => {
    const { inst, broker } = makeInstance({ autoFill: false });
    broker.failPlaceOrder = true; // 주문 API throw
    inst.start();

    await replayWithPoll(inst, V); // 프리플라이트는 통과(fetchFills 정상), 발주에서 throw

    expect(broker.placed).toHaveLength(0);
    expect(inst.state).toBe('FAULT');
    expect(inst.getView().lastFault?.text).toMatch(/주문을 넣지 못했어요/);
  });

  it('⑤ FAULT 상태에서는 이후 신호가 와도(브로커가 회복돼도) 주문하지 않는다', async () => {
    const { inst, broker } = makeInstance({ autoFill: true });
    broker.failFetchFills = true;
    inst.start();
    await replayWithPoll(inst, V);
    expect(inst.state).toBe('FAULT');

    broker.failFetchFills = false; // 브로커가 회복해도 자동 해제되지 않는다
    await replayWithPoll(inst, V);

    expect(broker.placed).toHaveLength(0);
    expect(inst.state).toBe('FAULT'); // 사용자 Stop 전까지 동결 유지
  });

  it('⑥ Stop 후 다시 Run하면 체결확인 정상 시 정상 사이클을 재개한다', async () => {
    const { inst, broker, clock } = makeInstance({ autoFill: true });
    broker.failFetchFills = true;
    inst.start();
    await replayWithPoll(inst, V);
    expect(inst.state).toBe('FAULT');

    // 사용자 개입: Stop → 인터록 해제(추가 주문 없이 종료)
    inst.stop();
    expect(inst.state).toBe('DONE');
    expect(inst.getView().lastFault).toBeNull();

    // 체결확인 회복 후 Run → 프리플라이트 통과 → 정상 진입.
    // (정지 후 시간이 흘렀으므로 버퍼는 오래돼 리셋되고 처음부터 워밍업한다 — 신선도 게이트 반영.)
    broker.failFetchFills = false;
    clock.advance(40000);
    inst.start();
    expect(inst.state).toBe('WATCH_BUY');
    await replayWithPoll(inst, V);

    expect(inst.state).toBe('HOLDING');
    expect(broker.placed.filter((p) => p.side === 'buy')).toHaveLength(1);
  });

  it('정상 경로 회귀 — 체결확인이 살아 있으면 프리플라이트를 통과해 기존처럼 진입한다', async () => {
    const { inst, broker } = makeInstance({ autoFill: true });
    inst.start();
    await replayWithPoll(inst, V);
    expect(inst.state).toBe('HOLDING');
    expect(inst.getView().lastFault).toBeNull();
    expect(broker.placed.filter((p) => p.side === 'buy')).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 오토런 — 사이클 자연 완료(SELL_SIGNAL) 시 손익에 따라 수량 조정 후 자동 재시작.
// STOP·FAULT는 재시작 금지. 수량 상한은 없다(무제한 재시작 — 사용자 결정).
// ─────────────────────────────────────────────────────────────────────────────
describe('nextAutoRunQty — 오토런 수량 판정(순수 함수)', () => {
  it('벌었으면 절반(반올림), 최소 1', () => {
    expect(nextAutoRunQty(4, 10)).toBe(2);
    expect(nextAutoRunQty(3, 10)).toBe(2); // round(1.5)=2
    expect(nextAutoRunQty(1, 10)).toBe(1); // max(1, round(0.5))=1
    expect(nextAutoRunQty(2, 0.0001)).toBe(1);
  });
  it('잃었거나 본전이면 2배', () => {
    expect(nextAutoRunQty(2, -5)).toBe(4);
    expect(nextAutoRunQty(3, 0)).toBe(6); // pnl<=0 포함
    expect(nextAutoRunQty(60, -1)).toBe(120);
  });
});

describe('ScalperInstance — 오토런(자동 재시작)', () => {
  interface AutoHarness {
    inst: ScalperInstance;
    broker: FakeBroker;
    trades: TradeRecord[];
    notes: Array<{ note: AutoRunNote; qty: number }>;
  }
  function makeAuto(opts: { qty: number; autoRun?: boolean }): AutoHarness {
    const broker = new FakeBroker({ autoFill: false });
    const clock = fakeClock(1000);
    const trades: TradeRecord[] = [];
    const notes: Array<{ note: AutoRunNote; qty: number }> = [];
    const deps: ScalperInstanceDeps = {
      broker,
      clock,
      scheduler: noopScheduler(),
      chunkSeconds: 1,
      bufferSize: 7,
      throttleMs: 0,
      // 오토런 메커닉 검증 — 짧은 역V(DOWN_UP_DOWN)에서 "전환 즉시 매도"를 가정하므로 매도 문턱 0(끔)을 명시한다.
      minSellMomentum: 0,
      onTrade: (_id, rec) => trades.push(rec),
      onAutoRun: (_id, note, qty) => notes.push({ note, qty }),
    };
    const inst = new ScalperInstance(
      { id: 'inst-1', ticker: 'AAPL', qty: opts.qty, autoRun: opts.autoRun },
      deps,
    );
    return { inst, broker, trades, notes };
  }

  /** 자연 완료 사이클 1회 — 진입/청산 체결가를 명시해 손익 부호를 통제한다. */
  async function runNaturalCycle(
    inst: ScalperInstance,
    broker: FakeBroker,
    entryPrice: number,
    exitPrice: number,
  ): Promise<void> {
    const filled = new Set<string>();
    let ts = 0;
    let soldThisCycle = false;
    for (const p of DOWN_UP_DOWN) {
      inst.pushTick(p, ts);
      ts += 1000;
      await flush();
      for (const o of broker.placed) {
        if (filled.has(o.odno)) continue;
        if (o.side === 'buy') {
          broker.fill(o.odno, entryPrice);
          filled.add(o.odno);
        } else {
          broker.fill(o.odno, exitPrice);
          filled.add(o.odno);
          soldThisCycle = true;
        }
      }
      await inst.pollCycle();
      await flush();
      if (soldThisCycle) break; // 한 사이클만 완주(그다음 오토런 재시작은 상태로 검증).
    }
  }

  it('이익 후 절반(반올림)으로 자동 재시작한다', async () => {
    const { inst, broker, trades, notes } = makeAuto({ qty: 4 });
    inst.start();
    await runNaturalCycle(inst, broker, 4, 9); // 진입 4 · 청산 9 → 이익

    expect(trades).toHaveLength(1);
    expect(trades[0].pnl).toBeGreaterThan(0);
    expect(inst.qty).toBe(2); // 4 → round(4/2)=2
    expect(inst.state).toBe('WATCH_BUY'); // 자동 재시작
    expect(notes.at(-1)?.note.kind).toBe('restarted');
    expect(notes.at(-1)?.note.text).toContain('2주');
  });

  it('손실 후 2배로 자동 재시작한다', async () => {
    const { inst, broker, trades } = makeAuto({ qty: 3 });
    inst.start();
    await runNaturalCycle(inst, broker, 9, 4); // 진입 9 · 청산 4 → 손실

    expect(trades[0].pnl).toBeLessThan(0);
    expect(inst.qty).toBe(6); // 3 → 6
    expect(inst.state).toBe('WATCH_BUY');
  });

  it('이익이어도 1 미만으로 내려가지 않는다', async () => {
    const { inst, broker } = makeAuto({ qty: 1 });
    inst.start();
    await runNaturalCycle(inst, broker, 4, 9); // 이익

    expect(inst.qty).toBe(1); // max(1, round(0.5))=1
    expect(inst.state).toBe('WATCH_BUY');
  });

  it('Stop으로 끝난(exitReason STOP) 경우엔 재시작하지 않는다', async () => {
    const { inst, broker, trades, notes } = makeAuto({ qty: 2 });
    inst.start();
    // 진입까지 몰아 HOLDING을 만든 뒤 Stop → 전량 매도(STOP)로 종료.
    let ts = 0;
    for (const p of V) {
      inst.pushTick(p, ts);
      ts += 1000;
      await flush();
      await inst.pollCycle();
      await flush();
      if (inst.state === 'BUYING') {
        broker.fill(broker.placed[0].odno, 5);
        await inst.pollCycle();
        await flush();
      }
      if (inst.state === 'HOLDING') break;
    }
    expect(inst.state).toBe('HOLDING');

    inst.stop(); // SELLING(STOP)
    await flush();
    const sellOdno = broker.placed.find((o) => o.side === 'sell')!.odno;
    broker.fill(sellOdno, 6);
    await inst.pollCycle();
    await flush();

    expect(trades).toHaveLength(1);
    expect(trades[0].exitReason).toBe('STOP');
    expect(inst.state).toBe('DONE'); // 재시작 안 함
    expect(notes).toHaveLength(0);
  });

  it('autoRun=false면 자연 완료여도 재시작하지 않는다', async () => {
    const { inst, broker, trades, notes } = makeAuto({ qty: 4, autoRun: false });
    inst.start();
    await runNaturalCycle(inst, broker, 4, 9); // 이익

    expect(trades).toHaveLength(1);
    expect(trades[0].exitReason).toBe('SELL_SIGNAL');
    expect(inst.state).toBe('DONE');
    expect(inst.qty).toBe(4); // 수량 변화 없음
    expect(notes).toHaveLength(0);
  });

  it('수량 상한이 없다 — 손실이 이어져 100주를 넘겨도 계속 배증 재시작한다(64→128)', async () => {
    const { inst, broker, notes } = makeAuto({ qty: 64 });
    inst.start();
    await runNaturalCycle(inst, broker, 9, 4); // 손실 → 64*2=128 (>100이어도 중지 없음)

    expect(inst.qty).toBe(128); // 상한 없이 그대로 배증 적용
    expect(inst.state).toBe('WATCH_BUY'); // 자동 재시작(중지하지 않음)
    expect(notes.at(-1)?.note.kind).toBe('restarted');
    expect(notes.at(-1)?.note.text).toContain('128주');
  });

  it('setAutoRun(false)는 실행 중에도 다음 완료 시 재시작을 막는다', async () => {
    const { inst, broker, notes } = makeAuto({ qty: 4 });
    inst.start();
    inst.setAutoRun(false); // 실행 중 토글
    await runNaturalCycle(inst, broker, 4, 9);

    expect(inst.state).toBe('DONE');
    expect(notes).toHaveLength(0);
    expect(inst.getView().autoRun).toBe(false);
  });
});

describe('ScalperInstance — BUY 게이트(거래량 스파이크·체결강도)', () => {
  /** 가격+extras를 초당 1틱으로 흘린다(replayWithPoll의 extras 버전). */
  async function replayWithExtras(
    inst: ScalperInstance,
    prices: number[],
    extrasAt: (i: number) => { volume?: number; strength?: number } | undefined,
    stepMs = 1000,
  ): Promise<void> {
    for (let i = 0; i < prices.length; i++) {
      inst.pushTick(prices[i], i * stepMs, extrasAt(i));
      await flush();
      await inst.pollCycle();
      await flush();
    }
    inst.pushTick(prices[prices.length - 1], prices.length * stepMs, extrasAt(prices.length));
    await flush();
    await inst.pollCycle();
    await flush();
  }

  it('거래량이 평평하면(스파이크 없음) 매수하지 않고, 게이트 배지(buyGateBlocked)가 관찰된다', async () => {
    const { inst, broker } = makeInstance({
      autoFill: true,
      extraDeps: { minBuyMomentum: 0, minVolumeSpikeRatio: 1.5 },
    });
    inst.start();
    let sawBlocked = false;
    const unsub = inst.subscribe((v) => {
      if (v.buyGateBlocked) sawBlocked = true;
    });
    await replayWithExtras(inst, V, () => ({ volume: 10 }));
    unsub();
    expect(broker.placed.filter((p) => p.side === 'buy')).toHaveLength(0);
    expect(sawBlocked).toBe(true);
  });

  it('변곡 부근에서 거래량이 터지면(스파이크) 매수한다', async () => {
    const { inst, broker } = makeInstance({
      autoFill: true,
      extraDeps: { minBuyMomentum: 0, minVolumeSpikeRatio: 1.5 },
    });
    inst.start();
    // 상승 구간(틱 8 이후)에 평소(10)의 10배 거래량 — 게이트 통과.
    await replayWithExtras(inst, V, (i) => ({ volume: i >= 8 ? 100 : 10 }));
    expect(broker.placed.filter((p) => p.side === 'buy')).toHaveLength(1);
  });

  it('체결강도 미달이면 매수하지 않고, 문턱 이상이면 매수한다', async () => {
    const weak = makeInstance({ autoFill: true, extraDeps: { minBuyMomentum: 0, minStrength: 100 } });
    weak.inst.start();
    await replayWithExtras(weak.inst, V, () => ({ strength: 80 }));
    expect(weak.broker.placed.filter((p) => p.side === 'buy')).toHaveLength(0);

    const strong = makeInstance({ autoFill: true, extraDeps: { minBuyMomentum: 0, minStrength: 100 } });
    strong.inst.start();
    await replayWithExtras(strong.inst, V, () => ({ strength: 130 }));
    expect(strong.broker.placed.filter((p) => p.side === 'buy')).toHaveLength(1);
  });

  it('게이트를 켜도 extras가 없으면(fail-open) 기존처럼 매수한다', async () => {
    const { inst, broker } = makeInstance({
      autoFill: true,
      extraDeps: { minBuyMomentum: 0, minVolumeSpikeRatio: 1.5, minStrength: 100 },
    });
    inst.start();
    await replayWithExtras(inst, V, () => undefined);
    expect(broker.placed.filter((p) => p.side === 'buy')).toHaveLength(1);
  });
});

describe('ScalperInstance — 매도 리프라이스 타이머', () => {
  /** BUY→체결→SELL 까지 몰아 SELLING 상태를 만든다. */
  async function toSelling(h: Harness): Promise<void> {
    h.inst.start();
    let ts = 0;
    for (const p of DOWN_UP_DOWN) {
      h.inst.pushTick(p, ts);
      ts += 1000;
      await flush();
      await h.inst.pollCycle();
      await flush();
      if (h.inst.state === 'BUYING') {
        h.broker.fill(h.broker.placed[0].odno, 4);
        await h.inst.pollCycle();
        await flush();
      }
      if (h.inst.state === 'SELLING') break;
    }
    expect(h.inst.state).toBe('SELLING');
  }

  /** 리프라이스 타이머 콜백 1회 발화(fired[1] — 폴 타이머 다음에 등록된다). */
  const tick = async (h: Harness) => {
    h.scheduler.fired[1]?.();
    await flush();
  };

  it('① SELLING 중 매수1호가가 바뀌면 정정이 나간다', async () => {
    const h = makeInstance({ autoFill: false });
    await toSelling(h);

    h.inst.pushQuote(3.9, 4.1, h.clock.now());
    await tick(h);
    expect(h.broker.amended).toHaveLength(1);
    expect(h.broker.amended[0].price).toBe(3.9);
  });

  it('② 매수1호가가 그대로면 정정을 내지 않는다 (유량 절감)', async () => {
    const h = makeInstance({ autoFill: false });
    await toSelling(h);

    h.inst.pushQuote(3.9, 4.1, h.clock.now());
    await tick(h);
    expect(h.broker.amended).toHaveLength(1);

    // 같은 호가로 여러 번 틱해도 추가 호출이 없다.
    for (let i = 0; i < 5; i++) {
      h.inst.pushQuote(3.9, 4.1, h.clock.now());
      await tick(h);
    }
    expect(h.broker.amended).toHaveLength(1);
  });

  it('③ 리프라이스를 해도 매도를 취소하지 않는다(무한 대기 정책 유지)', async () => {
    const h = makeInstance({ autoFill: false });
    await toSelling(h);
    for (const bid of [3.9, 3.8, 3.7]) {
      h.inst.pushQuote(bid, bid + 0.2, h.clock.now());
      await tick(h);
    }
    expect(h.broker.canceled).toHaveLength(0);
    expect(h.inst.state).toBe('SELLING');
  });

  it('④ 정정을 따라간 끝에 체결되면 정상 DONE + 거래 기록', async () => {
    const h = makeInstance({ autoFill: false });
    await toSelling(h);

    h.inst.pushQuote(3.9, 4.1, h.clock.now());
    await tick(h);
    const liveOdno = h.broker.amended[0].to;

    h.broker.fill(liveOdno, 3.9);
    await h.inst.pollCycle();
    await flush();

    expect(h.inst.state).toBe('DONE');
    expect(h.trades).toHaveLength(1);
    expect(h.trades[0].rec.exitPrice).toBe(3.9);
  });

  it('⑤ SELLING이 아닌 상태에서는 아무 것도 하지 않는다', async () => {
    const h = makeInstance({ autoFill: false });
    h.inst.start(); // WATCH_BUY
    h.inst.pushQuote(3.9, 4.1, h.clock.now());
    await tick(h);
    expect(h.broker.amended).toHaveLength(0);
  });

  it('⑥ FAULT면 리프라이스가 멈춘다', async () => {
    const h = makeInstance({ autoFill: false });
    await toSelling(h);

    h.broker.failFetchFills = true; // 체결 확인 실패 → FAULT
    await h.inst.pollCycle();
    await flush();
    expect(h.inst.getView().lastFault).not.toBeNull();

    h.inst.pushQuote(3.9, 4.1, h.clock.now());
    await tick(h);
    expect(h.broker.amended).toHaveLength(0);
  });

  it('⑦ 사용자 Stop 이후에도 SELLING이면 계속 따라간다(그 매도가 곧 청산)', async () => {
    const h = makeInstance({ autoFill: false });
    await toSelling(h);

    h.inst.stop();
    await flush();
    expect(h.inst.state).toBe('SELLING'); // 매도는 취소하지 않는다

    h.inst.pushQuote(3.9, 4.1, h.clock.now());
    await tick(h);
    expect(h.broker.amended).toHaveLength(1);
  });
});

describe('ScalperInstance — 실비용 손익', () => {
  it('① [사고 재현] 수동 정지(STOP) 청산의 손익이 0으로 기록되지 않는다', async () => {
    const h = makeInstance({ autoFill: false });
    // 호가를 주입해 발주가가 호가 기준(매수=ask1, 매도=bid1)으로 결정되게 한다.
    h.inst.pushQuote(3.9, 4.1, h.clock.now());
    h.inst.start();

    // V자를 흘려 매수 발주 → 손으로 체결시켜 HOLDING.
    let ts = 0;
    for (const p of V) {
      h.inst.pushTick(p, ts);
      ts += 1000;
      await flush();
      await h.inst.pollCycle();
      await flush();
      if (h.inst.state === 'BUYING') {
        const buy = h.broker.placed.find((o) => o.side === 'buy')!;
        h.broker.fill(buy.odno, buy.price);
        await h.inst.pollCycle();
        await flush();
      }
    }
    expect(h.inst.state).toBe('HOLDING');

    // 사용자 Stop → 전량 매도. 이 매도는 pendingSnapshot이 null이다.
    h.inst.pushQuote(3.9, 4.1, h.clock.now());
    h.inst.stop();
    await flush();
    expect(h.inst.state).toBe('SELLING');

    // 실물처럼 "미체결 목록에서 사라져 전량체결로 추론"되는 경로를 재현한다 —
    // 브로커가 체결가를 주지 않으므로 filledPrice가 null이 된다.
    const sell = h.broker.placed.find((o) => o.side === 'sell')!;
    h.broker.fillWithoutPrice(sell.odno);
    await h.inst.pollCycle();
    await flush();

    expect(h.inst.state).toBe('DONE');
    expect(h.trades).toHaveLength(1);
    const rec = h.trades[0].rec;
    expect(rec.exitReason).toBe('STOP');
    // 체결가가 없어도 실제 발주가(매수1호가 3.9)가 청산가로 남아야 한다.
    expect(rec.exitPrice).toBe(3.9);
    expect(rec.pnl).not.toBe(0);
  });
});

describe('ScalperInstance — 수수료 반영 시 행동 변화', () => {
  it('② 수수료를 켜면 본전 사이클이 손실로 분류돼 다음 수량이 2배가 된다', async () => {
    // ⚠ 행동 변화 고정 — 수수료를 켜면 "본전(pnl=0)"이 사실상 사라져 마틴게일이 훨씬 자주 2배로 간다.
    const broker = new FakeBroker({ autoFill: true });
    const clock = fakeClock(1000);
    const trades: Array<{ id: string; rec: TradeRecord }> = [];
    const notes: Array<{ note: AutoRunNote; qty: number }> = [];
    const inst = new ScalperInstance(
      { id: 'inst-1', ticker: 'AAPL', qty: 4, autoRun: true },
      {
        broker,
        clock,
        scheduler: noopScheduler(),
        chunkSeconds: 1,
        bufferSize: 7,
        throttleMs: 0,
        minSellMomentum: 0,
        feeRate: 0.0025,
        onTrade: (id, rec) => trades.push({ id, rec }),
        onAutoRun: (_id, note, qty) => notes.push({ note, qty }),
      },
    );
    // 매수1호가·매도1호가를 같은 값으로 둬 진입가 = 청산가(총손익 0)를 만든다.
    inst.pushQuote(10, 10, clock.now());
    inst.start();
    await replayWithPoll(inst, DOWN_UP_DOWN);

    expect(trades).toHaveLength(1);
    const rec = trades[0].rec;
    expect(rec.grossPnl).toBe(0);
    expect(rec.pnl).toBeLessThan(0); // 수수료 때문에 손실로 분류된다
    expect(notes[0].qty).toBe(8); // 손실 → 수량 2배
  });
});
