import { describe, expect, it, vi } from 'vitest';

import type { SchedulerLike } from './types';
import {
  computeDesired,
  isOrderable,
  isWithinMaxPrice,
  parseSignedRate,
  ScalperWatchlist,
  WATCH_SLOTS_PER_SOURCE,
  WATCHLIST_MAX_SIZE,
  WATCHLIST_POLL_INTERVAL_MS,
  type RankingSnapshot,
  type WatchCandidateRow,
} from './watchlist';

function row(symb: string, rate: string, extra: Partial<WatchCandidateRow> = {}): WatchCandidateRow {
  return { symb, rate, ...extra };
}

function snapshot(partial: Partial<RankingSnapshot>): RankingSnapshot {
  return { tradeVolume: [], tradeGrowth: [], tradeTurnover: [], upDownRate: [], ...partial };
}

/** 수동 트리거 스케줄러 — setInterval 콜백을 잡아두고 tick()으로 강제 실행. */
function manualScheduler() {
  let cb: (() => void) | null = null;
  const scheduler: SchedulerLike = {
    setInterval: (fn: () => void) => {
      cb = fn;
      return 1;
    },
    clearInterval: () => {
      cb = null;
    },
  };
  return { scheduler, tick: () => cb?.(), get active() { return cb !== null; } };
}

describe('parseSignedRate / isOrderable', () => {
  it('sign 4·5(하락)는 음수 강제, 1·2(상승)는 양수 강제, 그 외엔 원문 부호', () => {
    expect(parseSignedRate(row('A', '3.2', { sign: '5' }))).toBe(-3.2);
    expect(parseSignedRate(row('A', '-3.2', { sign: '2' }))).toBe(3.2);
    expect(parseSignedRate(row('A', '-1.1' ))).toBe(-1.1);
    expect(parseSignedRate(row('A', 'abc'))).toBeNaN();
  });

  it('매매가능 판정은 관대 — 명확한 X/N만 배제', () => {
    expect(isOrderable(row('A', '1', { e_ordyn: 'X' }))).toBe(false);
    expect(isOrderable(row('A', '1', { e_ordyn: 'n' }))).toBe(false);
    expect(isOrderable(row('A', '1', { e_ordyn: 'O' }))).toBe(true);
    expect(isOrderable(row('A', '1', {}))).toBe(true);
  });

  it('진입금액 상한 판정 — 현재가 > 상한만 배제, 상한·현재가가 없거나 이상하면 관대 통과', () => {
    expect(isWithinMaxPrice(row('A', '1', { last: '0.99' }), 1)).toBe(true);
    expect(isWithinMaxPrice(row('A', '1', { last: '1.00' }), 1)).toBe(true); // floor(1/1)=1주 — 진입 가능.
    expect(isWithinMaxPrice(row('A', '1', { last: '1.01' }), 1)).toBe(false);
    expect(isWithinMaxPrice(row('A', '1', { last: '50' }), null)).toBe(true); // 상한 없음(설정 미입력).
    expect(isWithinMaxPrice(row('A', '1', {}), 1)).toBe(true); // 현재가 누락 — 관대 통과.
    expect(isWithinMaxPrice(row('A', '1', { last: 'abc' }), 1)).toBe(true); // 현재가 파싱 불가 — 관대 통과.
    expect(isWithinMaxPrice(row('A', '1', { last: '5' }), 0)).toBe(true); // 상한 0 이하 — 필터 없음 취급.
  });
});

describe('computeDesired — 필터·중복 우선권·차순위 충원', () => {
  it('각 순위에서 +등락 상위 3개씩, 합계 12개(서로 다른 티커)', () => {
    const desired = computeDesired(
      snapshot({
        tradeVolume: [row('A', '1'), row('B', '2'), row('C', '3'), row('D', '4')],
        tradeGrowth: [row('E', '1'), row('F', '2'), row('G', '3')],
        tradeTurnover: [row('H', '1'), row('I', '2'), row('J', '3')],
        upDownRate: [row('K', '9'), row('L', '8'), row('M', '7'), row('N', '6')],
      }),
    );
    expect(desired).toHaveLength(WATCHLIST_MAX_SIZE);
    expect(WATCHLIST_MAX_SIZE).toBe(12);
    expect(desired.map((e) => e.ticker)).toEqual([
      'A', 'B', 'C', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
    ]);
    expect(desired.filter((e) => e.source === 'tradeVolume')).toHaveLength(WATCH_SLOTS_PER_SOURCE);
    expect(desired.filter((e) => e.source === 'upDownRate')).toHaveLength(WATCH_SLOTS_PER_SOURCE);
  });

  it('상승률 원천이 비어도(조회 실패 등) 나머지 3종으로 9개를 유지한다', () => {
    const desired = computeDesired(
      snapshot({
        tradeVolume: [row('A', '1'), row('B', '1'), row('C', '1')],
        tradeGrowth: [row('D', '1'), row('E', '1'), row('F', '1')],
        tradeTurnover: [row('G', '1'), row('H', '1'), row('I', '1')],
        upDownRate: [],
      }),
    );
    expect(desired).toHaveLength(9);
  });

  it('음전(-)·보합(0)·주문불가·빈 티커는 건너뛰고 차순위로 충원한다', () => {
    const desired = computeDesired(
      snapshot({
        tradeVolume: [
          row('DOWN', '2.0', { sign: '5' }), // 음전
          row('ZERO', '0'), // 보합
          row('NOPE', '1.0', { e_ordyn: 'X' }), // 주문불가
          row('', '1.0'), // 빈 티커
          row('A', '1.0'),
          row('B', '1.0'),
          row('C', '1.0'),
        ],
      }),
    );
    expect(desired.map((e) => e.ticker)).toEqual(['A', 'B', 'C']);
  });

  it('중복 티커는 우선권(거래량→증가율→회전율→상승률)이 가져가고 뒤 순위는 차순위로 채운다', () => {
    const desired = computeDesired(
      snapshot({
        tradeVolume: [row('AAPL', '1'), row('MSFT', '1'), row('NVDA', '1')],
        tradeGrowth: [row('AAPL', '9'), row('TSLA', '1'), row('AMD', '1'), row('AMZN', '1')],
        tradeTurnover: [row('MSFT', '9'), row('TSLA', '9'), row('GOOG', '1'), row('META', '1'), row('NFLX', '1')],
        upDownRate: [row('NVDA', '9'), row('GOOG', '9'), row('SMCI', '5'), row('PLTR', '4'), row('SOUN', '3')],
      }),
    );
    expect(desired.map((e) => e.ticker)).toEqual([
      'AAPL', 'MSFT', 'NVDA', // 거래량
      'TSLA', 'AMD', 'AMZN', // 증가율 — AAPL은 거래량이 선점, 차순위 충원
      'GOOG', 'META', 'NFLX', // 회전율 — MSFT·TSLA 선점, 차순위 충원
      'SMCI', 'PLTR', 'SOUN', // 상승률 — NVDA·GOOG 선점, 차순위 충원
    ]);
  });

  it('후보가 모자라면 그 순위 슬롯은 비워둔다(억지 충원 없음)', () => {
    const desired = computeDesired(snapshot({ tradeVolume: [row('A', '1')] }));
    expect(desired).toHaveLength(1);
  });

  it('진입금액 상한을 넘는 종목은 건너뛰고 차순위로 충원한다', () => {
    const desired = computeDesired(
      snapshot({
        tradeVolume: [
          row('RICH', '5', { last: '42.10' }), // $1 초과 — 제외.
          row('EDGE', '4', { last: '1.00' }), // 정확히 $1 — 1주 진입 가능, 채용.
          row('PENNY', '3', { last: '0.42' }),
          row('CHEAP', '2', { last: '0.87' }),
          row('SPARE', '1', { last: '0.55' }),
        ],
      }),
      1,
    );
    expect(desired.map((e) => e.ticker)).toEqual(['EDGE', 'PENNY', 'CHEAP']);
  });

  it('상한 미지정이면 가격 필터 없이 기존과 동일하게 동작한다', () => {
    const desired = computeDesired(
      snapshot({ tradeVolume: [row('RICH', '5', { last: '42.10' }), row('A', '1', { last: '0.5' })] }),
    );
    expect(desired.map((e) => e.ticker)).toEqual(['RICH', 'A']);
  });
});

describe('ScalperWatchlist — 폴링·diff·핀 유예', () => {
  it('start 시 즉시 1회 갱신하고, 주기 tick마다 재갱신한다', async () => {
    const sched = manualScheduler();
    const fetchSnapshot = vi
      .fn<() => Promise<RankingSnapshot>>()
      .mockResolvedValue(snapshot({ tradeVolume: [row('A', '1')] }));
    const wl = new ScalperWatchlist({ fetchSnapshot, scheduler: sched.scheduler });

    wl.start();
    await vi.waitFor(() => expect(wl.size).toBe(1));
    expect(sched.active).toBe(true);

    sched.tick();
    await vi.waitFor(() => expect(fetchSnapshot).toHaveBeenCalledTimes(2));

    wl.stop();
    expect(sched.active).toBe(false);
    expect(WATCHLIST_POLL_INTERVAL_MS).toBe(180_000);
  });

  it('순위에서 밀려나면 제거되고 새 종목이 추가된다 — onChange diff 통지', async () => {
    const { scheduler } = manualScheduler();
    const onChange = vi.fn();
    const fetchSnapshot = vi
      .fn<() => Promise<RankingSnapshot>>()
      .mockResolvedValueOnce(snapshot({ tradeVolume: [row('A', '1'), row('B', '1')] }))
      .mockResolvedValueOnce(snapshot({ tradeVolume: [row('B', '1'), row('C', '1')] }));
    const wl = new ScalperWatchlist({ fetchSnapshot, scheduler, onChange });

    await wl.refresh();
    expect(wl.list.map((e) => e.ticker)).toEqual(['A', 'B']);

    await wl.refresh();
    expect(wl.list.map((e) => e.ticker).sort()).toEqual(['B', 'C']);
    const diff = onChange.mock.calls[1][1];
    expect(diff.removed).toEqual(['A']);
    expect(diff.added.map((e: { ticker: string }) => e.ticker)).toEqual(['C']);
  });

  it('핀 고정 종목은 리스트에서 밀려나도 잔류한다(13종목 일시 허용) — unpin 시 즉시 제거', async () => {
    const { scheduler } = manualScheduler();
    const onChange = vi.fn();
    const twelve = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];
    const twelveRows = (names: string[]) => ({
      tradeVolume: names.slice(0, 3).map((n) => row(n, '1')),
      tradeGrowth: names.slice(3, 6).map((n) => row(n, '1')),
      tradeTurnover: names.slice(6, 9).map((n) => row(n, '1')),
      upDownRate: names.slice(9, 12).map((n) => row(n, '1')),
    });
    const fetchSnapshot = vi
      .fn<() => Promise<RankingSnapshot>>()
      .mockResolvedValueOnce(snapshot(twelveRows(twelve)))
      // A가 밀려나고 Z가 들어온 다음 폴링.
      .mockResolvedValueOnce(snapshot(twelveRows(['Z', ...twelve.slice(1)])));
    const wl = new ScalperWatchlist({ fetchSnapshot, scheduler, onChange });

    await wl.refresh();
    expect(wl.size).toBe(12);

    wl.pin('A'); // A로 사이클 진입 중.
    await wl.refresh();
    expect(wl.size).toBe(13); // A 잔류 + Z 추가.
    expect(wl.has('A')).toBe(true);
    expect(wl.list.find((e) => e.ticker === 'A')!.pinned).toBe(true);
    expect(onChange.mock.calls[1][1].removed).toEqual([]); // A 제거는 유예.

    wl.unpin('A'); // 사이클 종료(STOP) — 즉시 제거.
    expect(wl.size).toBe(12);
    expect(wl.has('A')).toBe(false);
    expect(onChange.mock.calls[2][1].removed).toEqual(['A']);
  });

  it('핀 종목이 리스트에 여전히 있으면 unpin해도 잔류한다', async () => {
    const { scheduler } = manualScheduler();
    const fetchSnapshot = vi
      .fn<() => Promise<RankingSnapshot>>()
      .mockResolvedValue(snapshot({ tradeVolume: [row('A', '1')] }));
    const wl = new ScalperWatchlist({ fetchSnapshot, scheduler });

    await wl.refresh();
    wl.pin('A');
    await wl.refresh();
    wl.unpin('A');
    expect(wl.has('A')).toBe(true);
    expect(wl.list.find((e) => e.ticker === 'A')!.pinned).toBe(false);
  });

  it('maxPriceUsd getter를 갱신마다 읽어 진입금액 초과 종목을 거른다 — 설정 변경도 다음 갱신에 반영', async () => {
    const { scheduler } = manualScheduler();
    let limit: number | null = 1;
    const fetchSnapshot = vi
      .fn<() => Promise<RankingSnapshot>>()
      .mockResolvedValue(snapshot({ tradeVolume: [row('RICH', '5', { last: '42.10' }), row('A', '1', { last: '0.50' })] }));
    const wl = new ScalperWatchlist({ fetchSnapshot, scheduler, maxPriceUsd: () => limit });

    await wl.refresh();
    expect(wl.list.map((e) => e.ticker)).toEqual(['A']); // $42.10짜리는 제외.

    limit = null; // 진입금액 미설정 상태 — 필터 해제.
    await wl.refresh();
    expect(wl.list.map((e) => e.ticker).sort()).toEqual(['A', 'RICH']);
  });

  it('폴링 실패 시 리스트는 직전 상태를 유지하고 onError로 통지한다', async () => {
    const { scheduler } = manualScheduler();
    const onError = vi.fn();
    const fetchSnapshot = vi
      .fn<() => Promise<RankingSnapshot>>()
      .mockResolvedValueOnce(snapshot({ tradeVolume: [row('A', '1')] }))
      .mockRejectedValueOnce(new Error('KIS 500'));
    const wl = new ScalperWatchlist({ fetchSnapshot, scheduler, onError });

    await wl.refresh();
    await wl.refresh();
    expect(wl.list.map((e) => e.ticker)).toEqual(['A']);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
