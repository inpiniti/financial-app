// 기울기 단타 모드 슬롯(2026-09-02 ADR 0011) — 틱마다 기울기/10초 문턱(+1%) 전환에서만 BUY/SELL을 낸다(스로틀·봉·세션 없음).
// 판정 규칙은 core/slope 테스트가, 여기는 **틱 → 신호 전환·부착 시점·다른 모드 배제** 배선을 본다.

import { describe, expect, it } from 'vitest';

import { FeedSlot, type SlotSignalContext } from './feedSlot';
import { fakeClock } from './fakes';

/** 2026-08-27 22:00 ET(주간거래) — 세션 게이트가 없음을 겸해 본다. */
const T0 = Date.UTC(2026, 7, 28, 2, 0);

function harness(nowMs = T0, attach = true) {
  const clock = fakeClock(nowMs);
  const slot = new FeedSlot({ ticker: 'A', clock, slope: true, martingale: true, model: true, trend: true });
  const signals: Array<{ signal: string; ctx: SlotSignalContext }> = [];
  if (attach) slot.attachDetector((signal, ctx) => signals.push({ signal, ctx }));
  return { clock, slot, signals };
}

/**
 * 직전 봉 재료 — T0+0~4초에 prevPrice 틱 5개. 창은 "지금 기준 슬라이딩 10초"라(SlopeMeter v2) 현재 봉 틱은 T0+14~19초에 넣어야
 * 현재 창 (t−10, t]에 직전 틱이 섞이지 않고, 직전 창 (t−20, t−10]에 0~4초 틱이 전부 든다. 그때 기울기 = (현재 창 평균 − prevPrice)/prevPrice.
 */
function fill(h: ReturnType<typeof harness>, prevPrice: number, curPrices: number[]) {
  for (let i = 0; i < 5; i += 1) {
    h.clock.set(T0 + i * 1_000);
    h.slot.pushTick(prevPrice, T0 + i * 1_000);
  }
  curPrices.forEach((p, i) => {
    const t = T0 + 14_000 + i * 1_000;
    h.clock.set(t);
    h.slot.pushTick(p, t);
  });
}

describe('FeedSlot 기울기 단타 모드', () => {
  it('기울기가 +1% 아래에서 이상으로 올라서는 틱에 BUY 1회, 위에 머무는 동안은 조용하다', () => {
    const h = harness();
    fill(h, 100, [100.5, 101.7, 101.7]); // 현재 봉 평균 100.5 → 101.1 → 101.3 : 0.5% → 1.1%(BUY) → 1.3%(조용)
    expect(h.signals).toHaveLength(1);
    expect(h.signals[0].signal).toBe('BUY');
    expect(h.signals[0].ctx.price).toBe(101.7);
    expect(h.slot.getView().slopeRate).toBeCloseTo(1.3, 6);
    expect(h.slot.getView().lastSignal).toBe('BUY');
  });

  it('위에서 +1% 미만으로 내려오는 틱에 SELL 1회 — 손익·세션 무관, 주간거래 시간에도 그대로', () => {
    const h = harness();
    fill(h, 100, [101.5]); // 1.5% → BUY
    expect(h.signals.map((s) => s.signal)).toEqual(['BUY']);
    h.clock.set(T0 + 15_000);
    h.slot.pushTick(99, T0 + 15_000); // 현재 봉 평균 (101.5+99)/2 = 100.25 → 0.25% → SELL
    expect(h.signals.map((s) => s.signal)).toEqual(['BUY', 'SELL']);
    expect(h.signals[1].ctx.price).toBe(99);
  });

  it('창이 미끄러져 직전 봉이 비면(null) 위 상태에서 SELL', () => {
    const h = harness();
    fill(h, 100, [101.5]); // BUY
    // 26초 뒤 한 틱 — (t−20s, t−10s] 직전 봉에 틱이 없어 null → SELL
    h.clock.set(T0 + 40_000);
    h.slot.pushTick(200, T0 + 40_000);
    expect(h.signals.map((s) => s.signal)).toEqual(['BUY', 'SELL']);
    expect(h.slot.getView().slopeRate).toBeNull();
  });

  it('리스너를 나중에 붙여도 "이미 위"였던 종목은 가짜 BUY를 내지 않는다(상태는 부착 전에도 갱신)', () => {
    const h = harness(T0, false);
    fill(h, 100, [102]); // 2% — 부착 전이라 신호 없음, 상태만 위
    const signals: string[] = [];
    h.slot.attachDetector((s) => signals.push(s));
    h.clock.set(T0 + 15_000);
    h.slot.pushTick(102, T0 + 15_000); // 여전히 위 — 전환 아님
    expect(signals).toEqual([]);
    h.clock.set(T0 + 16_000);
    h.slot.pushTick(98, T0 + 16_000); // 평균 100.67 → 0.67% → SELL(미보유면 오토파일럿이 무시)
    expect(signals).toEqual(['SELL']);
  });

  it('기울기 모드가 켜지면 물타기·모델·추세 판정은 돌지 않는다(봉 스냅샷 없음, 세션 게이트 없음)', () => {
    const h = harness();
    fill(h, 100, [101.5]);
    const v = h.slot.getView();
    expect(v.martingale).toBeNull();
    expect(v.martingaleLive).toBeNull();
    expect(v.trend).toBeNull();
    expect(v.modelProb).toBeNull();
    expect(h.signals).toHaveLength(1); // 주간거래 시간(22:00 ET)인데도 BUY — 세션 조건 없음
  });
});
