// 도움말 챗봇의 검색 — 둘로 나눠 둔다.
//   ① searchWebPages — 일반 웹 검색. 프록시의 Tavily 엔드포인트(/api/simple/search), 키는 서버에만.
//      무료 월 1,000회라 아껴 쓴다. 결과에 **본문 발췌**가 붙어 근거를 댈 수 있다.
//   ② searchNews — 뉴스 검색. Google 뉴스 RSS, 키 없이 무제한. 뉴스 질문을 여기로 받으면 크레딧을 안 쓴다.
//
// 왜 뉴스는 RSS인가(2026-08-21 실측):
//   · Gemini google_search 그라운딩 → 무료 할당량 밖(429). 2026-08-19에 이미 접었고 다시 확인해도 같다.
//   · DuckDuckGo(html/lite)·SearXNG 공개 인스턴스 → 봇 차단(캡차 페이지). 스크래핑은 못 믿는다.
//   · Google 뉴스 RSS → 키 없이 200, 한국어/영어 모두 최신 결과. 이게 유일하게 안정적인 무키 경로다.
//
// 한계(챗봇에게도 알려 준다): 결과는 **제목·언론사·날짜**까지다. RSS의 링크는 news.google.com 리다이렉트인데
// 서버 리다이렉트가 아니라 JS 페이지라 본문을 끌어올 수 없다(실측). 종목 기사 **본문**이 필요하면 Yahoo 경로
// (features/stock/yahooSearch.ts — 기업 탭이 쓰는 그것)를 쓴다.
const NEWS_RSS_BASE = 'https://news.google.com/rss/search';
const REQUEST_TIMEOUT_MS = 15_000;

export interface SearchNewsDeps {
  fetchImpl?: typeof fetch;
}

/**
 * 일반 웹 검색 — 프록시의 Tavily 엔드포인트(키는 서버에만). 뉴스 RSS와 나눠 둔 이유는 **한도**다.
 * Tavily 무료는 월 1,000회라 아껴야 하고, 뉴스 질문은 무제한인 RSS로 받으면 크레딧을 안 쓴다.
 */
export const WEB_SEARCH_ENDPOINT = 'https://simulation-inpiniti.vercel.app/api/simple/search';

export interface WebHit {
  title: string;
  url: string;
  /** Tavily가 뽑아 준 본문 발췌 — 검색 결과만으로도 근거를 댈 수 있다. */
  content: string;
  published: string;
}

export interface WebSearchResult {
  query: string;
  /** Tavily의 짧은 요약(없을 수 있다). */
  answer: string;
  results: WebHit[];
  /** 실패했을 때 사람이 읽는 사유 — 챗봇이 그대로 안내한다. */
  error?: string;
}

/**
 * 일반 웹 검색. 실패는 throw하지 않고 error 문구를 담아 돌려준다(대화가 끊기지 않게).
 * 키 미설정(503)·한도 초과(429)는 프록시가 message로 알려 주므로 그대로 싣는다.
 */
export async function searchWebPages(
  query: string,
  limit = 5,
  deps: SearchNewsDeps & { endpoint?: string } = {},
): Promise<WebSearchResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const empty = { query, answer: '', results: [] as WebHit[] };
  try {
    const url = `${deps.endpoint ?? WEB_SEARCH_ENDPOINT}?q=${encodeURIComponent(query)}&max=${limit}`;
    const res = await fetchImpl(url, { signal: controller.signal });
    const json = (await res.json().catch(() => null)) as Partial<WebSearchResult> & { message?: string };
    if (!res.ok) {
      return { ...empty, error: json?.message || `검색 서버 오류(${res.status})예요.` };
    }
    return {
      query,
      answer: typeof json?.answer === 'string' ? json.answer : '',
      results: Array.isArray(json?.results) ? (json.results as WebHit[]) : [],
    };
  } catch {
    return { ...empty, error: '검색을 못 했어요(네트워크).' };
  } finally {
    clearTimeout(timer);
  }
}

export const NEWS_RESULT_MAX = 8;

export interface NewsHit {
  title: string;
  /** 언론사. RSS <source>가 없으면 제목 끝의 " - 언론사"에서 뽑는다. */
  source: string;
  /** 원문 링크(news.google.com 리다이렉트) — 사용자가 눌러서 볼 수는 있다. */
  link: string;
  /** RFC822 원문 그대로가 아니라 YYYY-MM-DD로 정규화. 못 읽으면 빈 문자열. */
  date: string;
}

export type NewsLang = 'ko' | 'en';

export function buildNewsSearchUrl(query: string, lang: NewsLang = 'ko'): string {
  const locale =
    lang === 'en' ? 'hl=en-US&gl=US&ceid=US:en' : 'hl=ko&gl=KR&ceid=KR:ko';
  return `${NEWS_RSS_BASE}?q=${encodeURIComponent(query)}&${locale}`;
}

/** XML 엔티티 되돌리기 — RSS 제목에 &amp;·&#39; 등이 그대로 들어온다. */
export function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

function tagOf(item: string, tag: string): string {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(item);
  if (!m) return '';
  return decodeXmlEntities(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim();
}

/** RFC822(`Fri, 21 Aug 2026 06:29:40 GMT`) → `YYYY-MM-DD`. 못 읽으면 빈 문자열. */
export function toIsoDate(pubDate: string): string {
  const ms = Date.parse(pubDate);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * RSS XML → 결과 목록. RN에는 XML 파서가 없어 정규식으로 <item>만 훑는다(피드 구조가 단순해 충분하다).
 * 제목은 "제목 - 언론사" 형태라 <source>가 있으면 그 꼬리를 떼어 준다.
 */
export function parseNewsRss(xml: string, limit = NEWS_RESULT_MAX): NewsHit[] {
  const hits: NewsHit[] = [];
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  for (const item of items) {
    const rawTitle = tagOf(item, 'title');
    if (!rawTitle) continue;
    const source = tagOf(item, 'source');
    const title = source && rawTitle.endsWith(` - ${source}`)
      ? rawTitle.slice(0, -(source.length + 3)).trim()
      : rawTitle;
    hits.push({
      title,
      source: source || (/ - ([^-]+)$/.exec(rawTitle)?.[1]?.trim() ?? ''),
      link: tagOf(item, 'link'),
      date: toIsoDate(tagOf(item, 'pubDate')),
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

/** 검색 → 결과 목록. 실패(네트워크·차단)는 빈 배열 — 챗봇은 "못 찾았어요"로 답하면 된다. */
export async function searchNews(
  query: string,
  lang: NewsLang = 'ko',
  limit = NEWS_RESULT_MAX,
  deps: SearchNewsDeps = {},
): Promise<NewsHit[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(buildNewsSearchUrl(query, lang), { signal: controller.signal });
    if (!res.ok) return [];
    return parseNewsRss(await res.text(), limit);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
