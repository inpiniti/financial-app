import { describe, expect, it } from 'vitest';

import {
  MARTINGALE_CONFIG,
  MartingaleRule,
  evaluateMartingaleBars,
  isMartingaleEntryBar,
  multiplierForDrop,
} from './index';

/** 122봉 상승 시드(정배열·4선 상승) — 마지막 봉만 5선 아래로 눌렀다가(dip) 다음 봉에 5선 위로 돌파시키는 재료. */
function risingCloses(n = 122, step = 1): number[] {
  return Array.from({ length: n }, (_, i) => 100 + i * step);
}

describe('evaluateMartingaleBars — 진입(정배열 + 5선 상향 돌파)', () => {
  it('꾸준히 오르기만 하면 정배열이지만 돌파 봉이 아니라 entry=false', () => {
    const ev = evaluateMartingaleBars(risingCloses());
    expect(ev.aligned).toBe(true);
    expect(ev.entry).toBe(false);
    expect(ev.ma5TurnUp).toBe(false);
  });

  it('직전 봉 종가 < 5선, 이번 봉 종가 > 5선이면서 정배열·4선 상승이면 entry=true', () => {
    const closes = risingCloses(121);
    // 직전 봉: 5선 아래로 눌림(작게 — 4선 상승은 유지). 이번 봉: 크게 반등해 5선 위.
    closes.push(closes[closes.length - 1] - 3); // dip
    const dipped = evaluateMartingaleBars(closes);
    expect(dipped.entry).toBe(false);
    closes.push(closes[closes.length - 1] + 8); // 돌파
    const ev = evaluateMartingaleBars(closes);
    expect(ev.aligned).toBe(true);
    expect(ev.entry).toBe(true);
  });

  it('봉이 부족하면 판정하지 않는다(fail-closed)', () => {
    const ev = evaluateMartingaleBars(risingCloses(50));
    expect(ev.aligned).toBeNull();
    expect(ev.entry).toBe(false);
  });
});

describe('evaluateMartingaleBars — 5선 변곡(물타기 시점)', () => {
  it('5선이 내려가다(또는 보합) 이번 봉에 올라서면 ma5TurnUp=true, 이어서 오르는 봉은 false', () => {
    const closes = [...risingCloses(30), 125, 120, 115, 110]; // 하락 → 5선 하락
    expect(evaluateMartingaleBars(closes).ma5TurnUp).toBe(false);
    closes.push(140); // 5선 반등
    expect(evaluateMartingaleBars(closes).ma5TurnUp).toBe(true);
    closes.push(150); // 계속 상승 — 변곡 아님
    expect(evaluateMartingaleBars(closes).ma5TurnUp).toBe(false);
  });
});

describe('isMartingaleEntryBar — 모든 세션 허용, 마감 청산 구간(19:55~20:00 ET)만 금지', () => {
  // 2026-08-27(EDT, UTC−4). key(h, m) = 그 ET 시각에 시작하는 1분봉의 키.
  const key = (h: number, m: number) => Math.floor(Date.UTC(2026, 7, 27, h + 4, m) / 60_000);
  it('프리마켓·정규장·애프터마켓·주간거래 봉 모두 허용', () => {
    expect(isMartingaleEntryBar(key(5, 0))).toBe(true); // 프리
    expect(isMartingaleEntryBar(key(9, 30))).toBe(true); // 정규장 첫 봉
    expect(isMartingaleEntryBar(key(17, 0))).toBe(true); // 애프터
    expect(isMartingaleEntryBar(key(22, 0))).toBe(true); // 주간거래(KST 낮)
  });
  it('19:54 시작(19:55 종료)부터 19:59 시작(20:00 종료)까지는 마감 청산 구간이라 금지', () => {
    expect(isMartingaleEntryBar(key(19, 53))).toBe(true);
    expect(isMartingaleEntryBar(key(19, 54))).toBe(false);
    expect(isMartingaleEntryBar(key(19, 59))).toBe(false);
    expect(isMartingaleEntryBar(key(20, 0))).toBe(true);
  });
});

describe('multiplierForDrop — −k% → (k−1)배', () => {
  it('−3% 2배, −4% 3배, −10% 9배, −50% 49배, 그 이상은 49배 고정, −3% 미만은 0', () => {
    expect(multiplierForDrop(0.03)).toBe(2);
    expect(multiplierForDrop(0.04)).toBe(3);
    expect(multiplierForDrop(0.049)).toBe(3); // 내림
    expect(multiplierForDrop(0.1)).toBe(9);
    expect(multiplierForDrop(0.5)).toBe(49);
    expect(multiplierForDrop(0.8)).toBe(49);
    expect(multiplierForDrop(0.029)).toBe(0);
  });
});

describe('MartingaleRule — 포지션 규칙', () => {
  const clock = (start: number) => {
    let t = start;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };

  it('익절 목표는 물타기 횟수 사다리(+3/+2/+1)를 따른다', () => {
    const r = new MartingaleRule({ qty: 10, avgPrice: 100 });
    expect(r.targetPrice).toBeCloseTo(103, 9);
    r.setPosition({ qty: 30, avgPrice: 98 }); // 물타기 1회
    expect(r.adds).toBe(1);
    expect(r.targetPrice).toBeCloseTo(98 * 1.02, 9);
    r.setPosition({ qty: 120, avgPrice: 95 }); // 2회
    expect(r.targetPrice).toBeCloseTo(95 * 1.01, 9);
    r.setPosition({ qty: 600, avgPrice: 90 }); // 3회 — 사다리 끝값 유지
    expect(r.targetPrice).toBeCloseTo(90 * 1.01, 9);
  });

  it('BUY(5선 변곡)에서 낙폭 계단 배수만큼 산다 — −3% 2배·−5% 4배, 선 위면 null', () => {
    const r = new MartingaleRule({ qty: 10, avgPrice: 100 });
    expect(r.decide('BUY', 97.5)).toBeNull(); // −2.5% — 첫 선(−3%) 미달
    expect(r.decide('BUY', 97)).toEqual({ side: 'buy', qty: 20 }); // −3% → 2배
    expect(r.decide('BUY', 95)).toEqual({ side: 'buy', qty: 40 }); // −5% → 4배
    expect(r.decide('BUY', 50)).toEqual({ side: 'buy', qty: 490 }); // −50% → 49배
    expect(r.decide('SELL', 90)).toBeNull();
  });

  it('마지막 체결 후 5분이 안 지났으면 물타지 않는다', () => {
    const c = clock(1_000_000);
    const r = new MartingaleRule({ qty: 10, avgPrice: 100 }, { clock: c });
    expect(r.decide('BUY', 96)).toBeNull(); // 진입 직후
    c.advance(4 * 60_000);
    expect(r.decide('BUY', 96)).toBeNull();
    c.advance(60_000);
    expect(r.decide('BUY', 96)).toEqual({ side: 'buy', qty: 30 });
    r.setPosition({ qty: 40, avgPrice: 97 }); // 체결 — 간격 기준 갱신
    expect(r.decide('BUY', 93)).toBeNull();
    c.advance(5 * 60_000);
    expect(r.decide('BUY', 93)).toEqual({ side: 'buy', qty: 120 }); // 97→93 = −4.1% → 3배
  });

  it('틱: 목표가 이상이면 전량 매도(TAKE_PROFIT), 마감 시각이면 SESSION_END', () => {
    const r = new MartingaleRule({ qty: 10, avgPrice: 100 });
    expect(r.onPriceAt(102.9)).toBeNull();
    expect(r.onPriceAt(103)).toEqual({ side: 'sell', qty: 10 });
    expect(r.exitKind).toBe('TAKE_PROFIT');
    // 19:55 ET(EDT) = 23:55 UTC
    const closeMs = Date.UTC(2026, 7, 27, 23, 55);
    expect(r.onPriceAt(100, closeMs - 60_000)).toBeNull();
    expect(r.onPriceAt(100, closeMs)).toEqual({ side: 'sell', qty: 10 });
    expect(r.exitKind).toBe('SESSION_END');
  });

  it('취소선: 매수는 첫 선 위로 되돌아오면, 익절 매도는 목표 아래로 내려오면 접는다. 마감 매도는 안 접는다', () => {
    const r = new MartingaleRule({ qty: 10, avgPrice: 100 });
    expect(r.shouldAbort('buy', 97.5)).toBe(true);
    expect(r.shouldAbort('buy', 96)).toBe(false);
    r.onPriceAt(103); // 익절 결정
    expect(r.shouldAbort('sell', 102.5)).toBe(true);
    expect(r.shouldAbort('sell', 103.2)).toBe(false);
    const closeMs = Date.UTC(2026, 7, 27, 23, 55);
    r.onPriceAt(90, closeMs); // 마감 결정
    expect(r.shouldAbort('sell', 80)).toBe(false);
  });

  it('view: sellLine=목표가, buyLine=첫 물타기 선', () => {
    const r = new MartingaleRule({ qty: 10, avgPrice: 100 });
    expect(r.view).toEqual({ qty: 10, avgPrice: 100, entryQty: 10, sellLine: 103, buyLine: 97 });
    expect(MARTINGALE_CONFIG.tpLadder).toEqual([0.03, 0.02, 0.01]);
  });
});

describe('evaluateMartingaleBars — 진입 조건·이벤트(2026-08-28)', () => {
  it('꾸준히 오르는 봉: 조건은 충족하지만 이벤트는 없다(state)', () => {
    const ev = evaluateMartingaleBars(risingCloses());
    expect(ev.condition).toBe(true);
    expect(ev.entryEvent).toBeNull();
    expect(ev.entry).toBe(false);
  });

  it('V자 반등: 배열 성립(ordered) 또는 4선 상승 성립(allUp) 이벤트가 나오고, 그 뒤 봉은 state', () => {
    const closes: number[] = [];
    for (let i = 0; i < 130; i += 1) closes.push(200 - i); // 하락
    const seen: string[] = [];
    let lastEvent: string | null = null;
    for (let i = 0; i < 200; i += 1) {
      closes.push(closes[closes.length - 1] + 1.5); // 반등
      const ev = evaluateMartingaleBars(closes);
      if (ev.condition && ev.entryEvent !== null) {
        seen.push(ev.entryEvent);
        lastEvent = ev.entryEvent;
      } else if (ev.condition && lastEvent !== null) {
        expect(ev.entryEvent).toBeNull(); // 이벤트 뒤 이어지는 조건 봉은 state
      }
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((e) => e === 'ordered' || e === 'allUp')).toBe(true);
  });

  it('5선 돌파가 다른 이벤트와 겹치면 cross가 우선', () => {
    const closes = risingCloses(121);
    closes.push(closes[closes.length - 1] - 8); // 5선 아래로 눌림(ma5 하락)
    closes.push(closes[closes.length - 1] + 20); // 돌파 + ma5 재상승
    const ev = evaluateMartingaleBars(closes);
    expect(ev.condition).toBe(true);
    expect(ev.entryEvent).toBe('cross');
  });
});
