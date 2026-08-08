import { describe, expect, it, vi } from 'vitest';
import { inquireOverseasPeriodProfit, inquireOverseasPeriodProfitAll } from './periodProfit';

const credentials = { appKey: 'appkey-value', appSecret: 'appsecret-value' };
const account = { cano: '12345678', acntPrdtCd: '01' };

function mockFetch(body: unknown) {
  return vi.fn().mockResolvedValue({ json: async () => body });
}

/** tr_cont 응답 헤더까지 흉내 내는 mock — 호출 순서대로 페이지를 돌려준다. */
function mockPagedFetch(pages: { body: unknown; trCont: string }[]) {
  const fn = vi.fn();
  for (const page of pages) {
    fn.mockResolvedValueOnce({
      json: async () => page.body,
      headers: { get: (name: string) => (name === 'tr_cont' ? page.trCont : null) },
    });
  }
  return fn;
}

function rawItem(pdno: string, tradeDt = '20260710'): Record<string, string> {
  return {
    trad_day: tradeDt,
    ovrs_pdno: pdno,
    ovrs_item_name: pdno,
    slcl_qty: '1',
    pchs_avg_pric: '100',
    frcr_pchs_amt1: '100',
    avg_sll_unpr: '110',
    frcr_sll_amt_smtl1: '110',
    stck_sll_tlex: '0',
    ovrs_rlzt_pfls_amt: '10',
    pftrt: '10',
    exrt: '1350',
    ovrs_excg_cd: 'NASD',
    frst_bltn_exrt: '1350',
  };
}

describe('해외주식 기간손익 (TTTS3039R)', () => {
  it('TR ID·URL·파라미터가 기간손익.md와 일치한다(실전 도메인 고정)', async () => {
    const fetchImpl = mockFetch({
      rt_cd: '0',
      msg_cd: 'MSG',
      msg1: 'ok',
      output1: [],
      output2: {},
    });

    await inquireOverseasPeriodProfit(
      credentials,
      'token',
      { account, startDt: '20260701', endDt: '20260730' },
      { fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain(
      'https://openapi.koreainvestment.com:9443/uapi/overseas-stock/v1/trading/inquire-period-profit',
    );
    expect(url).toContain('CANO=12345678');
    expect(url).toContain('ACNT_PRDT_CD=01');
    expect(url).toContain('INQR_STRT_DT=20260701');
    expect(url).toContain('INQR_END_DT=20260730');
    expect(url).toContain('WCRC_FRCR_DVSN_CD=02');
    expect((init.headers as Record<string, string>).tr_id).toBe('TTTS3039R');
    // 모의투자 미지원 API이므로 environment 파라미터 자체가 없다 — 항상 실전 도메인.
    expect(url).not.toContain('openapivts');
  });

  it('OVRS_EXCG_CD 지정 시 그대로 반영하고, output1/output2를 문서 필드명 기준으로 파싱한다', async () => {
    const fetchImpl = mockFetch({
      rt_cd: '0',
      msg_cd: 'MSG',
      msg1: 'ok',
      output1: [
        {
          trad_day: '20260710',
          ovrs_pdno: 'AAPL',
          ovrs_item_name: '애플',
          slcl_qty: '10',
          pchs_avg_pric: '150.5',
          frcr_pchs_amt1: '1505.00',
          avg_sll_unpr: '160.25',
          frcr_sll_amt_smtl1: '1602.50',
          stck_sll_tlex: '1.20',
          ovrs_rlzt_pfls_amt: '96.30',
          pftrt: '6.40',
          exrt: '1350.5',
          ovrs_excg_cd: 'NASD',
          frst_bltn_exrt: '1349.0',
        },
      ],
      output2: {
        stck_sll_amt_smtl: '1602.50',
        stck_buy_amt_smtl: '1505.00',
        smtl_fee1: '1.20',
        excc_dfrm_amt: '1601.30',
        ovrs_rlzt_pfls_tot_amt: '96.30',
        tot_pftrt: '6.40',
        bass_dt: '20260730',
        exrt: '1350.5',
      },
    });

    const result = await inquireOverseasPeriodProfit(
      credentials,
      'token',
      { account, startDt: '20260701', endDt: '20260730', ovrsExcgCd: 'NASD' },
      { fetchImpl },
    );

    const [url] = fetchImpl.mock.calls[0];
    expect(url).toContain('OVRS_EXCG_CD=NASD');

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      tradeDt: '20260710',
      pdno: 'AAPL',
      name: '애플',
      sellQty: 10,
      realizedPnl: 96.3,
      pnlRate: 6.4,
      exchangeCode: 'NASD',
    });
    expect(result.summary).toMatchObject({
      totalRealizedPnl: 96.3,
      totalPnlRate: 6.4,
      baseDt: '20260730',
    });
  });

  it('연속조회 — 응답 헤더 tr_cont가 M인 동안 tr_cont=N + ctx 값으로 재호출해 전 페이지를 합친다', async () => {
    const fetchImpl = mockPagedFetch([
      {
        trCont: 'M',
        body: {
          rt_cd: '0', msg_cd: 'MSG', msg1: 'ok',
          output1: [rawItem('AAPL'), rawItem('TSLA')],
          output2: { ovrs_rlzt_pfls_tot_amt: '30', tot_pftrt: '10', bass_dt: '20260730', exrt: '1350' },
          ctx_area_fk200: 'FK-1',
          ctx_area_nk200: 'NK-1',
        },
      },
      {
        trCont: 'D',
        body: {
          rt_cd: '0', msg_cd: 'MSG', msg1: 'ok',
          output1: [rawItem('NVDA', '20260709')],
          output2: { ovrs_rlzt_pfls_tot_amt: '30', tot_pftrt: '10', bass_dt: '20260730', exrt: '1350' },
          ctx_area_fk200: '',
          ctx_area_nk200: '',
        },
      },
    ]);

    const result = await inquireOverseasPeriodProfitAll(
      credentials,
      'token',
      { account, startDt: '20260701', endDt: '20260730' },
      { fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [url2, init2] = fetchImpl.mock.calls[1];
    expect(url2).toContain('CTX_AREA_FK200=FK-1');
    expect(url2).toContain('CTX_AREA_NK200=NK-1');
    expect((init2.headers as Record<string, string>).tr_cont).toBe('N');
    // 첫 요청에는 tr_cont 헤더가 없다(초기 조회).
    expect((fetchImpl.mock.calls[0][1].headers as Record<string, string>).tr_cont).toBeUndefined();

    expect(result.items.map((i) => i.pdno)).toEqual(['AAPL', 'TSLA', 'NVDA']);
    expect(result.summary.totalRealizedPnl).toBe(30);
  });

  it('연속조회 — 마지막 페이지(tr_cont=D)면 한 번만 호출한다', async () => {
    const fetchImpl = mockPagedFetch([
      {
        trCont: 'D',
        body: {
          rt_cd: '0', msg_cd: 'MSG', msg1: 'ok',
          output1: [rawItem('AAPL')],
          output2: {},
          ctx_area_fk200: 'FK-1',
          ctx_area_nk200: 'NK-1',
        },
      },
    ]);

    const result = await inquireOverseasPeriodProfitAll(
      credentials,
      'token',
      { account, startDt: '20260701', endDt: '20260730' },
      { fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.items).toHaveLength(1);
  });

  it('연속조회 — 응답에 headers가 없어도(테스트/폴리필 fetch) 첫 페이지만으로 안전하게 끝난다', async () => {
    const fetchImpl = mockFetch({ rt_cd: '0', msg_cd: 'MSG', msg1: 'ok', output1: [rawItem('AAPL')], output2: {} });

    const result = await inquireOverseasPeriodProfitAll(
      credentials,
      'token',
      { account, startDt: '20260701', endDt: '20260730' },
      { fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.items).toHaveLength(1);
    expect(result.trCont).toBe('');
  });

  it('rt_cd가 0이 아니면 KisApiError를 던진다', async () => {
    const fetchImpl = mockFetch({ rt_cd: '1', msg_cd: 'EGW00123', msg1: '조회 실패' });

    await expect(
      inquireOverseasPeriodProfit(credentials, 'token', { account, startDt: '20260701', endDt: '20260730' }, { fetchImpl }),
    ).rejects.toMatchObject({ rtCd: '1', msgCd: 'EGW00123', msg1: '조회 실패' });
  });
});
