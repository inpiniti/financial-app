import { describe, expect, it } from 'vitest';
import {
  buildCompanyBriefPrompt,
  buildCompanyBriefRequestBody,
  companyBriefCacheKey,
  describePriceDetail,
  fetchCompanyBrief,
  parseCompanyBrief,
} from './companyBrief';
import { buildYahooSearchUrl, parseYahooSearch, type YahooSearchResult } from './yahooSearch';
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
  it('URL — 프록시 베이스 + 대문자 심볼', () => {
    expect(buildYahooSearchUrl('aapl')).toBe(
      'https://simulation-inpiniti.vercel.app/api/yahoo/v1/finance/search?q=AAPL&newsCount=8&quotesCount=5&enableFuzzyQuery=false',
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

  it('describePriceDetail — 값 있는 줄만, PBR 0은 생략', () => {
    const s = describePriceDetail(detail);
    expect(s).toContain('현재가 150.5 USD (전일 종가 148 대비 +1.69%)');
    expect(s).toContain('PER 25.1, EPS 6');
    expect(s).not.toContain('PBR');
    expect(describePriceDetail(null)).toBe('(시세 데이터 없음)');
  });

  it('프롬프트 — 시세·프로필·번호 매긴 헤드라인 포함, 요청 바디에 tools 없음', () => {
    const input = { ticker: 'AAPL', market: 'NAS', name: 'Apple', detail, yahoo };
    const prompt = buildCompanyBriefPrompt(input, 0);
    expect(prompt).toContain('Apple (AAPL, NAS)');
    expect(prompt).toContain('정식 명칭 Apple Inc.');
    expect(prompt).toContain('1. [2026-08-18] New news — B');
    const body = buildCompanyBriefRequestBody(input, 0) as Record<string, unknown>;
    expect(body.tools).toBeUndefined();
    expect(body.systemInstruction).toBeTruthy();
  });

  it('parse — index로 원본 매체·날짜·링크 채움, 코드펜스 허용, 5건 제한', () => {
    const news = [
      { index: 2, title: '옛 뉴스', summary: 'x' },
      { index: 1, title: '새 뉴스', summary: '' },
      { index: 99, title: '없는 번호', summary: '' },
      ...Array.from({ length: 5 }, (_, i) => ({ index: 1, title: `n${i}`, summary: '' })),
    ];
    const text = '```json\n' + JSON.stringify({ about: 'a', business: 'b', situation: 'c', news }) + '\n```';
    const brief = parseCompanyBrief(text, 123, yahoo);
    expect(brief.about).toBe('a');
    expect(brief.news).toHaveLength(5);
    expect(brief.news[0]).toEqual({ title: '옛 뉴스', source: 'A', date: '2026-08-17', summary: 'x', link: 'https://x/old' });
    expect(brief.news[1].link).toBe('https://x/new');
    expect(brief.news[2]).toMatchObject({ title: '없는 번호', source: '', link: '' });
    expect(brief.rawText).toBeUndefined();
  });

  it('parse — JSON 아니면 rawText로 폴백', () => {
    const brief = parseCompanyBrief('그냥 텍스트 답변', 1);
    expect(brief.rawText).toBe('그냥 텍스트 답변');
    expect(brief.news).toEqual([]);
  });

  it('fetch — Yahoo 실패해도 프록시는 호출하고 결과를 돌려준다', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('/api/yahoo/')) return new Response('nope', { status: 500 });
      return new Response('{"about":"A","business":"B","situation":"C","news":[]}', { status: 200 });
    }) as typeof fetch;
    const brief = await fetchCompanyBrief({ ticker: 'ZZZZ', market: 'NAS', detail: null }, { fetchImpl, now: () => 5 });
    expect(calls).toHaveLength(2);
    expect(brief).toMatchObject({ about: 'A', news: [], generatedAt: 5 });
  });

  it('cacheKey — 종목+ET 거래일', () => {
    // 2026-08-19 03:00 UTC = 08-18 23:00 ET
    const key = companyBriefCacheKey('aapl', 'NAS', Date.UTC(2026, 7, 19, 3));
    expect(key).toBe('stock:companyBrief:v1:NAS:AAPL:2026-08-18');
  });
});
