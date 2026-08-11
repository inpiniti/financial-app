// 토스 증권 자동완성 검색 클라이언트 — 비공식 API, 로그인 불필요(tossCommunity.ts와 같은 v2 엔드포인트, curl 실호출 확인).
// 티커·종목명(한글/영문) 질의 → 미국 3거래소(NAS/NYS/AMS) 종목만 걸러 반환한다. 국내 종목(KSP/KSQ 등)은 제외.
type FetchLike = typeof fetch;

export interface TossSearchDeps {
  fetchImpl?: FetchLike;
}

const SEARCH_URL = 'https://wts-info-api.tossinvest.com/api/v2/search-all/wts-auto-complete';

/** 앱/KIS 마켓 코드(features/stock/marketCodes.ts가 받는 값). */
export type TossAppMarket = 'NAS' | 'NYS' | 'AMS';

/** 토스 응답 market 코드 → 앱/KIS 마켓 코드. 순위(tossRanking.ts)도 같은 표를 쓴다. */
export const TOSS_MARKET_TO_APP: Record<string, TossAppMarket> = {
  NSQ: 'NAS',
  NYS: 'NYS',
  AMX: 'AMS',
};

export interface TossSearchResult {
  symbol: string;
  market: TossAppMarket;
  /** 토스 productName — 한글 종목명(없으면 영문). */
  name: string;
  logoImageUrl?: string;
}

interface RawSearchItem {
  symbol?: string;
  market?: string;
  productName?: string;
  logoImageUrl?: string;
}

interface RawSearchResponse {
  result?: Array<{ data?: { items?: RawSearchItem[] } }>;
}

/**
 * 티커 또는 종목명으로 검색해 미국 종목 목록을 돌려준다. 빈 질의는 네트워크 없이 [].
 * 응답 스키마 드리프트에 대비해 옵셔널 체이닝으로 방어한다(tossCommunity.ts 관례).
 */
export async function searchStocks(query: string, deps: TossSearchDeps = {}): Promise<TossSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const fetchImpl = deps.fetchImpl ?? fetch;
  const res = await fetchImpl(SEARCH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query: trimmed, sections: [{ type: 'PRODUCT' }] }),
  });
  const body = (await res.json()) as RawSearchResponse;
  const items = body.result?.[0]?.data?.items ?? [];

  const results: TossSearchResult[] = [];
  for (const item of items) {
    const market = item.market ? TOSS_MARKET_TO_APP[item.market] : undefined;
    if (!market || !item.symbol) continue;
    results.push({
      symbol: item.symbol,
      market,
      name: item.productName ?? item.symbol,
      logoImageUrl: item.logoImageUrl,
    });
  }
  return results;
}
