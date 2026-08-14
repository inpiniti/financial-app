import { describe, expect, it, vi } from 'vitest';

import {
  buildTossRankingBody,
  fetchTossRankings,
  fetchTossVolumeRanking,
  isTradableGroup,
  joinRankingRows,
  parseRankingProducts,
  parseStockInfos,
  TOSS_FILTER_EXCLUDE_MANAGEMENT,
  TOSS_RANKING_URL,
  TOSS_STOCK_INFO_URL,
} from './tossRanking';

/** 순위 응답 1건 — docs/toss/순위.txt 형태 그대로(필요 필드만). */
function product(rank: number, productCode: string, name: string, close: number, base: number) {
  return {
    rank,
    productCode,
    name,
    logoImageUrl: `https://static.toss.im/x-${name}.png`,
    price: { base, close, marketVolume: 1000 * rank, marketAmount: 2000 * rank },
  };
}

function info(code: string, symbol: string, marketCode: string, groupCode: string, name?: string) {
  return { code, symbol, name, market: { code: marketCode }, group: { code: groupCode } };
}

describe('parseRankingProducts / parseStockInfos', () => {
  it('응답 스키마가 어긋나면 빈 결과 — 던지지 않는다', () => {
    expect(parseRankingProducts(null)).toEqual([]);
    expect(parseRankingProducts({ result: {} })).toEqual([]);
    expect(parseStockInfos({ result: null }).size).toBe(0);
  });

  it('종목정보는 티커·미국 거래소가 있어야 담는다(NSQ→NAS, AMX→AMS)', () => {
    const map = parseStockInfos({
      result: [
        info('C1', 'NVDA', 'NSQ', 'ST', '엔비디아'),
        info('C2', 'KORU', 'AMX', 'EF'),
        info('C3', 'HIMS', 'NYS', 'ST'),
        info('C4', '005930', 'KSP', 'ST'), // 국내 — 미국 거래소가 아니라 제외.
        { code: 'C5', market: { code: 'NSQ' }, group: { code: 'ST' } }, // 티커 없음 — 제외.
      ],
    });
    expect([...map.keys()]).toEqual(['C1', 'C2', 'C3']);
    expect(map.get('C1')).toEqual({ symbol: 'NVDA', market: 'NAS', groupCode: 'ST', name: '엔비디아' });
    expect(map.get('C2')!.market).toBe('AMS');
  });
});

describe('isTradableGroup', () => {
  it('주권(ST)·주식예탁증권(DR)만 통과 — ETF·ETN·ELW와 미상은 제외', () => {
    expect(isTradableGroup('ST')).toBe(true);
    expect(isTradableGroup('DR')).toBe(true); // ADR(니오·알리바바 등)은 거래 대상.
    expect(isTradableGroup('EF')).toBe(false);
    expect(isTradableGroup('EN')).toBe(false);
    expect(isTradableGroup('EW')).toBe(false);
    expect(isTradableGroup('')).toBe(false);
  });
});

describe('joinRankingRows', () => {
  const infos = parseStockInfos({
    result: [
      info('C1', 'KORU', 'AMX', 'EF'),
      info('C2', 'NVDA', 'NSQ', 'ST', '엔비디아'),
      info('C3', 'NIO', 'NYS', 'DR'),
      info('C4', 'GDXU', 'AMX', 'EN'),
    ],
  });

  it('ETF·ETN과 종목정보를 못 찾은 행을 빼고 순위 순서를 지킨다', () => {
    const rows = joinRankingRows(
      [
        product(1, 'C1', 'KORU', 17.25, 16.41), // ETF — 제외.
        product(2, 'C2', '엔비디아', 219.02, 217.55),
        product(3, 'C4', 'GDXU', 137, 133.31), // ETN — 제외.
        product(4, 'C3', '니오(ADR)', 4.7, 4.82),
        product(5, 'C9', '모르는종목', 10, 10), // 종목정보 없음 — 제외.
      ],
      infos,
    );
    expect(rows.map((r) => r.symbol)).toEqual(['NVDA', 'NIO']);
    expect(rows[0].rank).toBe(2); // 토스 원본 순위를 그대로 들고 온다.
    expect(rows[0].market).toBe('NAS');
    expect(rows[1].market).toBe('NYS');
  });

  it('등락률은 기준가 대비로 계산한다 — 하락은 음수', () => {
    const rows = joinRankingRows([product(1, 'C2', '엔비디아', 110, 100), product(2, 'C3', '니오', 90, 100)], infos);
    expect(rows[0].ratePct).toBeCloseTo(10, 6);
    expect(rows[1].ratePct).toBeCloseTo(-10, 6);
  });

  it('현재가가 없거나 0이면 버리고, 기준가만 없으면 등락률 0으로 살린다', () => {
    const rows = joinRankingRows(
      [
        { rank: 1, productCode: 'C2', name: 'A', price: { close: 0, base: 10 } },
        { rank: 2, productCode: 'C3', name: 'B', price: { close: 12 } },
      ],
      infos,
    );
    expect(rows.map((r) => r.symbol)).toEqual(['NIO']);
    expect(rows[0].ratePct).toBe(0);
    expect(rows[0].base).toBe(12);
  });

  it('종목명은 순위 응답의 이름을 우선하고, 없으면 종목정보·티커로 폴백한다', () => {
    const rows = joinRankingRows(
      [product(1, 'C2', '엔비디아', 10, 10), { rank: 2, productCode: 'C3', price: { close: 5, base: 5 } }],
      infos,
    );
    expect(rows.map((r) => r.name)).toEqual(['엔비디아', 'NIO']);
  });
});

describe('fetchTossVolumeRanking', () => {
  it('순위 1콜 + 종목정보 1콜로 주식만 돌려준다', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === TOSS_RANKING_URL) {
        return { json: async () => ({ result: { products: [product(1, 'C1', 'KORU', 1, 1), product(2, 'C2', '엔비디아', 219, 200)] } }) };
      }
      return { json: async () => ({ result: [info('C1', 'KORU', 'AMX', 'EF'), info('C2', 'NVDA', 'NSQ', 'ST')] }) };
    }) as unknown as typeof fetch;

    const rows = await fetchTossVolumeRanking({ fetchImpl });

    expect(rows.map((r) => r.symbol)).toEqual(['NVDA']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, rankInit] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(rankInit.body)).toEqual(buildTossRankingBody('volume'));
    const [infoUrl] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(infoUrl).toBe(`${TOSS_STOCK_INFO_URL}?codes=C1,C2`);
  });

  it('순위가 비면 던진다 — 워치리스트가 직전 리스트를 유지하도록', async () => {
    const fetchImpl = vi.fn(async () => ({ json: async () => ({ result: { products: [] } }) })) as unknown as typeof fetch;
    await expect(fetchTossVolumeRanking({ fetchImpl })).rejects.toThrow('토스 순위');
  });
});

describe('buildTossRankingBody', () => {
  it('종류별 id — 거래량 biggest_market_volume, 거래대금 biggest_total_amount, 필터는 기본 빈 배열', () => {
    expect(buildTossRankingBody('volume')).toEqual({
      id: 'biggest_market_volume',
      filters: [],
      duration: 'realtime',
      tag: 'us',
    });
    expect(buildTossRankingBody('amount').id).toBe('biggest_total_amount');
  });

  it('excludeManagement면 관리종목 제외 필터만 싣는다 — $1·시총 필터는 넣지 않는다(2026-08-14 사용자 결정)', () => {
    expect(buildTossRankingBody('amount', true).filters).toEqual([TOSS_FILTER_EXCLUDE_MANAGEMENT]);
  });
});

describe('fetchTossRankings — 2종 병렬 + 종목정보 합집합 1콜', () => {
  it('순위 2콜 + 종목정보 1콜(코드 중복 제거)로 종류별 행을 돌려준다', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: { body?: string }) => {
      if (url === TOSS_RANKING_URL) {
        const body = JSON.parse(init!.body!) as { id: string };
        // 거래대금엔 C2·C3, 거래량엔 C2(중복)·C1(ETF) — 종목정보 코드는 합집합으로 한 번만.
        const products =
          body.id === 'biggest_total_amount'
            ? [product(1, 'C2', '엔비디아', 219, 200), product(2, 'C3', '니오', 4.7, 4.8)]
            : [product(1, 'C2', '엔비디아', 219, 200), product(2, 'C1', 'KORU', 1, 1)];
        return { json: async () => ({ result: { products } }) };
      }
      return {
        json: async () => ({
          result: [info('C1', 'KORU', 'AMX', 'EF'), info('C2', 'NVDA', 'NSQ', 'ST'), info('C3', 'NIO', 'NYS', 'DR')],
        }),
      };
    }) as unknown as typeof fetch;

    const rankings = await fetchTossRankings(['amount', 'volume'], { fetchImpl, excludeManagement: true });

    expect(rankings.amount.map((r) => r.symbol)).toEqual(['NVDA', 'NIO']);
    expect(rankings.volume.map((r) => r.symbol)).toEqual(['NVDA']); // ETF 제외.
    expect(fetchImpl).toHaveBeenCalledTimes(3); // 순위 2 + 종목정보 1.
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(JSON.parse(calls[0][1].body).filters).toEqual([TOSS_FILTER_EXCLUDE_MANAGEMENT]);
    expect(calls[2][0]).toBe(`${TOSS_STOCK_INFO_URL}?codes=C2,C3,C1`);
  });

  it('한 종류라도 비면 던진다 — 워치리스트가 직전 리스트를 유지하도록', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: { body?: string }) => {
      if (url === TOSS_RANKING_URL) {
        const body = JSON.parse(init!.body!) as { id: string };
        const products = body.id === 'biggest_total_amount' ? [product(1, 'C2', '엔비디아', 219, 200)] : [];
        return { json: async () => ({ result: { products } }) };
      }
      return { json: async () => ({ result: [] }) };
    }) as unknown as typeof fetch;
    await expect(fetchTossRankings(['amount', 'volume'], { fetchImpl })).rejects.toThrow('토스 순위');
  });
});
