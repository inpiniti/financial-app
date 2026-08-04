// 매매 파라미터(민감정보 아님) — AsyncStorage에 저장한다 (PRD §5 / §4-E). KIS 키는 lib/kisSettings.ts(secure-store) 담당.
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { KisEnvironment } from '../kis/types';

const STORAGE_KEY = 'app:settings';

export interface AppSettings {
  /** 기본 LIVE(실전) — PRD §9-6 확정. PAPER는 전환 옵션. */
  environment: KisEnvironment;
  /** 주문 수량 (고정 수량). */
  orderQty: number;
  /** 리샘플 청크 초 — 기본 3초 (PRD §4-B-2). */
  chunkSeconds: number;
  /** SG 원형 버퍼 크기 — 31~51 권장, 홀수 유지 필요 (PRD §4-B-3). */
  bufferSize: number;
  /**
   * 매수 모멘텀 문턱 — **% 단위**(사용자 입력·저장 모두 %). 기본 0.01(=0.01%/청크).
   * 변곡점(-→+ 전환) 후 상대 기울기가 이 % 이상일 때만 매수한다. **0이면 끔**(전환 즉시 매수).
   * detector로 넘길 땐 momentumThresholdToRatio()로 /100 변환한다(소수 0.0001). (PRD §4-C)
   */
  momentumThresholdPct: number;
  /**
   * 매도 모멘텀 문턱 — **% 단위**. 기본 0.005(=0.005%/청크). 변곡점(+→- 전환) 후 하락 기울기 크기가 이 % 이상이면 매도한다.
   * **0이면 끔**(전환 즉시 매도). 매수와 달리 대기 만료 시 반드시 매도한다(방어선 보존, PRD §4-C·§5, 2026-07-31 확정).
   * detector로 넘길 땐 momentumThresholdToRatio()로 /100 변환한다(소수 0.00005).
   */
  sellMomentumThresholdPct: number;
  /**
   * BUY 거래량 스파이크 게이트 — **배수 단위**(%가 아님). 기본 0(=끔).
   * 켜면 마지막 청크 거래량이 과거 평균의 이 배수 이상일 때만 매수한다(권장 1.5~2). SELL과 무관.
   * detector로 넘길 땐 gateThreshold()로 정리만 한다(/100 변환 없음). (2026-08-03 BUY 게이트)
   */
  buyVolumeSpikeRatio: number;
  /**
   * BUY 체결강도 게이트 — KIS STRN 값(100=매수·매도 균형). 기본 0(=끔).
   * 켜면 체결강도가 이 값 이상일 때만 매수한다. SELL과 무관.
   * detector로 넘길 땐 gateThreshold()로 정리만 한다(/100 변환 없음). (2026-08-03 BUY 게이트)
   */
  buyStrengthThreshold: number;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  environment: 'live',
  orderQty: 1,
  chunkSeconds: 3,
  bufferSize: 31,
  momentumThresholdPct: 0.01,
  sellMomentumThresholdPct: 0.005,
  buyVolumeSpikeRatio: 0,
  buyStrengthThreshold: 0,
};

/** 설정의 % 값을 detector가 쓰는 상대 기울기 소수로 변환한다(0.01% → 0.0001). 음수·비정상은 0(끔)으로 처리. */
export function momentumThresholdToRatio(pct: number): number {
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  return pct / 100;
}

/** BUY 게이트 문턱 정리 — 음수·비정상은 0(끔), 나머진 그대로(momentumThresholdToRatio와 달리 %가 아니라 /100 없음). */
export function gateThreshold(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value;
}

/**
 * 설정 슬라이더 값을 스텝 격자에 붙이고 범위 안으로 가둔다.
 *
 * ⚠ 격자는 **최솟값 기준**으로 잡는다. 0에서 세면(`Math.round(v/step)*step`) 최솟값이 격자 위에 없을 때
 * 엉뚱한 값이 나온다 — 버퍼(min 7 · step 2)에서 7이 8로, 51이 52로 튀어 "홀수만" 규칙이 깨졌다(실제 버그).
 * 부동소수 오차(0.015000000002 등)는 step 자릿수로 절사해 없앤다.
 */
export function snapToStep(value: number, min: number, max: number, step: number): number {
  if (!Number.isFinite(value)) return min;
  const decimals = (String(step).split('.')[1] ?? '').length;
  const snapped = min + Math.round((value - min) / step) * step;
  return Number(Math.min(max, Math.max(min, snapped)).toFixed(decimals));
}

export async function loadAppSettings(): Promise<AppSettings> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw) return DEFAULT_APP_SETTINGS;
  try {
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    // environment는 항상 'live'로 강제한다 (2026-07-30 사용자 확정 — 모의 전환 옵션 제거).
    // KIS 모의투자는 시세 WS·현재가·순위가 전부 미지원이라 이 앱에서 PAPER는 동작 불가이고,
    // 과거 스위치로 'paper'가 저장된 기기도 이 강제로 자연 복구된다.
    return { ...DEFAULT_APP_SETTINGS, ...parsed, environment: 'live' };
  } catch {
    // 저장값 파손 — 기본값으로 자연 복구.
    return DEFAULT_APP_SETTINGS;
  }
}

export async function saveAppSettings(settings: AppSettings): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

/**
 * 버퍼 크기가 SG 윈도 요건(홀수)을 만족하는지 확인한다.
 * 설정 화면은 홀수만 고르는 슬라이더(min 7·step 2)로 바뀌어 더 이상 쓰지 않지만,
 * 저장값·외부 입력을 검사할 때를 위해 남겨 둔다(Resampler도 자체적으로 홀수를 강제한다).
 */
export function isOddBufferSize(bufferSize: number): boolean {
  return Math.abs(bufferSize % 2) === 1;
}
