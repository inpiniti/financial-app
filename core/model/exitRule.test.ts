// 모델 청산 규칙 — 트레일링 −5% + 하드 손절 −2% + 장 마감(2026-08-24 전환).
// 근거·숫자는 financial-analyze `docs/analysis/2026-08-24_청산-연구.md`.

import { describe, expect, it } from 'vitest';
import { MODEL_EXIT_CONFIG, ModelExitRule, OUTLIER_JUMP_PCT } from './exitRule';

const seed = { qty: 10, avgPrice: 100 };
/** 2026-08-24 13:00Z = ET 09:00 — 장중(마감 20:00 ET 전). */
const T0 = Date.parse('2026-08-24T13:00:00Z');
const make = (nowRef?: { now: number }) =>
  new ModelExitRule(seed, {
    ...MODEL_EXIT_CONFIG,
    entryAtMs: T0,
    clock: nowRef ? { now: () => nowRef.now } : undefined,
  });

describe('ModelExitRule — 매도선', () => {
  it('진입 직후에는 하드 손절 −2%가 매도선이다 (고점=평단이라 트레일선이 더 아래)', () => {
    const r = make();
    expect(r.hardStopPrice).toBeCloseTo(98, 9);
    expect(r.peakPrice).toBe(100);
    expect(r.stopPrice).toBeCloseTo(98, 9); // max(98, 100×0.95=95) = 98
  });

  it('고점이 오르면 매도선이 따라 올라간다 — 그리고 내려오지 않는다', () => {
    const r = make();
    r.onPriceAt(110);
    expect(r.peakPrice).toBe(110);
    expect(r.stopPrice).toBeCloseTo(104.5, 9); // 110 × 0.95

    r.onPriceAt(106); // 되돌림 — 고점·매도선은 그대로
    expect(r.peakPrice).toBe(110);
    expect(r.stopPrice).toBeCloseTo(104.5, 9);

    r.onPriceAt(130);
    expect(r.stopPrice).toBeCloseTo(123.5, 9);
  });

  it('트레일선 전환점은 평단 대비 약 +3.2% — 그 전에는 −2%가 유효하다', () => {
    const r = make();
    r.onPriceAt(103); // 103×0.95 = 97.85 < 98 → 아직 하드 손절이 위
    expect(r.stopPrice).toBeCloseTo(98, 9);
    r.onPriceAt(104); // 104×0.95 = 98.8 > 98 → 트레일선이 앞선다
    expect(r.stopPrice).toBeCloseTo(98.8, 9);
  });
});

describe('ModelExitRule — 청산 판정', () => {
  it('고점 대비 −5%에 닿으면 전량 매도(TRAIL)', () => {
    const r = make();
    r.onPriceAt(120); // 매도선 114
    expect(r.onPriceAt(114.5)).toBeNull();
    expect(r.onPriceAt(114)).toEqual({ side: 'sell', qty: 10 });
    expect(r.exitKind).toBe('TRAIL');
  });

  it('오르지 않은 채 −2%에 닿으면 전량 매도(STOP_LOSS)', () => {
    const r = make();
    expect(r.onPriceAt(98.01)).toBeNull();
    expect(r.onPriceAt(98)).toEqual({ side: 'sell', qty: 10 });
    expect(r.exitKind).toBe('STOP_LOSS');
  });

  it('익절 상한이 없다 — 아무리 올라도 꺾이기 전에는 안 판다', () => {
    const r = make();
    // 실제 체결 흐름처럼 한 틱에 밴드(±30%) 안에서 오른다 — 100 → 1000까지 10배.
    let p = 100;
    while (p < 1000) {
      p = Math.min(1000, p * 1.2);
      expect(r.onPriceAt(p)).toBeNull();
    }
    expect(r.peakPrice).toBeCloseTo(1000, 6);
    expect(r.onPriceAt(950)).toEqual({ side: 'sell', qty: 10 }); // 1000×0.95
    expect(r.exitKind).toBe('TRAIL');
  });

  it('장 마감(20:00 ET) 이후면 전량 매도(SESSION_END)', () => {
    const now = { now: Date.parse('2026-08-24T23:59:00Z') }; // ET 19:59 — 아직 장중
    const r = make(now);
    expect(r.onPrice(101)).toBeNull();
    now.now = Date.parse('2026-08-25T00:00:00Z'); // ET 20:00
    expect(r.onPrice(101)).toEqual({ side: 'sell', qty: 10 });
    expect(r.exitKind).toBe('SESSION_END');
  });

  it('clock이 없으면 장 마감 청산은 하지 않는다 — 가격 판정만', () => {
    const r = make();
    expect(r.onPrice(101)).toBeNull();
  });
});

describe('ModelExitRule — 이상치 방어 (실거래 오체결)', () => {
  it('한 틱만 튄 가짜 고가는 고점을 올리지 않는다', () => {
    const r = make();
    r.onPriceAt(100);
    r.onPriceAt(1000); // ×10 오체결 — 보류
    expect(r.peakPrice).toBe(100);
    r.onPriceAt(100.5); // 정상 복귀 → 보류값 폐기
    expect(r.peakPrice).toBe(100.5);
    expect(r.stopPrice).toBeCloseTo(98, 9); // 매도선이 950으로 튀지 않았다
  });

  it('한 틱만 튄 가짜 저가는 손절을 유발하지 않는다', () => {
    const r = make();
    r.onPriceAt(110);
    expect(r.onPriceAt(1)).toBeNull(); // −99% 오체결 — 보류, 매도 없음
    expect(r.onPriceAt(109)).toBeNull(); // 정상 복귀
    expect(r.peakPrice).toBe(110);
  });

  it('다음 틱이 확인해 주면 진짜 급변으로 받아들인다 (최대 1틱 지연)', () => {
    const r = make();
    r.onPriceAt(100);
    expect(r.onPriceAt(60)).toBeNull(); // −40% 급락, 1틱 보류
    expect(r.onPriceAt(61)).toEqual({ side: 'sell', qty: 10 }); // 확인 → 손절
    expect(r.exitKind).toBe('STOP_LOSS');
  });

  it('허용 밴드(±30%) 안의 움직임은 지연 없이 그대로 반영된다', () => {
    const r = make();
    const inBand = 100 * (1 + OUTLIER_JUMP_PCT * 0.9);
    r.onPriceAt(inBand);
    expect(r.peakPrice).toBeCloseTo(inBand, 9);
  });
});

describe('ModelExitRule — PositionRule 계약', () => {
  it('신호로는 아무것도 하지 않는다 — 물타기도 없다', () => {
    const r = make();
    expect(r.decide('SELL', 90)).toBeNull();
    expect(r.decide('BUY', 90)).toBeNull();
  });

  it('취소선 없음 — 어떤 가격이든 추격을 이어간다', () => {
    const r = make();
    expect(r.shouldAbort('sell', 1)).toBe(false);
    expect(r.shouldAbort('buy', 1_000)).toBe(false);
  });

  it('게이지는 위끝=진입 후 고점, 아래끝=지금 매도선', () => {
    const r = make();
    r.onPriceAt(120);
    const v = r.view;
    expect(v.sellLine).toBe(120);
    expect(v.buyLine).toBeCloseTo(114, 9);
    expect(v.qty).toBe(10);
  });

  it('잔고 재조회로 평단이 바뀌면 손절선도 따라가되 고점은 낮추지 않는다', () => {
    const r = make();
    r.onPriceAt(120);
    r.setPosition({ qty: 20, avgPrice: 110 });
    expect(r.hardStopPrice).toBeCloseTo(107.8, 9); // 110 × 0.98
    expect(r.peakPrice).toBe(120); // 고점 유지
    expect(r.onPriceAt(114)).toEqual({ side: 'sell', qty: 20 });
  });
});
