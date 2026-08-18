import { describe, expect, it, vi } from 'vitest';
import { inquireOverseasMinuteChart, MINUTE_CHART_TR_ID } from './minuteChart';
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

describe('inquireOverseasMinuteChart (분봉조회.md, HHDFS76950200)', () => {
  it('TR ID·URL·필수 파라미터가 문서와 일치한다', async () => {
    const fetchImpl = mockFetch();
    await inquireOverseasMinuteChart(credentials, 'access-token', { excd: 'NAS', symb: 'AAPL', nmin: 1 }, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain('https://openapi.koreainvestment.com:9443/uapi/overseas-price/v1/quotations/inquire-time-itemchartprice');
    expect(url).toContain('AUTH=');
    expect(url).toContain('EXCD=NAS');
    expect(url).toContain('SYMB=AAPL');
    expect(url).toContain('NMIN=1');
    expect(url).toContain('PINC=0');
    expect(url).toContain('NREC=120');
    expect(url).toContain('FILL=');
    expect(url).toContain('KEYB=');

    const headers = init.headers as Record<string, string>;
    expect(headers.tr_id).toBe(MINUTE_CHART_TR_ID);
    expect(headers.tr_id).toBe('HHDFS76950200');
    expect(headers.custtype).toBe('P');
    expect(headers.authorization).toBe('Bearer access-token');
  });

  it('includePrev=true면 PINC=1로 보낸다', async () => {
    const fetchImpl = mockFetch();
    await inquireOverseasMinuteChart(
      credentials,
      'access-token',
      { excd: 'NAS', symb: 'AAPL', nmin: 1, includePrev: true },
      { fetchImpl },
    );

    const [url] = fetchImpl.mock.calls[0];
    expect(url).toContain('PINC=1');
  });

  it('output2를 숫자로 변환하고 시간 오름차순으로 정렬해 반환한다', async () => {
    const fetchImpl = mockFetch({
      output2: [
        { tymd: '20260729', xymd: '20260729', xhms: '093200', kymd: '20260729', khms: '223200', open: '10', high: '11', low: '9', last: '10.5', evol: '100', eamt: '1000' },
        { tymd: '20260729', xymd: '20260729', xhms: '093000', kymd: '20260729', khms: '223000', open: '9', high: '10', low: '8', last: '9.5', evol: '50', eamt: '500' },
        { tymd: '20260729', xymd: '20260729', xhms: '093100', kymd: '20260729', khms: '223100', open: '9.5', high: '10.5', low: '9', last: '10', evol: '75', eamt: '750' },
      ],
    });

    const result = await inquireOverseasMinuteChart(credentials, 'access-token', { excd: 'NAS', symb: 'AAPL', nmin: 1 }, { fetchImpl });

    expect(result.candles.map((c) => c.hms)).toEqual(['093000', '093100', '093200']);
    expect(result.candles[0]).toEqual({
      ymd: '20260729',
      hms: '093000',
      kymd: '20260729', // 한국 기준 일자·시각 원문 — 추세 1분봉 시드(kstToMinuteKey)용
      khms: '223000',
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
      inquireOverseasMinuteChart(credentials, 'access-token', { excd: 'NAS', symb: 'AAPL', nmin: 1 }, { fetchImpl }),
    ).rejects.toThrow(KisApiError);
  });
});
