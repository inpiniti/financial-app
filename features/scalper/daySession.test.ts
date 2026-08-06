import { describe, expect, it } from 'vitest';

import { isDaytimeSessionOpen, shouldForceSimBroker } from './daySession';

describe('isDaytimeSessionOpen', () => {
  it('10:00 KST 정각은 열림(경계 포함)', () => {
    expect(isDaytimeSessionOpen(Date.UTC(2026, 7, 6, 1, 0))).toBe(true); // 2026-08-06 10:00 KST
  });

  it('09:59 KST는 닫힘', () => {
    expect(isDaytimeSessionOpen(Date.UTC(2026, 7, 6, 0, 59))).toBe(false);
  });

  it('15:59 KST는 열림', () => {
    expect(isDaytimeSessionOpen(Date.UTC(2026, 7, 6, 6, 59))).toBe(true);
  });

  it('16:00 KST 정각은 닫힘(경계 미포함)', () => {
    expect(isDaytimeSessionOpen(Date.UTC(2026, 7, 6, 7, 0))).toBe(false);
  });

  it('한밤중(자정 부근)은 닫힘', () => {
    expect(isDaytimeSessionOpen(Date.UTC(2026, 7, 6, 15, 0))).toBe(false); // 2026-08-06 00:00 KST
  });

  it('여름/겨울 날짜 모두 같은 UTC 오프셋(KST는 서머타임 없음) — 문서의 "Summer Time 동일" 반영', () => {
    // 겨울(1월)도 여름(8월)과 동일하게 UTC+9로 판정돼야 한다.
    expect(isDaytimeSessionOpen(Date.UTC(2026, 0, 15, 1, 0))).toBe(true); // 2026-01-15 10:00 KST
    expect(isDaytimeSessionOpen(Date.UTC(2026, 0, 15, 0, 59))).toBe(false); // 2026-01-15 09:59 KST
    expect(isDaytimeSessionOpen(Date.UTC(2026, 0, 15, 7, 0))).toBe(false); // 2026-01-15 16:00 KST
  });

  it('주말 여부는 판단하지 않는다 — 시각만 본다(호출부가 평일 여부를 별도로 안다고 가정)', () => {
    // 2026-08-08은 토요일, 10:00 KST — 순수 시각 판정이라 true가 나오는 게 맞다(계약을 문서화하는 테스트).
    expect(isDaytimeSessionOpen(Date.UTC(2026, 7, 8, 1, 0))).toBe(true);
  });
});

describe('shouldForceSimBroker — 주간거래는 절대 실거래하지 않는다(plan v4 §3-3)', () => {
  const DAYTIME_EPOCH = Date.UTC(2026, 7, 6, 2, 0); // 2026-08-06 11:00 KST — 주간거래 창.
  const REGULAR_EPOCH = Date.UTC(2026, 7, 6, 14, 0); // 정규장(ET 09:30~16:00 EDT 안쪽 시각).

  it('주간거래 창이면 전역 시뮬레이션 모드가 꺼져 있어도(false) 강제로 시뮬 브로커를 쓴다', () => {
    expect(shouldForceSimBroker(DAYTIME_EPOCH, false)).toBe(true);
  });

  it('주간거래 창이면 전역 시뮬레이션 모드가 켜져 있어도(true) 당연히 시뮬 브로커를 쓴다', () => {
    expect(shouldForceSimBroker(DAYTIME_EPOCH, true)).toBe(true);
  });

  it('주간거래 창이 아니면 전역 시뮬레이션 모드 설정을 그대로 따른다', () => {
    expect(shouldForceSimBroker(REGULAR_EPOCH, false)).toBe(false);
    expect(shouldForceSimBroker(REGULAR_EPOCH, true)).toBe(true);
  });
});
