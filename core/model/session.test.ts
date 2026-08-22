// ET 시각 판정 — 거래일 경계(04:00)·정규장 창(09:31~16:00)·서머타임 전환.
// 여기가 한 시간 어긋나면 지표가 딴 날 봉과 섞이고 신호 창이 통째로 밀린다.

import { describe, expect, it } from 'vitest';
import {
  etDateString,
  etMinuteOfDay,
  etOffsetMinutes,
  inCollectWindow,
  isMainSessionBar,
  tradingDayIndex,
} from './session';

/** ET 현지 시각 문자열 → epoch 분. 오프셋을 명시해 테스트가 실행 환경 시간대에 흔들리지 않게. */
const at = (iso: string): number => Math.floor(Date.parse(iso) / 60_000);

describe('ET 시각 판정', () => {
  it('서머타임 경계 — 3월 둘째 일요일 02:00부터 EDT, 11월 첫째 일요일 02:00부터 EST', () => {
    // 2026년: DST 시작 3/8 02:00 EST(=07:00 UTC), 종료 11/1 02:00 EDT(=06:00 UTC).
    expect(etOffsetMinutes(Date.parse('2026-03-08T06:59:00Z'))).toBe(-300);
    expect(etOffsetMinutes(Date.parse('2026-03-08T07:00:00Z'))).toBe(-240);
    expect(etOffsetMinutes(Date.parse('2026-11-01T05:59:00Z'))).toBe(-240);
    expect(etOffsetMinutes(Date.parse('2026-11-01T06:00:00Z'))).toBe(-300);
    // 한겨울·한여름
    expect(etOffsetMinutes(Date.parse('2026-01-15T12:00:00Z'))).toBe(-300);
    expect(etOffsetMinutes(Date.parse('2026-07-15T12:00:00Z'))).toBe(-240);
  });

  it('ET 분 — 서머타임 구간의 09:31은 571분', () => {
    expect(etMinuteOfDay(at('2026-08-18T09:31:00-04:00'))).toBe(9 * 60 + 31);
    expect(etMinuteOfDay(at('2026-01-15T09:31:00-05:00'))).toBe(9 * 60 + 31);
  });

  it('정규장 봉 — 5분봉은 마지막 구성 분봉 기준(토스 sessionType 실측과 같은 경계)', () => {
    // 09:30~09:34 봉 → 마지막 09:34 → main (토스도 09:31부터 main)
    expect(isMainSessionBar(at('2026-08-18T09:30:00-04:00'), 5)).toBe(true);
    // 09:25~09:29 봉 → 마지막 09:29 → pre
    expect(isMainSessionBar(at('2026-08-18T09:25:00-04:00'), 5)).toBe(false);
    // 15:55~15:59 → main / 16:00~16:04 → after
    expect(isMainSessionBar(at('2026-08-18T15:55:00-04:00'), 5)).toBe(true);
    expect(isMainSessionBar(at('2026-08-18T16:00:00-04:00'), 5)).toBe(false);
  });

  it('표본 창 — 04:00~20:00 ET만 담는다(오버나이트·주간거래 봉은 버린다)', () => {
    expect(inCollectWindow(at('2026-08-18T04:00:00-04:00'))).toBe(true);
    expect(inCollectWindow(at('2026-08-18T19:55:00-04:00'))).toBe(true);
    expect(inCollectWindow(at('2026-08-18T20:00:00-04:00'))).toBe(false);
    expect(inCollectWindow(at('2026-08-18T03:55:00-04:00'))).toBe(false);
  });

  it('거래일 번호는 04:00 ET에 바뀐다 — 같은 날 프리~애프터는 한 묶음', () => {
    const pre = tradingDayIndex(at('2026-08-18T04:00:00-04:00'));
    const main = tradingDayIndex(at('2026-08-18T12:00:00-04:00'));
    const after = tradingDayIndex(at('2026-08-18T19:55:00-04:00'));
    const next = tradingDayIndex(at('2026-08-19T04:00:00-04:00'));
    expect(main).toBe(pre);
    expect(after).toBe(pre);
    expect(next).toBe(pre + 1);
  });

  it('ET 날짜 문자열은 토스 일봉 date와 같은 규약이다', () => {
    expect(etDateString(at('2026-08-18T04:00:00-04:00'))).toBe('2026-08-18');
    expect(etDateString(at('2026-08-18T19:59:00-04:00'))).toBe('2026-08-18');
  });
});
