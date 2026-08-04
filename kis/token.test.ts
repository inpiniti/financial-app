import { describe, expect, it, vi } from 'vitest';
import { getAccessToken } from './token';
import type { StorageLike } from './types';

function makeStorage(initial?: string): StorageLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  if (initial) store.set('seed', initial);
  return {
    store,
    get(key) {
      return store.get(key) ?? null;
    },
    set(key, value) {
      store.set(key, value);
    },
  };
}

describe('getAccessToken', () => {
  it('발급 응답을 access_token/token_type/expires_in 그대로 반영한다 (tokenP.md)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      json: async () => ({
        access_token: 'tok-123',
        token_type: 'Bearer',
        expires_in: 86400,
      }),
    });
    const clock = { now: () => 1_000_000 };

    const token = await getAccessToken(
      'live',
      { appKey: 'k', appSecret: 's' },
      { fetchImpl, clock },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://openapi.koreainvestment.com:9443/oauth2/tokenP',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(token.accessToken).toBe('tok-123');
    expect(token.expiresAt).toBe(1_000_000 + 86400 * 1000);
  });

  it('① 캐시된 토큰이 만료 전이면 재호출 시 fetch를 0회 호출한다', async () => {
    const fetchImpl = vi.fn();
    const clock = { now: () => 1_000_000 };
    const storage = makeStorage();
    // 미리 유효한 토큰을 캐시에 심어둔다 (만료 여유 60초를 넘는 미래 시각).
    await storage.set(
      'kis:accessToken:live:k',
      JSON.stringify({ accessToken: 'cached-token', tokenType: 'Bearer', expiresAt: clock.now() + 3600_000 }),
    );

    const token = await getAccessToken('live', { appKey: 'k', appSecret: 's' }, { fetchImpl, clock, storage });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(token.accessToken).toBe('cached-token');
  });

  it('캐시된 토큰이 만료(여유 포함)됐으면 재발급하고 새 값을 캐시에 저장한다', async () => {
    const clock = { now: () => 2_000_000 };
    const storage = makeStorage();
    await storage.set(
      'kis:accessToken:live:k',
      JSON.stringify({ accessToken: 'old-token', tokenType: 'Bearer', expiresAt: clock.now() + 10_000 }), // 여유(60s) 이내
    );
    const fetchImpl = vi.fn().mockResolvedValue({
      json: async () => ({ access_token: 'new-token', token_type: 'Bearer', expires_in: 86400 }),
    });

    const token = await getAccessToken('live', { appKey: 'k', appSecret: 's' }, { fetchImpl, clock, storage });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(token.accessToken).toBe('new-token');
    expect(JSON.parse((await storage.get('kis:accessToken:live:k'))!).accessToken).toBe('new-token');
  });

  it('모의(paper) 환경은 openapivts 도메인을 사용한다', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      json: async () => ({ access_token: 't', token_type: 'Bearer', expires_in: 100 }),
    });
    await getAccessToken('paper', { appKey: 'k', appSecret: 's' }, { fetchImpl, clock: { now: () => 0 } });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://openapivts.koreainvestment.com:29443/oauth2/tokenP',
      expect.anything(),
    );
  });
});
