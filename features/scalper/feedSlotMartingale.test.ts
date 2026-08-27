// 물타기 시험 모드 슬롯(2026-08-27) — 1분봉 합성 + 4선으로 진입(kind='entry')·5선 변곡(kind='add') BUY를 낸다.
// 판정 규칙은 core/martingale 테스트가, 여기는 **봉 마감 → 신호 종류·정규장 게이트** 배선을 본다.

import { describe, expect, it } from 'vitest';

import { FeedSlot, type SlotSignalContext } from './feedSlot';
import { fakeClock } from './fakes';

const M = 60_000;
/** 2026-08-27 10:00 ET(EDT) 정규장. */
const TEN_AM_ET = Date.UTC(2026, 7, 27, 14, 0);
/** 2026-08-27 05:00 ET — 프리마켓. */
const FIVE_AM_ET = Date.UTC(2026, 7, 27, 9, 0);

/** 오름차순 121봉 시드(꾸준히 상승) + 마지막 봉 눌림 — 다음 봉이 5선 위로 닫히면 진입 봉이 된다. */
function seedBars(endMs: number, n = 122): { minuteKey: number; close: number }[] {
  const endKey = Math.floor(endMs / M);
  return Array.from({ length: n }, (_, i) => ({
    minuteKey: endKey - n + i,
    close: 100 + i - (i === n - 1 ? 3 : 0),
  }));
}

function harness(nowMs: number) {
  const clock = fakeClock(nowMs);
  const slot = new FeedSlot({ ticker: 'A', clock, martingale: true, model: true, trend: true });
  const signals: Array<{ signal: string; ctx: SlotSignalContext }> = [];
  slot.attachDetector((signal, ctx) => signals.push({ signal, ctx }));
  return { clock, slot, signals };
}

describe('FeedSlot 물타기 모드', () => {
  it('시드 뒤 5선 돌파 봉이 닫히면 BUY(kind=entry), 시드 자체로는 신호가 없다', () => {
    const h = harness(TEN_AM_ET);
    expect(h.slot.seedTrend(seedBars(TEN_AM_ET))).toBe(122);
    expect(h.signals).toHaveLength(0);
    expect(h.slot.getView().martingale?.aligned).toBe(true);
    // 다음 1분봉(시드 종가 ~218): 크게 반등해 5선 위 종가로 닫힌다(그다음 분 첫 틱이 마감을 유발).
    h.slot.pushTick(230, TEN_AM_ET + 10_000);
    h.slot.pushTick(231, TEN_AM_ET + M + 1_000);
    const entry = h.signals.filter((s) => s.ctx.kind === 'entry');
    expect(entry).toHaveLength(1);
    expect(entry[0].signal).toBe('BUY');
    expect(entry[0].ctx.price).toBe(231);
    // 한 봉 눌림으로는 5선이 꺾이지 않았다(계속 상승) — 변곡(add)은 없다.
    expect(h.signals.some((s) => s.ctx.kind === 'add')).toBe(false);
    expect(h.slot.getView().martingale?.entry).toBe(true);
  });

  it('프리마켓 봉은 4선에는 쓰이지만 진입 신호는 내지 않는다', () => {
    const h = harness(FIVE_AM_ET);
    h.slot.seedTrend(seedBars(FIVE_AM_ET));
    h.slot.pushTick(230, FIVE_AM_ET + 10_000);
    h.slot.pushTick(231, FIVE_AM_ET + M + 1_000);
    expect(h.slot.getView().martingale?.entry).toBe(true); // 판정은 진입 봉
    expect(h.signals.filter((s) => s.ctx.kind === 'entry')).toHaveLength(0); // 정규장 밖 — 흘리지 않는다
  });

  it('5선 변곡만 있고 정배열 돌파가 아니면 add만 나온다', () => {
    const h = harness(TEN_AM_ET);
    // 하락 추세 시드 — 정배열 아님.
    const endKey = Math.floor(TEN_AM_ET / M);
    h.slot.seedTrend(Array.from({ length: 122 }, (_, i) => ({ minuteKey: endKey - 122 + i, close: 200 - i })));
    h.slot.pushTick(95, TEN_AM_ET + 10_000); // 반등 봉 → 5선 변곡
    h.slot.pushTick(96, TEN_AM_ET + M + 1_000);
    expect(h.signals.map((s) => s.ctx.kind)).toEqual(['add']);
  });

  it('봉 주기는 1분(주입된 trendBarMinutes보다 우선), 뷰에 판정 스냅샷이 실린다', () => {
    const clock = fakeClock(TEN_AM_ET);
    const slot = new FeedSlot({ ticker: 'A', clock, martingale: true, trendBarMinutes: 5 });
    slot.attachDetector(() => {});
    slot.seedTrend(seedBars(TEN_AM_ET));
    expect(slot.trendLastBarKey).toBe(Math.floor(TEN_AM_ET / M) - 1);
    slot.pushTick(230, TEN_AM_ET + 10_000);
    slot.pushTick(231, TEN_AM_ET + M + 1_000); // 1분 뒤 첫 틱에 봉이 닫힌다(5분봉이면 아직 안 닫힘)
    expect(slot.trendLastBarKey).toBe(Math.floor(TEN_AM_ET / M));
    expect(slot.getView().martingale?.bars).toBe(123);
    expect(slot.getView().modelProb).toBeNull();
  });
});
