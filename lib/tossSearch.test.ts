import { describe, expect, it, vi } from 'vitest';
import { searchStocks } from './tossSearch';

function mockSearchFetch(items: unknown[]) {
  return vi.fn().mockResolvedValue({
    json: async () => ({ result: [{ data: { items } }] }),
  });
}

describe('searchStocks', () => {
  it('미국 3거래소만 남기고 토스 마켓 코드를 앱 코드로 매핑한다(NSQ→NAS, AMX→AMS)', async () => {
    const fetchImpl = mockSearchFetch([
      { symbol: 'TSLA', market: 'NSQ', productName: '테슬라', logoImageUrl: 'https://x/tsla.png' },
      { symbol: 'KO', market: 'NYS', productName: '코카콜라' },
      { symbol: 'TSLW', market: 'AMX', productName: 'TSLW' },
    ]);

    const results = await searchStocks('테슬라', { fetchImpl });

    expect(results).toEqual([
      { symbol: 'TSLA', market: 'NAS', name: '테슬라', logoImageUrl: 'https://x/tsla.png' },
      { symbol: 'KO', market: 'NYS', name: '코카콜라', logoImageUrl: undefined },
      { symbol: 'TSLW', market: 'AMS', name: 'TSLW', logoImageUrl: undefined },
    ]);
  });

  it('국내 종목(KSP/KSQ)·market 없는 항목은 제외한다', async () => {
    const fetchImpl = mockSearchFetch([
      { symbol: '457480', market: 'KSP', productName: 'ACE 테슬라밸류체인액티브' },
      { symbol: 'AKO.B', market: null, productName: '엠보테야도라 안디나 B' },
      { symbol: 'TSLA', market: 'NSQ', productName: '테슬라' },
    ]);

    const results = await searchStocks('테슬라', { fetchImpl });

    expect(results.map((r) => r.symbol)).toEqual(['TSLA']);
  });

  it('빈/공백 질의는 네트워크 없이 빈 배열을 돌려준다', async () => {
    const fetchImpl = vi.fn();

    expect(await searchStocks('', { fetchImpl })).toEqual([]);
    expect(await searchStocks('   ', { fetchImpl })).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('응답 스키마가 비어 있어도(result 없음) 빈 배열을 돌려준다', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ json: async () => ({}) });

    expect(await searchStocks('AAPL', { fetchImpl })).toEqual([]);
  });

  it('productName이 없으면 symbol을 이름으로 쓴다', async () => {
    const fetchImpl = mockSearchFetch([{ symbol: 'AAPL', market: 'NSQ' }]);

    const results = await searchStocks('AAPL', { fetchImpl });

    expect(results[0].name).toBe('AAPL');
  });
});
