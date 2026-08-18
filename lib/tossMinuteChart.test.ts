import { describe, expect, it, vi } from 'vitest';

import {
  buildTossChartUrl,
  fetchTossMinuteBars,
  parseTossMinuteBars,
  resolveTossProductCode,
  TOSS_CHART_MAX_COUNT,
} from './tossMinuteChart';

// docs/toss/분봉.txt 원문 발췌 — 오버나이트 세션(ET 01:3x) 봉.
const SAMPLE = {
  result: {
    code: 'US20200609002',
    nextDateTime: '2026-08-17T20:31:00-04:00',
    exchangeRate: 1415.2,
    candles: [
      { dt: '2026-08-18T01:33:00-04:00', sessionType: 'day', base: 0.68, open: 0.7518, high: 0.7519, low: 0.7518, close: 0.7519, volume: 107, amount: 0 },
      { dt: '2026-08-18T01:32:00-04:00', sessionType: 'day', base: 0.68, open: 0.7519, high: 0.752, low: 0.7493, close: 0.7519, volume: 1820, amount: 0 },
      { dt: '2026-08-18T01:31:00-04:00', sessionType: 'day', base: 0.68, open: 0.7521, high: 0.7522, low: 0.752, close: 0.752, volume: 198, amount: 0 },
    ],
  },
};

describe('buildTossChartUrl', () => {
  it('us-s/{code}/min:1 에 count·useAdjustedRate를 싣는다(분봉.txt 원문 형태)', () => {
    expect(buildTossChartUrl('US20200609002', 130)).toBe(
      'https://wts-info-api.tossinvest.com/api/v1/c-chart/us-s/US20200609002/min:1?count=130&useAdjustedRate=true',
    );
  });
  it('count는 1..상한으로 자른다', () => {
    expect(buildTossChartUrl('X', 0)).toContain('count=1&');
    expect(buildTossChartUrl('X', 99_999)).toContain(`count=${TOSS_CHART_MAX_COUNT}&`);
  });
});

describe('parseTossMinuteBars', () => {
  it('dt(오프셋 ISO)를 epoch 분 키로, close를 종가로 — ET 01:33(-04:00) = UTC 05:33', () => {
    const bars = parseTossMinuteBars(SAMPLE);
    const k = Math.floor(Date.UTC(2026, 7, 18, 5, 33) / 60_000);
    expect(bars).toEqual([
      { minuteKey: k, close: 0.7519 },
      { minuteKey: k - 1, close: 0.7519 },
      { minuteKey: k - 2, close: 0.752 },
    ]);
  });
  it('dt 파싱 불가·종가 0 이하는 버리고, 형태가 다르면 []', () => {
    expect(
      parseTossMinuteBars({
        result: { candles: [{ dt: 'nope', close: 1 }, { dt: '2026-08-18T01:33:00-04:00', close: 0 }, { close: 2 }] },
      }),
    ).toEqual([]);
    expect(parseTossMinuteBars(null)).toEqual([]);
    expect(parseTossMinuteBars({ result: {} })).toEqual([]);
  });
});

describe('fetchTossMinuteBars', () => {
  it('GET · accept json · 응답을 MinuteBar[]로', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ json: async () => SAMPLE });
    const bars = await fetchTossMinuteBars('US20200609002', 130, { fetchImpl });
    expect(bars).toHaveLength(3);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain('/c-chart/us-s/US20200609002/min:1?count=130');
    expect(init.method).toBe('GET');
  });
});

describe('resolveTossProductCode', () => {
  const items = [
    { symbol: 'TSLA', market: 'NSQ', productCode: 'US20100629001', productName: '테슬라' },
    { symbol: 'TSLL', market: 'NSQ', productCode: 'US20220809012' },
    { symbol: 'TSLW', market: 'AMX', productCode: 'AMX0250219006' },
  ];
  const mk = () => vi.fn().mockResolvedValue({ json: async () => ({ result: [{ data: { items } }] }) });

  it('symbol 정확 일치 + 거래소 일치 항목의 productCode', async () => {
    expect(await resolveTossProductCode('tsla', 'NAS', { fetchImpl: mk() })).toBe('US20100629001');
    expect(await resolveTossProductCode('TSLW', 'AMS', { fetchImpl: mk() })).toBe('AMX0250219006');
  });
  it('거래소가 어긋나면 심볼만 맞는 미국 종목으로 폴백, 심볼이 없으면 null', async () => {
    expect(await resolveTossProductCode('TSLA', 'NYS', { fetchImpl: mk() })).toBe('US20100629001');
    expect(await resolveTossProductCode('AAPL', 'NAS', { fetchImpl: mk() })).toBeNull();
    expect(await resolveTossProductCode('  ', 'NAS', { fetchImpl: mk() })).toBeNull();
  });
});
