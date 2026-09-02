// 기울기 단타 모드(2026-09-02 ADR 0011, 사용자 확정) 단일 스위치.
//
// 세 층이 **같은 상수 하나**를 읽는다 —
//   · autopilotManager: 슬롯을 이 모드로 만든다(봉·워밍업·모델 스캐너 전부 안 돈다 — 지표는 SlopeMeter 하나).
//   · feedSlot: 틱마다 기울기/10초를 재서 문턱(+1%) 전환에서만 BUY/SELL을 낸다(스로틀 없음).
//   · autopilot/positionManager: 미보유 BUY → 진입(후보·속도·현금 게이트만), 보유 SELL·틱 판정(기울기 < 1%) → 전량 매도.
//     익절·손절·물타기·세션·마감 청산 없음. 보유 중엔 리프라이스 타이머가 SLOPE_EXIT_TICK_MS(100ms)로 돈다.
// 실제 활성화는 이 상수 AND 매니저의 `slope` 주입(설정 engineMode='slope'). 물타기·모델·추세보다 **우선**한다.
// false로 두면 설정과 무관하게 이 모드는 주입되지 않는다(엔진 모드 킬스위치 규약 — engineMode.ts).
export const SLOPE_MODE = true;
