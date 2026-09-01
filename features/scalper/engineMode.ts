// 엔진 모드(2026-09-01) — "±3% 단타 규칙"과 "모델" 중 무엇으로 매매하는지의 **런타임 단일 출처**.
//
// 왜 생겼나: 지금까지 모드는 컴파일 상수(MARTINGALE_MODE/MODEL_MODE)로만 갈렸다 — 바꾸려면 재빌드.
// 사용자가 설정으로 왔다갔다 하길 원해(2026-09-01) appSettings.engineMode로 강등했다. 다만 슬롯 봉 주기·
// ModelScanner·워밍업이 전부 매니저 **생성 시점**에 굳으므로, 반영은 **앱을 완전히 껐다 켠 뒤**다(재빌드보다
// 한 단계 약한 제약 — 보유·미체결 상태에서 관리자·청산 규칙이 갈리는 실계좌 사고를 원천 차단한다).
//
// 값은 managerProvider.buildManager가 설정을 읽어 앱 수명당 1회 확정하고(setActiveEngineMode),
// 화면·도움말·차트 기본 분봉은 전부 getActiveEngineMode()를 읽는다 — 컴파일 상수 분기는 이 파일로 대체됐다.
// 컴파일 상수(MARTINGALE_MODE·MODEL_MODE)는 "기능 존재" 킬스위치로 남는다 — 상수가 false면 설정과 무관하게
// 그 모드는 주입되지 않는다(autopilotManager의 "상수 AND 주입" 이중 게이트 그대로).

export type EngineMode = 'martingale' | 'model';

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
