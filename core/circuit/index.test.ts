import { describe, expect, it } from 'vitest';
import { CircuitExitRule, HaltDetector, HaltSequence } from './index';
import { TrendExitRule } from '../trend/exitRule';

/**
 * AIXC 2026-08-18(ET) 정지 직전가 수열 — 토스 1분봉 실측(docs/domain/서킷/2026-08-19_서킷-개념과-설계.md §2).
 * 재개 창은 분봉으로 못 재서 3초로 둔다(사용자 체감 5초, 60초 미만은 확실).
 */
const AIXC_HALT_PRICES = [
  1.19, 1.51, 1.77, 1.93, 1.69, 1.78, 2.2, 2.4, 2.65, 2.95, 2.59, 2.67, 3.14, 2.99, 2.45, 2.12, 1.85, 1.81, 1.82,
  1.73, 1.53,
];

const SEC = 1000;

/** 활발한 거래 구간 — 1초 간격 체결 n건. 마지막 체결가는 endPrice. 반환: 마지막 체결 시각. */
function trade(rule: CircuitExitRule, fromMs: number, n: number, price: number, regular = true): number {
  let t = fromMs;
  for (let i = 0; i < n; i++) {
    t = fromMs + i * SEC;
    rule.heartbeat({ nowMs: t, price, lastTradeAt: t, regularSession: regular });
  }
  return t;
}

/** 무체결 구간 — quietMs를 넘길 때까지 1초 폴. 마지막 heartbeat 결과를 돌려준다. */
function silence(rule: CircuitExitRule, lastTradeAt: number, price: number, seconds: number, regular = true) {
  let last = rule.heartbeat({ nowMs: lastTradeAt + SEC, price, lastTradeAt, regularSession: regular });
  const all = [...last.events];
  let decision = last.decision;
  let reason = last.reason;
  for (let s = 2; s <= seconds; s++) {
    last = rule.heartbeat({ nowMs: lastTradeAt + s * SEC, price, lastTradeAt, regularSession: regular });
    all.push(...last.events);
    if (last.decision) {
      decision = last.decision;
      reason = last.reason;
    }
  }
  return { events: all, decision, reason };
}

function makeRule(act = true, opts: { stopLossPct?: number; entry?: number } = {}) {
  const inner = new TrendExitRule({ qty: 10, avgPrice: opts.entry ?? 1.0 }, { stopLossPct: opts.stopLossPct ?? 0.07 });
  return new CircuitExitRule(inner, { act });
}

describe('HaltDetector — 무체결 45초 + 직전 3분 활발', () => {
  it('활발한 뒤 45초 무체결이면 정지 의심 1회, 재개 첫 체결에 RESUME(갭·정지 길이)', () => {
    const d = new HaltDetector();
    let t = 0;
    for (let i = 0; i < 40; i++) {
      t = i * SEC;
      d.pushTrade(1.0 + i * 0.001, t);
    }
    expect(d.poll(t + 44 * SEC)).toBeNull();
    const ev = d.poll(t + 45 * SEC);
    expect(ev?.kind).toBe('HALT_SUSPECT');
    expect(d.state).toBe('HALTED');
    expect(d.poll(t + 46 * SEC)).toBeNull(); // 같은 정지에서 반복 없음
    const r = d.pushTrade(1.2, t + 300 * SEC);
    expect(r?.kind).toBe('RESUME');
    if (r?.kind === 'RESUME') {
      expect(r.gapPct).toBeCloseTo(1.2 / 1.039 - 1, 6);
      expect(r.haltedMs).toBe(300 * SEC);
    }
    expect(d.state).toBe('TRADING');
  });

  it('직전 정지 뒤 15분 안에는 활발함 문턱을 풀어 재개 뒤 체결 몇 건 + 무체결로도 정지를 본다(서킷 연속 구간)', () => {
    const d = new HaltDetector();
    let t = 0;
    for (let i = 0; i < 40; i++) {
      t = i * SEC;
      d.pushTrade(1.0, t);
    }
    expect(d.poll(t + 45 * SEC)?.kind).toBe('HALT_SUSPECT');
    const resume = t + 300 * SEC;
    d.pushTrade(1.2, resume);
    d.pushTrade(1.21, resume + SEC);
    d.pushTrade(1.22, resume + 2 * SEC);
    expect(d.poll(resume + 2 * SEC + 45 * SEC)?.kind).toBe('HALT_SUSPECT');
  });

  it('저유동(3분 안 체결 30건 미만)의 공백은 정지가 아니다', () => {
    const d = new HaltDetector();
    for (let i = 0; i < 10; i++) d.pushTrade(1.0, i * 10 * SEC);
    expect(d.poll(90 * SEC + 60 * SEC)).toBeNull();
    expect(d.state).toBe('TRADING');
  });

  it('같은/과거 시각 체결은 중복 기록하지 않는다(1초 폴이 같은 lastTradeAt을 반복 넘겨도 안전)', () => {
    const d = new HaltDetector({ minActiveTicks: 3 });
    d.pushTrade(1.0, 1000);
    expect(d.pushTrade(1.0, 1000)).toBeNull();
    expect(d.pushTrade(1.0, 500)).toBeNull();
    d.pushTrade(1.0, 2000);
    expect(d.poll(2000 + 45 * SEC)).toBeNull(); // 체결 2건 < 3
  });
});

describe('HaltSequence — 방향·연속 하킷·재개 창·서킷 상태', () => {
  it('첫 정지는 refPrice 대비, 이후는 직전 정지가 대비. 하킷 1회 뒤 상킷이면 연속 리셋', () => {
    const s = new HaltSequence();
    s.onHalt(1.19, 0, 0.83);
    expect(s.last?.dir).toBe(1);
    s.onResume(1);
    s.onHalt(1.93, 2, 0); // 상킷(직전 1.19 대비)
    s.onResume(3);
    s.onHalt(1.69, 4, 0); // 하킷
    expect(s.consecutiveDown).toBe(1);
    s.onResume(5);
    s.onHalt(1.78, 6, 0); // 상킷 → 리셋
    expect(s.consecutiveDown).toBe(0);
    s.onResume(7);
    s.onHalt(1.5, 8, 0);
    s.onResume(9);
    s.onHalt(1.4, 10, 0);
    expect(s.consecutiveDown).toBe(2);
  });

  it('재개 창 60초 미만 재정지 → 서킷 상태, 재개 뒤 300초 무정지 → 해제', () => {
    const s = new HaltSequence();
    s.onHalt(2.0, 0, 1.0);
    expect(s.circuitActive(0)).toBe(false);
    s.onResume(300 * SEC);
    s.onHalt(2.2, 300 * SEC + 3 * SEC, 0); // 창 3초
    expect(s.last?.windowSec).toBe(3);
    expect(s.circuitActive(310 * SEC)).toBe(true);
    s.onResume(600 * SEC);
    expect(s.circuitActive(600 * SEC + 299 * SEC)).toBe(true);
    expect(s.circuitActive(600 * SEC + 300 * SEC)).toBe(false);
  });

  it('고립 정지(재개 뒤 창 ≥ 60초)는 서킷 상태가 아니다', () => {
    const s = new HaltSequence();
    s.onHalt(2.0, 0, 1.0);
    s.onResume(300 * SEC);
    s.onHalt(1.9, 300 * SEC + 120 * SEC, 0);
    expect(s.circuitActive(500 * SEC)).toBe(false);
  });
});

describe('CircuitExitRule — AIXC 08-18 재현', () => {
  /** 활발 60건 → 정지(감지) → 300초 뒤 재개 → 창 3초(3건) → 정지 … 를 정지가 수열대로 돌린다. */
  function replay(rule: CircuitExitRule, prices: number[]) {
    const out: { idx: number; decision: ReturnType<CircuitExitRule['heartbeat']>['decision']; reason: string | null; inCircuit: boolean }[] = [];
    let t = 0;
    let last = trade(rule, t, 60, 0.83); // 진입 후 활발(refPrice 0.83)
    for (let k = 0; k < prices.length; k++) {
      // 창: 첫 정지 전은 60건(활발), 이후는 3건(3초). 마지막 체결가 = 정지 직전가.
      if (k > 0) last = trade(rule, last + 300 * SEC, 3, prices[k]);
      else last = trade(rule, last + SEC, 1, prices[k]);
      const r = silence(rule, last, prices[k], 46);
      const halt = r.events.find((e) => e.kind === 'HALT');
      out.push({ idx: k, decision: r.decision, reason: r.reason, inCircuit: halt?.kind === 'HALT' ? halt.inCircuit : false });
    }
    return out;
  }

  it('act=true: 하킷 2연속(15번째 정지 2.45)에서 처음 발화, 지정가 = 2.45×0.88, 그 전 하킷 1회(1.69·2.59)는 홀드', () => {
    const rule = makeRule(true);
    const out = replay(rule, AIXC_HALT_PRICES);
    const fired = out.filter((o) => o.decision !== null);
    expect(fired[0]?.idx).toBe(14); // 0-based: 2.45
    expect(fired[0]?.reason).toBe('CIRCUIT');
    const d = fired[0]!.decision!;
    expect(d.side).toBe('sell');
    expect(d.qty).toBe(10);
    if (d.side === 'sell') {
      expect(d.limitPrice).toBeCloseTo(2.45 * 0.88, 6);
      expect(d.chaseAfterTradeAt).toBeGreaterThan(0);
    }
    // 1.69(idx 4)·2.59(idx 10)에선 결정 없음
    expect(out[4].decision).toBeNull();
    expect(out[10].decision).toBeNull();
    // 첫 정지 뒤 두 번째 정지(창 3초)부터 서킷 상태
    expect(out[0].inCircuit).toBe(false);
    expect(out[1].inCircuit).toBe(true);
  });

  it('서킷 상태면 ma5 SELL 신호를 무시하고, 해제되면 다시 통과한다', () => {
    const rule = makeRule(true);
    replay(rule, AIXC_HALT_PRICES.slice(0, 3));
    expect(rule.inCircuit).toBe(true);
    expect(rule.decide('SELL', 1.7)).toBeNull();
    // 재개 뒤 300초 동안 체결이 이어지고 정지 없음 → 해제
    const last = rule.detector.lastTradeAt!;
    trade(rule, last + 300 * SEC, 302, 1.8);
    expect(rule.inCircuit).toBe(false);
    expect(rule.decide('SELL', 1.7)).toEqual({ side: 'sell', qty: 10 });
  });

  it('act=false(관측 모드): 이벤트는 SELL까지 나오지만 결정은 없고 ma5 SELL도 그대로 통과', () => {
    const rule = makeRule(false);
    const out = replay(rule, AIXC_HALT_PRICES);
    expect(out.every((o) => o.decision === null)).toBe(true);
    expect(rule.decide('SELL', 1.7)).toEqual({ side: 'sell', qty: 10 });
  });

  it('손절선: 서킷 상태에서 정지 직전가가 평단×0.93 이하면 하킷 1회여도 발화(STOP_LOSS)', () => {
    const rule = makeRule(true, { entry: 2.0 });
    // 2.2 상킷 → 창 3초 → 1.8 하킷(= −10%)
    const out = replay(rule, [2.2, 1.8]);
    expect(out[1].decision?.side).toBe('sell');
    expect(out[1].reason).toBe('STOP_LOSS');
  });

  it('고립 정지: 정지 1회 → 재개 뒤 정상 거래 → 서킷 상태 아님, 결정 없음', () => {
    const rule = makeRule(true);
    let last = trade(rule, 0, 60, 1.0);
    const r1 = silence(rule, last, 1.0, 46);
    expect(r1.events.some((e) => e.kind === 'HALT')).toBe(true);
    // 300초 뒤 재개, 5분 동안 정상 체결
    last = trade(rule, last + 300 * SEC, 300, 0.95);
    expect(rule.inCircuit).toBe(false);
    // 다시 정지(창 300초 ≥ 60초) — 하킷이지만 서킷 상태 아님 → 결정 없음
    const r2 = silence(rule, last, 0.95, 46);
    expect(r2.decision).toBeNull();
    expect(rule.decide('SELL', 0.9)).toEqual({ side: 'sell', qty: 10 });
  });

  it('정규장 밖에서는 새 정지를 감지하지 않는다', () => {
    const rule = makeRule(true);
    const last = trade(rule, 0, 60, 1.0, false);
    const r = silence(rule, last, 1.0, 46, false);
    expect(r.events).toHaveLength(0);
  });
});
