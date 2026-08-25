import { describe, expect, it, vi } from 'vitest';

import {
  buildTossChartUrl,
  fetchTossMinuteBars,
  fetchTossMinuteCandles,
  parseTossMinuteBars,
  parseTossMinuteCandles,
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
  it('N분봉은 min:N', () => {
    expect(buildTossChartUrl('X', 10, 5)).toContain('/min:5?count=10&');
  });
});

describe('parseTossMinuteCandles', () => {
  it('OHLCV·dt·sessionType을 원문 순서(최신순)로 — 키는 봉 시작(dt는 끝 라벨이라 주기를 뺀다)', () => {
    const c = parseTossMinuteCandles(SAMPLE);
    expect(c).toHaveLength(3);
    expect(c[0]).toMatchObject({ dt: '2026-08-18T01:33:00-04:00', sessionType: 'day', open: 0.7518, high: 0.7519, low: 0.7518, close: 0.7519, volume: 107 });
    // dt 01:33(끝) − 1분 = 시작 01:32.
    expect(c[0].minuteKey).toBe(Math.floor(Date.UTC(2026, 7, 18, 5, 32) / 60_000));
  });
  it('N분봉이면 시작 키 = dt − N분', () => {
    const c = parseTossMinuteCandles(SAMPLE, 5);
    expect(c[0].minuteKey).toBe(Math.floor(Date.UTC(2026, 7, 18, 5, 28) / 60_000));
  });
  it('OHL이 없거나 0이면 종가로 채운다', () => {
    const c = parseTossMinuteCandles({ result: { candles: [{ dt: '2026-08-18T01:33:00-04:00', close: 2, open: 0 }] } });
    expect(c[0]).toMatchObject({ open: 2, high: 2, low: 2, close: 2, volume: 0 });
  });
});

describe('parseTossMinuteBars', () => {
  it('dt(오프셋 ISO, 봉 끝)를 시작 epoch 분 키로, close를 종가로 — dt 01:33 → 키 01:32', () => {
    const bars = parseTossMinuteBars(SAMPLE);
    const k = Math.floor(Date.UTC(2026, 7, 18, 5, 32) / 60_000);
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
  it('GET · accept json · 응답을 MinuteBar[]로(지금이 마지막 봉보다 뒤면 전부)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ json: async () => SAMPLE });
    const bars = await fetchTossMinuteBars('US20200609002', 130, { fetchImpl, nowMs: Date.UTC(2026, 7, 18, 5, 40) });
    expect(bars).toHaveLength(3);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain('/c-chart/us-s/US20200609002/min:1?count=130');
    expect(init.method).toBe('GET');
  });
  it('진행 중 봉만 뺀다 — 지금 01:32:40이면 dt 01:33 봉(01:32~33 진행 중)은 제외, 지금 01:33:20이면 그 봉은 닫혔으니 포함', async () => {
    const mk = () => vi.fn().mockResolvedValue({ json: async () => SAMPLE });
    const inProgress = await fetchTossMinuteBars('X', 130, { fetchImpl: mk(), nowMs: Date.UTC(2026, 7, 18, 5, 32, 40) });
    expect(inProgress.map((b) => b.close)).toEqual([0.7519, 0.752]);
    // 2026-08-25까지는 여기서 방금 닫힌 봉까지 버려 판정이 한 봉 늦었다(끝 라벨 오독).
    const closed = await fetchTossMinuteBars('X', 130, { fetchImpl: mk(), nowMs: Date.UTC(2026, 7, 18, 5, 33, 20) });
    expect(closed.map((b) => b.close)).toEqual([0.7519, 0.7519, 0.752]);
  });
});

describe('fetchTossMinuteBars — intervalMin', () => {
  const body = { result: { candles: [
    { dt: '2026-08-18T01:33:00-04:00', close: 3 }, // 끝 01:33 → 시작 01:30(= UTC 05:30, 3의 배수)
    { dt: '2026-08-18T01:30:00-04:00', close: 2 },
    { dt: '2026-08-18T01:27:00-04:00', close: 1 },
  ] } };
  it('min:N URL로 받고, 지금이 속한 N분 봉(진행 중)만 뺀다', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ json: async () => body });
    // 지금 = 05:32:10 → 진행 중 3분 봉 시작 = 05:30 → dt 01:33 봉(시작 05:30) 제외.
    const bars = await fetchTossMinuteBars('X', 130, { fetchImpl, intervalMin: 3, nowMs: Date.UTC(2026, 7, 18, 5, 32, 10) });
    expect(fetchImpl.mock.calls[0][0]).toContain('/min:3?count=130&');
    expect(bars.map((b) => b.close)).toEqual([2, 1]);
  });
  it('봉이 닫힌 직후에는 그 봉을 포함한다 — 지금 05:34:10이면 dt 01:33(시작 05:30) 봉은 닫혔다', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ json: async () => body });
    const bars = await fetchTossMinuteBars('X', 130, { fetchImpl, intervalMin: 3, nowMs: Date.UTC(2026, 7, 18, 5, 34, 10) });
    expect(bars.map((b) => b.close)).toEqual([3, 2, 1]);
  });
});

describe('fetchTossMinuteCandles', () => {
  it('min:N URL로 GET, 진행 중 봉 포함 그대로', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ json: async () => SAMPLE });
    const c = await fetchTossMinuteCandles('X', 3, 50, { fetchImpl });
    expect(c).toHaveLength(3);
    expect(fetchImpl.mock.calls[0][0]).toContain('/min:3?count=50&');
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
