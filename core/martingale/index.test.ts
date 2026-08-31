import { describe, expect, it } from 'vitest';

import {
  MARTINGALE_CONFIG,
  MartingaleRule,
  evaluateMartingaleBars,
  isMartingaleEntryBar,
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

describe('isMartingaleEntryBar — 프리·정규·애프터만 허용(2026-09-01, 주간거래 진입 제외)', () => {
  // 2026-08-27(EDT, UTC−4). key(h, m) = 그 ET 시각에 시작하는 1분봉의 키.
  const key = (h: number, m: number) => Math.floor(Date.UTC(2026, 7, 27, h + 4, m) / 60_000);
  it('프리마켓·정규장·애프터마켓 봉은 허용', () => {
    expect(isMartingaleEntryBar(key(4, 0))).toBe(true); // 프리 첫 봉(종료 04:01)
    expect(isMartingaleEntryBar(key(5, 0))).toBe(true); // 프리
    expect(isMartingaleEntryBar(key(9, 30))).toBe(true); // 정규장 첫 봉
    expect(isMartingaleEntryBar(key(17, 0))).toBe(true); // 애프터
  });
  it('주간거래(20:00~04:00 ET) 봉은 금지', () => {
    expect(isMartingaleEntryBar(key(20, 0))).toBe(false); // 주간거래 시작
    expect(isMartingaleEntryBar(key(22, 0))).toBe(false); // KST 낮
    expect(isMartingaleEntryBar(key(2, 0))).toBe(false); // 새벽
    expect(isMartingaleEntryBar(key(3, 59))).toBe(false); // 종료 04:00 — 아직 주간거래 끝 봉
  });
  it('19:54 시작(19:55 종료)부터는 마감 청산 구간이라 금지', () => {
    expect(isMartingaleEntryBar(key(19, 53))).toBe(true);
    expect(isMartingaleEntryBar(key(19, 54))).toBe(false);
    expect(isMartingaleEntryBar(key(19, 59))).toBe(false);
  });
});

describe('MartingaleRule — 포지션 규칙(±3%, 물타기 없음)', () => {
  it('익절 +3% · 손절 −3% 선이 평단에서 계산된다', () => {
    const r = new MartingaleRule({ qty: 10, avgPrice: 100 });
    expect(r.targetPrice).toBeCloseTo(103, 9);
    expect(r.stopPrice).toBeCloseTo(97, 9);
    expect(MARTINGALE_CONFIG.tpPct).toBe(0.03);
    expect(MARTINGALE_CONFIG.stopLossPct).toBe(0.03);
  });

  it('신호 매수(물타기)는 없다 — decide는 항상 null', () => {
    const r = new MartingaleRule({ qty: 10, avgPrice: 100 });
    expect(r.decide('BUY', 97)).toBeNull();
    expect(r.decide('BUY', 50)).toBeNull();
    expect(r.decide('SELL', 90)).toBeNull();
  });

  it('틱: 목표가 이상이면 TAKE_PROFIT, 손절선 이하면 STOP_LOSS, 마감 시각이면 SESSION_END', () => {
    const r = new MartingaleRule({ qty: 10, avgPrice: 100 });
    expect(r.onPriceAt(102.9)).toBeNull();
    expect(r.onPriceAt(103)).toEqual({ side: 'sell', qty: 10 });
    expect(r.exitKind).toBe('TAKE_PROFIT');
    expect(r.onPriceAt(97.1)).toBeNull();
    expect(r.onPriceAt(97)).toEqual({ side: 'sell', qty: 10 });
    expect(r.exitKind).toBe('STOP_LOSS');
    // 19:55 ET(EDT) = 23:55 UTC
    const closeMs = Date.UTC(2026, 7, 27, 23, 55);
    expect(r.onPriceAt(100, closeMs - 60_000)).toBeNull();
    expect(r.onPriceAt(100, closeMs)).toEqual({ side: 'sell', qty: 10 });
    expect(r.exitKind).toBe('SESSION_END');
  });

  it('취소선: 익절 매도는 목표 아래로 내려오면 접는다. 손절·마감 매도는 안 접는다', () => {
    const r = new MartingaleRule({ qty: 10, avgPrice: 100 });
    r.onPriceAt(103); // 익절 결정
    expect(r.shouldAbort('sell', 102.5)).toBe(true);
    expect(r.shouldAbort('sell', 103.2)).toBe(false);
    r.onPriceAt(97); // 손절 결정 — 되돌아와도 판다(손실 확정이 목적)
    expect(r.shouldAbort('sell', 99)).toBe(false);
    const closeMs = Date.UTC(2026, 7, 27, 23, 55);
    r.onPriceAt(90, closeMs); // 마감 결정
    expect(r.shouldAbort('sell', 80)).toBe(false);
  });

  it('view: sellLine=익절 목표, buyLine 자리=손절선(게이지 아래끝)', () => {
    const r = new MartingaleRule({ qty: 10, avgPrice: 100 });
    expect(r.view).toEqual({ qty: 10, avgPrice: 100, entryQty: 10, sellLine: 103, buyLine: 97 });
  });

  it('setPosition으로 평단이 바뀌면 선도 따라간다(입양 포지션 갱신)', () => {
    const r = new MartingaleRule({ qty: 10, avgPrice: 100 });
    r.setPosition({ qty: 10, avgPrice: 98 });
    expect(r.targetPrice).toBeCloseTo(98 * 1.03, 9);
    expect(r.stopPrice).toBeCloseTo(98 * 0.97, 9);
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
