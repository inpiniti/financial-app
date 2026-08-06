// 주간거래(미국 Blue Ocean/Bruce/Moon ATS 경유) 세션 판정.
// docs/development/2026-08-06_주간거래-plan.md §2-1: 운영 창은 시세(WS) 문서 기준 10:00~16:00 KST로 확정
// (주문 문서의 18:00은 이번 범위에서 미사용). docs/koreainvestment/주간주문.txt: "Summer Time 동일" —
// KST는 서머타임이 없는 고정 오프셋(UTC+9)이라 별도 보정 없이 Intl로 KST 시각만 뽑으면 된다.
//
// 이 함수는 순수 시각 판정만 한다 — 주말 여부는 보지 않는다(호출부가 정규장 세션(sessionOf)과 마찬가지로
// 평일 여부를 별도로 다루거나, 주말엔 애초에 워치리스트/시세가 비어 자연스럽게 감시가 없는 것으로 처리한다).

const DAYTIME_START_MINUTES = 10 * 60; // 10:00 KST
const DAYTIME_END_MINUTES = 16 * 60; // 16:00 KST (미포함)

/** epochMs가 미국 주간거래 창(KST 10:00~16:00, 경계는 [시작 포함, 끝 미포함)) 안인지 판정한다. */
export function isDaytimeSessionOpen(epochMs: number): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(epochMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  // Intl이 자정을 '24'로 주는 로케일 잔재 방어(en-US에서 hour12:false여도 발생할 수 있음).
  const minutes = (get('hour') % 24) * 60 + get('minute');
  return minutes >= DAYTIME_START_MINUTES && minutes < DAYTIME_END_MINUTES;
}

/**
 * 주간거래는 실거래를 절대 하지 않는다(plan v4 §1, §3-3 — 미체결내역·잔고 조회가 daytime 체결을 반영하는지
 * 확인할 수 없어 실거래 경로 자체를 만들지 않기로 함). 브로커 선택 지점이 이 함수 하나만 거치면,
 * 전역 "시뮬레이션 모드" 설정이 꺼져 있어도 주간거래 창에서는 항상 가상 체결소가 강제된다 —
 * 런타임 토글이 아니라 진입 경로 자체가 없는 구조라 실수로 열릴 수 없다(단위 테스트가 이 불변식의 유일한
 * 보증선이므로 반드시 green으로 유지한다).
 */
export function shouldForceSimBroker(epochMs: number, globalSimModeOn: boolean): boolean {
  return isDaytimeSessionOpen(epochMs) || globalSimModeOn;
}
