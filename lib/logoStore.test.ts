import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initLogoStore,
  LOGO_STORAGE_KEY,
  LOGO_TTL_MS,
  logoCount,
  logoUriFor,
  refreshLogos,
  resetLogoStoreForTest,
  subscribeLogos,
} from './logoStore';
import type { LogoPair } from './tradingviewLogos';

function fakeStorage(initial: Record<string, string> = {}) {
  const mapData = new Map(Object.entries(initial));
  return {
    mapData,
    getItem: async (k: string) => mapData.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      mapData.set(k, v);
    },
  };
}

const PAIRS: LogoPair[] = [
  ['NVDA', 'nvidia'],
  ['AAPL', 'apple'],
];

beforeEach(() => resetLogoStoreForTest());

describe('logoStore — 캐시·신선도·교체', () => {
  it('신선한 캐시가 있으면 로드만 하고 재조회하지 않는다', async () => {
    const storage = fakeStorage({
      [LOGO_STORAGE_KEY]: JSON.stringify({ fetchedAt: 1000, pairs: PAIRS }),
    });
    const fetchPairs = vi.fn();
    await initLogoStore({ storage, fetchPairs, now: () => 1000 + LOGO_TTL_MS - 1 });

    expect(logoUriFor('NVDA')).toBe('https://s3-symbol-logo.tradingview.com/nvidia.svg');
    expect(logoUriFor('nvda')).toBe('https://s3-symbol-logo.tradingview.com/nvidia.svg'); // 대소문자 무관
    expect(logoUriFor('TSLA')).toBeNull();
    expect(fetchPairs).not.toHaveBeenCalled();
  });

  it('캐시가 24시간을 넘겼으면 백그라운드 재조회로 통째 교체·영속한다', async () => {
    const storage = fakeStorage({
      [LOGO_STORAGE_KEY]: JSON.stringify({ fetchedAt: 0, pairs: [['OLD', 'old-logo']] }),
    });
    const fetchPairs = vi.fn().mockResolvedValue(PAIRS);
    await initLogoStore({ storage, fetchPairs, now: () => LOGO_TTL_MS + 1 });
    await vi.waitFor(() => expect(logoUriFor('NVDA')).not.toBeNull());

    expect(logoUriFor('OLD')).toBeNull(); // 머지 아님 — 통째 교체(plan §4-7).
    const saved = JSON.parse(storage.mapData.get(LOGO_STORAGE_KEY)!);
    expect(saved.pairs).toEqual(PAIRS);
    expect(saved.fetchedAt).toBe(LOGO_TTL_MS + 1);
  });

  it('재조회 실패 시 기존 캐시를 유지한다', async () => {
    const storage = fakeStorage({
      [LOGO_STORAGE_KEY]: JSON.stringify({ fetchedAt: 0, pairs: PAIRS }),
    });
    const fetchPairs = vi.fn().mockRejectedValue(new Error('network'));
    await initLogoStore({ storage, fetchPairs, now: () => LOGO_TTL_MS + 1 });
    await vi.waitFor(() => expect(fetchPairs).toHaveBeenCalled());

    expect(logoUriFor('NVDA')).not.toBeNull(); // 기존 캐시 그대로.
  });

  it('빈 응답으로는 기존 캐시를 지우지 않는다', async () => {
    const storage = fakeStorage({
      [LOGO_STORAGE_KEY]: JSON.stringify({ fetchedAt: 0, pairs: PAIRS }),
    });
    await initLogoStore({ storage, fetchPairs: vi.fn().mockResolvedValue([]), now: () => 0 });
    await refreshLogos({ storage, fetchPairs: vi.fn().mockResolvedValue([]), now: () => 1 });
    expect(logoCount()).toBe(2);
  });

  it('맵 교체 시 구독자에게 통지한다(TickerAvatar 리렌더 계약)', async () => {
    const storage = fakeStorage();
    const listener = vi.fn();
    subscribeLogos(listener);
    await refreshLogos({ storage, fetchPairs: vi.fn().mockResolvedValue(PAIRS), now: () => 1 });
    expect(listener).toHaveBeenCalled();
    expect(logoCount()).toBe(2);
  });

  it('캐시가 없으면 즉시 재조회한다', async () => {
    const storage = fakeStorage();
    const fetchPairs = vi.fn().mockResolvedValue(PAIRS);
    await initLogoStore({ storage, fetchPairs, now: () => 5 });
    await vi.waitFor(() => expect(logoUriFor('AAPL')).not.toBeNull());
  });
});
