// kis/flow.ts의 토큰 만료 자동 복구에 "실제 재발급 방법"을 꽂아 주는 앱 계층 어댑터.
// kis/는 저장소를 몰라야 하므로(테스트가 node에서 돈다) expo-secure-store 의존은 여기까지만 온다.
//
// 중복 발급 방어가 이 파일의 핵심이다 — 화면 여러 개가 동시에 만료 응답을 받으면 재발급도 동시에 터지는데,
// KIS 발급 API는 1분 1회 제한이 있어 그중 하나만 성공하고 나머지는 발급 실패로 떨어진다.
//  ① 앱키별 in-flight 프로미스 공유로 동시 재발급을 1건으로 합치고,
//  ② 그사이 다른 요청이 이미 새 토큰을 받아 뒀으면(캐시 값 ≠ 거절당한 토큰) 발급 없이 그 값을 준다.
import { setKisTokenRefresher, type KisTokenRefresher } from '../kis/flow';
import { getAccessToken, invalidateAccessToken } from '../kis/token';
import { secureTokenStorage } from './secureTokenStorage';

const inFlight = new Map<string, Promise<string>>();

const refresher: KisTokenRefresher = async ({ environment, credentials, expiredToken }) => {
  const key = `${environment}:${credentials.appKey}`;
  let pending = inFlight.get(key);
  if (!pending) {
    pending = (async () => {
      const cached = await getAccessToken(environment, credentials, { storage: secureTokenStorage });
      if (cached.accessToken !== expiredToken) return cached.accessToken; // 이미 누가 갱신해 뒀다.
      await invalidateAccessToken(environment, credentials, secureTokenStorage);
      const fresh = await getAccessToken(environment, credentials, {
        storage: secureTokenStorage,
        forceRefresh: true,
      });
      return fresh.accessToken;
    })();
    pending.catch(() => undefined).then(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  try {
    return await pending;
  } catch {
    // 재발급 실패 — null이면 flow가 원래 만료 오류를 그대로 화면에 올린다.
    return null;
  }
};

/** 앱 시작 시 1회 호출(app/_layout.tsx). */
export function installKisTokenRefresher(): void {
  setKisTokenRefresher(refresher);
}
