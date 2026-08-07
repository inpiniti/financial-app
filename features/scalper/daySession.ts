// 주간거래(미국 Blue Ocean/Bruce/Moon ATS 경유) 세션 판정 — **시세 조회 전용**.
// 거래(시뮬 브로커 강제) 용도는 2026-08-08 시뮬레이션 제거 plan으로 사라졌고, 지금은 종목 상세화면
// (useQuoteFeed)이 주간거래 창의 구독 tr_key(R+주간시장)를 고를 때만 쓴다.
// 운영 창은 시세(WS) 문서 기준 10:00~16:00 KST. "Summer Time 동일" — KST는 서머타임이 없는 고정
// 오프셋(UTC+9)이라 별도 보정 없이 Intl로 KST 시각만 뽑으면 된다.
//
// 이 함수는 순수 시각 판정만 한다 — 주말 여부는 보지 않는다(주말엔 시세가 비어 자연스럽게 무시된다).

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
