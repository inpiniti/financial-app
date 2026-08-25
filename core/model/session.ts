// ET(미 동부) 시각 판정 — 모델 경로 전용. 순수 산술이라 Intl·타임존 DB에 기대지 않는다.
//
// 왜 직접 계산하나: 모델의 표본 창(그날 04:00 ET부터)과 신호 창(정규장)이 **거래일 경계**에 걸려 있어,
// 런타임 Intl 구현 차이(Hermes/ICU 유무)로 한 시간 어긋나면 지표가 통째로 딴 날 봉과 섞인다.
// 미국 DST 규칙은 2007년 이후 고정이다 — 3월 둘째 일요일 02:00(현지 표준) 시작, 11월 첫째 일요일 02:00(현지 서머) 종료.

/** 하루 분. */
const DAY_MINUTES = 1440;
/** 표준시(EST) 오프셋(분). */
const EST_OFFSET = -300;
/** 서머타임(EDT) 오프셋(분). */
const EDT_OFFSET = -240;

/** 거래일 시작 — 04:00 ET(프리마켓 개시). 학습 데이터의 하루 경계와 같다. */
export const TRADING_DAY_START_MIN = 4 * 60;
/** 표본 창 끝 — 20:00 ET(애프터 종료, 미포함). 학습이 이 창 밖 봉을 아예 담지 않았다. */
export const TRADING_DAY_END_MIN = 20 * 60;
/**
 * 정규장 창 — 토스 sessionType 실측(2026-08-20)에 맞춘 경계. 토스는 09:30 봉을 'pre',
 * 09:31~16:00 봉을 'main', 16:01부터 'after'로 준다. 학습의 `session=='main'` 필터를 그대로 재현한다.
 */
export const MAIN_SESSION_START_MIN = 9 * 60 + 31;
export const MAIN_SESSION_END_MIN = 16 * 60;

/** year의 month(0-based) n번째 일요일 00:00 UTC의 epoch ms. */
function nthSundayUtc(year: number, month: number, n: number): number {
  const first = Date.UTC(year, month, 1);
  const dow = new Date(first).getUTCDay(); // 0=일
  const day = 1 + ((7 - dow) % 7) + (n - 1) * 7;
  return Date.UTC(year, month, day);
}

/** 그 시각의 뉴욕 UTC 오프셋(분) — EDT −240 또는 EST −300. */
export function etOffsetMinutes(epochMs: number): number {
  const year = new Date(epochMs).getUTCFullYear();
  // 3월 둘째 일요일 02:00 EST = 07:00 UTC / 11월 첫째 일요일 02:00 EDT = 06:00 UTC.
  const start = nthSundayUtc(year, 2, 2) + 7 * 3_600_000;
  const end = nthSundayUtc(year, 10, 1) + 6 * 3_600_000;
  return epochMs >= start && epochMs < end ? EDT_OFFSET : EST_OFFSET;
}

/** epoch 분 → 그 시각의 ET 자정 기준 분(0~1439). */
export function etMinuteOfDay(minuteKey: number): number {
  const shifted = minuteKey + etOffsetMinutes(minuteKey * 60_000);
  return ((shifted % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
}

/**
 * 거래일 번호 — 04:00 ET에 바뀌는 정수. 같은 거래일의 봉만 한 지표 계열에 들어간다.
 * (학습이 "일 단위 독립 — 전일 연속성 없음"이었다. docs/FEATURES.md)
 */
export function tradingDayIndex(minuteKey: number): number {
  const shifted = minuteKey + etOffsetMinutes(minuteKey * 60_000) - TRADING_DAY_START_MIN;
  return Math.floor(shifted / DAY_MINUTES);
}

/** epoch 분 → 그 시각의 ET 날짜(YYYY-MM-DD) — 토스 일봉의 date와 같은 규약(전일 종가 대조용). */
export function etDateString(minuteKey: number): string {
  const shifted = (minuteKey + etOffsetMinutes(minuteKey * 60_000)) * 60_000;
  return new Date(shifted).toISOString().slice(0, 10);
}

/**
 * 학습 표본 창(04:00~20:00 ET) 안의 봉인가 — 학습 파이프라인의 수집 규약 기록.
 * 2026-08-25부터 저장소(ModelDayBars)는 이 창 밖 봉(주간거래·오버나이트)도 담는다(표시용 참고 판정) —
 * 이 함수는 더 이상 저장 필터로 쓰지 않는다. "이 봉의 확률은 학습 분포 안인가"를 물을 때의 기준으로 남긴다.
 */
export function inCollectWindow(minuteKey: number): boolean {
  const m = etMinuteOfDay(minuteKey);
  return m >= TRADING_DAY_START_MIN && m < TRADING_DAY_END_MIN;
}

/**
 * 신호를 낼 수 있는 봉인가(학습의 `session=='main'` 필터) — 집계봉의 **마지막 구성 1분봉** 기준이다.
 * 학습 파이프라인이 k분봉의 session을 마지막 구성 분봉에서 가져왔다(build-dataset.aggregateBars).
 */
export function isMainSessionBar(barStartMinuteKey: number, barMinutes: number): boolean {
  const m = etMinuteOfDay(barStartMinuteKey + Math.max(1, barMinutes) - 1);
  return m >= MAIN_SESSION_START_MIN && m <= MAIN_SESSION_END_MIN;
}
