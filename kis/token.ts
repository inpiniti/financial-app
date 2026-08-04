// 접근토큰발급(P) [인증-001] — docs/koreainvestment/tokenP.md 그대로.
// 유효 24h·갱신주기 6h(6h 이내 재호출 시 기존 토큰 반환은 서버측 정책) — 클라이언트는 만료시각 기준으로 캐시해
// 불필요한 재발급 호출 자체를 막는다 (문서: "잦은 발급 요청은 서버가 제어함").
import { REST_DOMAIN } from './domain';
import { defaultClock, type ClockLike, type FetchLike, type KisCredentials, type KisEnvironment, type StorageLike } from './types';

export interface AccessToken {
  accessToken: string;
  tokenType: string;
  expiresAt: number; // epoch ms — access_token_token_expired 대신 expires_in으로 계산해 저장
}

interface CachedTokenPayload {
  accessToken: string;
  tokenType: string;
  expiresAt: number;
}

export interface TokenClientDeps {
  fetchImpl?: FetchLike;
  storage?: StorageLike;
  clock?: ClockLike;
}

// 만료 임박 시 재발급하도록 두는 안전 여유(60초) — 문서에 규정된 값은 아니며 클라이언트 판단.
const EXPIRY_SAFETY_MARGIN_MS = 60_000;

function cacheKeyFor(environment: KisEnvironment, appKey: string): string {
  return `kis:accessToken:${environment}:${appKey}`;
}

/**
 * 접근토큰을 발급받는다. storage가 주입되어 있고 캐시된 토큰이 아직 유효하면 fetch를 호출하지 않는다.
 */
export async function getAccessToken(
  environment: KisEnvironment,
  credentials: KisCredentials,
  deps: TokenClientDeps = {},
): Promise<AccessToken> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const clock = deps.clock ?? defaultClock;
  const storage = deps.storage;
  const cacheKey = cacheKeyFor(environment, credentials.appKey);

  if (storage) {
    const cached = await readCache(storage, cacheKey);
    if (cached && cached.expiresAt - EXPIRY_SAFETY_MARGIN_MS > clock.now()) {
      return cached;
    }
  }

  const res = await fetchImpl(`${REST_DOMAIN[environment]}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: credentials.appKey,
      appsecret: credentials.appSecret,
    }),
  });
  const body = (await res.json()) as {
    access_token?: string;
    token_type?: string;
    expires_in?: number;
  };

  // tokenP.md 응답 바디에는 rt_cd가 없다 — access_token 부재를 발급 실패로 간주한다.
  if (!body.access_token || !body.token_type || body.expires_in === undefined) {
    throw new Error(`KIS 토큰 발급 실패: 예상한 필드(access_token/token_type/expires_in)가 없습니다. 응답=${JSON.stringify(body)}`);
  }

  const token: AccessToken = {
    accessToken: body.access_token,
    tokenType: body.token_type,
    expiresAt: clock.now() + body.expires_in * 1000,
  };

  if (storage) {
    await storage.set(cacheKey, JSON.stringify(token satisfies CachedTokenPayload));
  }

  return token;
}

async function readCache(storage: StorageLike, key: string): Promise<AccessToken | null> {
  const raw = await storage.get(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CachedTokenPayload;
    if (
      typeof parsed.accessToken === 'string' &&
      typeof parsed.tokenType === 'string' &&
      typeof parsed.expiresAt === 'number'
    ) {
      return parsed;
    }
    return null;
  } catch {
    // 캐시 파손 — 재발급으로 자연 복구시킨다.
    return null;
  }
}
