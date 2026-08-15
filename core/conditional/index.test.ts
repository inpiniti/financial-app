import { describe, expect, it } from 'vitest';

import { ConditionalGrid } from './index';

const CFG = { sellProfitPct: 0.02, buyDropPct: 0.03 };

function make(qty = 10, avgPrice = 100, entryQty = 10) {
  return new ConditionalGrid({ position: { qty, avgPrice }, entryQty, config: CFG });
}

describe('ConditionalGrid — 조건부 그리드 판정(문서 §4)', () => {
  it('고점 변곡점 — 평단 대비 +2% 이상일 때만 전량 매도', () => {
    const g = make();
    expect(g.decide('SELL', 102)).toEqual({ side: 'sell', qty: 10 }); // 정확히 문턱 = 매도
    expect(g.decide('SELL', 105)).toEqual({ side: 'sell', qty: 10 });
    expect(g.decide('SELL', 101.99)).toBeNull(); // 문턱 미만 — 홀딩
    expect(g.decide('SELL', 100)).toBeNull();
  });

  it('상승 변곡점 — 평단 대비 −3% 이하일 때만 최초 진입 수량 매수(고정 수량)', () => {
    const g = make(20, 100, 7); // 물타기로 수량이 늘어도(20주) 매수는 항상 entryQty(7주)
    expect(g.decide('BUY', 97)).toEqual({ side: 'buy', qty: 7 }); // 정확히 문턱 = 매수
    expect(g.decide('BUY', 90)).toEqual({ side: 'buy', qty: 7 });
    expect(g.decide('BUY', 97.01)).toBeNull(); // 낙폭 부족 — 잔파동 물타기 금지
    expect(g.decide('BUY', 100)).toBeNull();
  });

  it('취소선 — 진입 조건의 부정(매도: 문턱 아래로, 매수: 문턱 위로 좁아지면 true)', () => {
    const g = make();
    expect(g.shouldAbort('sell', 102)).toBe(false);
    expect(g.shouldAbort('sell', 101.99)).toBe(true);
    expect(g.shouldAbort('buy', 97)).toBe(false);
    expect(g.shouldAbort('buy', 97.01)).toBe(true);
    // 판정 불가 가격은 추격 유지(false) — 가격이 다시 오면 그때 판정한다.
    expect(g.shouldAbort('sell', NaN)).toBe(false);
    expect(g.shouldAbort('buy', 0)).toBe(false);
  });

  it('물타기 체결 반영(setPosition) — 조건선이 새 평단 기준으로 내려간다', () => {
    const g = make(10, 100, 10);
    g.setPosition({ qty: 20, avgPrice: 98.5 });
    const v = g.view;
    expect(v.qty).toBe(20);
    expect(v.avgPrice).toBe(98.5);
    expect(v.sellLine).toBeCloseTo(98.5 * 1.02);
    expect(v.buyLine).toBeCloseTo(98.5 * 0.97);
    // 다음 물타기도 여전히 최초 진입 수량 고정.
    expect(g.decide('BUY', 90)).toEqual({ side: 'buy', qty: 10 });
  });

  it('비정상 입력 방어 — 가격·포지션이 무효면 판정하지 않는다', () => {
    const g = make();
    expect(g.decide('SELL', NaN)).toBeNull();
    expect(g.decide('BUY', 0)).toBeNull();
    g.setPosition({ qty: 0, avgPrice: 100 });
    expect(g.decide('SELL', 200)).toBeNull(); // 수량 0 — 팔 것도 기준도 없다.
  });
});
