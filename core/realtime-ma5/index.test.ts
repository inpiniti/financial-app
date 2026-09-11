import { describe, expect, it } from 'vitest';
import {
  RealtimeMa5Calculator,
  averagingDownQty,
  shouldEnter,
  isUsRegularSession,
  isUsInitialEntryAllowed,
  isUsAveragingDownAllowed,
} from './index';

describe('RealtimeMa5Calculator', () => {
  it('상향 돌파는 현재 MA5 기준(이전틱 < 현재 MA5 < 현재틱)으로 계산한다', () => {
    const calc = new RealtimeMa5Calculator();

    const first = calc.evaluate([100, 100, 100, 100], 90);
    expect(first.ma5).toBeCloseTo(98);

    const second = calc.evaluate([100, 100, 100, 100, 95], 101);

    expect(second.ma5).toBeCloseTo(99.2);
    expect(second.breakout).toBe(true);
    expect(second.slope).toBe('up');
    expect(shouldEnter(second)).toBe(true);
  });

  it('현재틱이 현재 MA5 아래면 돌파가 아니다(과거 MA5를 넘었어도 false)', () => {
    const calc = new RealtimeMa5Calculator();

    calc.evaluate([100, 100, 100, 100], 80);
    const state = calc.evaluate([100, 100, 100, 100, 100], 97);

    expect(state.ma5).toBeCloseTo(99.4);
    expect(state.breakout).toBe(false);
    expect(shouldEnter(state)).toBe(false);
  });

  it('기울기 하락이면 진입 조건은 거짓이다', () => {
    const calc = new RealtimeMa5Calculator();
    calc.evaluate([100, 100, 100, 100], 90);
    const state = calc.evaluate([100, 100, 100, 100, 110], 90);

    expect(state.slope).toBe('down');
    expect(state.breakout).toBe(false);
    expect(shouldEnter(state)).toBe(false);
  });

  it('시드 프로브(isLiveTick=false)는 이전틱을 오염시키지 않아 첫 라이브 틱에서 돌파가 발생하지 않는다', () => {
    const calc = new RealtimeMa5Calculator();
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

  it('신규 진입은 ET 09:30~14:00(장마감 2시간 전)까지만 허용되고 14:00 이후는 차단된다', () => {
    // 2026-09-11 (금) 13:59 ET -> 신규 진입 가능
    const beforeCutoff = new Date('2026-09-11T17:59:00Z').getTime();
    expect(isUsInitialEntryAllowed(beforeCutoff)).toBe(true);

    // 2026-09-11 (금) 14:00 ET -> 신규 진입 금지 (마감 2시간 전)
    const atCutoff = new Date('2026-09-11T18:00:00Z').getTime();
    expect(isUsInitialEntryAllowed(atCutoff)).toBe(false);

    // 2026-09-11 (금) 15:30 ET -> 신규 진입 금지
    const nearClose = new Date('2026-09-11T19:30:00Z').getTime();
    expect(isUsInitialEntryAllowed(nearClose)).toBe(false);

    // 주간거래 시간(KST 13:20 -> 2026-09-11T04:20:00Z -> ET 00:20) -> 신규 진입 금지
    const daytimeKst = new Date('2026-09-11T04:20:00Z').getTime();
    expect(isUsInitialEntryAllowed(daytimeKst)).toBe(false);
  });

  it('추가진입(물타기)은 정규장(ET 09:30~16:00) 내내 허용된다 (14:00~16:00도 허용)', () => {
    // 13:59 ET -> 추가진입 가능
    const beforeCutoff = new Date('2026-09-11T17:59:00Z').getTime();
    expect(isUsAveragingDownAllowed(beforeCutoff)).toBe(true);

    // 14:30 ET (장마감 1.5시간 전) -> 신규 진입은 불가능하지만 추가진입은 가능
    const afterCutoff = new Date('2026-09-11T18:30:00Z').getTime();
    expect(isUsInitialEntryAllowed(afterCutoff)).toBe(false);
    expect(isUsAveragingDownAllowed(afterCutoff)).toBe(true);

    // 15:59 ET -> 추가진입 가능
    const nearClose = new Date('2026-09-11T19:59:00Z').getTime();
    expect(isUsAveragingDownAllowed(nearClose)).toBe(true);

    // 16:00 ET (마감) -> 추가진입 불가
    const closed = new Date('2026-09-11T20:00:00Z').getTime();
    expect(isUsAveragingDownAllowed(closed)).toBe(false);
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
