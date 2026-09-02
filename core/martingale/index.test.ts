import { describe, expect, it } from 'vitest';

import {
  AveragingDownRule,
  MARTINGALE_CONFIG,
  MartingaleRule,
  NO_ENTRY_FILTERS,
  entryFiltersPass,
  evaluateMartingaleBars,
  evaluateMartingaleLive,
  isMartingaleEntryBar,
  multiplierForDrop,
} from './index';

/** 122봉 상승 시드(5선 상승 유지) — 마지막 봉만 5선 아래로 눌렀다가(dip) 다음 봉에 5선 위로 돌파시키는 재료. */
function risingCloses(n = 122, step = 1): number[] {
  return Array.from({ length: n }, (_, i) => 100 + i * step);
}

describe('evaluateMartingaleBars — 진입(5선 상승 + 5선 상향 돌파)', () => {
  it('꾸준히 오르기만 하면 5선 상승이지만 돌파 봉이 아니라 entry=false', () => {
    const ev = evaluateMartingaleBars(risingCloses());
    expect(ev.ma5Up).toBe(true);
    expect(ev.entry).toBe(false);
  });

  it('직전 봉 종가 < 5선, 이번 봉 종가 > 5선이면서 5선 상승이면 entry=true', () => {
    const closes = risingCloses(121);
    // 직전 봉: 5선 아래로 눌림(5선 하락). 이번 봉: 크게 반등해 5선 위(5선 재상승).
    closes.push(closes[closes.length - 1] - 3); // dip
    const dipped = evaluateMartingaleBars(closes);
    expect(dipped.entry).toBe(false);
    closes.push(closes[closes.length - 1] + 8); // 돌파 + 5선 상승
    const ev = evaluateMartingaleBars(closes);
    expect(ev.ma5Up).toBe(true);
    expect(ev.entry).toBe(true);
  });

  it('봉이 MARTINGALE_MIN_BARS(122) 미만이면 판정하지 않는다(fail-closed) — 5선만 쓰지만 문턱은 유지', () => {
    const ev = evaluateMartingaleBars(risingCloses(121));
    expect(ev.ma5Up).toBeNull();
    expect(ev.entry).toBe(false);
    expect(evaluateMartingaleBars(risingCloses(122)).ma5Up).toBe(true);
  });
});

describe('evaluateMartingaleLive — 진행 중 봉 실시간 진입 판정', () => {
  it('닫힌 봉 + 진행 중 종가를 마지막 봉으로 친 판정과 동일하다', () => {
    const closed = risingCloses(121);
    closed.push(closed[closed.length - 1] - 3); // 마지막 닫힌 봉: 5선 아래 눌림
    const provisional = closed[closed.length - 1] + 11; // 진행 중 봉: 5선 위로 반등 중
    const live = evaluateMartingaleLive(closed, provisional);
    expect(live).toEqual(evaluateMartingaleBars([...closed, provisional]));
    expect(live.entry).toBe(true);
  });

  it('진행 중 종가가 5선 아래면 진입 신호 없음', () => {
    const closed = risingCloses(121);
    closed.push(closed[closed.length - 1] - 3);
    const ev = evaluateMartingaleLive(closed, closed[closed.length - 1] - 1);
    expect(ev.entry).toBe(false);
  });

  it('현재가가 비정상(0·NaN)이면 판정하지 않는다(fail-closed)', () => {
    expect(evaluateMartingaleLive(risingCloses(), 0).entry).toBe(false);
    expect(evaluateMartingaleLive(risingCloses(), Number.NaN).ma5Up).toBeNull();
  });
});

describe('isMartingaleEntryBar — 프리·정규·애프터만 허용(주간거래 진입 제외)', () => {
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

describe('multiplierForDrop — 낙폭 → 물타기 배수', () => {
  it('낙폭 −k%(k≥3)면 (k−1)배: −3% → 2배, −4% → 3배, … −50% → 49배', () => {
    expect(multiplierForDrop(0.03)).toBe(2);
    expect(multiplierForDrop(0.04)).toBe(3);
    expect(multiplierForDrop(0.05)).toBe(4);
    expect(multiplierForDrop(0.5)).toBe(49);
  });
  it('낙폭이 3% 미만이면 0(물타기 없음)', () => {
    expect(multiplierForDrop(0.029)).toBe(0);
    expect(multiplierForDrop(0.02)).toBe(0);
    expect(multiplierForDrop(0)).toBe(0);
  });
  it('상한 50%를 넘으면 49배까지만', () => {
    expect(multiplierForDrop(0.6)).toBe(49);
    expect(multiplierForDrop(1)).toBe(49);
  });
});

describe('MartingaleRule — 포지션 규칙(익절 +3%, 물타기)', () => {
  it('익절 +3%, 물타기 선이 평단에서 계산된다', () => {
    const r = new MartingaleRule({ qty: 10, avgPrice: 100 });
    expect(r.targetPrice).toBeCloseTo(103, 9);
    expect(r.buyLinePrice).toBeCloseTo(97, 9);
    expect(MARTINGALE_CONFIG.tpPct).toBe(0.03);
    expect(MARTINGALE_CONFIG.dropStartPct).toBe(0.03);
  });

  it('신호 매수(물타기): 낙폭 −k%(k≥3)면 현재 보유량의 (k−1)배, −3% 미만이면 null', () => {
    const r = new MartingaleRule({ qty: 10, avgPrice: 100 });
    expect(r.decide('BUY', 97.5)).toBeNull(); // −2.5%
    expect(r.decide('BUY', 97)).toEqual({ side: 'buy', qty: 20 }); // −3% → 2배
    expect(r.decide('BUY', 96)).toEqual({ side: 'buy', qty: 30 }); // −4% → 3배
    expect(r.decide('BUY', 102)).toBeNull();
    expect(r.decide('SELL', 95)).toBeNull();
    // 물타기 체결 뒤에는 **현재 보유량** 기준 — 30주 · 평단 98에서 −3%(95.06)면 60주.
    r.setPosition({ qty: 30, avgPrice: 98 });
    expect(r.decide('BUY', 95)).toEqual({ side: 'buy', qty: 60 });
  });

  it('보유 1주 · 배수 2면 2주, 1주 미만이 되는 조합은 없다(floor ≥ 1)', () => {
    const r = new MartingaleRule({ qty: 1, avgPrice: 100 });
    expect(r.decide('BUY', 97)).toEqual({ side: 'buy', qty: 2 });
  });

  it('틱: 익절 목표 이상이면 TAKE_PROFIT, 마감 시각이면 SESSION_END', () => {
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

  it('취소선: 익절 매도는 목표 아래로 내려오면 접는다. 마감 매도는 안 접는다', () => {
    const r = new MartingaleRule({ qty: 10, avgPrice: 100 });
    r.onPriceAt(103); // 익절 결정
    expect(r.shouldAbort('sell', 102.5)).toBe(true);
    expect(r.shouldAbort('sell', 103.2)).toBe(false);
    const closeMs = Date.UTC(2026, 7, 27, 23, 55);
    r.onPriceAt(90, closeMs); // 마감 결정
    expect(r.shouldAbort('sell', 80)).toBe(false);
  });

  it('view: sellLine=익절 목표, buyLine=물타기 선', () => {
    const r = new MartingaleRule({ qty: 10, avgPrice: 100 });
    expect(r.view).toEqual({ qty: 10, avgPrice: 100, entryQty: 10, sellLine: 103, buyLine: 97 });
  });

  it('setPosition: 수량이 늘면 물타기 카운트(adds)가 오르고 익절 목표는 새 평단을 따른다', () => {
    const r = new MartingaleRule({ qty: 10, avgPrice: 100 });
    expect(r.adds).toBe(0);
    r.setPosition({ qty: 30, avgPrice: 98 });
    expect(r.adds).toBe(1);
    expect(r.targetPrice).toBeCloseTo(98 * 1.03, 9);
    r.setPosition({ qty: 90, avgPrice: 96 });
    expect(r.adds).toBe(2);
    r.setPosition({ qty: 90, avgPrice: 96 }); // 같은 수량 — 물타기 아님
    expect(r.adds).toBe(2);
  });
});

describe('진입 필터(엔진 옵션, ADR 0012) — 정배열·5선 상승·4선 모두 상승 AND', () => {
  it('필터 없음이면 돌파만으로 entry, 5선 하락 중 돌파도 신호', () => {
    const closes = Array.from({ length: 122 }, (_, i) => 200 - i * 0.5); // 완만한 하락 — 5선 하락
    closes.push(closes[121] + 1.5); // 5선(≈140.4) 위로 — 5선 자체는 아직 하락(140.5→140.4)
    const ev = evaluateMartingaleBars(closes, NO_ENTRY_FILTERS);
    expect(ev.crossUp).toBe(true);
    expect(ev.ma5Up).toBe(false);
    expect(ev.filtersPass).toBe(true);
    expect(ev.entry).toBe(true);
    expect(evaluateMartingaleBars(closes).entry).toBe(false); // 기본(5선 상승)은 막는다
  });

  it('정배열·4선 상승은 상승 시드에서 true, 하락 시드에서 false — 둘 다 체크하면 AND', () => {
    const rising = risingCloses(121);
    rising.push(rising[120] - 3, rising[120] + 8);
    const up = evaluateMartingaleBars(rising, { ordered: true, ma5Up: true, allUp: true });
    expect(up.ordered).toBe(true);
    expect(up.allUp).toBe(true);
    expect(up.entry).toBe(true);
    const falling = Array.from({ length: 122 }, (_, i) => 300 - i);
    falling.push(200); // 반등 돌파
    const dn = evaluateMartingaleBars(falling, { ordered: true, ma5Up: false, allUp: false });
    expect(dn.crossUp).toBe(true);
    expect(dn.ordered).toBe(false);
    expect(dn.entry).toBe(false);
    expect(evaluateMartingaleBars(falling, { ordered: false, ma5Up: true, allUp: false }).entry).toBe(true); // 5선은 반등으로 상승
  });

  it('entryFiltersPass — 필요한 값이 null이면 null(fail-closed), 필터 없으면 true', () => {
    expect(entryFiltersPass({ ordered: null, ma5Up: true, allUp: null }, { ordered: true, ma5Up: false, allUp: false })).toBeNull();
    expect(entryFiltersPass({ ordered: null, ma5Up: true, allUp: null }, { ordered: false, ma5Up: true, allUp: false })).toBe(true);
    expect(entryFiltersPass({ ordered: null, ma5Up: null, allUp: null }, NO_ENTRY_FILTERS)).toBe(true);
    expect(evaluateMartingaleBars(risingCloses(50), { ordered: true, ma5Up: false, allUp: false }).filtersPass).toBeNull();
  });

  it('evaluateMartingaleLive도 같은 필터를 받는다', () => {
    const closed = Array.from({ length: 122 }, (_, i) => 300 - i);
    expect(evaluateMartingaleLive(closed, 200, NO_ENTRY_FILTERS).entry).toBe(true);
    expect(evaluateMartingaleLive(closed, 200, { ordered: true, ma5Up: false, allUp: false }).entry).toBe(false);
  });
});

describe('물타기 옵션 — MartingaleRule 스위치와 AveragingDownRule 데코레이터', () => {
  it('averagingDown=false면 BUY 신호를 무시한다', () => {
    const r = new MartingaleRule({ qty: 10, avgPrice: 100 }, { averagingDown: false });
    expect(r.decide('BUY', 96)).toBeNull();
    expect(r.onPriceAt(103)).toEqual({ side: 'sell', qty: 10 }); // 익절은 그대로
  });

  it('데코레이터: 안쪽이 BUY에 null이면 낙폭 배수로 사고, 나머지는 안쪽에 위임한다', () => {
    const calls: string[] = [];
    const inner = {
      qty: 10,
      avgPrice: 100,
      get view() {
        return { qty: this.qty, avgPrice: this.avgPrice, entryQty: 10, sellLine: 103, buyLine: 97 };
      },
      decide: (signal: 'BUY' | 'SELL') => (signal === 'SELL' ? { side: 'sell' as const, qty: 10 } : null),
      onPrice: (price: number) => (price >= 103 ? { side: 'sell' as const, qty: 10 } : null),
      shouldAbort: () => {
        calls.push('abort');
        return false;
      },
      setPosition(p: { qty: number; avgPrice: number }) {
        this.qty = p.qty;
        this.avgPrice = p.avgPrice;
      },
    };
    const r = new AveragingDownRule(inner);
    expect(r.decide('BUY', 97.5)).toBeNull(); // −2.5%
    expect(r.decide('BUY', 96)).toEqual({ side: 'buy', qty: 30 }); // −4% → ×3
    expect(r.decide('SELL', 96)).toEqual({ side: 'sell', qty: 10 }); // 안쪽 결정 우선
    expect(r.onPrice(103)).toEqual({ side: 'sell', qty: 10 });
    expect(r.shouldAbort('sell', 1)).toBe(false);
    expect(calls).toEqual(['abort']);
    r.setPosition({ qty: 40, avgPrice: 97 });
    expect(r.view.qty).toBe(40);
    expect(r.decide('BUY', 94)).toEqual({ side: 'buy', qty: 80 }); // 새 평단 97 대비 −3.1% → ×2
  });
});
