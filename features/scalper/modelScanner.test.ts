// 모델 스캐너 — 봉 마감마다 전 종목 판정, 임계값 초과에서만 BUY, 조회는 첫 회만 그날치.

import { describe, expect, it, vi } from 'vitest';
import type { OhlcvBar } from '../../core/model/bars';
import type { GbdtModel } from '../../core/model/gbdt';
import {
  MODEL_INCREMENTAL_BAR_COUNT,
  MODEL_SEED_BAR_COUNT,
  ModelScanner,
  MODEL_SCAN_DELAY_MS,
} from './modelScanner';

const at = (iso: string): number => Math.floor(Date.parse(iso) / 60_000);
const BAR = 5;

/** 한 Feature(return_1bar, 인덱스 0)만 보는 1트리 모델 — 문턱을 넘으면 raw +10(확률≈1). */
function stubModel(features: string[]): GbdtModel {
  return {
    kind: 'lgbm-binary-flat',
    features,
    sigmoid: 1,
    threshold: 0.9,
    trees: [{ f: [0], t: [0.001], l: [~0], r: [~1], d: [1], m: [2], v: [-10, 10], root: 0 }],
  };
}

/** 09:30부터 5분 간격 봉 n개 — 마지막 봉의 상승률만 up으로 준다. */
function bars(n: number, lastUp: number): OhlcvBar[] {
  const start = at('2026-08-18T09:30:00-04:00');
  const out: OhlcvBar[] = [];
  let close = 100;
  for (let i = 0; i < n; i += 1) {
    const next = i === n - 1 ? close * (1 + lastUp) : close;
    out.push({ minuteKey: start + i * BAR, open: close, high: next, low: close, close: next, volume: 100_000 });
    close = next;
  }
  return out;
}

interface Harness {
  scanner: ModelScanner;
  signals: Array<{ ticker: string; prob: number | null }>;
  verdicts: Array<{ ticker: string; prob: number | null; reject: string | null }>;
  counts: number[];
  now: { value: number };
}

function harness(all: OhlcvBar[], opts: { tickers?: string[] } = {}): Harness {
  const signals: Array<{ ticker: string; prob: number | null }> = [];
  const verdicts: Array<{ ticker: string; prob: number | null; reject: string | null }> = [];
  const counts: number[] = [];
  const now = { value: (all[all.length - 1].minuteKey + BAR) * 60_000 + MODEL_SCAN_DELAY_MS };
  const scanner = new ModelScanner({
    model: stubModel(['return_1bar']),
    clock: { now: () => now.value },
    scheduler: { setInterval: () => 1, clearInterval: () => undefined },
    barMinutes: BAR,
    tickers: () => opts.tickers ?? ['AAPL'],
    fetchBars: async (_t, count) => {
      counts.push(count);
      return all.slice(Math.max(0, all.length - count));
    },
    fetchDailyCloses: async () => [{ date: '2026-08-15', close: 99 }, { date: '2026-08-14', close: 98 }],
    onSignal: (ticker, ev) => signals.push({ ticker, prob: ev.prob }),
    onVerdict: (ticker, ev) => verdicts.push({ ticker, prob: ev.prob, reject: ev.reject }),
  });
  return { scanner, signals, verdicts, counts, now };
}

describe('ModelScanner', () => {
  it('마지막 봉이 임계값을 넘으면 BUY를 낸다 — 확률도 함께 준다', async () => {
    const h = harness(bars(30, 0.02));
    await h.scanner.pump();
    expect(h.signals).toHaveLength(1);
    expect(h.signals[0].ticker).toBe('AAPL');
    expect(h.signals[0].prob).toBeGreaterThan(0.9);
    expect(h.verdicts).toHaveLength(1);
    expect(h.verdicts[0]).toMatchObject({ ticker: 'AAPL', reject: null });
  });

  it('임계값에 못 미치면 신호가 없다 — 판정 결과(onVerdict)는 그래도 나온다', async () => {
    const h = harness(bars(30, 0));
    await h.scanner.pump();
    expect(h.signals).toHaveLength(0);
    expect(h.verdicts).toHaveLength(1);
    expect(h.verdicts[0]).toMatchObject({ ticker: 'AAPL', reject: 'prob' });
    expect(h.verdicts[0].prob).not.toBeNull();
  });

  it('첫 조회는 그날치, 이후 봉부터는 몇 봉만 덧붙인다', async () => {
    const all = bars(30, 0.02);
    const h = harness(all);
    await h.scanner.pump();
    expect(h.counts).toEqual([MODEL_SEED_BAR_COUNT]);

    // 다음 봉이 닫혔다 — 봉 하나를 더 얹고 시계를 옮긴다.
    const nextKey = all[all.length - 1].minuteKey + BAR;
    all.push({ minuteKey: nextKey, open: 100, high: 103, low: 100, close: 103, volume: 100_000 });
    h.now.value = (nextKey + BAR) * 60_000 + MODEL_SCAN_DELAY_MS;
    await h.scanner.pump();
    expect(h.counts).toEqual([MODEL_SEED_BAR_COUNT, MODEL_INCREMENTAL_BAR_COUNT]);
  });

  it('같은 봉을 두 번 판정하지 않는다 — 스캔을 여러 번 돌려도 신호는 한 번', async () => {
    const h = harness(bars(30, 0.02));
    await h.scanner.pump();
    await h.scanner.pump();
    await h.scanner.pump();
    expect(h.signals).toHaveLength(1);
  });

  it('정규장이 아닌 봉에서는 신호를 내지 않는다(학습의 session==main 필터)', async () => {
    // 04:00부터 시작하는 프리마켓 봉만
    const start = at('2026-08-18T04:00:00-04:00');
    const pre: OhlcvBar[] = [];
    let close = 100;
    for (let i = 0; i < 30; i += 1) {
      const next = i === 29 ? close * 1.02 : close;
      pre.push({ minuteKey: start + i * BAR, open: close, high: next, low: close, close: next, volume: 100_000 });
      close = next;
    }
    const h = harness(pre);
    await h.scanner.pump();
    expect(h.signals).toHaveLength(0);
    expect(h.verdicts[0]).toMatchObject({ reject: 'session' }); // 화면은 "정규장 아님"을 읽을 수 있다
  });

  it('누적 거래대금이 $2M에 못 미치면 신호를 내지 않는다(감지 가능 시점 필터)', async () => {
    const thin = bars(30, 0.02).map((b) => ({ ...b, volume: 1 }));
    const h = harness(thin);
    await h.scanner.pump();
    expect(h.signals).toHaveLength(0);
    expect(h.verdicts[0]).toMatchObject({ reject: 'liquidity' });
  });

  it('조회가 실패하면 그 종목만 건너뛰고 다른 종목은 계속 본다', async () => {
    const all = bars(30, 0.02);
    const signals: string[] = [];
    const scanner = new ModelScanner({
      model: stubModel(['return_1bar']),
      clock: { now: () => (all[all.length - 1].minuteKey + BAR) * 60_000 + MODEL_SCAN_DELAY_MS },
      scheduler: { setInterval: () => 1, clearInterval: () => undefined },
      barMinutes: BAR,
      tickers: () => ['BAD', 'GOOD'],
      fetchBars: async (t, count) => {
        if (t === 'BAD') throw new Error('네트워크');
        return all.slice(Math.max(0, all.length - count));
      },
      fetchDailyCloses: async () => [],
      onSignal: (t) => signals.push(t),
    });
    await scanner.pump();
    expect(signals).toEqual(['GOOD']);
  });

  it('전일 종가 조회가 실패해도 신호는 계속 난다(전일 Feature만 결측)', async () => {
    const all = bars(30, 0.02);
    const signals: string[] = [];
    const daily = vi.fn(async () => {
      throw new Error('일봉 실패');
    });
    const scanner = new ModelScanner({
      model: stubModel(['return_1bar']),
      clock: { now: () => (all[all.length - 1].minuteKey + BAR) * 60_000 + MODEL_SCAN_DELAY_MS },
      scheduler: { setInterval: () => 1, clearInterval: () => undefined },
      barMinutes: BAR,
      tickers: () => ['AAPL'],
      fetchBars: async (_t, count) => all.slice(Math.max(0, all.length - count)),
      fetchDailyCloses: daily,
      onSignal: (t) => signals.push(t),
    });
    await scanner.pump();
    expect(daily).toHaveBeenCalledTimes(1);
    expect(signals).toEqual(['AAPL']);
  });

  it('장이 닫혀 새 봉이 없으면 — 가진 봉으로 판정을 알리되 매수 신호는 내지 않고, 다음 봉까지 재조회하지 않는다', async () => {
    const h = harness(bars(30, 0.02)); // 마지막 봉이 임계값을 넘는 자리
    h.now.value += 30 * 60_000; // 목표 봉보다 6봉 뒤 — "장 닫힘"으로 판정된다
    await h.scanner.pump();
    expect(h.signals).toHaveLength(0); // 옛 봉으로는 사지 않는다
    expect(h.verdicts).toHaveLength(1); // 화면에는 상황이 간다
    expect(h.verdicts[0].reject).toBeNull();
    await h.scanner.pump(); // 같은 봉 주기 안 — 재조회·재판정 없음(밤새 20초마다 헛조회하던 문제)
    expect(h.counts).toHaveLength(1);
    expect(h.verdicts).toHaveLength(1);
  });

  it('장중 토스 지연(목표 봉이 2봉 이내로 늦음)은 판정을 미루고 다음 점검 때 다시 조회한다', async () => {
    const h = harness(bars(30, 0));
    h.now.value += 5 * 60_000; // 목표 봉보다 1봉 뒤 — 곧 올라올 봉을 기다린다
    await h.scanner.pump();
    expect(h.verdicts).toHaveLength(0);
    await h.scanner.pump();
    expect(h.counts).toHaveLength(2); // 재시도마다 다시 조회
  });

  it('리스트에서 빠진 종목의 봉·맥락은 버린다', async () => {
    const h = harness(bars(30, 0.02));
    await h.scanner.pump();
    expect(h.scanner.barCount('AAPL')).toBeGreaterThan(0);
    h.scanner.drop('AAPL');
    expect(h.scanner.barCount('AAPL')).toBeNull();
  });
});
