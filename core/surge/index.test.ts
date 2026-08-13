import { describe, expect, it } from 'vitest';
import { SurgeDetector, type SurgeAlert, type SurgeSignal, type SurgeDetectorOptions } from './index';

// 실기본값(σ창 60초·룩백 20분)은 테스트가 너무 길어진다 — 비율은 유지하고 창만 줄인다.
const OPTS: SurgeDetectorOptions = {
  sigmaWindowSec: 10, // 수익률 창
  sigmaLookbackSec: 60, // σ 롤링 창(워밍업)
  highLookbackSec: 30, // 신고가 창
  minBaselineSec: 20,
  baselineSec: 60,
  minSigma: 0.001, // σ 하한 0.1% → 4σ = 0.4%
  minStrn: 100,
};

type Ev = SurgeAlert | SurgeSignal;
const surges = (a: Ev[]) => a.filter((e): e is SurgeSignal => e.kind === 'surge');
const exits = (a: Ev[]) => a.filter((e): e is SurgeSignal => e.kind === 'exit');
const alerts = (a: Ev[]) => a.filter((e): e is SurgeAlert => e.kind === 'alert');

/** t0초부터 초당 1틱 고정가 — σ·기준선 워밍업. 마지막 초를 돌려준다. */
function feedFlat(d: SurgeDetector, fromSec: number, seconds: number, price = 100): number {
  for (let i = 0; i < seconds; i += 1) d.onTick(price, (fromSec + i) * 1000, { strength: 120 });
  return fromSec + seconds - 1;
}

/** 1초 안에 n틱을 등차 상승시키며 폭주 — 발화 이벤트들을 돌려준다. */
function feedBurst(d: SurgeDetector, atSec: number, n: number, from: number, to: number): Ev[] {
  const out: Ev[] = [];
  for (let i = 0; i < n; i += 1) {
    const price = from + ((to - from) * (i + 1)) / n;
    const res = d.onTick(price, atSec * 1000 + i * 90, { strength: 120 });
    if (res) out.push(res);
  }
  return out;
}

/** 워밍업 완료(σ 표본 가득)된 감지기 — 기준가 100, 마지막 초를 함께 돌려준다. */
function warmedDetector(): { d: SurgeDetector; sec: number } {
  const d = new SurgeDetector(OPTS);
  const sec = feedFlat(d, 0, 90);
  expect(d.warmedUp).toBe(true);
  return { d, sec };
}

describe('SurgeDetector v2 — 급등 확정(3조건 AND)', () => {
  it('폭(4σ)+신고가+참여가 동시에 성립하면 surge — 앵커·σ·돌파선이 실린다', () => {
    const { d, sec } = warmedDetector();
    const fired = surges(feedBurst(d, sec + 1, 10, 100, 100.5)); // +0.5% ≥ 4σ(0.4%)
    expect(fired).toHaveLength(1);
    expect(fired[0].anchorPrice).toBeCloseTo(100, 5);
    expect(fired[0].sigma).toBeCloseTo(0.001, 5); // minSigma 하한.
    expect(fired[0].breakoutLevel).toBeCloseTo(100, 5);
    expect(d.getSnapshot().tracking).toBe(true);
  });

  it('폭이 4σ 미만이면(미세 발작) 확정 없음 — v1 실패의 재발 방지', () => {
    const { d, sec } = warmedDetector();
    const events = feedBurst(d, sec + 1, 10, 100, 100.2); // +0.2% < 0.4%
    expect(surges(events)).toHaveLength(0);
  });

  it('참여(틱속도 폭주) 없이 천천히 오르면 확정 없음', () => {
    const { d, sec } = warmedDetector();
    const events: Ev[] = [];
    for (let i = 0; i < 8; i += 1) {
      const res = d.onTick(100 + (i + 1) * 0.08, (sec + 1 + i) * 1000, { strength: 120 }); // 1틱/초, +0.64%까지.
      if (res) events.push(res);
    }
    expect(surges(events)).toHaveLength(0);
  });

  it('체결강도 미달(매수 주도 아님)이면 확정 없음 — null이면 fail-open', () => {
    const { d, sec } = warmedDetector();
    const blocked: Ev[] = [];
    for (let i = 0; i < 10; i += 1) {
      const res = d.onTick(100 + ((i + 1) * 0.5) / 10, (sec + 1) * 1000 + i * 90, { strength: 80 });
      if (res) blocked.push(res);
    }
    expect(surges(blocked)).toHaveLength(0);

    const { d: d2, sec: sec2 } = warmedDetector();
    const open: Ev[] = [];
    for (let i = 0; i < 10; i += 1) {
      const res = d2.onTick(100 + ((i + 1) * 0.5) / 10, (sec2 + 1) * 1000 + i * 90, { strength: null });
      if (res) open.push(res);
    }
    expect(surges(open)).toHaveLength(1); // 판정 불가 → fail-open(기존 게이트 관례).
  });

  it('직전 30초 고가를 못 넘으면(신고가 아님) 막히고, 넘는 순간 발화', () => {
    const d = new SurgeDetector(OPTS);
    feedFlat(d, 0, 75);
    d.onTick(100.6, 75_000, { strength: 120 }); // 스파이크 고점 — 신고가 선.
    feedFlat(d, 76, 15); // 100으로 복귀 유지(스파이크가 신고가 창 30초 안에 남는다).
    const belowHigh = feedBurst(d, 91, 10, 100, 100.5); // 폭은 충분하나 100.6 미돌파.
    expect(surges(belowHigh)).toHaveLength(0);
    const breakout = feedBurst(d, 92, 10, 100.5, 100.75); // 100.6 돌파.
    expect(surges(breakout)).toHaveLength(1);
    expect(surges(breakout)[0].breakoutLevel).toBeCloseTo(100.6, 5);
  });

  it('σ 워밍업(룩백 60초) 미달이면 확정 없음', () => {
    const d = new SurgeDetector(OPTS);
    feedFlat(d, 0, 40); // 수익률 표본 ~30 < 60.
    expect(d.warmedUp).toBe(false);
    expect(surges(feedBurst(d, 41, 10, 100, 100.6))).toHaveLength(0);
  });
});

describe('SurgeDetector v2 — 이탈(3경로)', () => {
  /** 급등 확정(고점 ~100.5, 돌파선 100, σ=0.001)까지 만든 감지기. */
  function surgedDetector(): { d: SurgeDetector; sec: number } {
    const { d, sec } = warmedDetector();
    const fired = surges(feedBurst(d, sec + 1, 10, 100, 100.5));
    expect(fired).toHaveLength(1);
    return { d, sec: sec + 1 };
  }

  it('돌파했던 신고가 선 아래로 복귀하면 즉시 breakout_fail — 가짜 돌파', () => {
    const { d, sec } = surgedDetector();
    const res = d.onTick(99.95, (sec + 3) * 1000, { strength: 120 }); // 돌파선 100 아래.
    expect(res?.kind).toBe('exit');
    expect((res as SurgeSignal).exitReason).toBe('breakout_fail');
    expect((res as SurgeSignal).trailingHigh).toBeCloseTo(100.5, 5);
  });

  it('참여가 아직 뜨거워도 고점 대비 3σ 하락이면 hard(투매)', () => {
    const { d, sec } = surgedDetector();
    // 확정 직후(참여 신선) — 고점 100.5, hard선 = −0.3% = 100.1985. 돌파선(100) 위에서.
    expect(d.onTick(100.35, sec * 1000 + 950, { strength: 120 })).toBeNull(); // −0.15% — hard 미달, soft는 뜨거워서 억제.
    const res = d.onTick(100.15, sec * 1000 + 980, { strength: 120 });
    expect((res as SurgeSignal)?.exitReason).toBe('hard');
  });

  it('참여가 식은 뒤에는 1.5σ 하락만으로 soft — 힘 빠진 급등', () => {
    const { d, sec } = surgedDetector();
    // 12초간 1틱/초로 식힌다(참여 신선도 10초 창 소멸) — 고점 유지 수준의 가격.
    for (let i = 0; i < 12; i += 1) d.onTick(100.48, (sec + 2 + i) * 1000, { strength: 120 });
    // 고점 100.5, soft선 = −0.15% = 100.349. hard(−0.3%)엔 못 미치는 하락.
    const res = d.onTick(100.3, (sec + 15) * 1000, { strength: 120 });
    expect((res as SurgeSignal)?.exitReason).toBe('soft');
  });

  it('스프레드 하한 — 스프레드×2가 σ 문턱보다 크면 그 아래 하락은 이탈이 아니다(호가 소음)', () => {
    const { d, sec } = surgedDetector();
    for (let i = 0; i < 12; i += 1) d.onTick(100.48, (sec + 2 + i) * 1000, { strength: 120 });
    // 스프레드 0.5% → soft 문턱 = max(0.15%, 1%) = 1%. −0.2% 하락은 이탈 아님.
    expect(d.onTick(100.3, (sec + 15) * 1000, { strength: 120, spreadPct: 0.005 })).toBeNull();
    // 돌파선 상실은 스프레드와 무관하게 이탈.
    const res = d.onTick(99.9, (sec + 16) * 1000, { strength: 120, spreadPct: 0.005 });
    expect((res as SurgeSignal)?.exitReason).toBe('breakout_fail');
  });

  it('추적 중 재폭주해도 새 surge 없음(세트 유지), 이탈 후 쿨다운 지나야 새 세트', () => {
    const { d, sec } = surgedDetector();
    expect(surges(feedBurst(d, sec + 2, 10, 100.5, 101.2))).toHaveLength(0); // 추적 중 — 억제.
    const exit = d.onTick(99.9, (sec + 5) * 1000, { strength: 120 }); // breakout_fail로 종결.
    expect(exit?.kind).toBe('exit');
    // 쿨다운(60초) 안 — 재확정 억제.
    expect(surges(feedBurst(d, sec + 10, 10, 99.9, 100.6))).toHaveLength(0);
    // 쿨다운 후 — 조건 다시 갖추면 새 세트. (99.9~ 유지로 σ·신고가 재정렬)
    feedFlat(d, sec + 12, 70, 99.9);
    const again = surges(feedBurst(d, sec + 82, 10, 99.9, 100.5)); // +0.6% & 신고가(직전 30초 고가 99.9 돌파).
    expect(again).toHaveLength(1);
  });
});

describe('SurgeDetector v2 — 조기경보', () => {
  it('2σ 도달 + 참여면 경보(확정 전 호가 예열) — 4σ 미만이라 확정은 없음', () => {
    const { d, sec } = warmedDetector();
    const events = feedBurst(d, sec + 1, 10, 100, 100.28); // +0.28% ∈ [2σ=0.2%, 4σ=0.4%)
    expect(alerts(events).length).toBeGreaterThanOrEqual(1);
    expect(surges(events)).toHaveLength(0);
  });

  it('σ 워밍업 전에는 속도 정배열이 경보를 대신한다(확정은 불가)', () => {
    const d = new SurgeDetector(OPTS);
    // 초당 틱수 1→2→3→4→5 가속 + 업틱.
    let price = 100;
    const events: Ev[] = [];
    for (let s = 0; s < 5; s += 1) {
      for (let j = 0; j <= s; j += 1) {
        price += 0.01;
        const res = d.onTick(price, s * 1000 + j * 100, { strength: 120 });
        if (res) events.push(res);
      }
    }
    for (let j = 0; j < 4; j += 1) {
      const res = d.onTick(price + 0.01 * (j + 1), 5000 + j * 100, { strength: 120 });
      if (res) events.push(res);
    }
    expect(alerts(events).length).toBeGreaterThanOrEqual(1);
    expect(surges(events)).toHaveLength(0);
  });
});

describe('SurgeDetector v2 — 리셋', () => {
  it('reset 후 워밍업·추적이 초기화된다', () => {
    const { d } = warmedDetector();
    d.reset();
    expect(d.warmedUp).toBe(false);
    expect(d.getSnapshot().tracking).toBe(false);
    expect(d.getSnapshot().sigma).toBeNull();
  });
});
