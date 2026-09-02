// 엔진 모드(2026-09-01) — "5선 물타기 단타"(martingale)와 "모델" 중 무엇으로 매매하는지의 **런타임 단일 출처**.
//
// 왜 생겼나: 지금까지 모드는 컴파일 상수(MARTINGALE_MODE/MODEL_MODE)로만 갈렸다 — 바꾸려면 재빌드.
// 사용자가 설정으로 왔다갔다 하길 원해(2026-09-01) appSettings.engineMode로 강등했다. 다만 슬롯 봉 주기·
// ModelScanner·워밍업이 전부 매니저 **생성 시점**에 굳으므로, 반영은 **앱을 완전히 껐다 켠 뒤**다(재빌드보다
// 한 단계 약한 제약 — 보유·미체결 상태에서 관리자·청산 규칙이 갈리는 실계좌 사고를 원천 차단한다).
//
// 값은 managerProvider.buildManager가 설정을 읽어 앱 수명당 1회 확정하고(setActiveEngineMode),
// 화면·도움말·차트 기본 분봉은 전부 getActiveEngineMode()를 읽는다 — 컴파일 상수 분기는 이 파일로 대체됐다.
// 컴파일 상수(MARTINGALE_MODE·MODEL_MODE·SLOPE_MODE)는 "기능 존재" 킬스위치로 남는다 — 상수가 false면 설정과 무관하게
// 그 모드는 주입되지 않는다(autopilotManager의 "상수 AND 주입" 이중 게이트 그대로).

export type EngineMode = 'martingale' | 'model' | 'slope';

/** 부트 전 기본값 — 설정 기본값(DEFAULT_APP_SETTINGS.engineMode)과 같은 'martingale'. */
let active: EngineMode = 'martingale';

/** buildManager 전용 — 매니저 생성 직전에 설정값으로 1회 확정한다. 화면이 부를 일은 없다. */
export function setActiveEngineMode(mode: EngineMode): void {
  active = mode;
}

/** 지금 활성 엔진 모드 — 매니저가 아직 없으면(부트 전) 기본 'martingale'. */
export function getActiveEngineMode(): EngineMode {
  return active;
}

/**
 * 엔진 옵션(2026-09-03 ADR 0012) — 엔진(택1)과 별개로 **중복 선택**하는 조건. 세 엔진 공통.
 *  · ordered / ma5Up / allUp : 진입 필터(1분봉 4선 — 정배열 · 5선 상승 · 4선 모두 상승), 체크한 것끼리 AND
 *  · martingale             : (k−1)배 물타기(보유 중 그 엔진의 BUY 신호에서 평단 −k%면 보유량 ×(k−1))
 * 기본값(DEFAULT_ENGINE_OPTIONS)은 2026-09-02 5선 돌파 엔진의 동작 그대로(5선 상승 + 물타기).
 */
export interface EngineOptions {
  ordered: boolean;
  ma5Up: boolean;
  allUp: boolean;
  martingale: boolean;
}

export const DEFAULT_ENGINE_OPTIONS: EngineOptions = { ordered: false, ma5Up: true, allUp: false, martingale: true };

let activeOptions: EngineOptions = DEFAULT_ENGINE_OPTIONS;

/** buildManager 전용 — 매니저 생성 직전에 설정값으로 1회 확정한다. */
export function setActiveEngineOptions(options: EngineOptions): void {
  activeOptions = options;
}

/** 지금 활성 엔진 옵션 — 화면·도움말 문구용. */
export function getActiveEngineOptions(): EngineOptions {
  return activeOptions;
}

/** 옵션을 사람 말로 — "정배열 · 5선 상승 · 물타기" / "없음". */
export function describeEngineOptions(o: EngineOptions = activeOptions): string {
  const parts: string[] = [];
  if (o.ordered) parts.push('정배열');
  if (o.ma5Up) parts.push('5선 상승');
  if (o.allUp) parts.push('4선 모두 상승');
  if (o.martingale) parts.push('(k−1)배 물타기');
  return parts.length ? parts.join(' · ') : '없음';
}
