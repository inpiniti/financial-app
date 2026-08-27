import { describe, expect, it, vi } from 'vitest';

import type { SchedulerLike } from './types';
import {
  computeDesired,
  isOrderable,
  isWithinMaxPrice,
  parseSignedRate,
  ScalperWatchlist,
  WATCHLIST_MAX_SIZE,
  WATCHLIST_POLL_INTERVAL_MS,
  type RankingSnapshot,
  type WatchCandidateRow,
} from './watchlist';

function row(symb: string, rate: string, extra: Partial<WatchCandidateRow> = {}): WatchCandidateRow {
  return { symb, rate, ...extra };
}

/** 옛 2원천 구성(거래대금 → 거래량, 각 15)을 스냅샷 배열로 — 우선권은 배열 순서. */
function snapshot(partial: { tossAmount?: WatchCandidateRow[]; tossVolume?: WatchCandidateRow[] }): RankingSnapshot {
  return [
    { source: 'tossAmount', count: 15, rows: partial.tossAmount ?? [] },
    { source: 'tossVolume', count: 15, rows: partial.tossVolume ?? [] },
  ];
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

describe('computeDesired — 필터·중복 제거·차순위 충원', () => {
  it('원천별 상위 15개씩, 겹치는 티커는 앞 원천(거래대금)이 가져가고 뒤 원천은 차순위 충원한다', () => {
    const rows = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => row(`${prefix}${i + 1}`, '1'));
    // 거래대금 20종 + 거래량 20종(앞 5종은 거래대금 상위와 중복).
    const amount = rows('A', 20);
    const volume = [...rows('A', 5), ...rows('V', 15)];
    const desired = computeDesired(snapshot({ tossAmount: amount, tossVolume: volume }));

    // 2종 × 15 = 총 30(2026-08-14 거래대금+거래량 확장 — 총 크기는 30 유지).
    expect(WATCHLIST_MAX_SIZE).toBe(30);
    expect(desired).toHaveLength(30);
    const amountSide = desired.filter((e) => e.source === 'tossAmount').map((e) => e.ticker);
    const volumeSide = desired.filter((e) => e.source === 'tossVolume').map((e) => e.ticker);
    expect(amountSide).toEqual(Array.from({ length: 15 }, (_, i) => `A${i + 1}`));
    // A1~A5는 거래대금에 이미 채용 — 거래량은 V1~V15로 채운다.
    expect(volumeSide).toEqual(Array.from({ length: 15 }, (_, i) => `V${i + 1}`));
  });

  it('가격 하한은 없다(2026-08-27, $1 이하 배제 필터 제거) — 초저가 종목도 순위 그대로 리스트에 오른다', () => {
    const rows = [row('P', '1', { last: '0.80' }), row('A', '1', { last: '5' }), row('B', '1', { last: '3' })];
    const desired = computeDesired([{ source: 's', count: 2, rows }]);
    expect(desired.map((e) => e.ticker)).toEqual(['P', 'A']);
  });

  it('순위가 비면(조회 실패 등) 리스트도 비운다', () => {
    expect(computeDesired(snapshot({ tossVolume: [] }))).toHaveLength(0);
    expect(computeDesired([])).toHaveLength(0); // 계획이 비면(원천을 다 끔) 리스트도 빈다.
  });

  it('원천별 count가 채용 개수를 정하고, 총합은 WATCHLIST_MAX_SIZE에서 잘린다(2026-08-18 순위 도메인)', () => {
    const rows = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => row(`${prefix}${i + 1}`, '1'));
    const desired = computeDesired([
      { source: 'toss:amount:realtime:norisk', count: 3, rows: rows('A', 10) },
      { source: 'kis:tradeVolume', count: 2, rows: [row('A1', '1'), ...rows('K', 10)] }, // A1은 앞 원천이 채용 — 차순위 충원.
      { source: 'x', count: 0, rows: rows('X', 3) }, // 0개 — 채용 없음.
    ]);
    expect(desired.map((e) => [e.ticker, e.source])).toEqual([
      ['A1', 'toss:amount:realtime:norisk'],
      ['A2', 'toss:amount:realtime:norisk'],
      ['A3', 'toss:amount:realtime:norisk'],
      ['K1', 'kis:tradeVolume'],
      ['K2', 'kis:tradeVolume'],
    ]);

    const capped = computeDesired([
      { source: 'p', count: 25, rows: rows('P', 40) },
      { source: 'q', count: 25, rows: rows('Q', 40) },
    ]);
    expect(capped).toHaveLength(WATCHLIST_MAX_SIZE);
    expect(capped.filter((e) => e.source === 'q')).toHaveLength(5);
  });

  it('음전(-)·보합(0)·주문불가·빈 티커는 건너뛰고 차순위로 충원한다', () => {
    const desired = computeDesired(
      snapshot({
        tossVolume: [
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

  it('같은 티커가 두 번 오면 첫 번째만 채용한다', () => {
    const desired = computeDesired(
      snapshot({ tossVolume: [row('AAPL', '1'), row('MSFT', '1'), row('AAPL', '9'), row('NVDA', '1')] }),
    );
    expect(desired.map((e) => e.ticker)).toEqual(['AAPL', 'MSFT', 'NVDA']);
    expect(desired[0].rate).toBe(1); // 나중 행이 앞 행을 덮어쓰지 않는다.
  });

  it('후보가 모자라면 슬롯을 비워둔다(억지 충원 없음)', () => {
    const desired = computeDesired(snapshot({ tossVolume: [row('A', '1')] }));
    expect(desired).toHaveLength(1);
  });

  it('진입금액 상한을 넘는 종목은 건너뛰고 차순위로 충원한다', () => {
    const desired = computeDesired(
      snapshot({
        tossVolume: [
          row('RICH', '5', { last: '42.10' }), // 상한($10) 초과 — 제외.
          row('EDGE', '4', { last: '10.00' }), // 정확히 상한 — 1주 진입 가능, 채용.
          row('PENNY', '3', { last: '4.20' }),
          row('CHEAP', '2', { last: '8.70' }),
          row('SPARE', '1', { last: '5.50' }),
        ],
      }),
      10,
    );
    expect(desired.map((e) => e.ticker)).toEqual(['EDGE', 'PENNY', 'CHEAP', 'SPARE']);
  });

  it('행의 excd를 채용 거래소(market)로 기록한다 — 없거나 모르는 값은 NAS', () => {
    const desired = computeDesired(
      snapshot({
        tossVolume: [row('N', '1', { excd: 'NYS' }), row('A', '1', { excd: 'AMS' }), row('X', '1')],
      }),
    );
    expect(desired.map((e) => [e.ticker, e.market])).toEqual([
      ['N', 'NYS'],
      ['A', 'AMS'],
      ['X', 'NAS'],
    ]);
  });

  it('행의 종목명(name)을 엔트리로 옮긴다 — 공백·빈 값은 undefined(화면이 티커로 폴백)', () => {
    const desired = computeDesired(
      snapshot({ tossVolume: [row('TSLA', '1', { name: ' 테슬라 ' }), row('NVDA', '1', { name: '  ' }), row('AMD', '1')] }),
    );
    expect(desired.map((e) => [e.ticker, e.name])).toEqual([
      ['TSLA', '테슬라'],
      ['NVDA', undefined],
      ['AMD', undefined],
    ]);
  });

  it('상한 미지정이면 가격 필터 없이 기존과 동일하게 동작한다', () => {
    const desired = computeDesired(
      snapshot({ tossVolume: [row('RICH', '5', { last: '42.10' }), row('A', '1', { last: '5' })] }),
    );
    expect(desired.map((e) => e.ticker)).toEqual(['RICH', 'A']);
  });
});

describe('ScalperWatchlist — 폴링·diff·핀 유예', () => {
  it('start 시 즉시 1회 갱신하고, 주기 tick마다 재갱신한다', async () => {
    const sched = manualScheduler();
    const fetchSnapshot = vi
      .fn<() => Promise<RankingSnapshot>>()
      .mockResolvedValue(snapshot({ tossVolume: [row('A', '1')] }));
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
      .mockResolvedValueOnce(snapshot({ tossVolume: [row('A', '1'), row('B', '1')] }))
      .mockResolvedValueOnce(snapshot({ tossVolume: [row('B', '1'), row('C', '1')] }));
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
    const twelveRows = (names: string[]) => ({ tossVolume: names.map((n) => row(n, '1')) });
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
      .mockResolvedValue(snapshot({ tossVolume: [row('A', '1')] }));
    const wl = new ScalperWatchlist({ fetchSnapshot, scheduler });

    await wl.refresh();
    wl.pin('A');
    await wl.refresh();
    wl.unpin('A');
    expect(wl.has('A')).toBe(true);
    expect(wl.list.find((e) => e.ticker === 'A')!.pinned).toBe(false);
  });

  it('유지 종목의 종목명은 한 번 알아낸 값을 지킨다 — 이름 없이 온 응답에 이름이 사라지지 않는다', async () => {
    const { scheduler } = manualScheduler();
    const fetchSnapshot = vi
      .fn<() => Promise<RankingSnapshot>>()
      .mockResolvedValueOnce(snapshot({ tossVolume: [row('TSLA', '1', { name: '테슬라' })] }))
      .mockResolvedValueOnce(snapshot({ tossVolume: [row('TSLA', '2')] }));
    const wl = new ScalperWatchlist({ fetchSnapshot, scheduler });

    await wl.refresh();
    expect(wl.list[0].name).toBe('테슬라');
    await wl.refresh();
    expect(wl.list[0].name).toBe('테슬라');
    expect(wl.list[0].rate).toBe(2); // 등락률은 최신화된다.
  });

  it('maxPriceUsd getter를 갱신마다 읽어 진입금액 초과 종목을 거른다 — 설정 변경도 다음 갱신에 반영', async () => {
    const { scheduler } = manualScheduler();
    let limit: number | null = 10;
    const fetchSnapshot = vi
      .fn<() => Promise<RankingSnapshot>>()
      .mockResolvedValue(snapshot({ tossVolume: [row('RICH', '5', { last: '42.10' }), row('A', '1', { last: '5.00' })] }));
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
      .mockResolvedValueOnce(snapshot({ tossVolume: [row('A', '1')] }))
      .mockRejectedValueOnce(new Error('KIS 500'));
    const wl = new ScalperWatchlist({ fetchSnapshot, scheduler, onError });

    await wl.refresh();
    await wl.refresh();
    expect(wl.list.map((e) => e.ticker)).toEqual(['A']);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
