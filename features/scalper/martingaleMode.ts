// 5선 물타기 단타 모드(2026-08-27 ADR 0006 → 2026-09-01 ADR 0007 → 2026-09-02 ADR 0010) 단일 스위치.
//
// 세 층이 **같은 상수 하나**를 읽는다 —
//   · autopilotManager: 슬롯을 이 모드(1분봉)로 만들고 추세 워밍업(분봉 시드)을 1분봉으로 돌린다. 모델 스캐너는 돌지 않는다.
//   · feedSlot: 1분봉 합성 + 5선으로 "5선 상승 ∧ 종가 5선 상향 돌파" 봉마다 BUY(kind='entry')를 낸다(봉 마감 + 진행 중 봉 실시간).
//   · autopilot/positionManager: 미보유면 진입, 보유 중이면 MartingaleRule.decide가 평단 −k%(k≥3)일 때 보유량 ×(k−1) 물타기.
//     청산은 익절 +3% · 19:55 ET 마감 청산뿐(손절 없음). 진입·물타기는 프리·정규·애프터만(isMartingaleEntryBar).
// 실제 활성화는 이 상수 AND 매니저의 `martingale` 주입. 모델·추세보다 **우선**한다(시험 모드라 켜면 이것만 돈다).
// false로 두면 모델(MODEL_MODE)로 **한 줄 롤백**된다.
//
// 근거: docs/adr/0010 — 2026-09-01의 ±3% 손절(ADR 0007)에서 사용자가 물타기를 되살리고 진입 조건을 5선 하나로 줄였다(2026-09-02).
export const MARTINGALE_MODE = true;

/** 물타기 모드 봉 주기(분) — 백테스트 규약(1분봉). */
export const MARTINGALE_BAR_MINUTES = 1;
