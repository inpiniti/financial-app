import { describe, expect, it, vi } from 'vitest';
import {
  inquireOverseasBalance,
  isHoldablePosition,
  type OverseasBalancePosition,
} from './balance';

function samplePosition(overrides: Partial<OverseasBalancePosition> = {}): OverseasBalancePosition {
  return {
    prdt_name: 'Apple Inc',
    cblc_qty13: '10',
    thdt_buy_ccld_qty1: '0',
    thdt_sll_ccld_qty1: '0',
    ccld_qty_smtl1: '10',
    ord_psbl_qty1: '10',
    frcr_pchs_amt: '1500.00',
    frcr_evlu_amt2: '1700.00',
    evlu_pfls_amt2: '200.00',
    evlu_pfls_rt1: '13.33',
    pdno: 'AAPL',
    bass_exrt: '1350.00',
    buy_crcy_cd: 'USD',
    ovrs_now_pric1: '170.00',
    avg_unpr3: '150.00',
    tr_mket_name: '나스닥',
    natn_kor_name: '미국',
    ovrs_excg_cd: 'NASD',
    ...overrides,
  };
}

describe('isHoldablePosition — 유효 보유 종목 필터링', () => {
  it('체결기준 수량 > 0 및 현재가 > 0 인 정상 종목은 통과한다', () => {
    const pos = samplePosition({ ccld_qty_smtl1: '5', ovrs_now_pric1: '150.25' });
    expect(isHoldablePosition(pos)).toBe(true);
  });

  it('당일 전량 매도되어 체결기준 수량이 0인 종목은 제외한다 (결제수량이 남아있어도 제외)', () => {
    // T+1 결제 대기로 cblc_qty13은 10이지만 ccld_qty_smtl1은 0인 경우
    const pos = samplePosition({
      cblc_qty13: '10',
      ccld_qty_smtl1: '0',
      ovrs_now_pric1: '150.25',
    });
    expect(isHoldablePosition(pos)).toBe(false);
  });

  it('체결기준 수량이 음수이거나 0 이하인 비정상 종목은 제외한다', () => {
    expect(isHoldablePosition(samplePosition({ ccld_qty_smtl1: '-1' }))).toBe(false);
    expect(isHoldablePosition(samplePosition({ ccld_qty_smtl1: '0.00' }))).toBe(false);
  });

  it('현재가가 0인 종목(CVR, 거래 불능 잔여 권리, 상폐)은 제외한다', () => {
    const pos = samplePosition({
      ccld_qty_smtl1: '100',
      ovrs_now_pric1: '0',
    });
    expect(isHoldablePosition(pos)).toBe(false);
    expect(isHoldablePosition(samplePosition({ ovrs_now_pric1: '0.0000' }))).toBe(false);
  });

  it('수량이나 현재가가 유효한 숫자가 아니면 제외한다', () => {
    expect(isHoldablePosition(samplePosition({ ccld_qty_smtl1: '' }))).toBe(false);
    expect(isHoldablePosition(samplePosition({ ccld_qty_smtl1: 'NaN' }))).toBe(false);
    expect(isHoldablePosition(samplePosition({ ovrs_now_pric1: '' }))).toBe(false);
    expect(isHoldablePosition(samplePosition({ ovrs_now_pric1: 'undefined' }))).toBe(false);
  });
});

describe('inquireOverseasBalance — API 호출 및 파싱', () => {
  it('REST API를 올바르게 호출하고 output1, output2, output3을 반환한다', async () => {
    const mockOutput1 = [samplePosition({ pdno: 'AAPL' }), samplePosition({ pdno: 'TSLA', ccld_qty_smtl1: '0' })];
    const mockOutput3 = {
      pchs_amt_smtl: '1000',
      evlu_amt_smtl: '1200',
      evlu_pfls_amt_smtl: '200',
      tot_asst_amt: '5000000',
      evlu_erng_rt1: '20.0',
      tot_dncl_amt: '3000000',
    };

    const mockFetch = vi.fn().mockResolvedValue({
      json: async () => ({
        rt_cd: '0',
        msg_cd: 'MCA00000',
        msg1: '정상처리 되었습니다.',
        output1: mockOutput1,
        output2: [],
        output3: mockOutput3,
      }),
    });

    const res = await inquireOverseasBalance(
      'paper',
      { appKey: 'key', appSecret: 'secret' },
      'token',
      { account: { cano: '12345678', acntPrdtCd: '01' } },
      { fetchImpl: mockFetch as any },
    );

    expect(res.output1).toHaveLength(2);
    expect(res.output3.tot_asst_amt).toBe('5000000');
    // isHoldablePosition 필터링 검증
    const filtered = res.output1.filter(isHoldablePosition);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].pdno).toBe('AAPL');
  });
});
