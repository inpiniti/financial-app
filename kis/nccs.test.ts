import { describe, expect, it, vi } from 'vitest';
import { inquireOverseasUnfilled, NCCS_TR_ID } from './nccs';
import { KisApiError } from './types';

const account = { cano: '12345678', acntPrdtCd: '01' };
const credentials = { appKey: 'appkey-value', appSecret: 'appsecret-value' };

function mockFetch(overrides: Record<string, unknown> = {}) {
  return vi.fn().mockResolvedValue({
    json: async () => ({
      rt_cd: '0',
      msg_cd: 'MSG',
      msg1: 'ok',
      ctx_area_fk200: '',
      ctx_area_nk200: '',
      output: [],
      ...overrides,
    }),
  });
}

describe('inquireOverseasUnfilled (미체결내역.md, TTTS3018R)', () => {
  it('TR ID·URL·필수 파라미터가 문서와 일치한다', async () => {
    const fetchImpl = mockFetch();
    await inquireOverseasUnfilled('live', credentials, 'access-token', { account, ovrsExcgCd: 'NASD' }, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain('https://openapi.koreainvestment.com:9443/uapi/overseas-stock/v1/trading/inquire-nccs');
    expect(url).toContain('CANO=12345678');
    expect(url).toContain('ACNT_PRDT_CD=01');
    expect(url).toContain('OVRS_EXCG_CD=NASD');
    expect(url).toContain('SORT_SQN=DS');
    expect(url).toContain('CTX_AREA_FK200=');
    expect(url).toContain('CTX_AREA_NK200=');

    const headers = init.headers as Record<string, string>;
    expect(headers.tr_id).toBe(NCCS_TR_ID);
    expect(headers.tr_id).toBe('TTTS3018R');
    expect(headers.custtype).toBe('P');
    expect(headers.authorization).toBe('Bearer access-token');
  });

  it('연속조회 파라미터(ctxAreaFk200/ctxAreaNk200)를 그대로 쿼리에 실어 보낸다', async () => {
    const fetchImpl = mockFetch();
    await inquireOverseasUnfilled(
      'live',
      credentials,
      'access-token',
      { account, ovrsExcgCd: 'NASD', ctxAreaFk200: 'FK-PAGE2', ctxAreaNk200: 'NK-PAGE2' },
      { fetchImpl },
    );

    const [url] = fetchImpl.mock.calls[0];
    expect(url).toContain('CTX_AREA_FK200=FK-PAGE2');
    expect(url).toContain('CTX_AREA_NK200=NK-PAGE2');
  });

  it('연속조회 응답의 ctx_area_fk200/nk200을 결과에 그대로 반환한다', async () => {
    const fetchImpl = mockFetch({ ctx_area_fk200: 'FK-NEXT', ctx_area_nk200: 'NK-NEXT' });
    const result = await inquireOverseasUnfilled('live', credentials, 'access-token', { account, ovrsExcgCd: 'NASD' }, { fetchImpl });

    expect(result.ctxAreaFk200).toBe('FK-NEXT');
    expect(result.ctxAreaNk200).toBe('NK-NEXT');
  });

  it('rt_cd가 0이 아니면 KisApiError를 던진다', async () => {
    const fetchImpl = mockFetch({ rt_cd: '1', msg_cd: 'APTR0058', msg1: '처리계좌의 ID와 사용자정보가 상이' });

    await expect(
      inquireOverseasUnfilled('live', credentials, 'access-token', { account, ovrsExcgCd: 'NASD' }, { fetchImpl }),
    ).rejects.toThrow(KisApiError);
  });
});
