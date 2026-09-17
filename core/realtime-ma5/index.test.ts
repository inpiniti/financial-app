import { describe, expect, it } from 'vitest';
import {
  RealtimeMa5Calculator,
  calculateRealtimeBb,
  calculateRealtimeMa,
  averagingDownQty,
  calculateDynamicTpRate,
  dynamicSellTargetMultiplier,
  shouldEnter,
  shouldAverageDown,
  isUsRegularSession,
  isUsInitialEntryAllowed,
  isUsAveragingDownAllowed,
  isBeforeKst2Am,
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

describe('averagingDownQty — 기본 설정', () => {
  it('희망수량이 가능최대수량보다 크면 가용자본 기준으로 캡핑한다', () => {
    // 기본 orderQty = 1주, 가용자본 50, 현재가 95 -> 최대 0주
    expect(averagingDownQty(95, 100, 10, 50)).toBe(0);
  });

  it('가용자본이 충분하면 기본 설정 수량(1주)을 산다 (배수 제거)', () => {
    expect(averagingDownQty(95, 100, 10, 10_000)).toBe(1);
  });
});

describe('calculateDynamicTpRate & dynamicSellTargetMultiplier — 계좌 투입 비중별 동적 익절률', () => {
  it('투입 비중 1~5% 이하 구간은 3.0% (배율 1.03)를 적용한다', () => {
    // 10,000 USD 자산 중 400 USD 투입 (4%)
    expect(calculateDynamicTpRate(400, 10_000)).toBe(0.03);
    expect(dynamicSellTargetMultiplier(400, 10_000)).toBe(1.03);
    // 경계값 5%
    expect(calculateDynamicTpRate(500, 10_000)).toBe(0.03);
    expect(dynamicSellTargetMultiplier(500, 10_000)).toBe(1.03);
  });

  it('투입 비중 5% 초과 ~ 16% 이하 구간은 2.0% (배율 1.02)를 적용한다', () => {
    // 10,000 USD 중 1,000 USD 투입 (10%)
    expect(calculateDynamicTpRate(1_000, 10_000)).toBe(0.02);
    expect(dynamicSellTargetMultiplier(1_000, 10_000)).toBe(1.02);
    // 경계값 16%
    expect(calculateDynamicTpRate(1_600, 10_000)).toBe(0.02);
    expect(dynamicSellTargetMultiplier(1_600, 10_000)).toBe(1.02);
  });

  it('투입 비중 16% 초과 ~ 50% 이하 구간은 1.0% (배율 1.01)를 적용한다', () => {
    // 10,000 USD 중 3,000 USD 투입 (30%)
    expect(calculateDynamicTpRate(3_000, 10_000)).toBe(0.01);
    expect(dynamicSellTargetMultiplier(3_000, 10_000)).toBe(1.01);
    // 경계값 50%
    expect(calculateDynamicTpRate(5_000, 10_000)).toBe(0.01);
    expect(dynamicSellTargetMultiplier(5_000, 10_000)).toBe(1.01);
  });

  it('투입 비중 50% 초과 구간은 0.5% (배율 1.005)를 적용한다', () => {
    // 10,000 USD 중 7,000 USD 투입 (70%)
    expect(calculateDynamicTpRate(7_000, 10_000)).toBe(0.005);
    expect(dynamicSellTargetMultiplier(7_000, 10_000)).toBe(1.005);
    // 95% 투입
    expect(calculateDynamicTpRate(9_500, 10_000)).toBe(0.005);
    expect(dynamicSellTargetMultiplier(9_500, 10_000)).toBe(1.005);
  });

  it('자산이 0 이하이거나 조회 실패(비정상) 시 기본값 3.0% (배율 1.03)로 안전하게 폴백한다', () => {
    expect(calculateDynamicTpRate(500, 0)).toBe(0.03);
    expect(calculateDynamicTpRate(500, -1000)).toBe(0.03);
    expect(calculateDynamicTpRate(500, NaN)).toBe(0.03);
    expect(calculateDynamicTpRate(-100, 10_000)).toBe(0.03);
    expect(dynamicSellTargetMultiplier(500, 0)).toBe(1.03);
  });
});

describe('calculateRealtimeMa — 실시간 60선 및 120선 계산 및 상승 판정', () => {
  it('봉 수가 period 미만이면 null과 isRising: false를 반환한다', () => {
    const closes = Array(50).fill(100);
    const res60 = calculateRealtimeMa(closes, 100, 60);
    expect(res60.ma).toBeNull();
    expect(res60.isRising).toBe(false);

    const res120 = calculateRealtimeMa(closes, 100, 120);
    expect(res120.ma).toBeNull();
    expect(res120.isRising).toBe(false);
  });

  it('확정봉 60개 이상에서 현재틱이 60봉 전보다 높고 확정봉 기울기도 우상향이면 isRising이 true다', () => {
    // 60개 봉: 1부터 60까지 점진적 상승 (우상향)
    const rising60 = Array.from({ length: 60 }, (_, i) => 100 + i * 0.5);
    // 현재틱이 직전 60봉 전(rising60[0]=100)보다 훨씬 높은 150
    const res = calculateRealtimeMa(rising60, 150, 60);
    expect(res.ma).not.toBeNull();
    expect(res.isRising).toBe(true);
  });

  it('현재틱이 과거 N봉 전보다 낮아 MA가 꺾이면 isRising이 false다', () => {
    // 60개 봉: 100
    const flat60 = Array(60).fill(100);
    // 현재틱 90 (100보다 낮으므로 MA 하락)
    const res = calculateRealtimeMa(flat60, 90, 60);
    expect(res.isRising).toBe(false);
  });
});

describe('isBeforeKst2Am — 한국시간 새벽 02:00 진입 차단 게이트', () => {
  it('한국시간 01:59 (새벽 2시 전)에는 진입이 허용된다', () => {
    // 2026-09-17 01:59 KST = 2026-09-16 16:59 UTC
    const t = new Date('2026-09-16T16:59:00Z').getTime();
    expect(isBeforeKst2Am(t)).toBe(true);
  });

  it('한국시간 02:00 (새벽 2시 정각) 및 02:01에는 진입이 차단된다', () => {
    // 2026-09-17 02:00 KST = 2026-09-16 17:00 UTC
    const t2 = new Date('2026-09-16T17:00:00Z').getTime();
    expect(isBeforeKst2Am(t2)).toBe(false);

    const t201 = new Date('2026-09-16T17:01:00Z').getTime();
    expect(isBeforeKst2Am(t201)).toBe(false);
  });

  it('한국시간 03:00 및 낮 시간대(14:00)에도 2시 이후이므로 차단된다', () => {
    const t3 = new Date('2026-09-16T18:00:00Z').getTime(); // 03:00 KST
    expect(isBeforeKst2Am(t3)).toBe(false);

    const t14 = new Date('2026-09-17T05:00:00Z').getTime(); // 14:00 KST
    expect(isBeforeKst2Am(t14)).toBe(false);
  });

  it('한국시간 밤 23:00 (정규장 오픈 전후)에는 진입이 허용된다', () => {
    const t23 = new Date('2026-09-16T14:00:00Z').getTime(); // 23:00 KST
    expect(isBeforeKst2Am(t23)).toBe(true);
  });
});

describe('averagingDownQty — 설정 수량/금액 기반 고정 분할 매수 (배수 제거)', () => {
  it('orderQty가 설정되어 있으면(예: 1주) 낙폭과 무관하게 1주만 매수한다', () => {
    const config = { orderQty: 1, sellTargetMultiplier: 1.03, averagingDownThresholdPct: -3, startAmountUsd: 100 };
    // 낙폭 -10%여도 1주만 매수
    expect(averagingDownQty(90, 100, 5, 10_000, config)).toBe(1);
    // orderQty가 2주면 2주만 매수
    expect(averagingDownQty(90, 100, 5, 10_000, { ...config, orderQty: 2 })).toBe(2);
  });

  it('가용자본이 부족하면 가용자본 한도로 캡핑된다', () => {
    const config = { orderQty: 5, sellTargetMultiplier: 1.03, averagingDownThresholdPct: -3, startAmountUsd: 100 };
    // 현재가 100, 가용자본 250 -> 최대 2주
    expect(averagingDownQty(100, 120, 5, 250, config)).toBe(2);
  });
});

describe('RealtimeMa5Calculator — 볼린저 상단 상향 돌파(upperBreakout) 및 중심선 상향 돌파(middleCross) 익절 신호', () => {
  it('상단선 미만에서 상단선 이상으로 상향 돌파 시 upperBreakout=true가 1회 발화된다', () => {
    const calc = new RealtimeMa5Calculator(0);
    const closes = Array(19).fill(100);
    // 1) 95 (상단선 미만)
    const s1 = calc.evaluate(closes, 95, true);
    expect(s1.upperBreakout).toBe(false);

    // 2) 105 (상단선 이상으로 상향 돌파) -> upperBreakout 발화!
    const s2 = calc.evaluate(closes, 105, true);
    expect(s2.upperBreakout).toBe(true);

    // 3) 다음 틱 (105 유지) -> 1회 발화 후 소진
    const s3 = calc.evaluate(closes, 105, true);
    expect(s3.upperBreakout).toBe(false);
  });

  it('중심선(MA20) 미만에서 중심선 이상으로 상향 돌파 시 middleCross=true가 1회 발화된다', () => {
    const calc = new RealtimeMa5Calculator(0);
    const closes = Array(19).fill(100);
    // 1) 90 (MA20 미만)
    const s1 = calc.evaluate(closes, 90, true);
    expect(s1.middleCross).toBe(false);

    // 2) 100 (MA20 이상으로 상향 돌파) -> middleCross 발화!
    const s2 = calc.evaluate(closes, 100, true);
    expect(s2.middleCross).toBe(true);

    // 3) 다음 틱 (100 유지) -> 1회 발화 후 소진
    const s3 = calc.evaluate(closes, 100, true);
    expect(s3.middleCross).toBe(false);
  });
});

describe('shouldEnter & shouldAverageDown — 60/120선 동시 상승 및 KST 2시 세션 게이트', () => {
  it('breakout이 발생해도 60선 또는 120선이 상승 중이 아니면 shouldEnter가 false다', () => {
    const state = {
      ma5: 100,
      slope: 'up' as const,
      breakout: true,
      refClose5: 90,
      ma60Up: false,
      ma120Up: true,
    };
    expect(shouldEnter(state)).toBe(false);
  });

  it('breakout이 발생하고 60선과 120선이 모두 상승 중이면 shouldEnter가 true다', () => {
    const state = {
      ma5: 100,
      slope: 'up' as const,
      breakout: true,
      refClose5: 90,
      ma60Up: true,
      ma120Up: true,
    };
    expect(shouldEnter(state)).toBe(true);
  });

  it('nowMs가 한국시간 02:00 이후이면 shouldEnter 및 shouldAverageDown이 false다', () => {
    const state = {
      ma5: 100,
      slope: 'up' as const,
      breakout: true,
      refClose5: 90,
      ma60Up: true,
      ma120Up: true,
    };
    // 02:30 KST = 2026-09-16 17:30 UTC
    const after2Am = new Date('2026-09-16T17:30:00Z').getTime();
    expect(shouldEnter(state, after2Am)).toBe(false);
    expect(shouldAverageDown(90, 100, state, -3, after2Am)).toBe(false);

    // 01:30 KST = 2026-09-16 16:30 UTC
    const before2Am = new Date('2026-09-16T16:30:00Z').getTime();
    expect(shouldEnter(state, before2Am)).toBe(true);
    expect(shouldAverageDown(90, 100, state, -3, before2Am)).toBe(true);
  });
});


