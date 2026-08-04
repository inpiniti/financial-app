import { describe, expect, it, vi } from 'vitest';
import { inquireOverseasPeriodChart, PERIOD_CHART_TR_ID } from './periodChart';
import { KisApiError } from './types';

const credentials = { appKey: 'appkey-value', appSecret: 'appsecret-value' };

function mockFetch(overrides: Record<string, unknown> = {}) {
  return vi.fn().mockResolvedValue({
    json: async () => ({
      rt_cd: '0',
      msg_cd: 'MSG',
      msg1: 'ok',
      output1: {},
      output2: [],
      ...overrides,
    }),
  });
}

describe('inquireOverseasPeriodChart (기간별시세.md, HHDFS76240000)', () => {
  it('TR ID·URL·필수 파라미터가 문서와 일치한다(일봉, 기본 MODP=1)', async () => {
    const fetchImpl = mockFetch();
    await inquireOverseasPeriodChart('live', credentials, 'access-token', { excd: 'NAS', symb: 'AAPL', period: 'D' }, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain('https://openapi.koreainvestment.com:9443/uapi/overseas-price/v1/quotations/dailyprice');
    expect(url).toContain('AUTH=');
    expect(url).toContain('EXCD=NAS');
    expect(url).toContain('SYMB=AAPL');
    expect(url).toContain('GUBN=0');
    expect(url).toContain('BYMD=');
    expect(url).toContain('MODP=1');
    expect(url).toContain('KEYB=');

    const headers = init.headers as Record<string, string>;
    expect(headers.tr_id).toBe(PERIOD_CHART_TR_ID);
    expect(headers.tr_id).toBe('HHDFS76240000');
    expect(headers.custtype).toBe('P');
    expect(headers.authorization).toBe('Bearer access-token');
  });

  it('period=W/M이 GUBN 1/2로, environment=paper가 모의 도메인으로 매핑된다', async () => {
    const fetchImplWeek = mockFetch();
    await inquireOverseasPeriodChart('paper', credentials, 'access-token', { excd: 'NAS', symb: 'AAPL', period: 'W' }, { fetchImpl: fetchImplWeek });
    const [weekUrl] = fetchImplWeek.mock.calls[0];
    expect(weekUrl).toContain('https://openapivts.koreainvestment.com:29443');
    expect(weekUrl).toContain('GUBN=1');

    const fetchImplMonth = mockFetch();
    await inquireOverseasPeriodChart('live', credentials, 'access-token', { excd: 'NAS', symb: 'AAPL', period: 'M', modp: '0' }, { fetchImpl: fetchImplMonth });
    const [monthUrl] = fetchImplMonth.mock.calls[0];
    expect(monthUrl).toContain('GUBN=2');
    expect(monthUrl).toContain('MODP=0');
  });

  it('output2를 숫자로 변환하고 일자 오름차순으로 정렬해 반환한다', async () => {
    const fetchImpl = mockFetch({
      output2: [
        { xymd: '20260729', clos: '10.5', sign: '2', diff: '0.5', rate: '5', open: '10', high: '11', low: '9', tvol: '100', tamt: '1000' },
        { xymd: '20260727', clos: '9.5', sign: '2', diff: '0.5', rate: '5', open: '9', high: '10', low: '8', tvol: '50', tamt: '500' },
        { xymd: '20260728', clos: '10', sign: '2', diff: '0.5', rate: '5', open: '9.5', high: '10.5', low: '9', tvol: '75', tamt: '750' },
      ],
    });

    const result = await inquireOverseasPeriodChart('live', credentials, 'access-token', { excd: 'NAS', symb: 'AAPL', period: 'D' }, { fetchImpl });

    expect(result.candles.map((c) => c.ymd)).toEqual(['20260727', '20260728', '20260729']);
    expect(result.candles[0]).toEqual({
      ymd: '20260727',
      open: 9,
      high: 10,
      low: 8,
      close: 9.5,
      volume: 50,
    });
  });

  it('rt_cd가 0이 아니면 KisApiError를 던진다', async () => {
    const fetchImpl = mockFetch({ rt_cd: '1', msg_cd: 'OPSQ0011', msg1: '조회 실패' });

    await expect(
      inquireOverseasPeriodChart('live', credentials, 'access-token', { excd: 'NAS', symb: 'AAPL', period: 'D' }, { fetchImpl }),
    ).rejects.toThrow(KisApiError);
  });
});
