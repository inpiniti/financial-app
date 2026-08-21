import { describe, expect, it, vi } from 'vitest';
import { buildNewsSearchUrl, decodeXmlEntities, parseNewsRss, searchNews, toIsoDate } from './webSearch';

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel>
<title>"NVDA" - Google News</title>
<item><title>Cathie Wood buys &amp; sells NVDA - thestreet.com</title>
<link>https://news.google.com/rss/articles/CBMiabc?oc=5</link>
<pubDate>Fri, 21 Aug 2026 06:29:40 GMT</pubDate>
<source url="https://www.thestreet.com">thestreet.com</source></item>
<item><title>엔비디아, 8조 계약 - AI타임스</title>
<link>https://news.google.com/rss/articles/CBMixyz?oc=5</link>
<pubDate>Thu, 20 Aug 2026 22:10:00 GMT</pubDate>
<source url="https://www.aitimes.com">AI타임스</source></item>
</channel></rss>`;

describe('buildNewsSearchUrl', () => {
  it('한국어가 기본이고 검색어를 인코딩한다', () => {
    const url = buildNewsSearchUrl('엔비디아 실적');
    expect(url).toContain('hl=ko&gl=KR&ceid=KR:ko');
    expect(url).toContain(encodeURIComponent('엔비디아 실적'));
  });

  it('en이면 미국 뉴스 로케일로 간다', () => {
    expect(buildNewsSearchUrl('NVDA', 'en')).toContain('hl=en-US&gl=US&ceid=US:en');
  });
});

describe('decodeXmlEntities', () => {
  it('&amp;를 마지막에 풀어 이중 디코딩을 막는다', () => {
    // &amp;lt; 는 "&lt;" 라는 글자여야 한다 — &amp;를 먼저 풀면 "<"가 되어 원문이 깨진다.
    expect(decodeXmlEntities('a &amp;lt; b')).toBe('a &lt; b');
    expect(decodeXmlEntities('A &amp; B &quot;C&quot; &#39;D&#39;')).toBe(`A & B "C" 'D'`);
  });
});

describe('toIsoDate', () => {
  it('RFC822를 YYYY-MM-DD로 줄인다', () => {
    expect(toIsoDate('Fri, 21 Aug 2026 06:29:40 GMT')).toBe('2026-08-21');
  });

  it('못 읽는 값은 빈 문자열 — 지어내지 않는다', () => {
    expect(toIsoDate('언젠가')).toBe('');
  });
});

describe('parseNewsRss', () => {
  it('제목 끝의 " - 언론사"를 떼고 언론사로 분리한다', () => {
    const hits = parseNewsRss(RSS);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({
      title: 'Cathie Wood buys & sells NVDA',
      source: 'thestreet.com',
      link: 'https://news.google.com/rss/articles/CBMiabc?oc=5',
      date: '2026-08-21',
    });
    expect(hits[1].title).toBe('엔비디아, 8조 계약');
    expect(hits[1].source).toBe('AI타임스');
  });

  it('채널 제목(<title> 최상단)은 결과로 세지 않는다 — <item>만 본다', () => {
    expect(parseNewsRss(RSS).every((h) => !h.title.includes('Google News'))).toBe(true);
  });

  it('limit까지만 돌려준다', () => {
    expect(parseNewsRss(RSS, 1)).toHaveLength(1);
  });

  it('빈 피드·깨진 XML은 빈 배열', () => {
    expect(parseNewsRss('')).toEqual([]);
    expect(parseNewsRss('<rss><channel></channel></rss>')).toEqual([]);
  });
});

describe('searchNews', () => {
  it('결과를 파싱해 돌려준다', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, text: async () => RSS }) as unknown as Response);
    const hits = await searchNews('NVDA', 'en', 8, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(hits).toHaveLength(2);
    expect(String((fetchImpl.mock.calls as unknown as unknown[][])[0][0])).toContain('news.google.com/rss/search');
  });

  it('실패·차단은 빈 배열 — 챗봇이 "못 찾았어요"로 이어가게', async () => {
    const bad = vi.fn(async () => ({ ok: false, text: async () => '' }) as unknown as Response);
    expect(await searchNews('x', 'ko', 8, { fetchImpl: bad as unknown as typeof fetch })).toEqual([]);
    const boom = vi.fn(async () => {
      throw new Error('network');
    });
    expect(await searchNews('x', 'ko', 8, { fetchImpl: boom as unknown as typeof fetch })).toEqual([]);
  });
});
