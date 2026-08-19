import { describe, expect, it } from 'vitest';
import {
  buildCompanyBriefPrompt,
  buildCompanyBriefRequestBody,
  companyBriefCacheKey,
  describePriceDetail,
  fetchCompanyBrief,
  parseCompanyBrief,
  parsePartialCompanyBrief,
  type CompanyBriefProgress,
} from './companyBrief';
import {
  buildArticleUrl,
  buildYahooSearchUrl,
  parseYahooSearch,
  type YahooArticleBody,
  type YahooSearchResult,
} from './yahooSearch';
import type { OverseasPriceDetail } from '../../kis/priceDetail';

const detail = {
  last: '150.5',
  base: '148',
  open: '149',
  high: '151',
  low: '147.5',
  tvol: '1234567',
  mcap: '2500000000',
  perx: '25.1',
  pbrx: '0',
  epsx: '6.0',
  h52p: '200',
  h52d: '20260301',
  l52p: '100',
  l52d: '20251001',
  e_icod: '3571',
  etyp_nm: 'COMMON STOCK',
  curr: 'USD',
} as unknown as OverseasPriceDetail;

const yahooJson = {
  quotes: [
    { symbol: 'AAPLW', longname: 'Wrong' },
    { symbol: 'AAPL', longname: 'Apple Inc.', exchDisp: 'NASDAQ', sectorDisp: 'Technology', industryDisp: 'Consumer Electronics' },
  ],
  news: [
    { title: 'Old news', publisher: 'A', providerPublishTime: 1787000000, link: 'https://x/old' },
    { title: 'New news', publisher: 'B', providerPublishTime: 1787110380, link: 'https://x/new' },
    { title: '', publisher: 'C', providerPublishTime: 1787110390 },
  ],
};

describe('yahooSearch', () => {
  it('URL — 프록시 베이스 + 대문자 심볼 / 기사 URL 인코딩', () => {
    expect(buildYahooSearchUrl('aapl')).toBe(
      'https://simulation-inpiniti.vercel.app/api/yahoo/v1/finance/search?q=AAPL&newsCount=8&quotesCount=5&enableFuzzyQuery=false',
    );
    expect(buildArticleUrl('https://finance.yahoo.com/m/a?b=1')).toBe(
      'https://simulation-inpiniti.vercel.app/api/simple/article?url=https%3A%2F%2Ffinance.yahoo.com%2Fm%2Fa%3Fb%3D1&max=3000',
    );
  });

  it('parse — 심볼 정확 일치 프로필, 뉴스 최신순·빈 제목 제외', () => {
    const r = parseYahooSearch(yahooJson, 'aapl');
    expect(r.profile).toEqual({ longName: 'Apple Inc.', sector: 'Technology', industry: 'Consumer Electronics', exchange: 'NASDAQ' });
    expect(r.news.map((n) => n.title)).toEqual(['New news', 'Old news']);
    expect(r.news[0].publishedAt).toBe(1787110380000);
  });
});

describe('companyBrief', () => {
  const yahoo: YahooSearchResult = parseYahooSearch(yahooJson, 'AAPL');
  const articles: Array<YahooArticleBody | null> = [
    { url: 'https://x/new', title: 'New news', text: 'Body of the new article.', truncated: false },
    null,
  ];

  it('describePriceDetail — 값 있는 줄만, PBR 0은 생략', () => {
    const s = describePriceDetail(detail);
    expect(s).toContain('현재가 150.5 USD (전일 종가 148 대비 +1.69%)');
    expect(s).toContain('PER 25.1, EPS 6');
    expect(s).not.toContain('PBR');
    expect(describePriceDetail(null)).toBe('(시세 데이터 없음)');
  });

  it('프롬프트 — 시세·프로필·번호 매긴 기사(본문 있음/없음) 포함, 요청 바디에 tools 없음·JSON 모드', () => {
    const input = { ticker: 'AAPL', market: 'NAS', name: 'Apple', detail, yahoo, articles };
    const prompt = buildCompanyBriefPrompt(input, 0);
    expect(prompt).toContain('Apple (AAPL, NAS)');
    expect(prompt).toContain('정식 명칭 Apple Inc.');
    expect(prompt).toContain('1. [2026-08-18] New news — B\n본문:\nBody of the new article.');
    expect(prompt).toContain('2. [2026-08-17] Old news — A\n(본문 없음 — 헤드라인만)');
    const body = buildCompanyBriefRequestBody(input, 0) as { tools?: unknown; generationConfig: { responseMimeType: string } };
    expect(body.tools).toBeUndefined();
    expect(body.generationConfig.responseMimeType).toBe('application/json');
  });

  it('parse — 분석 필드·refs 범위 검증·근거 기사 목록(read 표시), 코드펜스 허용', () => {
    const payload = {
      about: 'a',
      business: 'b',
      situation: 'c',
      newsDigest: 'd',
      positives: [{ text: '좋아요', refs: [1, 1, 9] }, { text: '', refs: [] }],
      negatives: [{ text: '나빠요', refs: [2] }],
      watch: ['실적 발표', '', '가이던스', 'x', 'y'],
    };
    const brief = parseCompanyBrief('```json\n' + JSON.stringify(payload) + '\n```', 123, yahoo, articles);
    expect(brief.newsDigest).toBe('d');
    expect(brief.positives).toEqual([{ text: '좋아요', refs: [1] }]);
    expect(brief.negatives).toEqual([{ text: '나빠요', refs: [2] }]);
    expect(brief.watch).toEqual(['실적 발표', '가이던스', 'x']);
    expect(brief.news).toEqual([
      { title: 'New news', link: 'https://x/new', source: 'B', date: '2026-08-18', read: true },
      { title: 'Old news', link: 'https://x/old', source: 'A', date: '2026-08-17', read: false },
    ]);
    expect(brief.rawText).toBeUndefined();
    expect(brief.generatedAt).toBe(123);
  });

  it('parse — JSON 아니면 rawText로 폴백(근거 기사는 유지)', () => {
    const brief = parseCompanyBrief('그냥 텍스트 답변', 1, yahoo, []);
    expect(brief.rawText).toBe('그냥 텍스트 답변');
    expect(brief.news).toHaveLength(2);
    expect(brief.positives).toEqual([]);
  });

  it('fetch — Yahoo 검색 → 기사 본문 N건 → 프록시. Yahoo/기사 실패해도 프록시는 호출', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('/api/yahoo/')) return new Response(JSON.stringify(yahooJson), { status: 200 });
      if (u.includes('/api/simple/article')) {
        return u.includes('new')
          ? new Response(JSON.stringify({ text: 'body' }), { status: 200 })
          : new Response('nope', { status: 500 });
      }
      return new Response(JSON.stringify({ about: 'A', newsDigest: 'D', positives: [{ text: 'p', refs: [1] }] }), {
        status: 200,
      });
    }) as typeof fetch;
    const brief = await fetchCompanyBrief({ ticker: 'AAPL', market: 'NAS', detail: null }, { fetchImpl, now: () => 5 });
    expect(calls.filter((u) => u.includes('/api/simple/article'))).toHaveLength(2);
    expect(calls.at(-1)).toContain('/api/simple/gemini');
    expect(brief).toMatchObject({ about: 'A', newsDigest: 'D', generatedAt: 5 });
    expect(brief.news.map((n) => n.read)).toEqual([true, false]);
    // 프록시로 보낸 프롬프트에 읽은 본문이 들어갔는지
    expect(brief.positives[0].refs).toEqual([1]);
  });

  it('parsePartial — 스트리밍 조각에서 미완성 문자열 필드를 뽑고 지금 쓰는 필드를 가리킨다', () => {
    expect(parsePartialCompanyBrief('{"abo')).toEqual({ about: '', business: '', situation: '', newsDigest: '', writing: null });
    const p1 = parsePartialCompanyBrief('{"about":"애플은 \\"아이폰\\"을 만드는');
    expect(p1.about).toBe('애플은 "아이폰"을 만드는');
    expect(p1.writing).toBe('about');
    const p2 = parsePartialCompanyBrief('{"about":"A","business":"B\\nC","situation":"지금');
    expect(p2).toMatchObject({ about: 'A', business: 'B\nC', situation: '지금', writing: 'situation' });
    // 이스케이프 도중 잘린 조각(백슬래시 하나·\\u 미완)도 깨지지 않는다.
    expect(parsePartialCompanyBrief('{"about":"끝\\').about).toBe('끝');
    expect(parsePartialCompanyBrief('{"about":"끝\\u00').about).toBe('끝');
    // 전부 닫힌 완성본은 writing null.
    expect(parsePartialCompanyBrief('{"about":"A","newsDigest":"D"}').writing).toBeNull();
  });

  it('fetch — 진행 단계(search→articles→generate) 통지, 응답 body 스트림이면 조각마다 누적 텍스트로 알린다', async () => {
    const progress: CompanyBriefProgress[] = [];
    const chunks = ['{"about":"애', '플","newsDigest":', '"D"}'];
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/api/yahoo/')) return new Response(JSON.stringify(yahooJson), { status: 200 });
      if (u.includes('/api/simple/article')) return new Response(JSON.stringify({ text: 'body' }), { status: 200 });
      const enc = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          for (const ch of chunks) c.enqueue(enc.encode(ch));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }) as typeof fetch;
    const brief = await fetchCompanyBrief(
      { ticker: 'AAPL', market: 'NAS', detail: null },
      { fetchImpl, now: () => 5, onProgress: (p) => progress.push(p) },
    );
    expect(brief).toMatchObject({ about: '애플', newsDigest: 'D' });
    expect(progress.map((p) => p.stage)).toEqual(['search', 'articles', 'generate', 'generate', 'generate', 'generate']);
    expect(progress[1]).toEqual({ stage: 'articles', total: 2 });
    const texts = progress.filter((p): p is Extract<CompanyBriefProgress, { stage: 'generate' }> => p.stage === 'generate').map((p) => p.text);
    expect(texts).toEqual(['', '{"about":"애', '{"about":"애플","newsDigest":', '{"about":"애플","newsDigest":"D"}']);
  });

  it('cacheKey — 종목+ET 거래일, v2', () => {
    // 2026-08-19 03:00 UTC = 08-18 23:00 ET
    const key = companyBriefCacheKey('aapl', 'NAS', Date.UTC(2026, 7, 19, 3));
    expect(key).toBe('stock:companyBrief:v2:NAS:AAPL:2026-08-18');
  });
});
