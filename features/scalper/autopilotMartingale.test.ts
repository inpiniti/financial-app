// 5선 물타기 단타 모드 배선(2026-09-02 ADR 0010) — ① 5선 상승·돌파 봉에서 진입(정배열·4선 상승 조건 없음)
// ② 보유 중 같은 돌파는 물타기 후보로 규칙에 넘어가 낙폭(−3%~)에 따라 보유량 ×(k−1) 매수 ③ 추격 게이트 없음 + 매수 미체결은 매도1호가 추종.
import { describe, expect, it } from 'vitest';

import type { TradeRecord } from '../../core/cycle';
import { AutoPilot, type AutoPilotConfig, type AutoPilotDeps, MARTINGALE_POSITION_CONFIG, MODEL_CONFIG } from './autopilot';
import { FeedSlot } from './feedSlot';
import { FakeBroker, FakeStore, fakeClock, flush, noopScheduler } from './fakes';

const M = 60_000;
/** 2026-08-27 10:00 ET(EDT) — 정규장. 시드는 이 분 직전 122봉. */
const BASE = Math.floor(Date.UTC(2026, 7, 27, 14, 0) / M);
const CONFIG: AutoPilotConfig = { startAmountUsd: 10_000, minTickRate: 0.01 };

/** 꾸준히 오르는 122봉, 마지막 봉만 5선 아래로 눌림(218 < ma5 218.4) — 다음 봉이 5선 위로 오르면 "아래→위 돌파"가 된다. */
const risingSeed = () =>
  Array.from({ length: 122 }, (_, i) => ({ minuteKey: BASE - 122 + i, close: 100 + i - (i === 121 ? 3 : 0) }));

function makeHarness(opts: { autoFill?: boolean } = {}) {
  const clock = fakeClock(BASE * M);
  const slots = new Map([['A', new FeedSlot({ ticker: 'A', clock, martingale: true, model: true })]]);
  const brokers = new Map<string, FakeBroker>();
  const trades: TradeRecord[] = [];
  const events: string[] = [];
  const scheduler = noopScheduler();
  const pilot = new AutoPilot({
    slots: () => [...slots.values()],
    pin: () => {},
    unpin: () => {},
    makeBroker: (t) => {
      const b = new FakeBroker({ autoFill: opts.autoFill ?? true });
      brokers.set(t, b);
      return b;
    },
    positionManagement: { model: MODEL_CONFIG, martingale: MARTINGALE_POSITION_CONFIG },
    clock,
    scheduler,
    storage: new FakeStore(),
    onTrade: (r) => trades.push(r),
    onEvent: (e) => events.push(e.text),
  } satisfies AutoPilotDeps);
  pilot.setConfig(CONFIG);
  return { pilot, slots, brokers, clock, trades, events, scheduler };
}
type Harness = ReturnType<typeof makeHarness>;

/**
 * 분 키 `minute`의 첫 틱(직전 분 봉이 닫힌다) + 5초 뒤 같은 가격의 두 번째 틱(진행 중 봉 실시간 판정) + 재선정·체결 폴 2회(진입 → 인계).
 * 첫 틱은 봉 마감 판정만 돌고 실시간 판정은 다음 틱부터라(feedSlot), 두 번째 틱이 있어야 "이 분의 가격"으로 돌파를 잰다.
 */
async function tick(h: Harness, price: number, minute: number): Promise<void> {
  // 시계를 먼저 그 분으로 — 틱/초 미터는 clock 기준이라, 시계를 뒤에 옮기면 속도 창이 비어 속도 게이트에 걸린다.
  h.clock.set(minute * M);
  h.slots.get('A')!.pushTick(price, minute * M);
  h.pilot.reselect();
  h.clock.advance(5_000);
  h.slots.get('A')!.pushTick(price, minute * M + 5_000);
  h.clock.advance(1000);
  await flush();
  await h.pilot.pollCycle();
  await flush();
  await h.pilot.pollCycle();
  await flush();
}

async function fireTimers(h: Harness): Promise<void> {
  for (const fn of h.scheduler.fired) fn();
  await flush();
  await flush();
}

describe('5선 물타기 단타 모드 — 진입', () => {
  it('5선 아래로 눌렸다가 위로 뚫는 봉에 산다 — 추격 게이트도 없다', async () => {
    const h = makeHarness();
    h.slots.get('A')!.seedTrend(risingSeed());
    h.pilot.start();
    h.slots.get('A')!.pushQuote(221, 230); // ask1이 +3% 위 — 추세 모드였다면 게이트에 걸렸다
    await tick(h, 216, BASE); // 시드 마지막 봉(218)에 이어 여전히 5선 아래 — 신호 없음, 후보 선정만
    expect(h.pilot.getView().activeTickers).toEqual([]);
    await tick(h, 230, BASE + 1); // 키 BASE 닫힘(216) · 새 봉 230 = 5선 위로 돌파 + 5선 상승 → 진입
    expect(h.pilot.getView().activeTickers).toEqual(['A']);
    expect(h.brokers.get('A')!.placed[0]).toMatchObject({ side: 'buy' });
    expect(h.events.some((e) => e.includes('추격 상한'))).toBe(false);
    expect(h.events.some((e) => e.includes('5선 물타기 관리 인계'))).toBe(true);
  });

  it('봉 마감 없이도 진행 중 봉 돌파에서 실시간으로 진입한다(2026-09-01)', async () => {
    const h = makeHarness();
    h.slots.get('A')!.seedTrend(risingSeed());
    h.pilot.start();
    await tick(h, 216, BASE); // 5선 아래 — 신호 없음, 후보 선정만 된다
    expect(h.pilot.getView().activeTickers).toEqual([]);
    // 같은 봉 안에서 5선 위로 돌파 — 봉이 닫히지 않았는데 실시간 판정(1초 스로틀)이 진입을 낸다.
    h.clock.advance(2_000);
    h.slots.get('A')!.pushTick(230, BASE * M + 30_000); // 직전 닫힌 봉(시드 218)이 5선 아래였으니 230은 돌파다
    await flush();
    await h.pilot.pollCycle();
    await flush();
    await h.pilot.pollCycle();
    await flush();
    expect(h.pilot.getView().activeTickers).toEqual(['A']);
    expect(h.brokers.get('A')!.placed[0]).toMatchObject({ side: 'buy' });
  });

  it('보유 중 평단 −4% 아래에서 5선 돌파가 오면 보유량 ×3 물타기 — 손절 없이 버틴다', async () => {
    const h = makeHarness();
    h.slots.get('A')!.seedTrend(risingSeed());
    h.pilot.start();
    await tick(h, 216, BASE); // 5선 아래 눌림
    await tick(h, 230, BASE + 1); // 돌파 → 진입 @230
    expect(h.pilot.getView().activeTickers).toEqual(['A']);
    const broker = h.brokers.get('A')!;
    expect(broker.placed).toHaveLength(1);
    const qty0 = broker.placed[0].qty;
    broker.position = { qty: qty0, avgPrice: 230 }; // 체결 뒤 잔고 — FakeBroker는 자동 체결해도 잔고를 채우지 않는다(수동 청산 오판 방지).
    // 급락: 평단 230 대비 −4% 아래(220.8)로 몇 분치 봉을 내려 5선을 끌어내린 뒤, 다시 5선을 위로 뚫는다.
    await tick(h, 215, BASE + 2);
    await tick(h, 212, BASE + 3);
    await tick(h, 210, BASE + 4);
    await tick(h, 208, BASE + 5);
    await tick(h, 207, BASE + 6);
    await tick(h, 206, BASE + 7);
    expect(broker.placed).toHaveLength(1); // 손절 없음 — 내려가도 팔지 않는다
    await tick(h, 218, BASE + 8); // 5선(≈208.6) 위로 돌파 + 5선 상승 · 평단 대비 −5.2% → k=5 → 보유량 ×4
    await flush();
    expect(broker.placed).toHaveLength(2);
    expect(broker.placed[1]).toMatchObject({ side: 'buy', qty: qty0 * 4 });
    expect(h.trades).toHaveLength(0); // 손절·정산 없음
    expect(h.pilot.getView().activeTickers).toEqual(['A']); // 여전히 보유·관리 중
  });

  it('청산 뒤 같은 날 다시 돌파가 오면 재진입한다(당일 재진입 게이트 없음)', async () => {
    const h = makeHarness();
    h.slots.get('A')!.seedTrend(risingSeed());
    h.pilot.start();
    await tick(h, 216, BASE);
    await tick(h, 230, BASE + 1); // 진입
    expect(h.pilot.getView().activeTickers).toEqual(['A']);
    expect(h.pilot.sellNow('A')).toBeNull();
    await flush();
    await h.pilot.pollCycle();
    await flush();
    expect(h.pilot.getView().activeTickers).toEqual([]);
    expect(h.trades).toHaveLength(1);
    // 분을 +12부터 잇는다 — 드랍 로그 스로틀 창(10분)과 무관하게 신호 처리만 본다.
    await tick(h, 231, BASE + 12); // 5선 위 지속 — 돌파 아님
    await tick(h, 200, BASE + 13); // 5선 아래
    await tick(h, 199, BASE + 14);
    await tick(h, 240, BASE + 15); // 돌파 → 재진입
    expect(h.pilot.getView().activeTickers).toEqual(['A']);
  });

  it('매수 미체결이면 매도1호가로 정정해 따라간다(리프라이스 틱)', async () => {
    const h = makeHarness({ autoFill: false });
    h.slots.get('A')!.seedTrend(risingSeed());
    h.pilot.start();
    await tick(h, 216, BASE);
    await tick(h, 230, BASE + 1); // 돌파 → 진입 발주(미체결)
    const broker = h.brokers.get('A')!;
    expect(broker.placed).toHaveLength(1);
    expect(broker.placed[0].side).toBe('buy');
    // 가격이 위로 달아났다 — 매도1호가 236. 리프라이스 틱이 매수 주문(230)을 236으로 정정한다.
    h.slots.get('A')!.pushQuote(235, 236); // 신선한 호가(10초 이내)여야 정정한다
    h.clock.advance(2_000);
    await fireTimers(h);
    expect(broker.amended.length).toBeGreaterThanOrEqual(1);
    expect(broker.amended.at(-1)!.price).toBe(236);
  });
});
