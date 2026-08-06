import { describe, expect, it } from 'vitest';

import { isDaytimeSessionOpen } from './daySession';

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
