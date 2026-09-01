// ±3% 단타 모드 배선(2026-08-28, 2026-09-01 물타기 제거) — ① 처음 보는 종목은 조건(정배열·4선 상승·5선 위)만 맞으면 이벤트 없이 진입
// ② 당일 매매한 종목은 조건만으로는 재진입하지 않고 이벤트(5선 돌파 등)에서만 ③ 추격 게이트 없음 + 매수 미체결은 매도1호가 추종.
import { describe, expect, it } from 'vitest';

import type { TradeRecord } from '../../core/cycle';
import { AutoPilot, type AutoPilotConfig, type AutoPilotDeps, MARTINGALE_POSITION_CONFIG, MODEL_CONFIG } from './autopilot';
import { FeedSlot } from './feedSlot';
import { FakeBroker, FakeStore, fakeClock, flush, noopScheduler } from './fakes';

const M = 60_000;
/** 2026-08-27 10:00 ET(EDT) — 정규장. 시드는 이 분 직전 122봉. */
const BASE = Math.floor(Date.UTC(2026, 7, 27, 14, 0) / M);
const CONFIG: AutoPilotConfig = { startAmountUsd: 10_000, minTickRate: 0.01 };

/** 꾸준히 오르는 122봉 — 정배열·4선 상승·종가>5선(조건 충족 상태). */
const risingSeed = () => Array.from({ length: 122 }, (_, i) => ({ minuteKey: BASE - 122 + i, close: 100 + i }));

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

/** 분 키 `minute`의 첫 틱(직전 분 봉이 닫힌다) + 재선정·체결 폴 2회(진입 → 인계). */
async function tick(h: Harness, price: number, minute: number): Promise<void> {
  // 시계를 먼저 그 분으로 — 틱/초 미터는 clock 기준이라, 시계를 뒤에 옮기면 속도 창이 비어 속도 게이트에 걸린다.
  h.clock.set(minute * M);
  h.slots.get('A')!.pushTick(price, minute * M);
  h.pilot.reselect();
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

describe('±3% 단타 모드 — 진입', () => {
  it('처음 보는 종목은 조건만 맞으면(이벤트 없는 봉) 바로 산다 — 추격 게이트도 없다', async () => {
    const h = makeHarness();
    h.slots.get('A')!.seedTrend(risingSeed());
    h.pilot.start();
    h.slots.get('A')!.pushQuote(221, 230); // ask1이 +3% 위 — 추세 모드였다면 게이트에 걸렸다
    await tick(h, 222, BASE); // 진행 중 봉 — 신호 없음
    expect(h.pilot.getView().activeTickers).toEqual([]);
    await tick(h, 223, BASE + 1); // 키 BASE 닫힘(222) — 조건 충족(이벤트 없음) → 진입
    expect(h.pilot.getView().activeTickers).toEqual(['A']);
    expect(h.brokers.get('A')!.placed[0]).toMatchObject({ side: 'buy' });
    expect(h.events.some((e) => e.includes('추격 상한'))).toBe(false);
    expect(h.events.some((e) => e.includes('±3% 관리 인계'))).toBe(true);
  });

  it('봉 마감 없이도 진행 중 봉 돌파에서 실시간으로 진입한다(2026-09-01)', async () => {
    const h = makeHarness();
    h.slots.get('A')!.seedTrend(risingSeed());
    h.pilot.start();
    await tick(h, 216, BASE); // 5선 아래 — 신호 없음, 후보 선정만 된다
    expect(h.pilot.getView().activeTickers).toEqual([]);
    // 같은 봉 안에서 5선 위로 돌파 — 봉이 닫히지 않았는데 실시간 판정(1초 스로틀)이 진입을 낸다.
    h.clock.advance(2_000);
    h.slots.get('A')!.pushTick(230, BASE * M + 30_000);
    await flush();
    await h.pilot.pollCycle();
    await flush();
    await h.pilot.pollCycle();
    await flush();
    expect(h.pilot.getView().activeTickers).toEqual(['A']);
    expect(h.brokers.get('A')!.placed[0]).toMatchObject({ side: 'buy' });
  });

  it('당일 매매한 종목은 조건만으로는 다시 안 사고, 5선 돌파 이벤트 봉에서 재진입한다', async () => {
    const h = makeHarness();
    h.slots.get('A')!.seedTrend(risingSeed());
    h.pilot.start();
    await tick(h, 222, BASE);
    await tick(h, 223, BASE + 1); // 진입
    expect(h.pilot.getView().activeTickers).toEqual(['A']);
    // 사용자 전량 매도로 사이클을 끝낸다(익절 경로와 같은 정산).
    expect(h.pilot.sellNow('A')).toBeNull();
    await flush();
    await h.pilot.pollCycle();
    await flush();
    expect(h.pilot.getView().activeTickers).toEqual([]);
    expect(h.trades).toHaveLength(1);

    // 조건은 계속 충족(상승 지속) — 이벤트 없는 봉이라 재진입하지 않고 사유를 남긴다.
    // 분을 +12부터 잇는다 — 첫 틱의 실시간 신호(2026-09-01)가 '후보 밖' 드랍 로그로 스로틀 창
    // (BUY_DROP_LOG_THROTTLE_MS=10분)을 차지해, 그 안에서는 '오늘 이미 매매' 로그가 숨는다(신호 처리는 정상).
    await tick(h, 224, BASE + 12);
    await tick(h, 225, BASE + 13);
    expect(h.pilot.getView().activeTickers).toEqual([]);
    expect(h.events.some((e) => e.includes('BUY 무시') && e.includes('오늘 이미 매매한 종목'))).toBe(true);

    // 5선 아래로 눌렀다가(조건 깨짐) 다시 위로 돌파 → 이벤트 봉 → 재진입.
    await tick(h, 200, BASE + 14); // 키 BASE+13 닫힘(225)
    await tick(h, 199, BASE + 15); // 키 BASE+14 닫힘(200) — 5선 아래
    await tick(h, 240, BASE + 16); // 키 BASE+15 닫힘(199) — 아직 아래
    await tick(h, 241, BASE + 17); // 키 BASE+16 닫힘(240) — 5선 위로 돌파(cross) → 재진입
    expect(h.pilot.getView().activeTickers).toEqual(['A']);
  });

  it('매수 미체결이면 매도1호가로 정정해 따라간다(리프라이스 틱)', async () => {
    const h = makeHarness({ autoFill: false });
    h.slots.get('A')!.seedTrend(risingSeed());
    h.pilot.start();
    await tick(h, 222, BASE);
    await tick(h, 223, BASE + 1); // 진입 발주(미체결)
    const broker = h.brokers.get('A')!;
    expect(broker.placed).toHaveLength(1);
    expect(broker.placed[0].side).toBe('buy');
    // 가격이 위로 달아났다 — 매도1호가 230. 리프라이스 틱이 매수 주문을 230으로 정정한다.
    h.slots.get('A')!.pushQuote(229, 230); // 신선한 호가(10초 이내)여야 정정한다
    h.clock.advance(2_000);
    await fireTimers(h);
    expect(broker.amended.length).toBeGreaterThanOrEqual(1);
    expect(broker.amended.at(-1)!.price).toBe(230);
  });
});
