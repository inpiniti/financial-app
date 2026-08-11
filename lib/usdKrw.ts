// USD/KRW 환율 — 화면 여러 곳(조회 손익 "오늘예상", 트레이딩 "오늘 성과")이 달러 금액을 원화로
// 함께 보여주려고 쓰는 공용 값. 앱 자체 거래 기록(tradeStore)은 전부 USD라 표시 단계에서만 환산한다.
//
// 출처: 해외주식 체결기준현재잔고(kis/balance.ts)의 output2 — 통화별 잔고 행 중 USD의 최초고시환율.
// 잔고 응답 한 번에서 얻으므로 환율 전용 API를 따로 부르지 않는다. USD 행이 없으면(외화예수금 0 등)
// 보유 종목 행의 기준환율(bass_exrt)로 폴백하고, 그것도 없으면 null — 그때는 화면이 USD만 보여준다.
//
// 환율은 하루 단위로 고시되는 값이라 30분 캐시로 충분하다. 모듈 스코프 캐시라 화면을 오가도 유지된다.
import { inquireOverseasBalance } from '../kis/balance';
import { getAccessToken } from '../kis/token';
import { loadAppSettings } from './appSettings';

/** 캐시 수명 — 고시환율은 하루 단위라 짧게 잡을 이유가 없다. */
export const USD_KRW_TTL_MS = 30 * 60 * 1000;

/** 잔고 응답에서 USD/KRW 환율을 고른다 — 통화별 행(USD) 우선, 없으면 보유 종목 행의 기준환율. */
export function pickUsdKrwRate(
  output2: readonly Record<string, unknown>[] | undefined,
  output1?: readonly Record<string, unknown>[],
): number | null {
  for (const row of output2 ?? []) {
    if (String(row.crcy_cd ?? '').trim().toUpperCase() !== 'USD') continue;
    const rate = Number(row.frst_bltn_exrt);
    if (Number.isFinite(rate) && rate > 0) return rate;
  }
  for (const row of output1 ?? []) {
    if (String(row.buy_crcy_cd ?? '').trim().toUpperCase() !== 'USD') continue;
    const rate = Number(row.bass_exrt);
    if (Number.isFinite(rate) && rate > 0) return rate;
  }
  return null;
}

let cached: { rate: number; at: number } | null = null;
let inFlight: Promise<number | null> | null = null;

/** 테스트·설정 변경 후 캐시를 비운다. */
export function resetUsdKrwCache(): void {
  cached = null;
  inFlight = null;
}

/**
 * USD/KRW 환율(캐시). KIS 키가 없거나 조회에 실패하면 null — 호출부는 USD 표시로 자연 폴백한다.
 * 동시 호출은 하나의 요청으로 합친다(화면 두 곳이 같은 프레임에 물어봐도 잔고 조회는 1회).
 */
export async function getUsdKrwRate(nowMs: number = Date.now()): Promise<number | null> {
  if (cached && nowMs - cached.at < USD_KRW_TTL_MS) return cached.rate;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      // KIS 키 저장소는 expo-secure-store를 끌고 오는데 vitest가 그 패키지를 파싱하지 못한다 —
      // 여기서만 지연 import해 이 모듈(환율 계산 로직)이 테스트에서 그대로 로드되게 둔다.
      const [{ loadKisSettings }, { secureTokenStorage }] = await Promise.all([
        import('./kisSettings'),
        import('./secureTokenStorage'),
      ]);
      const [kisSettings, appSettings] = await Promise.all([loadKisSettings(), loadAppSettings()]);
      if (!kisSettings) return null;
      const credentials = { appKey: kisSettings.appKey, appSecret: kisSettings.appSecret };
      const token = await getAccessToken(appSettings.environment, credentials, { storage: secureTokenStorage });
      const res = await inquireOverseasBalance(appSettings.environment, credentials, token.accessToken, {
        account: { cano: kisSettings.cano, acntPrdtCd: kisSettings.acntPrdtCd },
      });
      const rate = pickUsdKrwRate(res.output2, res.output1);
      if (rate !== null) cached = { rate, at: nowMs };
      return rate;
    } catch {
      // 환율은 표시용 부가 정보다 — 실패해도 화면을 막지 않고 USD로 보여준다.
      return null;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}
