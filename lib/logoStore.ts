// 로고 스토어 — 티커 → 트레이딩뷰 로고 URL (로고 도메인 plan §2-3).
//
// 앱 시작 시: ① 저장된 페어를 즉시 메모리에 올리고(오프라인에서도 마지막 로고 사용)
// ② fetchedAt이 24시간보다 오래됐으면 백그라운드로 재조회해 **통째로 교체**한다(머지 아님 —
// 상장폐지 티커 자연 정리, plan §4-7). 조회 실패는 조용히 무시(기존 캐시 유지).
//
// TickerAvatar가 동기 조회(logoUriFor) + 구독(subscribeLogos)으로 쓴다.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { fetchLogoPairs, logoUrlOf, type LogoPair } from './tradingviewLogos';

export const LOGO_STORAGE_KEY = 'logos:v1';
export const LOGO_TTL_MS = 24 * 3600 * 1000;

/** AsyncStorage 최소 계약 — 테스트는 Map 기반 심을 주입한다. */
interface StorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface LogoStoreDeps {
  storage?: StorageLike;
  fetchPairs?: () => Promise<LogoPair[]>;
  now?: () => number;
}

interface PersistedLogos {
  fetchedAt: number;
  pairs: LogoPair[];
}

let map = new Map<string, string>();
const listeners = new Set<() => void>();
let refreshing = false;

function notify(): void {
  for (const l of listeners) l();
}

/** 티커의 로고 SVG URL — 없으면 null(호출부가 이니셜 폴백). 동기(인메모리). */
export function logoUriFor(ticker: string): string | null {
  const logoid = map.get(ticker.toUpperCase());
  return logoid ? logoUrlOf(logoid) : null;
}

/** 로고 맵 교체 통지 구독 — TickerAvatar가 로드 완료 후 리렌더하는 데 쓴다. 반환값은 해제 함수. */
export function subscribeLogos(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 현재 메모리에 있는 로고 수(진단·테스트용). */
export function logoCount(): number {
  return map.size;
}

/** 테스트 전용 — 모듈 상태 초기화. */
export function resetLogoStoreForTest(): void {
  map = new Map();
  listeners.clear();
  refreshing = false;
}

/**
 * 부트스트랩 진입점 — 캐시 즉시 로드 후, 신선도(24h)에 따라 백그라운드 재조회.
 * 반환 Promise는 캐시 로드까지만 기다린다(재조회는 fire-and-forget — 테스트는 refreshLogos를 직접 await).
 */
export async function initLogoStore(deps: LogoStoreDeps = {}): Promise<void> {
  const storage = deps.storage ?? AsyncStorage;
  const now = deps.now ?? Date.now;

  let fetchedAt: number | null = null; // null = 캐시 없음(무조건 재조회).
  try {
    const raw = await storage.getItem(LOGO_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedLogos>;
      if (Array.isArray(parsed.pairs)) {
        map = new Map(parsed.pairs.map(([t, l]) => [t.toUpperCase(), l]));
        fetchedAt = typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : 0;
        notify();
      }
    }
  } catch {
    // 손상된 캐시 — 무시(다음 재조회가 덮어쓴다).
  }

  if (fetchedAt === null || now() - fetchedAt >= LOGO_TTL_MS) {
    void refreshLogos(deps);
  }
}

/** 스크리너 재조회 → 메모리·저장 통째 교체. 실패는 조용히 무시(기존 캐시 유지). 재진입 방지. */
export async function refreshLogos(deps: LogoStoreDeps = {}): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  const storage = deps.storage ?? AsyncStorage;
  const fetchPairs = deps.fetchPairs ?? fetchLogoPairs;
  const now = deps.now ?? Date.now;
  try {
    const pairs = await fetchPairs();
    if (pairs.length === 0) return; // 빈 응답으로 기존 캐시를 지우지 않는다.
    map = new Map(pairs.map(([t, l]) => [t.toUpperCase(), l]));
    const data: PersistedLogos = { fetchedAt: now(), pairs };
    await storage.setItem(LOGO_STORAGE_KEY, JSON.stringify(data));
    notify();
  } catch {
    // 네트워크 실패 등 — 기존 캐시 유지.
  } finally {
    refreshing = false;
  }
}
