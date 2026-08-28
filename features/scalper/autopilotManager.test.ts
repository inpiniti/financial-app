import { describe, expect, it, vi } from 'vitest';

import { AutoPilotManager, AUTOPILOT_TRADE_ID, type AutoPilotManagerDeps } from './autopilotManager';
import { TREND_CONFIG } from './autopilot';
import { TREND_BAR_MINUTES } from '../../core/trend/bars';
import { FakeBroker, FakeStore, fakeClock, flush, noopScheduler } from './fakes';
import type { FeedStatus, RealtimeControlMessage, RealtimeFeed } from './types';
import type { RankingSnapshot } from './watchlist';

// (trId|trKey) 쌍으로 구독을 추적하는 가짜 피드 — 현재 쓰는 TR은 체결가(HDFSCNT0)뿐이다.
class PairFeed implements RealtimeFeed {
  connected = false;
  readonly pairs = new Set<string>();
  private tick: ((symb: string, price: number, tsMs: number) => void) | null = null;
  private quote:
    | ((symb: string, bid1: number, ask1: number, tsMs: number, bidVol1?: number, askVol1?: number) => void)
    | null = null;

  connect(): void {
    this.connected = true;
  }
  close(): void {
    this.connected = false;
  }
  /** 구독/해제 호출 순서 기록 — 세션 키 회전 순서(해제 → 구독) 검증용. */
  readonly ops: string[] = [];
  subscribe(trKey: string, trId = 'HDFSCNT0'): void {
    this.pairs.add(`${trId}|${trKey}`);
    this.ops.push(`+${trKey}`);
  }
  unsubscribe(trKey: string, trId = 'HDFSCNT0'): void {
    this.pairs.delete(`${trId}|${trKey}`);
    this.ops.push(`-${trKey}`);
  }
  setTickHandler(handler: (symb: string, price: number, tsMs: number) => void): void {
    this.tick = handler;
  }
  setQuoteHandler(
    handler: (symb: string, bid1: number, ask1: number, tsMs: number, bidVol1?: number, askVol1?: number) => void,
  ): void {
    this.quote = handler;
  }
  setStatusHandler(_handler: (status: FeedStatus) => void): void {}
  setControlHandler(_handler: (msg: RealtimeControlMessage) => void): void {}
  emit(symb: string, price: number, tsMs: number): void {
    this.tick?.(symb, price, tsMs);
  }
  emitQuote(symb: string, bid1: number, ask1: number, tsMs: number): void {
    this.quote?.(symb, bid1, ask1, tsMs);
  }
  tickPairs(): string[] {
    return [...this.pairs].filter((p) => p.startsWith('HDFSCNT0|'));
  }
}

const TWELVE = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];

function snapshotOf(tickers: string[]): RankingSnapshot {
  return [{ source: 'tossVolume', count: 15, rows: tickers.map((t) => ({ symb: t, rate: '1' })) }];
}

function makeManager(
  opts: {
    holdings?: string[];
    entryLadder?: { interval: number; triggerCount: number };
    /** 추세 모드 — 주입하면 trend 활성 + 워밍업 큐가 이 함수를 부른다. */
    fetchMinuteBars?: AutoPilotManagerDeps['fetchMinuteBars'];
  } = {},
) {
  const feed = new PairFeed();
  const store = new FakeStore();
  const clock = fakeClock(1000);
  const fetchSnapshot = vi.fn<() => Promise<RankingSnapshot>>().mockResolvedValue(snapshotOf(TWELVE));
  const keepAwake = { active: 0, activate: vi.fn(), deactivate: vi.fn() };
  const scheduler = noopScheduler();
  const manager = new AutoPilotManager({
    realtime: feed,
    storage: store,
    clock,
    scheduler,
    makeBroker: () => new FakeBroker({ autoFill: true }),
    fetchSnapshot,
    fetchHoldings: opts.holdings ? async () => opts.holdings! : undefined,
    keepAwake,
    chunkSeconds: 1,
    bufferSize: 7,
    entryLadder: opts.entryLadder,
    trend: opts.fetchMinuteBars ? TREND_CONFIG : undefined,
    fetchMinuteBars: opts.fetchMinuteBars,
  });
  manager.setConfig({ startAmountUsd: 100, minTickRate: 0.01 });
  return { manager, feed, store, clock, fetchSnapshot, keepAwake, scheduler };
}

describe('AutoPilotManager — 리스트 가격 상한(2026-08-20 분리)', () => {
  const priced: RankingSnapshot = [
    {
      source: 'tossVolume',
      count: 15,
      rows: [
        { symb: 'CHEAP', rate: '1', last: '5' },
        { symb: 'EXPSV', rate: '1', last: '150' }, // MRNA류 — 진입금액($100)보다 비싸다
      ],
    },
  ];

  it('금액 모드(entryQty 미설정) — 진입금액이 상한이라 비싼 종목은 리스트에서 빠진다(옛 동작 유지)', async () => {
    const { manager, fetchSnapshot } = makeManager();
    fetchSnapshot.mockResolvedValue(priced);
    manager.start();
    await vi.waitFor(() => expect(manager.watchlist.size).toBe(1));
    expect(manager.watchlist.list.map((e) => e.ticker)).toEqual(['CHEAP']);
  });

  it('수량 모드(entryQty ≥ 1) — 상한은 maxPriceUsd라 진입금액보다 비싼 종목도 리스트에 들어온다', async () => {
    const { manager, fetchSnapshot } = makeManager();
    fetchSnapshot.mockResolvedValue(priced);
    manager.setConfig({ startAmountUsd: 100, entryQty: 1, maxPriceUsd: 200, minTickRate: 0.01 });
    manager.start();
    await vi.waitFor(() => expect(manager.watchlist.size).toBe(2));
  });

  it('수량 모드라도 maxPriceUsd가 0(미설정)이면 진입금액이 상한(폴백)', async () => {
    const { manager, fetchSnapshot } = makeManager();
    fetchSnapshot.mockResolvedValue(priced);
    manager.setConfig({ startAmountUsd: 100, entryQty: 1, maxPriceUsd: 0, minTickRate: 0.01 });
    manager.start();
    await vi.waitFor(() => expect(manager.watchlist.size).toBe(1));
  });
});

describe('AutoPilotManager — 배선(구독·라우팅·상호 배타)', () => {
  it('start → 리스트 12종 슬롯 + 체결가 12건, 호가 TR 구독은 없다(1호가는 체결가 틱에 실려 온다)', async () => {
    const { manager, feed } = makeManager();
    manager.start();
    await vi.waitFor(() => expect(manager.watchlist.size).toBe(12));
    await flush();

    expect(feed.connected).toBe(true);
    expect(feed.tickPairs()).toHaveLength(12); // 체결가(D) — 전 종목.
    expect(feed.pairs.size).toBe(12); // 다른 TR(HDFSASP0 등) 구독 없음.
    expect(manager.getView().state).toBe('SCANNING');
    expect(manager.getRows()).toHaveLength(12);

    // 감시가 붙어도 추가 구독은 생기지 않는다.
    for (const t of ['A', 'B', 'C']) {
      for (let i = 0; i < 10; i += 1) manager.routeTick(t, 10, i * 10);
    }
    manager.pilot.reselect();
    expect(feed.pairs.size).toBe(12);
  });

  it('3거래소 병합 리스트 — 채용 거래소(NYS/AMS)로 체결가 trKey를 조립한다(excd 없으면 NAS)', async () => {
    const { manager, feed, fetchSnapshot } = makeManager();
    fetchSnapshot.mockResolvedValue([
      {
        source: 'tossVolume',
        count: 15,
        rows: [
          { symb: 'NY1', rate: '1', excd: 'NYS' },
          { symb: 'AM1', rate: '1', excd: 'AMS' },
          { symb: 'NQ1', rate: '1' },
        ],
      },
    ]);
    manager.start();
    await vi.waitFor(() => expect(manager.watchlist.size).toBe(3));

    expect(feed.pairs.has('HDFSCNT0|DNYSNY1')).toBe(true);
    expect(feed.pairs.has('HDFSCNT0|DAMSAM1')).toBe(true);
    expect(feed.pairs.has('HDFSCNT0|DNASNQ1')).toBe(true);
  });

  it('주간거래 창(KST 10~16시)에는 D+NAS가 아니라 R+BAQ trKey로 체결가를 구독한다', async () => {
    const { manager, feed, clock } = makeManager();
    clock.set(Date.UTC(2026, 7, 10, 2, 0)); // 2026-08-10 11:00 KST — 주간거래 창.
    manager.start();
    await vi.waitFor(() => expect(manager.watchlist.size).toBe(12));
    await flush();

    expect(feed.tickPairs()).toHaveLength(12);
    expect(feed.pairs.has('HDFSCNT0|RBAQA')).toBe(true); // 정규장이었다면 DNASA.
    expect(feed.pairs.has('HDFSCNT0|DNASA')).toBe(false);
  });

  it('구독 중 세션이 바뀌어도(주간거래→정규장) 실제 구독했던 키 그대로 해제한다 — 고아 구독 방지', async () => {
    const { manager, feed, fetchSnapshot, clock } = makeManager();
    clock.set(Date.UTC(2026, 7, 10, 2, 0)); // 주간거래 창에서 시작 — R+BAQ로 구독됨.
    manager.start();
    await vi.waitFor(() => expect(manager.watchlist.size).toBe(12));
    await flush();
    expect(feed.pairs.has('HDFSCNT0|RBAQA')).toBe(true);

    clock.set(Date.UTC(2026, 7, 10, 14, 0)); // 정규장 시각으로 이동 — 이 시점의 판정은 D+NAS.
    fetchSnapshot.mockResolvedValue(snapshotOf(['Z', ...TWELVE.slice(1)])); // A → Z 교체(A 드롭).
    await manager.watchlist.refresh();
    await flush();

    // A는 원래 R+BAQ로 구독했으므로 그 키로 해제돼야 한다 — D+NAS로 해제 시도하면 고아로 남는다.
    expect(feed.pairs.has('HDFSCNT0|RBAQA')).toBe(false);
    expect(feed.pairs.has('HDFSCNT0|DNASA')).toBe(false); // 애초에 그 키로 구독한 적 없음.
    expect(feed.pairs.has('HDFSCNT0|DNASZ')).toBe(true); // 새로 들어온 Z는 지금(정규장) 시각 기준 D+NAS.
  });

  it('세션 전환 감시 타이머 — 정규장→주간거래 전환 시 리스트가 안 바뀐 종목도 R키로 회전한다', async () => {
    const { manager, feed, clock, scheduler } = makeManager();
    clock.set(Date.UTC(2026, 7, 10, 0, 0)); // 09:00 KST — 정규장 계열(주간거래 창 밖).
    manager.start();
    await vi.waitFor(() => expect(manager.watchlist.size).toBe(12));
    await flush();
    expect(feed.pairs.has('HDFSCNT0|DNASA')).toBe(true);

    clock.set(Date.UTC(2026, 7, 10, 1, 30)); // 10:30 KST — 주간거래 창 진입.
    for (const fn of scheduler.fired) fn(); // 세션 감시 타이머 발화(다른 타이머 발화는 무해).
    await flush();

    // 리스트 교체 없이도 전 종목 구독이 R+BAQ로 회전하고 옛 D키는 해제된다.
    expect(feed.pairs.has('HDFSCNT0|RBAQA')).toBe(true);
    expect(feed.pairs.has('HDFSCNT0|DNASA')).toBe(false);
    expect(feed.tickPairs()).toHaveLength(12);
    // 회전 순서는 종목마다 **해제 → 구독**(2026-08-28 MAX SUBSCRIBE OVER 실사고) — 동시 등록 수가 리스트 크기를 넘지 않는다.
    const rotation = feed.ops.slice(feed.ops.indexOf('-DNASA'));
    expect(rotation.slice(0, 2)).toEqual(['-DNASA', '+RBAQA']);
    let live = 12;
    for (const op of rotation) {
      live += op.startsWith('+') ? 1 : -1;
      expect(live).toBeLessThanOrEqual(12);
    }
  });

  it('구독 거절(ACK 실패)은 리스트 행 feedRejected로 드러난다 — R키면 daytime=true, ACK 전·성공은 null(2026-08-28)', async () => {
    // 실제 배선: ScalperManager.getSubscriptionStatus. 여기서는 (trId|trKey)별 ACK 표를 직접 흉내 낸다.
    const acks = new Map<string, { success: boolean; message: string }>();
    const feed = new PairFeed();
    const clock = fakeClock(1000);
    clock.set(Date.UTC(2026, 7, 28, 6, 0)); // 2026-08-28 15:00 KST — 주간거래 창(R+BAQ 키).
    const manager = new AutoPilotManager({
      realtime: feed,
      storage: new FakeStore(),
      clock,
      scheduler: noopScheduler(),
      makeBroker: () => new FakeBroker({ autoFill: true }),
      fetchSnapshot: async () => snapshotOf(TWELVE),
      keepAwake: { activate: vi.fn(), deactivate: vi.fn() },
      chunkSeconds: 1,
      bufferSize: 7,
      getFeedSubscriptionStatus: (trKey, trId) => acks.get(`${trId}|${trKey}`) ?? null,
    });
    manager.setConfig({ startAmountUsd: 100, minTickRate: 0.01 });
    const listener = vi.fn();
    manager.subscribeList(listener);
    manager.start();
    await vi.waitFor(() => expect(manager.watchlist.size).toBe(12));
    await flush();

    // ACK 전 — 아무 표시도 없다.
    expect(manager.getRows().every((r) => r.feedRejected === null)).toBe(true);

    acks.set('HDFSCNT0|RBAQA', { success: false, message: 'mci send failed' }); // A는 주간거래 미지원 종목.
    acks.set('HDFSCNT0|RBAQB', { success: true, message: '' });
    const before = listener.mock.calls.length;
    manager.refreshList(); // managerProvider가 구독 ACK 진단 이벤트마다 부른다.
    expect(listener.mock.calls.length).toBe(before + 1);

    const rows = manager.getRows();
    expect(rows.find((r) => r.entry.ticker === 'A')?.feedRejected).toEqual({
      trKey: 'RBAQA',
      message: 'mci send failed',
      daytime: true,
    });
    expect(rows.find((r) => r.entry.ticker === 'B')?.feedRejected).toBeNull();
    expect(rows.find((r) => r.entry.ticker === 'C')?.feedRejected).toBeNull(); // ACK 없음.
  });

  it('routeTick/routeQuote — 해당 티커 슬롯으로만 흘러간다', async () => {
    const { manager } = makeManager();
    manager.start();
    await vi.waitFor(() => expect(manager.watchlist.size).toBe(12));

    manager.routeTick('A', 123.45, 1000);
    manager.routeQuote('A', 123.4, 123.5, 1000);
    manager.routeTick('NOPE', 1, 1000); // 리스트 밖 — 무해.

    const rowA = manager.getRows().find((r) => r.entry.ticker === 'A')!;
    expect(rowA.view.price).toBe(123.45);
    expect(rowA.view.bid1).toBe(123.4);
  });

  it('리스트 교체 — 밀려난 종목 슬롯·구독 해제, 새 종목 슬롯·구독 등록', async () => {
    const { manager, feed, fetchSnapshot } = makeManager();
    manager.start();
    await vi.waitFor(() => expect(manager.watchlist.size).toBe(12));

    fetchSnapshot.mockResolvedValue(snapshotOf(['Z', ...TWELVE.slice(1)])); // A → Z 교체.
    await manager.watchlist.refresh();
    await flush();

    expect(manager.watchlist.has('A')).toBe(false);
    expect(manager.watchlist.has('Z')).toBe(true);
    expect(feed.tickPairs()).toHaveLength(12);
    expect(feed.pairs.has('HDFSCNT0|DNASZ')).toBe(true);
    expect(feed.pairs.has('HDFSCNT0|DNASA')).toBe(false);
  });

  it('보유 감지 — 잔고에 종목이 있으면 경고 이벤트를 낸다(차단 안 함)', async () => {
    const { manager } = makeManager({ holdings: ['TSLA'] });
    manager.start();
    await vi.waitFor(() =>
      expect(manager.recentEvents.some((e) => e.text.includes('보유 종목이 있어요') && e.text.includes('TSLA'))).toBe(
        true,
      ),
    );
    expect(manager.getView().state).toBe('SCANNING'); // 차단하지 않는다.
  });

  it('keep-awake — 시작하면 켜지고 정지하면 꺼진다', async () => {
    const { manager, keepAwake } = makeManager();
    manager.start();
    await vi.waitFor(() => expect(keepAwake.activate).toHaveBeenCalled());
    manager.stop();
    expect(keepAwake.deactivate).toHaveBeenCalled();
    expect(manager.getView().state).toBe('IDLE');
  });

  it('[사고 재현] applySettings(entryLadder) — 이미 감시 중인 슬롯도 새 간격·횟수로 갈아탄다(앱 재시작 불필요)', async () => {
    const { manager } = makeManager({ entryLadder: { interval: 0.01, triggerCount: 3 } });
    manager.start();
    await vi.waitFor(() => expect(manager.watchlist.size).toBe(12));
    await flush();

    const ladderOf = (ticker: string) => manager.getRows().find((r) => r.entry.ticker === ticker)!.view.ladder;
    manager.routeTick('A', 100, 0);
    manager.routeTick('A', 99, 1000);
    manager.routeTick('A', 99, 2000);
    expect(ladderOf('A')!.triggerCount).toBe(3);
    expect(ladderOf('A')!.count).toBe(1);

    manager.applySettings({ trading: {}, entryLadder: { interval: 0.02, triggerCount: 2 } });
    manager.routeTick('A', 100, 3000);
    manager.routeTick('A', 98, 4000);
    manager.routeTick('A', 98, 5000);
    expect(ladderOf('A')!.triggerCount).toBe(2);
    expect(ladderOf('A')!.count).toBe(1); // 새 앵커(100)에서 −2% 한 칸.
    expect(manager.recentEvents.some((e) => e.text.includes('진입 감지 설정 적용'))).toBe(true);
  });

  it('applySettings(entryLadder) — 이후 리스트에 새로 들어오는 종목도 새 값으로 만들어진다', async () => {
    const { manager, fetchSnapshot } = makeManager({ entryLadder: { interval: 0.01, triggerCount: 3 } });
    manager.start();
    await vi.waitFor(() => expect(manager.watchlist.size).toBe(12));

    manager.applySettings({ trading: {}, entryLadder: { interval: 0.02, triggerCount: 2 } });
    fetchSnapshot.mockResolvedValue(snapshotOf(['NEW', ...TWELVE.slice(0, 11)]));
    await manager.watchlist.refresh();
    await flush();

    manager.routeTick('NEW', 100, 0);
    manager.routeTick('NEW', 98, 1000);
    manager.routeTick('NEW', 98, 2000);
    const ladder = manager.getRows().find((r) => r.entry.ticker === 'NEW')!.view.ladder;
    expect(ladder!.triggerCount).toBe(2);
  });

  it('applySettings — 매수 미체결 취소가 파일럿으로 흘러가 이벤트로 확인된다', async () => {
    const { manager } = makeManager();
    manager.applySettings({ trading: { buyCancelAfterMs: 3000 } });
    expect(manager.recentEvents.some((e) => e.text.includes('매수 미체결 취소 3초'))).toBe(true);

    manager.applySettings({ trading: { buyCancelAfterMs: 0 } });
    expect(manager.recentEvents.some((e) => e.text.includes('매수 미체결 취소를 껐어요'))).toBe(true);
  });

  it('진입 수량을 지정해도 "진입금액 이하" 가격 필터는 유지된다 — 진입금액이 가격 상한 역할(2026-08-18)', async () => {
    // 진입금액 $100 · A는 $500 — 수량 모드에서도 A는 리스트에서 빠져야 한다.
    const { manager, fetchSnapshot } = makeManager();
    fetchSnapshot.mockResolvedValue([
      {
        source: 'tossVolume',
        count: 15,
        rows: [
          { symb: 'A', rate: '1', last: '500' },
          { symb: 'B', rate: '1', last: '10' },
        ],
      },
    ]);
    manager.start();
    await vi.waitFor(() => expect(manager.watchlist.size).toBe(1));
    expect(manager.watchlist.has('A')).toBe(false);
    manager.stop();
    await flush();

    manager.setConfig({ startAmountUsd: 100, minTickRate: 0.01, entryQty: 1 });
    manager.start();
    await vi.waitFor(() => expect(manager.watchlist.size).toBe(1));
    expect(manager.watchlist.has('A')).toBe(false);
    expect(manager.watchlist.has('B')).toBe(true);
  });

  it('AUTOPILOT_TRADE_ID 상수 계약', () => {
    expect(AUTOPILOT_TRADE_ID).toBe('autopilot');
  });
});

// ---- 추세 워밍업 큐(2026-08-18 추세→그리드→매매) ----

describe('AutoPilotManager — 추세 워밍업 큐(REST 분봉 시드)', () => {
  // 슬롯 봉 주기(TREND_BAR_MINUTES)에 맞춘 키 — 1분 키로 주면 3분 버킷에서 합쳐져 봉 수가 준다.
  const rising = Array.from({ length: 122 }, (_, i) => ({ minuteKey: i * TREND_BAR_MINUTES, close: 100 + i }));

  it('슬롯마다 티커당 1회, 직렬로 호출해 seedTrend에 넣는다', async () => {
    let inflight = 0;
    let maxInflight = 0;
    const calls: string[] = [];
    const fetchMinuteBars = vi.fn(async (ticker: string) => {
      calls.push(ticker);
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await flush();
      inflight -= 1;
      return rising;
    });
    const { manager } = makeManager({ fetchMinuteBars });
    manager.start();
    await vi.waitFor(() => expect(manager.watchlist.size).toBe(12));
    await vi.waitFor(() => expect(calls).toHaveLength(12));
    await flush();
    expect(new Set(calls).size).toBe(12); // 티커당 1회
    expect(maxInflight).toBe(1); // 직렬
    const rowA = manager.getRows().find((r) => r.entry.ticker === 'A')!;
    expect(rowA.view.trend?.bars).toBe(122);
    expect(manager.recentEvents.some((e) => e.text.includes('A 추세 시드 · 122봉'))).toBe(true);
  });

  it('조회 실패는 throw 없이 이벤트 1건 + 재시도 타이머 1회, 재시도 성공이면 시드된다', async () => {
    let fail = true;
    const fetchMinuteBars = vi.fn(async () => {
      if (fail) throw new Error('분봉 실패(모의)');
      return rising;
    });
    const { manager, scheduler, fetchSnapshot } = makeManager({ fetchMinuteBars });
    fetchSnapshot.mockResolvedValue(snapshotOf(['A']));
    manager.start();
    await vi.waitFor(() => expect(manager.watchlist.size).toBe(1));
    await vi.waitFor(() => expect(fetchMinuteBars).toHaveBeenCalledTimes(1));
    await flush();
    expect(manager.recentEvents.some((e) => e.text.includes('추세 시드 실패'))).toBe(true);
    // 재시도 타이머 발화 → 다시 큐에 들어가 성공.
    fail = false;
    for (const fn of scheduler.fired) fn();
    await vi.waitFor(() => expect(fetchMinuteBars).toHaveBeenCalledTimes(2));
    await flush();
    const rowA = manager.getRows().find((r) => r.entry.ticker === 'A')!;
    expect(rowA.view.trend?.bars).toBe(122);
  });

  it('trend 미주입이면 워밍업 호출이 없고 슬롯 뷰 trend는 null', async () => {
    const { manager } = makeManager();
    manager.start();
    await vi.waitFor(() => expect(manager.watchlist.size).toBe(12));
    await flush();
    expect(manager.getRows().every((r) => r.view.trend === null)).toBe(true);
  });
});

describe('AutoPilotManager — 거래 결과 기록 전략 태그', () => {
  it('trend 주입이면 trend, 아니면 사다리(entryLadder) → ladder', () => {
    const withTrend = makeManager({ fetchMinuteBars: async () => [] });
    expect(withTrend.manager.strategyTag()).toBe('trend');
    const ladder = makeManager({ entryLadder: { interval: 0.01, triggerCount: 3 } });
    expect(ladder.manager.strategyTag()).toBe('ladder');
    const plain = makeManager();
    expect(plain.manager.strategyTag()).toBe('grid');
  });
});
