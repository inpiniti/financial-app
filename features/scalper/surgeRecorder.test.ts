import { describe, expect, it } from 'vitest';
import { SurgeRecorder, type SurgeRecorderDeps } from './surgeRecorder';
import type { SurgeAlert, SurgeSignal } from '../../core/surge';
import type { SurgeLogClient } from '../../lib/surgeLog';

function makeAlert(at: number): SurgeAlert {
  return { kind: 'alert', at, price: 100, shortRate: 6, baselineRate: 1 };
}

function makeSignal(kind: 'surge' | 'exit', at: number): SurgeSignal {
  return { kind, at, price: 100, runLength: 4, shortRate: 6, baselineRate: 1, trailingHigh: kind === 'exit' ? 101 : null };
}

/** 호출 기록 남기는 가짜 기록 클라이언트 — id는 db-N. */
function fakeLog() {
  let seq = 0;
  const calls: string[] = [];
  const log: SurgeLogClient = {
    insertOpen: async (input) => {
      calls.push(`open:${input.ticker}`);
      seq += 1;
      return `db-${seq}`;
    },
    close: async (id) => {
      calls.push(`close:${id}`);
      return true;
    },
    expire: async (id) => {
      calls.push(`expire:${id}`);
      return true;
    },
    sweepOrphans: async () => {
      calls.push('sweep');
      return 0;
    },
  };
  return { log, calls };
}

function makeHarness(overrides: Partial<SurgeRecorderDeps> = {}) {
  let now = 1_000_000;
  const timers: { fn: () => void }[] = [];
  const events: string[] = [];
  let targetsChangedCount = 0;
  const { log, calls } = fakeLog();
  let quote: { bid1: number; ask1: number; bid2: number | null; ask2: number | null; at: number } | null = null;

  const recorder = new SurgeRecorder({
    clock: { now: () => now },
    scheduler: {
      setInterval: (fn) => {
        const h = { fn };
        timers.push(h);
        return h;
      },
      clearInterval: (h) => {
        const idx = timers.indexOf(h as { fn: () => void });
        if (idx >= 0) timers.splice(idx, 1);
      },
    },
    log,
    getQuote: () => quote,
    getMarket: () => 'NAS',
    onQuoteTargetsChanged: () => {
      targetsChangedCount += 1;
    },
    onEvent: (text) => events.push(text),
    ...overrides,
  });

  return {
    recorder,
    calls,
    events,
    setNow: (t: number) => {
      now = t;
    },
    getNow: () => now,
    setQuote: (q: typeof quote) => {
      quote = q;
    },
    fireSweep: () => timers.forEach((t) => t.fn()),
    targetsChanged: () => targetsChangedCount,
  };
}

/** DB insert 비동기 완료 대기(마이크로태스크 소진). */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('SurgeRecorder — 에피소드 상태기계', () => {
  it('surge → open 에피소드 + insertOpen, id가 DB id로 갱신된다', async () => {
    const h = makeHarness();
    h.recorder.enable();
    h.setQuote({ bid1: 99.9, ask1: 100.1, bid2: 99.8, ask2: 100.2, at: h.getNow() });
    h.recorder.handleSignal('AAPL', makeSignal('surge', h.getNow()), 100.05);
    await flush();
    const [ep] = h.recorder.recentEpisodes;
    expect(ep.status).toBe('open');
    expect(ep.surgeAsk1).toBe(100.1);
    expect(ep.surgeAsk2).toBe(100.2);
    expect(ep.logged).toBe(true);
    expect(ep.id).toBe('db-1');
    expect(h.calls).toContain('open:AAPL');
  });

  it('exit(이탈)가 열린 에피소드를 closed로 종결하고 변동율을 계산한다', async () => {
    const h = makeHarness();
    h.recorder.enable();
    h.setQuote({ bid1: 99.9, ask1: 100, bid2: null, ask2: null, at: h.getNow() });
    h.recorder.handleSignal('AAPL', makeSignal('surge', h.getNow()), 100);
    await flush();
    h.setNow(h.getNow() + 60_000);
    h.setQuote({ bid1: 97, ask1: 97.2, bid2: 96.9, ask2: null, at: h.getNow() });
    h.recorder.handleSignal('AAPL', makeSignal('exit', h.getNow()), 97.1);
    await flush();
    const [ep] = h.recorder.recentEpisodes;
    expect(ep.status).toBe('closed');
    expect(ep.plungeBid1).toBe(97);
    expect(ep.priceChangePct).toBeCloseTo(-2.9, 1);
    expect(ep.l1ChangePct).toBeCloseTo(-3, 1); // 100에 사서 97에 판 값.
    expect(h.calls).toContain('close:db-1');
  });

  it('열린 에피소드 중 재급등은 무시된다', async () => {
    const h = makeHarness();
    h.recorder.enable();
    h.recorder.handleSignal('AAPL', makeSignal('surge', h.getNow()), 100);
    await flush();
    h.recorder.handleSignal('AAPL', makeSignal('surge', h.getNow() + 120_000), 105);
    await flush();
    expect(h.recorder.recentEpisodes).toHaveLength(1);
    expect(h.calls.filter((c) => c === 'open:AAPL')).toHaveLength(1);
  });

  it('열린 에피소드 없는 exit는 버린다 — 세트만 기록한다', async () => {
    const h = makeHarness();
    h.recorder.enable();
    h.recorder.handleSignal('TSLA', makeSignal('exit', h.getNow()), 200);
    await flush();
    expect(h.recorder.recentEpisodes).toHaveLength(0);
    expect(h.calls.filter((c) => c.startsWith('close') || c.startsWith('open'))).toHaveLength(0);
  });

  it('낡은 호가 캐시(10초 초과)는 스냅샷에 쓰지 않는다', async () => {
    const h = makeHarness();
    h.recorder.enable();
    h.setQuote({ bid1: 99, ask1: 99.5, bid2: null, ask2: null, at: h.getNow() - 20_000 });
    h.recorder.handleSignal('AAPL', makeSignal('surge', h.getNow()), 100);
    await flush();
    expect(h.recorder.recentEpisodes[0].surgeAsk1).toBeNull();
  });

  it('타임아웃(30분) 지난 open 에피소드는 sweep에서 expired', async () => {
    const h = makeHarness();
    h.recorder.enable();
    h.recorder.handleSignal('AAPL', makeSignal('surge', h.getNow()), 100);
    await flush();
    h.setNow(h.getNow() + 31 * 60_000);
    h.fireSweep();
    expect(h.recorder.recentEpisodes[0].status).toBe('expired');
    expect(h.calls).toContain('expire:db-1');
  });

  it('disable(Stop)이 열린 에피소드를 전부 expired로 마감한다', async () => {
    const h = makeHarness();
    h.recorder.enable();
    h.recorder.handleSignal('AAPL', makeSignal('surge', h.getNow()), 100);
    h.recorder.handleSignal('TSLA', makeSignal('surge', h.getNow()), 200);
    await flush();
    h.recorder.disable();
    const statuses = h.recorder.recentEpisodes.map((e) => e.status);
    expect(statuses).toEqual(['expired', 'expired']);
    // 비활성 상태에서 오는 신호는 무시된다.
    h.recorder.handleSignal('NVDA', makeSignal('surge', h.getNow()), 300);
    expect(h.recorder.recentEpisodes).toHaveLength(2);
  });

  it('enable 시 DB 고아 open 행을 쓸어낸다(sweepOrphans)', () => {
    const h = makeHarness();
    h.recorder.enable();
    expect(h.calls).toContain('sweep');
  });
});

describe('SurgeRecorder — 조기경보·호가 예열', () => {
  it('경보는 quoteTargets에 올리고(alerting 행 표시) 기록은 하지 않는다', () => {
    const h = makeHarness();
    h.recorder.enable();
    h.recorder.handleAlert('AAPL', makeAlert(h.getNow()));
    expect(h.recorder.quoteTargets()).toContain('AAPL');
    expect(h.recorder.recentEpisodes[0].status).toBe('alerting');
    expect(h.calls.filter((c) => c.startsWith('open') || c.startsWith('plunge'))).toHaveLength(0);
  });

  it('예열 상한(3) 초과 시 가장 오래된 경보부터 밀려난다(LRU)', () => {
    const h = makeHarness();
    h.recorder.enable();
    for (const [i, ticker] of ['A', 'B', 'C', 'D'].entries()) {
      h.recorder.handleAlert(ticker, makeAlert(h.getNow() + i * 1000));
    }
    const targets = h.recorder.quoteTargets();
    expect(targets).toHaveLength(3);
    expect(targets).not.toContain('A');
    expect(targets).toContain('D');
  });

  it('경보가 surge로 승격되면 alerting 행이 open 행으로 대체된다', async () => {
    const h = makeHarness();
    h.recorder.enable();
    h.recorder.handleAlert('AAPL', makeAlert(h.getNow()));
    h.recorder.handleSignal('AAPL', makeSignal('surge', h.getNow() + 3000), 100);
    await flush();
    const rows = h.recorder.recentEpisodes.filter((e) => e.ticker === 'AAPL');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('open');
  });

  it('확정 없이 식은 경보는 TTL(60초) 후 sweep에서 사라진다', () => {
    const h = makeHarness();
    h.recorder.enable();
    h.recorder.handleAlert('AAPL', makeAlert(h.getNow()));
    h.setNow(h.getNow() + 61_000);
    h.fireSweep();
    expect(h.recorder.quoteTargets()).not.toContain('AAPL');
    expect(h.recorder.recentEpisodes).toHaveLength(0);
  });
});
