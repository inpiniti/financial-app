import { describe, expect, it, vi } from 'vitest';

import { AutoPilotManager, AUTOPILOT_TRADE_ID } from './autopilotManager';
import { FakeBroker, FakeStore, fakeClock, flush, noopScheduler } from './fakes';
import type { FeedStatus, RealtimeControlMessage, RealtimeFeed } from './types';
import type { RankingSnapshot } from './watchlist';

// 체결가(HDFSCNT0)·호가(HDFSASP0)가 같은 trKey(DNAS…)를 쓰므로 (trId|trKey) 쌍으로 추적하는 가짜 피드.
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
  subscribe(trKey: string, trId = 'HDFSCNT0'): void {
    this.pairs.add(`${trId}|${trKey}`);
  }
  unsubscribe(trKey: string, trId = 'HDFSCNT0'): void {
    this.pairs.delete(`${trId}|${trKey}`);
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
  quotePairs(): string[] {
    return [...this.pairs].filter((p) => p.startsWith('HDFSASP0|'));
  }
}

const TWELVE = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];

function snapshotOf(tickers: string[]): RankingSnapshot {
  return { tossVolume: tickers.map((t) => ({ symb: t, rate: '1' })) };
}

function makeManager(opts: { holdings?: string[]; entryLadder?: { interval: number; triggerCount: number } } = {}) {
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
  });
  manager.pilot.setConfig({ startAmountUsd: 100, minTickRate: 0.01 });
  return { manager, feed, store, clock, fetchSnapshot, keepAwake, scheduler };
}

describe('AutoPilotManager — 배선(구독 예산·라우팅·상호 배타)', () => {
  it('start → 리스트 12종 슬롯 + 체결가 12건, 감시 top3만 호가 구독(합계 15건)', async () => {
    const { manager, feed } = makeManager();
    manager.start();
    await vi.waitFor(() => expect(manager.watchlist.size).toBe(12));
    await flush();

    expect(feed.connected).toBe(true);
    expect(feed.tickPairs()).toHaveLength(12); // 체결가(D) — 전 종목.
    expect(manager.pilot.getView().state).toBe('SCANNING');
    expect(manager.getRows()).toHaveLength(12);

    // 최소 속도 자격을 만들려면 틱이 필요 — 3종목에 틱을 흘리고 재선정하면 호가(R) 구독이 붙는다.
    for (const t of ['A', 'B', 'C']) {
      for (let i = 0; i < 10; i += 1) manager.routeTick(t, 10, i * 10);
    }
    manager.pilot.reselect();
    expect(feed.quotePairs()).toHaveLength(3); // 호가(R) — 감시 top3만.
  });

  it('3거래소 병합 리스트 — 채용 거래소(NYS/AMS)로 체결가 trKey를 조립한다(excd 없으면 NAS)', async () => {
    const { manager, feed, fetchSnapshot } = makeManager();
    fetchSnapshot.mockResolvedValue({
      tossVolume: [
        { symb: 'NY1', rate: '1', excd: 'NYS' },
        { symb: 'AM1', rate: '1', excd: 'AMS' },
        { symb: 'NQ1', rate: '1' },
      ],
    });
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
    expect(manager.pilot.getView().state).toBe('SCANNING'); // 차단하지 않는다.
  });

  it('keep-awake — 시작하면 켜지고 정지하면 꺼진다', async () => {
    const { manager, keepAwake } = makeManager();
    manager.start();
    await vi.waitFor(() => expect(keepAwake.activate).toHaveBeenCalled());
    manager.stop();
    expect(keepAwake.deactivate).toHaveBeenCalled();
    expect(manager.pilot.getView().state).toBe('IDLE');
  });

  it('[사고 재현] setEntryLadder — 이미 감시 중인 슬롯도 새 간격·횟수로 갈아탄다(앱 재시작 불필요)', async () => {
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

    manager.setEntryLadder({ interval: 0.02, triggerCount: 2 });
    manager.routeTick('A', 100, 3000);
    manager.routeTick('A', 98, 4000);
    manager.routeTick('A', 98, 5000);
    expect(ladderOf('A')!.triggerCount).toBe(2);
    expect(ladderOf('A')!.count).toBe(1); // 새 앵커(100)에서 −2% 한 칸.
    expect(manager.recentEvents.some((e) => e.text.includes('진입 감지 설정 적용'))).toBe(true);
  });

  it('setEntryLadder — 이후 리스트에 새로 들어오는 종목도 새 값으로 만들어진다', async () => {
    const { manager, fetchSnapshot } = makeManager({ entryLadder: { interval: 0.01, triggerCount: 3 } });
    manager.start();
    await vi.waitFor(() => expect(manager.watchlist.size).toBe(12));

    manager.setEntryLadder({ interval: 0.02, triggerCount: 2 });
    fetchSnapshot.mockResolvedValue(snapshotOf(['NEW', ...TWELVE.slice(0, 11)]));
    await manager.watchlist.refresh();
    await flush();

    manager.routeTick('NEW', 100, 0);
    manager.routeTick('NEW', 98, 1000);
    manager.routeTick('NEW', 98, 2000);
    const ladder = manager.getRows().find((r) => r.entry.ticker === 'NEW')!.view.ladder;
    expect(ladder!.triggerCount).toBe(2);
  });

  it('setBuyCancelAfterMs — 파일럿으로 흘러가 이벤트로 확인된다', async () => {
    const { manager } = makeManager();
    manager.setBuyCancelAfterMs(3000);
    expect(manager.recentEvents.some((e) => e.text.includes('매수 미체결 취소 3초'))).toBe(true);

    manager.setBuyCancelAfterMs(0);
    expect(manager.recentEvents.some((e) => e.text.includes('매수 미체결 취소를 껐어요'))).toBe(true);
  });

  it('AUTOPILOT_TRADE_ID 상수 계약', () => {
    expect(AUTOPILOT_TRADE_ID).toBe('autopilot');
  });
});
