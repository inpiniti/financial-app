// FeedSlot 모델 모드 — 슬롯은 스스로 판정하지 않고 스캐너가 민 신호만 흘린다.

import { describe, expect, it } from 'vitest';
import { fakeClock } from './fakes';
import { FeedSlot } from './feedSlot';

function slot(model = true) {
  const clock = fakeClock(1_000);
  const s = new FeedSlot({ ticker: 'A', clock, model, trend: true, trendBarMinutes: 1 });
  const got: Array<{ signal: string; price: number }> = [];
  s.attachDetector((signal, ctx) => got.push({ signal, price: ctx.price }));
  return { s, clock, got };
}

describe('FeedSlot — 모델 모드', () => {
  it('틱만으로는 신호가 나지 않는다 — 봉 4선 판정을 돌리지 않는다', () => {
    const { s, got } = slot();
    let t = Date.parse('2026-08-18T13:00:00Z');
    for (let i = 0; i < 300; i += 1) {
      s.pushTick(100 + i, t, { volume: 10 });
      t += 20_000;
    }
    expect(got).toHaveLength(0);
    expect(s.getView().trend).toBeNull();
  });

  it('emitSignal이 리스너로 흘러간다 — 진입가는 슬롯의 최신 체결가', () => {
    const { s, got } = slot();
    s.pushTick(123.45, Date.parse('2026-08-18T13:00:00Z'), { volume: 10 });
    expect(s.emitSignal('BUY', 120)).toBe(true);
    expect(got).toEqual([{ signal: 'BUY', price: 123.45 }]);
    expect(s.getView().lastSignal).toBe('BUY');
  });

  it('체결가가 아직 없으면 신호 봉 종가를 진입가로 쓴다', () => {
    const { s, got } = slot();
    expect(s.emitSignal('BUY', 120)).toBe(true);
    expect(got).toEqual([{ signal: 'BUY', price: 120 }]);
  });

  it('감지기가 안 붙어 있으면 흘리지 않는다(false)', () => {
    const { s } = slot();
    s.detachDetector();
    expect(s.emitSignal('BUY', 120)).toBe(false);
  });

  it('모델 모드가 아니면 emitSignal은 아무것도 하지 않는다 — 추세 경로가 오염되지 않는다', () => {
    const { s, got } = slot(false);
    expect(s.emitSignal('BUY', 120)).toBe(false);
    expect(got).toHaveLength(0);
  });

  it('틱/초·호가는 모델 모드에서도 계속 잰다(진입 자격·발주 단가용)', () => {
    const { s, clock } = slot();
    const base = clock.now();
    for (let i = 0; i < 5; i += 1) s.pushTick(100, base + i * 100, { volume: 1 });
    s.pushQuote(99.9, 100.1);
    expect(s.tickRate(clock.now())).toBeGreaterThan(0);
    expect(s.quote).toEqual({ bid1: 99.9, ask1: 100.1, at: clock.now() });
  });

  it('확률은 화면용으로만 들고 있는다', () => {
    const { s } = slot();
    expect(s.getView().modelProb).toBeNull();
    s.setModelProb(0.42);
    expect(s.getView().modelProb).toBeCloseTo(0.42, 9);
    s.setModelProb(Number.NaN);
    expect(s.getView().modelProb).toBeNull();
  });
});
