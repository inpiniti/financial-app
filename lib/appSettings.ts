// 매매 파라미터(민감정보 아님) — AsyncStorage에 저장한다 (PRD §5 / §4-E). KIS 키는 lib/kisSettings.ts(secure-store) 담당.
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { KisEnvironment } from '../kis/types';

const STORAGE_KEY = 'app:settings';

// 2026-08-08 설정 정리 — 청크·버퍼·모멘텀 문턱·BUY 게이트·수수료율은 설정에서 제거했다.
// 코드 기본값(Resampler 3초·31칸, TrendDetector 0.0001/0.00005, 게이트·수수료 0=끔)이
// 옛 설정 기본값과 동일해 자동단타 동작은 변하지 않는다. 저장돼 있던 옛 키는 무시된다.
export interface AppSettings {
  /** 기본 LIVE(실전) — PRD §9-6 확정. PAPER는 전환 옵션. */
  environment: KisEnvironment;
  /** 주문 수량 (고정 수량). */
  orderQty: number;
  /**
   * 매수 미체결 자동 취소까지의 대기 — **초 단위**. 기본 0(=끔, 체결까지 무한 대기).
   * 켜면 이 시간 안에 안 붙은 매수를 취소하고 다시 변곡점을 기다린다. 일부라도 체결됐으면 취소하지 않는다.
   * ⚠ 과거 실계좌 사고로 삭제됐던 기능의 매수 한정 재도입이라 기본값은 끔이다. (2026-08-06)
   */
  buyCancelAfterSec: number;
  /**
   * 매도 관리 그리드 폭 — **% 단위**. 기본 3(=3%). 진입 시점에 칸 간격 step=평단×이 %(달러)로 굳고,
   * 이후 사다리 다리는 중앙값(마지막 체결 레벨)±step에 걸린다. managerProvider가 /100 해서
   * core/grid의 width(소수)로 넘긴다. (사다리 그리드 재설계 — 2026-08-13.
   * 옛 gridBuyMultiplier(배수 물타기)는 이때 제거 — 저장소에 남은 옛 키는 무시된다.)
   */
  gridWidthPct: number;
  /**
   * 사다리 진입 감지 간격 — **% 단위**. 기본 3(=3%). 감시 시작가(트레일링 고점)에서 이 %씩 떨어질
   * 때마다 홀(가상 매수) 1회를 세고, entryLadderCount번째 홀에서 매수한다(2026-08-07 변곡점 그리드감지 plan).
   * ⚠ 매도그리드 폭(gridWidthPct)과 **별개** — 감지는 분 단위 잔파동, 그리드는 포지션 관리용이다.
   * managerProvider가 /100 해서 소수로 넘긴다.
   */
  entryLadderIntervalPct: number;
  /**
   * 사다리 진입 홀 횟수 — 기본 4. 이 횟수째 가상 매수(누적 낙폭 ≈ 간격×횟수 %)가 찍히면 실매수를 발화한다.
   * 클수록 보수적(깊은 하락에서만 진입).
   */
  entryLadderCount: number;
  /**
   * 종목당 진입금액(USD) — 기본 1. 0이면 **미설정**(자동 트레이딩 시작이 거부된다).
   * 2026-08-12까지는 트레이딩 화면 시트가 오토파일럿 저장소에 직접 넣던 값인데, 설정을 한 화면으로 모으면서
   * 여기로 옮겼다. managerProvider가 트레이딩 화면 포커스마다 pilot.setConfig로 흘려 넣는다(IDLE에서만 적용).
   * ⚠ 기본값은 사용자가 직접 정한 $1이다(2026-08-12). 오발주 피해가 사실상 없는 최소 금액이라 미설정(0) 대신
   * 이 값을 심는다 — 그보다 큰 금액을 코드가 임의로 정하지는 않는다.
   */
  startAmountUsd: number;
  /** 최소 속도(틱/초) — 이보다 조용한 종목은 감시하지 않는다. 기본 1(autopilot.DEFAULT_MIN_TICK_RATE와 같은 값). */
  minTickRate: number;
  /** 동시에 관리할 그리드(종목) 개수. 기본 1(autopilot.DEFAULT_MAX_GRIDS와 같은 값), 상한은 autopilot이 잘라낸다. */
  maxConcurrentGrids: number;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  environment: 'live',
  orderQty: 1,
  buyCancelAfterSec: 0,
  gridWidthPct: 3,
  entryLadderIntervalPct: 3,
  entryLadderCount: 4,
  startAmountUsd: 1,
  minTickRate: 1,
  maxConcurrentGrids: 1,
};

/** 사다리 간격 %를 소수로(3% → 0.03). 비정상·0 이하는 기본값(3%)으로 방어(감지가 꺼지는 개념이 아니다). */
export function ladderIntervalToRatio(pct: number): number {
  if (!Number.isFinite(pct) || pct <= 0) return DEFAULT_APP_SETTINGS.entryLadderIntervalPct / 100;
  return pct / 100;
}

/** 사다리 홀 횟수 정리 — 1 미만·비정상은 기본값(4)으로 방어, 정수 절사. */
export function ladderCountOf(count: number): number {
  if (!Number.isFinite(count) || count < 1) return DEFAULT_APP_SETTINGS.entryLadderCount;
  return Math.floor(count);
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
 * 엉뚱한 값이 나온다 — 옛 버퍼 슬라이더(min 7 · step 2)에서 7이 8로 튀어 "홀수만" 규칙이 깨졌다(실제 버그).
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
    // 키를 명시적으로 골라 담는다 — 저장소에 남은 제거된 옛 키(chunkSeconds 등)를 확실히 버린다.
    return {
      environment: 'live',
      orderQty: parsed.orderQty ?? DEFAULT_APP_SETTINGS.orderQty,
      buyCancelAfterSec: parsed.buyCancelAfterSec ?? DEFAULT_APP_SETTINGS.buyCancelAfterSec,
      gridWidthPct: parsed.gridWidthPct ?? DEFAULT_APP_SETTINGS.gridWidthPct,
      entryLadderIntervalPct: parsed.entryLadderIntervalPct ?? DEFAULT_APP_SETTINGS.entryLadderIntervalPct,
      entryLadderCount: parsed.entryLadderCount ?? DEFAULT_APP_SETTINGS.entryLadderCount,
      startAmountUsd: parsed.startAmountUsd ?? DEFAULT_APP_SETTINGS.startAmountUsd,
      minTickRate: parsed.minTickRate ?? DEFAULT_APP_SETTINGS.minTickRate,
      maxConcurrentGrids: parsed.maxConcurrentGrids ?? DEFAULT_APP_SETTINGS.maxConcurrentGrids,
    };
  } catch {
    // 저장값 파손 — 기본값으로 자연 복구.
    return DEFAULT_APP_SETTINGS;
  }
}

export async function saveAppSettings(settings: AppSettings): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}
