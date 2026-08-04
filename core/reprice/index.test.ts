import { describe, expect, it } from 'vitest';
import { decideReprice, type RepriceInput } from './index';

/** 정정이 나가는 정상 상태 — 각 테스트가 필요한 필드만 덮어쓴다. */
const BASE: RepriceInput = {
  currentPrice: 12.34,
  bid1: 12.3,
  quoteFresh: true,
  remainingQty: 10,
  amendInFlight: false,
  cancelInvolved: false,
  disabled: false,
};

const at = (over: Partial<RepriceInput>) => decideReprice({ ...BASE, ...over });

describe('decideReprice — 매도 리프라이스 판정', () => {
  it('① 매수1호가가 접수가와 같으면 정정하지 않는다 (유량 절감)', () => {
    expect(at({ bid1: 12.34, currentPrice: 12.34 })).toEqual({ action: 'hold', reason: 'same-price' });
  });

  it('② 매수1호가가 바뀌면 그 가격·잔량으로 정정한다', () => {
    expect(at({ bid1: 12.3, currentPrice: 12.34, remainingQty: 7 })).toEqual({
      action: 'amend',
      price: 12.3,
      qty: 7,
    });
  });

  it('③ 매수1호가가 올라가도 그대로 따라간다 (하향 전용이 아니다)', () => {
    expect(at({ bid1: 12.5, currentPrice: 12.34 })).toEqual({ action: 'amend', price: 12.5, qty: 10 });
  });

  it('④ 호가가 낡으면(폴백 발주 중) 정정하지 않는다', () => {
    expect(at({ quoteFresh: false })).toEqual({ action: 'hold', reason: 'stale-quote' });
  });

  it('⑤ 유효한 매수1호가가 없으면 정정하지 않는다', () => {
    expect(at({ bid1: 0 })).toEqual({ action: 'hold', reason: 'no-quote' });
  });

  it('⑥ 잔량이 없으면(전량 체결) 정정하지 않는다', () => {
    expect(at({ remainingQty: 0 })).toEqual({ action: 'hold', reason: 'no-remaining' });
    expect(at({ remainingQty: -1 })).toEqual({ action: 'hold', reason: 'no-remaining' });
  });

  it('⑦ 접수된 주문이 없으면 정정하지 않는다', () => {
    expect(at({ currentPrice: 0 })).toEqual({ action: 'hold', reason: 'no-order' });
  });

  it('⑧ 직전 정정이 왕복 중이면 새 정정을 내지 않는다', () => {
    expect(at({ amendInFlight: true })).toEqual({ action: 'hold', reason: 'in-flight' });
  });

  it('⑨ 취소가 얽힌 주문은 정정하지 않는다', () => {
    expect(at({ cancelInvolved: true })).toEqual({ action: 'hold', reason: 'cancel-involved' });
  });

  it('⑩ 자진 중단 상태면 어떤 조건에서도 정정하지 않는다', () => {
    expect(at({ disabled: true })).toEqual({ action: 'hold', reason: 'disabled' });
  });

  it('⑪ 보류 사유는 우선순위대로 판정한다 (중단 > 취소 > 왕복중)', () => {
    expect(at({ disabled: true, cancelInvolved: true, amendInFlight: true }).action).toBe('hold');
    expect(at({ disabled: true, cancelInvolved: true, amendInFlight: true })).toEqual({
      action: 'hold',
      reason: 'disabled',
    });
    expect(at({ cancelInvolved: true, amendInFlight: true })).toEqual({
      action: 'hold',
      reason: 'cancel-involved',
    });
  });

  it('⑫ 같은 입력이면 항상 같은 출력이다 — 시간에 따라 값이 변하지 않는다(에스컬레이션 금지)', () => {
    // 이 모듈에는 시간 입력이 없으므로, 몇 번을 불러도 정정가는 언제나 매수1호가 그대로다.
    const input: RepriceInput = { ...BASE, bid1: 12.3, currentPrice: 12.34 };
    const results = Array.from({ length: 100 }, () => decideReprice(input));
    for (const r of results) expect(r).toEqual({ action: 'amend', price: 12.3, qty: 10 });
  });
});
