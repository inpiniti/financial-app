import { describe, expect, it, vi } from 'vitest';
import { fetchTossComments, resolveTossProductCode, type TossKeyValueStore } from './tossCommunity';

function createMapStorage(): TossKeyValueStore {
  const map = new Map<string, string>();
  return {
    getItem: async (key) => map.get(key) ?? null,
    setItem: async (key, value) => {
      map.set(key, value);
    },
  };
}

function mockSearchFetch(items: unknown[]) {
  return vi.fn().mockResolvedValue({
    json: async () => ({ result: [{ data: { items } }] }),
  });
}

describe('resolveTossProductCode', () => {
  it('symbol이 티커와 정확히 일치하는 항목만 채택한다(APLY 같은 유사 항목 무시)', async () => {
    const fetchImpl = mockSearchFetch([
      { symbol: 'APLY', productCode: 'US-WRONG', productName: '유사종목' },
      { symbol: 'AAPL', productCode: 'US19801212001', productName: '애플' },
    ]);
    const storage = createMapStorage();

    const code = await resolveTossProductCode('AAPL', { fetchImpl, storage });

    expect(code).toBe('US19801212001');
  });

  it('캐시 히트 시 fetch를 호출하지 않는다', async () => {
    const storage = createMapStorage();
    await storage.setItem('toss.productCode.AAPL', 'US19801212001');
    const fetchImpl = vi.fn();

    const code = await resolveTossProductCode('AAPL', { fetchImpl, storage });

    expect(code).toBe('US19801212001');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('정확히 일치하는 항목이 없으면 null을 반환하고 캐시하지 않는다', async () => {
    const fetchImpl = mockSearchFetch([{ symbol: 'APLY', productCode: 'US-WRONG', productName: '유사종목' }]);
    const storage = createMapStorage();

    const code = await resolveTossProductCode('AAPL', { fetchImpl, storage });

    expect(code).toBeNull();
    expect(await storage.getItem('toss.productCode.AAPL')).toBeNull();
  });

  it('성공하면 결과를 영구 캐시한다(다음 호출은 fetch 없이 반환)', async () => {
    const fetchImpl = mockSearchFetch([{ symbol: 'AAPL', productCode: 'US19801212001', productName: '애플' }]);
    const storage = createMapStorage();

    await resolveTossProductCode('AAPL', { fetchImpl, storage });
    const second = await resolveTossProductCode('AAPL', { fetchImpl, storage });

    expect(second).toBe('US19801212001');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('fetchTossComments', () => {
  it('댓글 페이지를 파싱하고 hasNext/key를 그대로 넘긴다', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      json: async () => ({
        result: {
          results: [
            {
              commentId: 'c1',
              author: { nickname: '토스러버', badge: null },
              message: { message: '오늘 오르네요' },
              statistic: { likeCount: 3, replyCount: 1 },
              createdAt: '2026-07-25T00:00:00.000Z',
            },
          ],
          hasNext: true,
          key: 'cursor-2',
        },
      }),
    });

    const page = await fetchTossComments('US19801212001', 'RECENT', undefined, { fetchImpl });

    expect(page.results).toHaveLength(1);
    expect(page.results[0].commentId).toBe('c1');
    expect(page.hasNext).toBe(true);
    expect(page.key).toBe('cursor-2');

    const [url] = fetchImpl.mock.calls[0];
    expect(url).toContain('subjectId=US19801212001');
    expect(url).toContain('subjectType=STOCK');
    expect(url).toContain('commentSortType=RECENT');
    expect(url).not.toContain('lastCommentId=');
  });

  it('key를 넘기면 lastCommentId 커서로 다음 페이지를 요청한다(key= 로 보내면 서버가 무시하고 1페이지를 반복한다)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      json: async () => ({ result: { results: [], hasNext: false, key: null } }),
    });

    await fetchTossComments('US19801212001', 'POPULAR', 308548934, { fetchImpl });

    const [url] = fetchImpl.mock.calls[0];
    expect(url).toContain('lastCommentId=308548934');
    expect(url).not.toContain('key=');
    expect(url).toContain('commentSortType=POPULAR');
  });
});
