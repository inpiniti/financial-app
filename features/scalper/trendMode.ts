// 추세 → 그리드 → 매매 (2026-08-18 도메인 문서) 단일 스위치.
// docs/domain/추세/2026-08-18_추세-그리드-매매-조합-plan.md
//
// feedSlot(신호 생성)과 autopilot(포지션 규칙)이 **같은 상수 하나**를 읽는다 — 두 층의 스위치가 갈라져
// "추세 신호 + 변곡점 조건부 그리드(물타기)" 같은 불일치 조합이 생기지 않게 한다.
// (feedSlot → autopilot import는 순환이라 별도 파일.)
// 실제 활성화는 이 상수 AND 매니저의 `trend` 주입(슬롯 옵션·pilot deps를 한 번에 켠다).
// false면 변곡점+그리드 조합(INFLECTION_ENTRY/INFLECTION_GRID)으로 **한 줄 롤백**된다.
export const TREND_MODE = true;
