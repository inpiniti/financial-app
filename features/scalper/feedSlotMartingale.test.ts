// 5선 물타기 단타 모드 슬롯(2026-09-02 ADR 0010) — 1분봉 합성 + 5선으로 "5선 상승·상향 돌파" BUY(kind='entry')를 낸다.
// 미보유=진입·보유=물타기 후보로 가르는 건 오토파일럿·규칙 몫이라 여기엔 없다.
// 2026-09-01 실시간 진입: 봉 마감을 기다리지 않고 진행 중 봉을 현재가로 넣어 판정한다(봉당 발화 1회).
// 판정 규칙은 core/martingale 테스트가, 여기는 **틱 → 신호 종류·세션 게이트·중복 방지** 배선을 본다.

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

describe('FeedSlot 5선 물타기 단타 모드', () => {
  it('시드 뒤 5선 돌파는 봉 마감을 기다리지 않고 진행 중 봉 첫 틱에서 BUY(kind=entry), 시드 자체로는 신호가 없다', () => {
    const h = harness(TEN_AM_ET);
    expect(h.slot.seedTrend(seedBars(TEN_AM_ET))).toBe(122);
    expect(h.signals).toHaveLength(0);
    expect(h.slot.getView().martingale?.ma5Up).toBe(true);
    // 진행 중 1분봉(시드 종가 ~218): 크게 반등해 5선 위 — 실시간 판정이 그 자리에서 BUY를 낸다(2026-09-01).
    h.slot.pushTick(230, TEN_AM_ET + 10_000);
    const entry = h.signals.filter((s) => s.ctx.kind === 'entry');
    expect(entry).toHaveLength(1);
    expect(entry[0].signal).toBe('BUY');
    expect(entry[0].ctx.price).toBe(230);
    expect(entry[0].ctx.entryEvent).toBe('cross');
    expect(h.slot.getView().martingaleLive?.entry).toBe(true);
    // 봉이 닫혀도 같은 봉의 확정 신호는 다시 내지 않는다 — 봉당 1회(보유 중 물타기 중복 방지, ADR 0010).
    h.slot.pushTick(231, TEN_AM_ET + M + 1_000);
    expect(h.signals.filter((s) => s.ctx.kind === 'entry')).toHaveLength(1);
    // 신호 종류는 entry 하나 — 보유 중 물타기 여부는 오토파일럿·규칙이 가른다.
    expect(h.signals.every((s) => s.ctx.kind === 'entry')).toBe(true);
    expect(h.slot.getView().martingale?.entry).toBe(true);
  });

  it('같은 진행 봉에서는 실시간 BUY를 한 번만 낸다(1초 스로틀 뒤 재판정에도 재발화 없음)', () => {
    const h = harness(TEN_AM_ET);
    h.slot.seedTrend(seedBars(TEN_AM_ET));
    h.slot.pushTick(230, TEN_AM_ET + 10_000);
    h.clock.advance(2_000); // 스로틀(1초)을 확실히 넘긴다
    h.slot.pushTick(232, TEN_AM_ET + 12_000);
    h.clock.advance(2_000);
    h.slot.pushTick(234, TEN_AM_ET + 14_000);
    expect(h.signals.filter((s) => s.ctx.kind === 'entry')).toHaveLength(1);
  });

  it('프리마켓 봉에서도 진입 신호를 낸다(프리·정규·애프터, 2026-09-01)', () => {
    const h = harness(FIVE_AM_ET);
    h.slot.seedTrend(seedBars(FIVE_AM_ET));
    h.slot.pushTick(230, FIVE_AM_ET + 10_000); // 실시간 1회
    h.slot.pushTick(231, FIVE_AM_ET + M + 1_000); // 마감 — 같은 봉이라 추가 신호 없음
    expect(h.slot.getView().martingale?.entry).toBe(true);
    expect(h.signals.filter((s) => s.ctx.kind === 'entry')).toHaveLength(1);
  });

  it('하락 추세(20·60·120선 아래)여도 5선이 오르며 종가가 5선을 뚫으면 신호가 난다 — 정배열·4선 상승 조건 폐기(ADR 0010)', () => {
    const h = harness(TEN_AM_ET);
    const endKey = Math.floor(TEN_AM_ET / M);
    // 200 → 79로 꾸준히 내려온 122봉: 5선도 하락 중, 종가는 5선 아래.
    h.slot.seedTrend(Array.from({ length: 122 }, (_, i) => ({ minuteKey: endKey - 122 + i, close: 200 - i })));
    expect(h.slot.getView().martingale?.ma5Up).toBe(false);
    h.slot.pushTick(95, TEN_AM_ET + 10_000); // 진행 중 봉 95: 5선(≈81→84) 위로 돌파 + 5선 상승 → 실시간 BUY
    const entries = h.signals.filter((s) => s.ctx.kind === 'entry');
    expect(entries).toHaveLength(1);
    expect(entries[0].ctx.entryEvent).toBe('cross');
  });

  it('5선이 내려가는 중의 돌파는 신호가 아니다(5선 상승 조건)', () => {
    const h = harness(TEN_AM_ET);
    const endKey = Math.floor(TEN_AM_ET / M);
    // 완만한 하락 뒤 마지막 봉만 살짝 반등: 종가는 5선 위지만 5선 자체는 아직 하락.
    const closes = Array.from({ length: 122 }, (_, i) => 200 - i * 0.5);
    h.slot.seedTrend(closes.map((close, i) => ({ minuteKey: endKey - 122 + i, close })));
    h.slot.pushTick(closes[121] + 0.6, TEN_AM_ET + 10_000); // 5선(≈140.5)보다 살짝 위, 5선은 여전히 하락
    const live = h.slot.getView().martingaleLive;
    expect(live?.ma5Up).toBe(false);
    expect(live?.entry).toBe(false);
    expect(h.signals).toHaveLength(0);
  });

  it('주간거래(ET 20:00~04:00) 봉에서는 조건이 맞아도 진입 신호를 내지 않는다(2026-09-01)', () => {
    const overnight = Date.UTC(2026, 7, 28, 2, 0); // 2026-08-27 22:00 ET — 주간거래
    const h = harness(overnight);
    h.slot.seedTrend(seedBars(overnight));
    h.slot.pushTick(230, overnight + 10_000);
    h.slot.pushTick(231, overnight + M + 1_000);
    expect(h.slot.getView().martingale?.entry).toBe(true); // 판정은 되지만
    expect(h.signals).toHaveLength(0); // 신호는 없다
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

describe('FeedSlot 5선 물타기 단타 모드 — 신호는 돌파 봉에서만', () => {
  it('돌파 봉은 entryEvent=cross 1회(실시간), 마감·이어지는 다음 봉은 신호 없음', () => {
    const h = harness(TEN_AM_ET);
    h.slot.seedTrend(seedBars(TEN_AM_ET));
    h.slot.pushTick(230, TEN_AM_ET + 10_000); // 진행 중 돌파 — 실시간 cross
    h.slot.pushTick(231, TEN_AM_ET + M + 1_000); // 돌파 봉 닫힘 — 같은 봉이라 재발화 없음
    h.slot.pushTick(232, TEN_AM_ET + 2 * M + 1_000); // 상승 지속 봉 닫힘 — 돌파가 아니라 조용하다
    const entries = h.signals.filter((s) => s.ctx.kind === 'entry').map((s) => s.ctx.entryEvent);
    expect(entries).toEqual(['cross']);
  });

  it('봉 중간 틱이 없어 실시간 판정이 못 돈 봉은 마감에서 신호를 낸다(실시간 경로의 보완)', () => {
    const h = harness(TEN_AM_ET);
    h.slot.seedTrend(seedBars(TEN_AM_ET));
    h.slot.pushTick(216, TEN_AM_ET); // 진행 중 봉 216 — 5선 아래, 신호 없음
    // 다음 분 첫 틱은 "직전 봉(216) 마감" 판정만 돌고 새 진행 봉(230)의 실시간 판정은 두 번째 틱부터다.
    // 230 봉엔 틱이 이것 하나뿐이라 실시간이 못 돌았고, 그다음 분 첫 틱에서 닫히며 마감 신호가 난다(가격은 그 첫 틱 232).
    h.slot.pushTick(230, TEN_AM_ET + M);
    expect(h.signals).toHaveLength(0);
    h.slot.pushTick(232, TEN_AM_ET + 2 * M); // 230 봉 닫힘 → 마감 신호(돌파: 216 < ma5, 230 > ma5, 5선 상승)
    const entries = h.signals.filter((s) => s.ctx.kind === 'entry');
    expect(entries).toHaveLength(1);
    expect(entries[0].ctx.price).toBe(232);
  });
});
