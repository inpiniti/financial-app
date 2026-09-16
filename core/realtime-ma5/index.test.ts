import { describe, expect, it } from 'vitest';
import {
  RealtimeMa5Calculator,
  calculateRealtimeBb,
  averagingDownQty,
  shouldEnter,
  shouldAverageDown,
  isUsRegularSession,
  isUsInitialEntryAllowed,
  isUsAveragingDownAllowed,
} from './index';

describe('calculateRealtimeBb — 실시간 1분봉 20선 볼린저 밴드 계산', () => {
  it('확정 봉 수가 19개 미만이면 계산 불가(null)를 반환한다 (워밍업 안전성)', () => {
    const res = calculateRealtimeBb([100, 100, 100], 100);
    expect(res.lowerBb).toBeNull();
    expect(res.ma20).toBeNull();
    expect(res.upperBb).toBeNull();
  });

  it('19개 확정 종가와 현재 틱으로 실시간 MA20 및 lowerBb, upperBb가 정확히 산출된다', () => {
    // 19개 봉 종가가 모두 100이고 현재 틱이 100인 경우 (표준편차 0)
    const flatCloses = Array(19).fill(100);
    const flatRes = calculateRealtimeBb(flatCloses, 100);
    expect(flatRes.ma20).toBeCloseTo(100);
    expect(flatRes.lowerBb).toBeCloseTo(100);
    expect(flatRes.upperBb).toBeCloseTo(100);

    // 10개는 90, 9개는 110, 현재 틱 100 (총 20개 평균 100)
    const varCloses = [...Array(10).fill(90), ...Array(9).fill(110)];
    const varRes = calculateRealtimeBb(varCloses, 100);
    expect(varRes.ma20).toBeCloseTo(99.5); // (90*10 + 110*9 + 100) / 20 = 1990 / 20 = 99.5
    expect(varRes.lowerBb).toBeLessThan(99.5);
    expect(varRes.upperBb).toBeGreaterThan(99.5);
  });
});

describe('RealtimeMa5Calculator — 양방향 3초 체류 및 잔파동(1초 디바운스) 상태 머신', () => {
  it('minDwellMs=0이면 체류 지연 없이 즉시 돌파가 계산된다 (기존 동작/하위 호환)', () => {
    const calc = new RealtimeMa5Calculator(0);

    const first = calc.evaluate([100, 100, 100, 100], 90);
    expect(first.ma5).toBeCloseTo(98);

    const second = calc.evaluate([100, 100, 100, 100, 95], 101);

    expect(second.ma5).toBeCloseTo(99.2);
    expect(second.breakout).toBe(true);
    expect(second.slope).toBe('up');
    expect(shouldEnter(second)).toBe(true);
  });

  it('하단 3초 체류 중 1초 미만(0.5초)으로 상단으로 튄 잔파동은 무시되고 하단 체류가 유지된다', () => {
    const calc = new RealtimeMa5Calculator(3_000, 1_000);
    const closes = [100, 100, 100, 100]; // baseline = ma5 = 100 부근

    // 1) t = 0ms: 95로 하단 진입
    calc.evaluate(closes, 95, true, 0);

    // 2) t = 2000ms: 2초 하단 체류
    const s1 = calc.evaluate(closes, 95, true, 2000);
    expect(s1.belowDwellMs).toBe(2000);
    expect(s1.belowDwellOk).toBe(false);

    // 3) t = 2100ms: 상단 101로 튐 (잔파동 시작)
    const s2 = calc.evaluate(closes, 101, true, 2100);
    // 1초 미만이므로 즉시 취소되지 않고 하단 체류 시간 유지
    expect(s2.belowDwellMs).toBe(2100);
    expect(s2.belowDwellOk).toBe(false);

    // 4) t = 2600ms: 0.5초 튀고 다시 95(하단)로 복귀!
    const s3 = calc.evaluate(closes, 95, true, 2600);
    expect(s3.belowDwellMs).toBe(2600);
    expect(s3.belowDwellOk).toBe(false);

    // 5) t = 3100ms: 하단 지속 -> 총 3초 충족으로 belowDwellOk 달성!
    const s4 = calc.evaluate(closes, 95, true, 3100);
    expect(s4.belowDwellOk).toBe(true);
  });

  it('하단 체류 중 1초 이상 상단에 머물면 진짜 이탈로 인정되어 하단 체류가 취소(리셋)된다', () => {
    const calc = new RealtimeMa5Calculator(3_000, 1_000);
    const closes = [100, 100, 100, 100];

    // t = 0ms: 하단 진입
    calc.evaluate(closes, 95, true, 0);

    // t = 2000ms: 2초 체류
    calc.evaluate(closes, 95, true, 2000);

    // t = 2100ms: 상단 101로 올라섬
    calc.evaluate(closes, 101, true, 2100);

    // t = 3200ms: 상단에 1100ms(>= 1000ms) 동안 지속 머묾 -> 취소 리셋!
    const s = calc.evaluate(closes, 101, true, 3200);
    expect(s.belowDwellMs).toBeNull();
    expect(s.belowDwellOk).toBe(false);
  });

  it('하단 3초 + 상단 3초 양방향 체류를 모두 충족해야 breakout이 발화되고 1회 소진된다', () => {
    const calc = new RealtimeMa5Calculator(3_000, 1_000);
    // 19개 확정 종가 100 -> lowerBb = 100
    const closes = Array(19).fill(100);

    // 1. 하단 진입 (t = 0)
    calc.evaluate(closes, 95, true, 0);

    // 2. 하단 3초 도달 (t = 3000)
    const s1 = calc.evaluate(closes, 95, true, 3000);
    expect(s1.belowDwellOk).toBe(true);
    expect(s1.isArmed).toBe(false);
    expect(s1.breakout).toBe(false); // 하단만 채웠으므로 아직 돌파 아님!

    // 3. 상단 진입 (t = 3100, 가격 105)
    const s2 = calc.evaluate(closes, 105, true, 3100);
    expect(s2.belowDwellOk).toBe(true);
    expect(s2.aboveDwellMs).toBe(0);
    expect(s2.breakout).toBe(false);

    // 4. 상단 2초 경과 (t = 5100, 총 상단 2000ms)
    const s3 = calc.evaluate(closes, 105, true, 5100);
    expect(s3.aboveDwellMs).toBe(2000);
    expect(s3.isArmed).toBe(false);
    expect(s3.breakout).toBe(false);

    // 5. 상단 3초 도달 (t = 6100, 총 상단 3000ms) -> 돌파 발화!
    const s4 = calc.evaluate(closes, 105, true, 6100);
    expect(s4.breakout).toBe(true);
    expect(shouldEnter(s4)).toBe(true);
    // 발화 즉시 소진
    expect(s4.isArmed).toBe(false);
    expect(s4.belowDwellOk).toBe(false);

    // 6. 다음 틱 (t = 6200) -> 추가 중복 발화 없음
    const s5 = calc.evaluate(closes, 105, true, 6200);
    expect(s5.breakout).toBe(false);
  });

  it('상단 3초 체류 중 1초 미만(0.4초)으로 하단으로 밀린 잔파동은 무시되고 상단 체류가 유지된다', () => {
    const calc = new RealtimeMa5Calculator(3_000, 1_000);
    const closes = Array(19).fill(100);

    // 하단 3초 채우기
    calc.evaluate(closes, 95, true, 0);
    calc.evaluate(closes, 95, true, 3000);

    // 상단 진입 (t = 3100)
    calc.evaluate(closes, 105, true, 3100);

    // t = 4500: 1.4초 상단 체류 상태에서 순간 98로 하단 밀림
    calc.evaluate(closes, 98, true, 4500);

    // t = 4900 (0.4초 후): 다시 105로 복귀 -> 1초 미만이므로 상단 체류 유지!
    const s = calc.evaluate(closes, 105, true, 4900);
    expect(s.aboveDwellMs).toBe(1800);
    expect(s.breakout).toBe(false);

    // t = 6200: 상단 3초 도달 시 돌파 발화!
    const s2 = calc.evaluate(closes, 105, true, 6200);
    expect(s2.breakout).toBe(true);
  });

  it('상단 체류 중 1초 이상 하단에 지속 머물면 상단 체류가 취소되고 다시 하단 체류로 전환된다', () => {
    const calc = new RealtimeMa5Calculator(3_000, 1_000);
    const closes = Array(19).fill(100);

    // 하단 3초 채우기
    calc.evaluate(closes, 95, true, 0);
    calc.evaluate(closes, 95, true, 3000);

    // 상단 진입 (t = 3100)
    calc.evaluate(closes, 105, true, 3100);

    // t = 4000: 하단으로 주저앉음 (95)
    calc.evaluate(closes, 95, true, 4000);

    // t = 5100: 하단에 1100ms 머묾 (>= 1000ms) -> 상단 체류 취소 및 하단 체류로 전환
    const s = calc.evaluate(closes, 95, true, 5100);
    expect(s.aboveDwellMs).toBeNull();
    expect(s.isArmed).toBe(false);
    expect(s.breakout).toBe(false);
    expect(s.belowDwellOk).toBe(false);
  });

  it('시드 프로브(isLiveTick=false)는 이전틱을 오염시키지 않아 첫 라이브 틱에서 돌파가 발생하지 않는다', () => {
    const calc = new RealtimeMa5Calculator(0);
    const probe = calc.evaluate([100, 100, 100, 100], 90, false);
    expect(probe.breakout).toBe(false);

    const firstLive = calc.evaluate([100, 100, 100, 100, 95], 101, true);
    expect(firstLive.breakout).toBe(false);

    calc.evaluate([100, 100, 100, 100, 95], 90, true);
    const breakoutLive = calc.evaluate([100, 100, 100, 100, 95], 101, true);
    expect(breakoutLive.breakout).toBe(true);
  });
});

describe('세션 시간 판정 (미국 정규장 및 진입 허용 창)', () => {
  it('정규장(ET 09:30~16:00 평일) 판정', () => {
    // 2026-09-11 (금) 09:30 ET -> UTC 13:30 (서머타임 EDT: UTC-4)
    const openTime = new Date('2026-09-11T13:30:00Z').getTime();
    expect(isUsRegularSession(openTime)).toBe(true);

    // 09:29 ET -> 정규장 전
    const preMarket = new Date('2026-09-11T13:29:00Z').getTime();
    expect(isUsRegularSession(preMarket)).toBe(false);

    // 16:00 ET -> 정규장 마감
    const postMarket = new Date('2026-09-11T20:00:00Z').getTime();
    expect(isUsRegularSession(postMarket)).toBe(false);
  });

  it('신규 진입은 프리마켓 및 정규장(ET 04:00~16:00) 동안 허용되고 애프터마켓(16:00 이후)은 차단된다', () => {
    // 2026-09-11 (금) 03:59 ET -> 프리마켓 개장 전 (차단)
    const beforePre = new Date('2026-09-11T07:59:00Z').getTime();
    expect(isUsInitialEntryAllowed(beforePre)).toBe(false);

    // 2026-09-11 (금) 04:00 ET -> 프리마켓 개장 (허용)
    const preStart = new Date('2026-09-11T08:00:00Z').getTime();
    expect(isUsInitialEntryAllowed(preStart)).toBe(true);

    // 2026-09-11 (금) 09:30 ET -> 정규장 개장 (허용)
    const regStart = new Date('2026-09-11T13:30:00Z').getTime();
    expect(isUsInitialEntryAllowed(regStart)).toBe(true);

    // 2026-09-11 (금) 14:30 ET -> 정규장 후반 (기존 14:00 차단 삭제 -> 이제 허용)
    const regAfternoon = new Date('2026-09-11T18:30:00Z').getTime();
    expect(isUsInitialEntryAllowed(regAfternoon)).toBe(true);

    // 2026-09-11 (금) 15:59 ET -> 정규장 마감 1분 전 (허용)
    const regNearClose = new Date('2026-09-11T19:59:00Z').getTime();
    expect(isUsInitialEntryAllowed(regNearClose)).toBe(true);

    // 2026-09-11 (금) 16:00 ET -> 애프터마켓 (신규 진입 차단)
    const postStart = new Date('2026-09-11T20:00:00Z').getTime();
    expect(isUsInitialEntryAllowed(postStart)).toBe(false);

    // 2026-09-11 (금) 18:00 ET -> 애프터마켓 (신규 진입 차단)
    const postMarket = new Date('2026-09-11T22:00:00Z').getTime();
    expect(isUsInitialEntryAllowed(postMarket)).toBe(false);

    // 주간거래 시간(KST 13:20 -> 2026-09-11T04:20:00Z -> ET 00:20) -> 신규 진입 차단
    const daytimeKst = new Date('2026-09-11T04:20:00Z').getTime();
    expect(isUsInitialEntryAllowed(daytimeKst)).toBe(false);

    // 주말 2026-09-12 (토) 10:00 ET -> 신규 진입 차단
    const weekend = new Date('2026-09-12T14:00:00Z').getTime();
    expect(isUsInitialEntryAllowed(weekend)).toBe(false);
  });

  it('추가진입(물타기)은 프리마켓, 정규장, 애프터마켓(ET 04:00~19:55) 내내 허용되고 19:55 이후는 차단된다', () => {
    // 03:59 ET -> 프리마켓 개장 전 (차단)
    const beforePre = new Date('2026-09-11T07:59:00Z').getTime();
    expect(isUsAveragingDownAllowed(beforePre)).toBe(false);

    // 04:00 ET -> 프리마켓 개장 (허용)
    const preStart = new Date('2026-09-11T08:00:00Z').getTime();
    expect(isUsAveragingDownAllowed(preStart)).toBe(true);

    // 14:30 ET -> 정규장 (허용)
    const regAfternoon = new Date('2026-09-11T18:30:00Z').getTime();
    expect(isUsAveragingDownAllowed(regAfternoon)).toBe(true);

    // 16:00 ET (애프터마켓 시작) -> 신규는 차단되지만 물타기는 허용
    const postStart = new Date('2026-09-11T20:00:00Z').getTime();
    expect(isUsInitialEntryAllowed(postStart)).toBe(false);
    expect(isUsAveragingDownAllowed(postStart)).toBe(true);

    // 19:54 ET -> 마감 청산 1분 전 (물타기 허용)
    const beforeCloseout = new Date('2026-09-11T23:54:00Z').getTime();
    expect(isUsAveragingDownAllowed(beforeCloseout)).toBe(true);

    // 19:55 ET -> 마감 청산 시점 (물타기 차단)
    const atCloseout = new Date('2026-09-11T23:55:00Z').getTime();
    expect(isUsAveragingDownAllowed(atCloseout)).toBe(false);

    // 20:00 ET (장 마감) -> 추가진입 불가
    const closed = new Date('2026-09-12T00:00:00Z').getTime();
    expect(isUsAveragingDownAllowed(closed)).toBe(false);

    // 주말 -> 추가진입 불가
    const weekend = new Date('2026-09-12T14:00:00Z').getTime();
    expect(isUsAveragingDownAllowed(weekend)).toBe(false);
  });
});

describe('averagingDownQty', () => {
  it('희망수량이 가능최대수량보다 크면 가용자본 기준으로 캡핑한다', () => {
    // gapRate = -5% → 희망수량 = (5 - 1) * 10 = 40주
    // 가능최대수량 = floor(2000 / 95) = 21주
    expect(averagingDownQty(95, 100, 10, 2000)).toBe(21);
  });

  it('가용자본이 충분하면 희망수량 그대로 산다', () => {
    expect(averagingDownQty(95, 100, 10, 10_000)).toBe(40);
  });
});
