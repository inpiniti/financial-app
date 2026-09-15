import { describe, expect, it } from 'vitest';
import {
  RealtimeMa5Calculator,
  averagingDownQty,
  shouldEnter,
  shouldAverageDown,
  isUsRegularSession,
  isUsInitialEntryAllowed,
  isUsAveragingDownAllowed,
} from './index';

describe('RealtimeMa5Calculator — 3초 하단 체류 상태 머신 및 상향 돌파', () => {
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

  it('5선 위(105)에서 하락 중 5선(100) 부근 0.1초 틱 진동(99.99 -> 100.01)은 돌파가 차단된다', () => {
    const calc = new RealtimeMa5Calculator(3_000); // 3초 하단 체류 필수
    const closes = [100, 100, 100, 100]; // sum4 = 400

    // 1) 현재가 105(5선 위)에서 시작 (t = 0ms)
    const s1 = calc.evaluate(closes, 105, true, 0);
    expect(s1.breakout).toBe(false);
    expect(s1.isArmed).toBe(false);
    expect(s1.belowDwellMs).toBeNull();

    // 2) 105 -> 99.99 로 하락 (t = 1000ms). 5선(99.998) 이하 진입!
    const s2 = calc.evaluate(closes, 99.99, true, 1000);
    expect(s2.breakout).toBe(false);
    expect(s2.isArmed).toBe(false); // 0ms 경과 -> 미충족
    expect(s2.belowDwellMs).toBe(0);

    // 3) 0.1초 만에 100.01로 틱 진동 튐 (t = 1100ms)
    const s3 = calc.evaluate(closes, 100.01, true, 1100);
    // 체류 시간 100ms < 3000ms이므로 돌파 차단!
    expect(s3.breakout).toBe(false);
    expect(s3.isArmed).toBe(false);
    expect(shouldEnter(s3)).toBe(false);
    // 5선 위로 튀었으므로 체류 시간 타이머 리셋 확인!
    expect(s3.belowDwellMs).toBeNull();
  });

  it('5선 아래에서 3초 이상 연속 체류 후 5선을 상향 돌파하면 breakout이 발화되고 1회 소진된다', () => {
    const calc = new RealtimeMa5Calculator(3_000);
    const closes = [100, 100, 100, 100];

    // t = 0ms: 5선 아래 95.0 진입
    calc.evaluate(closes, 95.0, true, 0);

    // t = 2000ms (2초 경과): 아직 3초 미만
    const s2 = calc.evaluate(closes, 94.0, true, 2000);
    expect(s2.isArmed).toBe(false);
    expect(s2.belowDwellMs).toBe(2000);

    // t = 3000ms (3초 도달): isArmed = true 완료!
    const s3 = calc.evaluate(closes, 94.5, true, 3000);
    expect(s3.isArmed).toBe(true);
    expect(s3.breakout).toBe(false); // 아직 돌파 안 함

    // t = 3500ms: 여전히 5선 아래(99.0) -> isArmed 유지
    const s4 = calc.evaluate(closes, 99.0, true, 3500);
    expect(s4.isArmed).toBe(true);
    expect(s4.breakout).toBe(false);

    // t = 3600ms: 5선((400 + 101) / 5 = 100.2) 상향 돌파 (101.0)!
    const s5 = calc.evaluate(closes, 101.0, true, 3600);
    expect(s5.breakout).toBe(true);
    expect(shouldEnter(s5)).toBe(true);
    // 돌파 발화 즉시 isArmed는 false로 소진!
    expect(s5.isArmed).toBe(false);

    // t = 3700ms: 계속 5선 위(101.5) -> 추가 중복 돌파 발화 없음
    const s6 = calc.evaluate(closes, 101.5, true, 3700);
    expect(s6.breakout).toBe(false);
  });

  it('5선 아래 체류 중 3초 미만(2.9초) 시점에 5선 위로 1틱이라도 튀면 엄격 리셋된다', () => {
    const calc = new RealtimeMa5Calculator(3_000);
    const closes = [100, 100, 100, 100];

    // t = 0ms: 5선 아래 95.0 진입
    calc.evaluate(closes, 95.0, true, 0);

    // t = 2900ms: 2.9초 머묾 (아직 미충족)
    const s1 = calc.evaluate(closes, 96.0, true, 2900);
    expect(s1.isArmed).toBe(false);

    // t = 2950ms: 100.5로 순간 튐 (5선 위) -> 리셋!
    const s2 = calc.evaluate(closes, 100.5, true, 2950);
    expect(s2.breakout).toBe(false);
    expect(s2.belowDwellMs).toBeNull();

    // t = 3000ms: 다시 95.0으로 하락 -> 카운트가 0초부터 새로 시작!
    const s3 = calc.evaluate(closes, 95.0, true, 3000);
    expect(s3.belowDwellMs).toBe(0);
    expect(s3.isArmed).toBe(false);

    // t = 5000ms (2초 경과): 아직 누적 2초이므로 미충족
    const s4 = calc.evaluate(closes, 96.0, true, 5000);
    expect(s4.isArmed).toBe(false);

    // t = 6000ms (3초 경과): 이제 다시 충족!
    const s5 = calc.evaluate(closes, 97.0, true, 6000);
    expect(s5.isArmed).toBe(true);
  });

  it('현재틱이 현재 MA5 아래면 돌파가 아니다(과거 MA5를 넘었어도 false)', () => {
    const calc = new RealtimeMa5Calculator(0);

    calc.evaluate([100, 100, 100, 100], 80);
    const state = calc.evaluate([100, 100, 100, 100, 100], 97);

    expect(state.ma5).toBeCloseTo(99.4);
    expect(state.breakout).toBe(false);
    expect(shouldEnter(state)).toBe(false);
  });

  it('급락 후 바닥에서 3초 체류 후 5선 돌파 시 5개 전 종가보다 낮아 slope가 down이어도 돌파 및 진입은 즉시 true가 된다', () => {
    const calc = new RealtimeMa5Calculator(3_000);
    // 5분 전 종가는 120으로 매우 높고, 최근 4개 봉은 100, 95, 90, 90으로 급락한 상황
    calc.evaluate([120, 100, 95, 90, 90], 90, true, 0);
    // 3초 체류 경과
    calc.evaluate([120, 100, 95, 90, 90], 90, true, 3100);

    // 현재 틱 97로 반등하며 5선((100+95+90+90+97)/5 = 94.4)을 상향 돌파!
    const state = calc.evaluate([120, 100, 95, 90, 90], 97, true, 3200);

    // 5분 전 종가(120)보다는 낮으므로 slope는 'down'이지만
    expect(state.slope).toBe('down');
    // 5선(94.4)을 90 -> 97로 상향 돌파했으므로 breakout은 true!
    expect(state.breakout).toBe(true);
    // 진입 신호도 과거 5분 지연 없이 즉시 발화!
    expect(shouldEnter(state)).toBe(true);
  });

  it('FTFT 이슈 시나리오: 평단 $3.28에서 $2.78로 급락 후 3초 체류 뒤 $3.04로 5선($3.03) 돌파 시 즉시 물타기(-7.31% <= -3%)가 성립한다', () => {
    const calc = new RealtimeMa5Calculator(3_000);
    // 최근 4개 봉 종가합 12.11 (현재틱 3.04일 때 5선 = (12.11 + 3.04) / 5 = 3.030)
    const closes = [3.35, 3.10, 3.05, 2.96, 3.00];

    // 직전 틱 3.01 (5선 3.024 아래) 진입
    calc.evaluate(closes, 3.01, true, 0);
    // 3.5초 체류
    calc.evaluate(closes, 3.01, true, 3500);

    // 현재 틱 3.04로 5선(3.030) 돌파!
    const state = calc.evaluate(closes, 3.04, true, 3600);

    expect(state.breakout).toBe(true);
    // 5분 전 가격 3.30보다는 낮아 slope는 down이지만
    expect(state.slope).toBe('down');
    // 물타기 판정은 즉시 true! 지연 없이 매수 가능!
    expect(shouldAverageDown(3.04, 3.28, state)).toBe(true);
  });

  it('시드 프로브(isLiveTick=false)는 이전틱을 오염시키지 않아 첫 라이브 틱에서 돌파가 발생하지 않는다', () => {
    const calc = new RealtimeMa5Calculator(0);
    // 시드 프로브(과거 종가 90)로 상태 계산
    const probe = calc.evaluate([100, 100, 100, 100], 90, false);
    expect(probe.breakout).toBe(false);

    // 첫 라이브 틱(101) 수신 시 probe(90)와의 차이로 돌파가 오발생하면 안 됨 (라이브 틱 카운트 1)
    const firstLive = calc.evaluate([100, 100, 100, 100, 95], 101, true);
    expect(firstLive.breakout).toBe(false);

    // 라이브 틱이 90으로 내려간 후
    calc.evaluate([100, 100, 100, 100, 95], 90, true);
    // 다시 101로 돌파했을 때만 true
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
