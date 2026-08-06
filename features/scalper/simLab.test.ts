import { describe, expect, it } from 'vitest';

import {
  buildSimMatrix,
  DEFAULT_MAX_EPISODES,
  kstDateOf,
  kstTimeOf,
  sessionOf,
  SimLab,
  type SimEpisodeRecord,
} from './simLab';
import { fakeClock } from './fakes';

function makeLab(opts: { matrix?: Parameters<typeof SimLab.prototype.onEntry>[3] extends never ? never : { widthPct: number; buyMultiplier: number; isPrimary?: boolean }[]; maxEpisodes?: number } = {}) {
  const clock = fakeClock(1_700_000_000_000);
  const records: SimEpisodeRecord[] = [];
  const holds: string[] = [];
  const releases: string[] = [];
  const lab = new SimLab({
    clock,
    matrix: opts.matrix ?? [{ widthPct: 10, buyMultiplier: 1, isPrimary: true }],
    onRecord: (r) => records.push(r),
    hold: (t) => holds.push(t),
    release: (t) => releases.push(t),
    maxEpisodes: opts.maxEpisodes,
  });
  return { lab, clock, records, holds, releases };
}

describe('buildSimMatrix', () => {
  it('기본 20조합 + 사용자 조합이 축 위에 있으면 그 행이 primary가 된다', () => {
    const m = buildSimMatrix({ widthPct: 10, buyMultiplier: 1 });
    expect(m).toHaveLength(20);
    expect(m.filter((c) => c.isPrimary)).toEqual([{ widthPct: 10, buyMultiplier: 1, isPrimary: true }]);
  });

  it('사용자 조합이 축 밖이면 21번째로 추가된다 — 실전 대응 행은 반드시 존재', () => {
    const m = buildSimMatrix({ widthPct: 4, buyMultiplier: 1.5 });
    expect(m).toHaveLength(21);
    expect(m.at(-1)).toEqual({ widthPct: 4, buyMultiplier: 1.5, isPrimary: true });
  });
});

describe('SimLab — 에피소드 수명주기', () => {
  it('탈출(escaped) — +w를 한 틱 넘겨야 체결, 지표(MAE·기간)가 기록된다', () => {
    const { lab, clock, records, holds, releases } = makeLab();
    lab.onEntry('A', 10, 100, { mode: 'sim', tickRate: 2.5 });
    expect(holds).toEqual(['A']);

    clock.advance(60_000);
    lab.onTick('A', 95, clock.now()); // 역행 — minPrice 갱신, −10%(90)는 안 뚫림.
    lab.onTick('A', 110, clock.now()); // +10% 정확히 닿음 — 미체결.
    expect(records).toHaveLength(0);

    clock.advance(60_000);
    lab.onTick('A', 110.01, clock.now()); // 뚫림 — 탈출.
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      mode: 'sim',
      ticker: 'A',
      entry_price: 100,
      exit_price: 110, // 체결가 = 지정가.
      min_price: 95,
      mae_pct: 5,
      max_qty: 10,
      max_invested_usd: 1000,
      rebuy_count: 0,
      width_pct: 10,
      buy_multiplier: 1,
      is_primary: true,
      escaped: true,
      exit_reason: 'escaped',
      tick_rate_at_entry: 2.5,
      duration_s: 120,
    });
    expect(releases).toEqual(['A']); // 전 전략 종료 — 에피소드 해제.
    expect(lab.activeTickers).toEqual([]);
  });

  it('물타기 — −w를 뚫으면 배율만큼 사서 평단이 내려오고 다리가 재계산된다', () => {
    const { lab, clock, records } = makeLab();
    lab.onEntry('A', 10, 100, { mode: 'sim' });
    lab.onTick('A', 89.9, clock.now()); // −10%(90) 뚫림 — 10주 @90 물타기 → 20주 평단 95.
    expect(records).toHaveLength(0);

    // 새 매도가 = 95×1.1 = 104.5 — 104.5는 미체결, 104.51에 탈출.
    lab.onTick('A', 104.5, clock.now());
    expect(records).toHaveLength(0);
    lab.onTick('A', 104.51, clock.now());
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      exit_price: 104.5,
      rebuy_count: 1,
      max_qty: 20,
      max_invested_usd: 100 * 10 + 90 * 10, // 1900 — 무한 현금 기준 최대 투입.
      escaped: true,
    });
  });

  it('전략마다 독립 — 좁은 폭은 탈출하고 넓은 폭은 남는다', () => {
    const { lab, clock, records } = makeLab({
      matrix: [
        { widthPct: 2, buyMultiplier: 1 },
        { widthPct: 10, buyMultiplier: 1, isPrimary: true },
      ],
    });
    lab.onEntry('A', 10, 100, { mode: 'live' });
    lab.onTick('A', 102.1, clock.now()); // +2%(102) 뚫림 — 좁은 폭만 탈출.
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ width_pct: 2, escaped: true, mode: 'live' });
    expect(lab.activeTickers).toEqual(['A']); // 10% 전략이 아직 보유 중.

    lab.closeEpisode('A', 'stopped');
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({ width_pct: 10, escaped: false, exit_reason: 'stopped', exit_price: 102.1 });
  });

  it('closeEpisode — 미탈출 전략을 마지막 틱 가격으로 기록한다(미탈출 데이터 보존)', () => {
    const { lab, clock, records, releases } = makeLab();
    lab.onEntry('A', 10, 100, { mode: 'sim' });
    clock.advance(30_000);
    lab.onTick('A', 93, clock.now());

    lab.closeEpisode('A', 'data_lost');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      escaped: false,
      exit_reason: 'data_lost',
      exit_price: 93,
      min_price: 93,
      mae_pct: 7,
      duration_s: 30,
    });
    expect(releases).toEqual(['A']);
  });

  it('같은 티커 재진입 — 옛 에피소드를 stopped로 마감하고 새로 연다', () => {
    const { lab, clock, records } = makeLab();
    lab.onEntry('A', 10, 100, { mode: 'sim' });
    lab.onTick('A', 99, clock.now());
    lab.onEntry('A', 5, 99, { mode: 'sim' });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ exit_reason: 'stopped', entry_price: 100 });
    expect(lab.activeTickers).toEqual(['A']);
  });

  it('에피소드 상한 초과 — 가장 오래된 것을 evicted로 마감한다(WS 예산 보호)', () => {
    const { lab, records, releases } = makeLab({ maxEpisodes: 2 });
    lab.onEntry('A', 1, 100, { mode: 'sim' });
    lab.onEntry('B', 1, 100, { mode: 'sim' });
    lab.onEntry('C', 1, 100, { mode: 'sim' });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ ticker: 'A', exit_reason: 'evicted' });
    expect(lab.activeTickers).toEqual(['B', 'C']);
    expect(releases).toEqual(['A']);
    expect(DEFAULT_MAX_EPISODES).toBe(8);
  });
});

describe('SimLab — entry_session 라벨', () => {
  it('주간거래 창(KST 10~16시)에 진입하면 정규장 4종이 아니라 daytime으로 기록된다', () => {
    const { lab, clock, records } = makeLab();
    clock.set(Date.UTC(2026, 7, 6, 2, 0)); // 2026-08-06 11:00 KST — 주간거래 창 안.
    lab.onEntry('A', 10, 100, { mode: 'sim' });
    lab.onTick('A', 110.01, clock.now()); // 탈출 — 기록 확정.
    expect(records[0]).toMatchObject({ entry_session: 'daytime' });
  });

  it('주간거래 창 밖에서는 기존처럼 sessionOf(ET 기준) 라벨을 쓴다', () => {
    const { lab, clock, records } = makeLab();
    clock.set(Date.UTC(2026, 7, 6, 14, 0)); // 정규장(regular) — 기존 sessionOf 테스트와 동일 시각.
    lab.onEntry('A', 10, 100, { mode: 'sim' });
    lab.onTick('A', 110.01, clock.now());
    expect(records[0]).toMatchObject({ entry_session: 'regular' });
  });
});

describe('시각/세션 헬퍼 — KST 기록(사용자 확정)', () => {
  it('kstDateOf/kstTimeOf — UTC를 한국시간으로 변환한다', () => {
    const utc = Date.UTC(2026, 7, 6, 16, 30, 15); // 2026-08-06 16:30:15 UTC = KST 다음날 01:30:15.
    expect(kstDateOf(utc)).toBe('2026-08-07');
    expect(kstTimeOf(utc)).toBe('2026-08-07 01:30:15');
  });

  it('sessionOf — 미국장 세션 판정(서머타임 반영), 라벨만 반환한다', () => {
    // 2026-08-06은 EDT(UTC-4): 정규장 09:30–16:00 ET = 13:30–20:00 UTC.
    expect(sessionOf(Date.UTC(2026, 7, 6, 14, 0))).toBe('regular');
    expect(sessionOf(Date.UTC(2026, 7, 6, 12, 0))).toBe('pre'); // 08:00 ET
    expect(sessionOf(Date.UTC(2026, 7, 6, 21, 0))).toBe('after'); // 17:00 ET
    expect(sessionOf(Date.UTC(2026, 7, 6, 6, 0))).toBe('off'); // 02:00 ET
    // 겨울(EST, UTC-5): 14:00 UTC = 09:00 ET → 프리마켓.
    expect(sessionOf(Date.UTC(2026, 0, 15, 14, 0))).toBe('pre');
  });
});
