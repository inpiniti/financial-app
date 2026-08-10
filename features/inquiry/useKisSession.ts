// 홈 섹션 공통 — KIS 키/계좌 로드 → 토큰 발급까지 한 번에 처리하는 훅.
// 설정 화면(app/settings.tsx)이 저장한 lib/kisSettings·lib/appSettings를 읽고,
// kis/token.ts + lib/secureTokenStorage(토큰 캐시)로 accessToken을 받아온다.
import { useEffect, useState } from 'react';
import { getAccessToken } from '../../kis/token';
import type { KisAccount, KisCredentials, KisEnvironment } from '../../kis/types';
import { loadAppSettings } from '../../lib/appSettings';
import { loadKisSettings } from '../../lib/kisSettings';
import { secureTokenStorage } from '../../lib/secureTokenStorage';

export interface KisSession {
  credentials: KisCredentials;
  account: KisAccount;
  environment: KisEnvironment;
  accessToken: string;
}

export type KisSessionState =
  | { kind: 'loading' }
  /** KIS 키가 설정 탭에 아직 저장돼 있지 않음 — "설정 탭에서 키를 먼저 등록해 주세요" 안내 대상. */
  | { kind: 'needsSetup' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; session: KisSession };

/**
 * reloadKey가 바뀔 때마다 세션(키·계좌·토큰)을 다시 로드한다 — 당겨서 새로고침 시 토큰 만료도 함께 재확인하려는 의도.
 */
export function useKisSession(reloadKey: number): KisSessionState {
  const [state, setState] = useState<KisSessionState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setState({ kind: 'loading' });
      const [kisSettings, appSettings] = await Promise.all([loadKisSettings(), loadAppSettings()]);
      if (!kisSettings) {
        if (!cancelled) setState({ kind: 'needsSetup' });
        return;
      }

      try {
        const credentials: KisCredentials = { appKey: kisSettings.appKey, appSecret: kisSettings.appSecret };
        const account: KisAccount = { cano: kisSettings.cano, acntPrdtCd: kisSettings.acntPrdtCd };
        const token = await getAccessToken(appSettings.environment, credentials, { storage: secureTokenStorage });
        if (cancelled) return;
        setState({
          kind: 'ready',
          session: { credentials, account, environment: appSettings.environment, accessToken: token.accessToken },
        });
      } catch (e) {
        if (!cancelled) setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  return state;
}
