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
  /**
   * 거래 수수료율 — **% 단위 · 편도 기준**. 기본 0(=끔, 기존 동작).
   * 매수 체결대금과 매도 체결대금에 각각 이 비율을 곱해 손익에서 뺀다(왕복이면 실질 두 번).
   * core로 넘길 땐 commissionRateToRatio()로 /100 변환한다(0.25% → 0.0025). (2026-08-05 실비용 손익)
   */
  commissionRatePct: number;
  /**
   * 매수 미체결 자동 취소까지의 대기 — **초 단위**. 기본 0(=끔, 체결까지 무한 대기).
   * 켜면 이 시간 안에 안 붙은 매수를 취소하고 다시 변곡점을 기다린다. 일부라도 체결됐으면 취소하지 않는다.
   * ⚠ 과거 실계좌 사고로 삭제됐던 기능의 매수 한정 재도입이라 기본값은 끔이다. (2026-08-06)
   */
  buyCancelAfterSec: number;
  /**
   * 매도 관리 그리드 폭 — **% 단위**. 기본 10(=10%). 진입 체결 후 평단 ±이 %에 매수·매도 지정가를 건다
   * (buyPrice=평단×(1−w), sellPrice=평단×(1+w)). managerProvider가 /100 해서 core/grid의 width(소수)로 넘긴다.
   * (매도 관리 그리드 Phase B — 2026-08-05)
   */
  gridWidthPct: number;
  /**
   * 매도 관리 그리드 매수 배율 — 기본 1(=보유수량과 같은 수량). 리브래킷 매수 수량은
   * floor(보유수량 × 이 배율)로 계산된다(core/grid 몫, 여기서는 값만 전달). (Phase B)
   */
  gridBuyMultiplier: number;
  /**
   * 사다리 진입 감지 간격 — **% 단위**. 기본 1(=1%). 감시 시작가(트레일링 고점)에서 이 %씩 떨어질
   * 때마다 홀(가상 매수) 1회를 세고, entryLadderCount번째 홀에서 매수한다(2026-08-07 변곡점 그리드감지 plan).
   * ⚠ 매도그리드 폭(gridWidthPct)과 **별개** — 감지는 분 단위 잔파동, 그리드는 포지션 관리용이다.
   * managerProvider가 /100 해서 소수로 넘긴다.
   */
  entryLadderIntervalPct: number;
  /**
   * 사다리 진입 홀 횟수 — 기본 3. 이 횟수째 가상 매수(누적 낙폭 ≈ 간격×횟수 %)가 찍히면 실매수를 발화한다.
   * 클수록 보수적(깊은 하락에서만 진입).
   */
  entryLadderCount: number;
  /**
   * 시뮬레이션 모드 — 기본 false(실거래). 켜면 **오토파일럿만** 주문을 KIS에 내지 않고
   * SimExchange(가상 체결)로 돌린다. 시세·감시·그리드 로직은 실거래와 완전히 동일하다.
   * 수동 단타 카드는 이 플래그와 무관하게 항상 실거래다(사용자 확정 2026-08-06).
   * ⚠ 실행 중 전환은 반영되지 않는다 — 오토파일럿 IDLE + 단타 탭 재진입 시 적용(managerProvider 가드).
   */
  simulationMode: boolean;
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
  commissionRatePct: 0,
  buyCancelAfterSec: 0,
  gridWidthPct: 10,
  gridBuyMultiplier: 1,
  entryLadderIntervalPct: 1,
  entryLadderCount: 3,
  simulationMode: false,
};

/** 사다리 간격 %를 소수로(1% → 0.01). 비정상·0 이하는 기본 1%로 방어(감지가 꺼지는 개념이 아니다). */
export function ladderIntervalToRatio(pct: number): number {
  if (!Number.isFinite(pct) || pct <= 0) return DEFAULT_APP_SETTINGS.entryLadderIntervalPct / 100;
  return pct / 100;
}

/** 사다리 홀 횟수 정리 — 1 미만·비정상은 기본 3으로 방어, 정수 절사. */
export function ladderCountOf(count: number): number {
  if (!Number.isFinite(count) || count < 1) return DEFAULT_APP_SETTINGS.entryLadderCount;
  return Math.floor(count);
}

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
 * 수수료율 %를 core가 쓰는 소수로 변환한다(0.25% → 0.0025). 음수·비정상은 0(끔).
 * momentumThresholdToRatio와 식은 같지만 의미가 달라 별도 함수로 둔다(문턱 vs 비용).
 */
export function commissionRateToRatio(pct: number): number {
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  return pct / 100;
}

/** 매수 미체결 취소 대기(초)를 ms로 변환한다. 음수·비정상은 0(끔). */
export function buyCancelAfterToMs(sec: number): number {
  if (!Number.isFinite(sec) || sec <= 0) return 0;
  return sec * 1000;
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
