// Yahoo Finance 검색(v1/finance/search) — 종목의 최근 뉴스 목록 + 섹터/업종/정식명. 무인증.
// bitcoin-simulation의 Vercel 프록시(/api/yahoo/* → query1.finance.yahoo.com)를 거친다(CDN 1시간 캐시).
// 기업 탭(companyBrief)이 AI에 던질 재료로 쓴다 — Gemini 검색 그라운딩은 무료 할당량 밖(429)이라
// 2026-08-19 앱이 직접 조회해 프롬프트에 넣는 방식으로 확정.
// quoteSummary(사업 설명 assetProfile)는 crumb 인증이 필요해 쓰지 않는다.

export const YAHOO_PROXY_BASE = 'https://simulation-inpiniti.vercel.app/api/yahoo';
const TIMEOUT_MS = 15_000;

export interface YahooNewsItem {
  title: string;
  publisher: string;
  /** epoch ms. */
  publishedAt: number;
  link: string;
}

export interface YahooCompanyProfile {
  longName: string;
  sector: string;
  industry: string;
  exchange: string;
}

export interface YahooSearchResult {
  profile: YahooCompanyProfile | null;
  news: YahooNewsItem[];
}

export function buildYahooSearchUrl(ticker: string, newsCount = 8, base = YAHOO_PROXY_BASE): string {
  const q = encodeURIComponent(ticker.trim().toUpperCase());
  return `${base}/v1/finance/search?q=${q}&newsCount=${newsCount}&quotesCount=5&enableFuzzyQuery=false`;
}

function s(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** 응답 JSON → 정규화. quotes에서 심볼이 정확히 일치하는 EQUITY/ETF 하나를 프로필로 고른다. */
export function parseYahooSearch(json: unknown, ticker: string): YahooSearchResult {
  const obj = (json ?? {}) as { quotes?: unknown[]; news?: unknown[] };
  const upper = ticker.trim().toUpperCase();
  let profile: YahooCompanyProfile | null = null;
  for (const raw of Array.isArray(obj.quotes) ? obj.quotes : []) {
    const q = (raw ?? {}) as Record<string, unknown>;
    if (s(q.symbol).toUpperCase() !== upper) continue;
    profile = {
      longName: s(q.longname) || s(q.shortname),
      sector: s(q.sectorDisp) || s(q.sector),
      industry: s(q.industryDisp) || s(q.industry),
      exchange: s(q.exchDisp) || s(q.exchange),
    };
    break;
  }
  const news: YahooNewsItem[] = (Array.isArray(obj.news) ? obj.news : [])
    .map((raw) => {
      const n = (raw ?? {}) as Record<string, unknown>;
      const t = typeof n.providerPublishTime === 'number' ? n.providerPublishTime : Number(n.providerPublishTime);
      return {
        title: s(n.title),
        publisher: s(n.publisher),
        publishedAt: Number.isFinite(t) ? t * 1000 : 0,
        link: s(n.link),
      };
    })
    .filter((n) => n.title)
    .sort((a, b) => b.publishedAt - a.publishedAt);
  return { profile, news };
}

export interface FetchYahooSearchDeps {
  fetchImpl?: typeof fetch;
  base?: string;
}

/** 실패(네트워크·비200·파싱)는 throw — 호출 측(companyBrief)이 뉴스 없이 진행할지 정한다. */
export async function fetchYahooSearch(ticker: string, deps: FetchYahooSearchDeps = {}): Promise<YahooSearchResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(buildYahooSearchUrl(ticker, 8, deps.base), { signal: controller.signal });
    if (!res.ok) throw new Error(`Yahoo search HTTP ${res.status}`);
    return parseYahooSearch(await res.json(), ticker);
  } finally {
    clearTimeout(timer);
  }
}
