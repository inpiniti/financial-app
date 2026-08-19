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

// ---- 기사 본문 (bitcoin-simulation /api/simple/article) ----

export const ARTICLE_ENDPOINT = 'https://simulation-inpiniti.vercel.app/api/simple/article';
const ARTICLE_TIMEOUT_MS = 20_000;
/** 기사당 본문 최대 글자수 — 5건×3,000자 ≈ 4~5K 토큰, 3.5-flash-lite TPM(250K) 안에서 넉넉하다. */
export const ARTICLE_MAX_CHARS = 3000;

export interface YahooArticleBody {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

export function buildArticleUrl(link: string, base = ARTICLE_ENDPOINT, max = ARTICLE_MAX_CHARS): string {
  return `${base}?url=${encodeURIComponent(link)}&max=${max}`;
}

/** 본문 1건 — 실패·빈 본문이면 null(호출 측은 헤드라인만으로 진행). */
export async function fetchYahooArticle(
  link: string,
  deps: { fetchImpl?: typeof fetch; base?: string } = {},
): Promise<YahooArticleBody | null> {
  if (!link) return null;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ARTICLE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(buildArticleUrl(link, deps.base), { signal: controller.signal });
    if (!res.ok) return null;
    const json = (await res.json()) as Partial<YahooArticleBody>;
    const text = typeof json.text === 'string' ? json.text.trim() : '';
    if (!text) return null;
    return { url: s(json.url) || link, title: s(json.title), text, truncated: json.truncated === true };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 상위 n건 본문을 병렬로 — 결과 배열은 news와 같은 인덱스(없으면 null). */
export async function fetchYahooArticles(
  news: YahooNewsItem[],
  n: number,
  deps: { fetchImpl?: typeof fetch; base?: string } = {},
): Promise<Array<YahooArticleBody | null>> {
  return Promise.all(news.slice(0, n).map((item) => fetchYahooArticle(item.link, deps)));
}
