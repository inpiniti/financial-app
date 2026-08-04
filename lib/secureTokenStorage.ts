// kis/token.ts의 StorageLike를 expo-secure-store로 구현한 어댑터 — 토큰 캐시를 기기 보안 저장소에 둔다.
// SecureStore 키는 영숫자·'.'·'-'·'_'만 허용하므로, token.ts가 만드는 'kis:accessToken:live:appkey' 같은
// 콜론 포함 키를 그대로 넘기면 저장에 실패한다 — 여기서 안전한 문자로 치환해 보관한다.
import * as SecureStore from 'expo-secure-store';
import type { StorageLike } from '../kis/types';

function sanitizeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, '_');
}

export const secureTokenStorage: StorageLike = {
  async get(key: string) {
    return SecureStore.getItemAsync(sanitizeKey(key));
  },
  async set(key: string, value: string) {
    await SecureStore.setItemAsync(sanitizeKey(key), value);
  },
};
