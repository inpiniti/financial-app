// 7단계 — 통합(종단) 테스트, 자동 단타 경로(수동 카드 제거 후 2026-08-08 개조).
// 단위 테스트(autopilot·autopilotManager·createKisBroker·realtimePrice)가 각 모듈을 검증했다 — 여기서는
// 그 바깥 경계에서 "합성 WS 프레임 → 실물 파싱·허브 라우팅·슬롯 판정·사이클 → 실물 REST 글루 → 가짜 fetch"
// 전 체인을 검증한다. 가짜는 kis 경계 바로 바깥(fetch·WebSocket)에만 심는다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTOPILOT_TRADE_ID } from '../../features/scalper/autopilotManager';
import { readTodayTrades } from '../../features/scalper/tradeStore';
import {
  DOWN_UP_DOWN,
  V_SHAPE,
  advanceAndPoll,
  makeHarness,
  startAndOpen,
  tickSeries,
} from './harness';

// 실전(live)·미국(NASD) TR ID — docs/koreainvestment/주문.md·정정취소주문.md TR ID 표 그대로(독립 출처).
const BUY_TR_ID = 'TTTT1002U';
const SELL_TR_ID = 'TTTT1006U';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('7단계 종단 — 자동 단타 체인 (WS 프레임 → 허브 라우팅 → 슬롯 판정/사이클 → REST 글루 → 가짜 fetch)', () => {
  it('① start → 리스트 12종의 체결가(D) 구독 register 프레임이 실제 WS로 전송된다', async () => {
    const h = makeHarness({ autoFillOrders: true });
    await startAndOpen(h);

    // 실물 OverseasRealtimePriceClient가 만든 register 프레임에 trKey가 실려 나갔는가(경계 검증).
    expect(h.socket().sent.some((s) => s.includes('DNASAAPL'))).toBe(true);
    expect(h.autopilot.getView().state).toBe('SCANNING');
  });

  it('② V자 가격 시퀀스에서 진입 BUY가 정확히 1회 발주된다(TR ID·PDNO·금액÷가격 수량 검증)', async () => {
    const h = makeHarness({ autoFillOrders: true, startAmountUsd: 100 });
    await startAndOpen(h);

    await tickSeries(h, 'AAPL', V_SHAPE);

    const buys = h.api.placed.filter((p) => p.side === 'buy');
    expect(buys).toHaveLength(1);
    expect(buys[0].trId).toBe(BUY_TR_ID);
    expect(buys[0].pdno).toBe('AAPL');
    // 수량 = ⌊시작 금액 ÷ 발주가⌋ — 발주가는 신호 시점 체결가(호가 미수신이라 last price).
    expect(buys[0].qty).toBe(Math.floor(100 / buys[0].price));
    expect(buys[0].qty).toBeGreaterThan(0);
  });

  it('③ 하락-상승-하락 전체 사이클 — BUY 후 SELL 발주·완주, tradeStore에 autopilot 기록이 남는다', async () => {
    const h = makeHarness({ autoFillOrders: true, startAmountUsd: 100 });
    await startAndOpen(h);

    await tickSeries(h, 'AAPL', DOWN_UP_DOWN);
    // 매도 체결 정산이 폴 몇 번 뒤에 끝날 수 있다 — 시세 없이 폴만 몇 번 더 돌린다.
    for (let i = 0; i < 3; i += 1) await advanceAndPoll(h, 1000);

    const buys = h.api.placed.filter((p) => p.side === 'buy');
    const sells = h.api.placed.filter((p) => p.side === 'sell');
    expect(buys).toHaveLength(1);
    expect(sells).toHaveLength(1);
    expect(sells[0].trId).toBe(SELL_TR_ID);
    expect(sells[0].pdno).toBe('AAPL');
    expect(sells[0].qty).toBe(buys[0].qty); // 전량 매도

    // 손익 화면이 읽는 기록 — 자동관리 사이클은 전부 AUTOPILOT_TRADE_ID로 남는다.
    const today = await readTodayTrades(h.store, h.clock);
    expect(today).toHaveLength(1);
    expect(today[0].instanceId).toBe(AUTOPILOT_TRADE_ID);
    expect(today[0].ticker).toBe('AAPL');
    expect(today[0].qty).toBe(buys[0].qty);
    expect(today[0].entryPrice).toBe(buys[0].price);
    expect(today[0].exitPrice).toBe(sells[0].price);
  });

  it('④ start 없이 틱만 흘리면 주문 fetch 0회', async () => {
    const h = makeHarness();
    // start(자동관리 시작)는 호출하지 않고 WS 연결만 직접 연다.
    h.realtime.connect();
    h.socket().open();

    await tickSeries(h, 'AAPL', DOWN_UP_DOWN); // 변곡점이 뚜렷한 시퀀스인데도

    expect(h.api.placed).toHaveLength(0);
    expect(h.autopilot.getView().state).toBe('IDLE');
  });
});
