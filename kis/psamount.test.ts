import { describe, expect, it, vi } from 'vitest';
import { buyableUsdOf, inquirePsAmount } from './psamount';

const credentials = { appKey: 'appkey-value', appSecret: 'appsecret-value' };
const account = { cano: '12345678', acntPrdtCd: '01' };

function mockFetch(output: Record<string, unknown> = {}) {
  return vi.fn().mockResolvedValue({
    json: async () => ({ rt_cd: '0', msg_cd: 'MSG', msg1: 'ok', output }),
  });
}

describe('매수가능금액조회 (TTTS3007R/VTTS3007R)', () => {
  it('TR ID·URL·파라미터가 매수가능금액조회.md와 일치한다', async () => {
    const fetchImpl = mockFetch({ ovrs_ord_psbl_amt: '123.45' });
    const output = await inquirePsAmount(
      'live',
      credentials,
      'token',
      { account, ovrsExcgCd: 'NASD', ordUnpr: 12.34, itemCd: 'AAPL' },
      { fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain('https://openapi.koreainvestment.com:9443/uapi/overseas-stock/v1/trading/inquire-psamount');
    expect(url).toContain('CANO=12345678');
    expect(url).toContain('ACNT_PRDT_CD=01');
    expect(url).toContain('OVRS_EXCG_CD=NASD');
    expect(url).toContain('OVRS_ORD_UNPR=12.34');
    expect(url).toContain('ITEM_CD=AAPL');
    expect((init.headers as Record<string, string>).tr_id).toBe('TTTS3007R');
    expect(output.ovrs_ord_psbl_amt).toBe('123.45');
  });

  it('모의는 VTTS3007R', async () => {
    const fetchImpl = mockFetch();
    await inquirePsAmount(
      'paper',
      credentials,
      'token',
      { account, ovrsExcgCd: 'NASD', ordUnpr: 1, itemCd: 'AAPL' },
      { fetchImpl },
    );
    expect((fetchImpl.mock.calls[0][1].headers as Record<string, string>).tr_id).toBe('VTTS3007R');
  });

  it('buyableUsdOf — ovrs_ord_psbl_amt 숫자 변환, 파싱 불가면 null', () => {
    expect(buyableUsdOf({ ovrs_ord_psbl_amt: '250.00' })).toBe(250);
    expect(buyableUsdOf({ ovrs_ord_psbl_amt: '' })).toBeNull();
    expect(buyableUsdOf({})).toBeNull();
  });

  it('rt_cd가 0이 아니면 throw', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      json: async () => ({ rt_cd: '1', msg_cd: 'ERR', msg1: '조회 실패' }),
    });
    await expect(
      inquirePsAmount('live', credentials, 'token', { account, ovrsExcgCd: 'NASD', ordUnpr: 1, itemCd: 'AAPL' }, { fetchImpl }),
    ).rejects.toThrow();
  });
});
