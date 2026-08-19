// 분봉 로컬 합성 — WS 체결가 틱을 분 버킷(기본 3분, TREND_BAR_MINUTES)으로 잘라 종가 링을 유지한다(추세 4선의 입력).
// 2026-08-19: 첫날 42건 분석(docs/분석/2026-08-19_추세-첫날-42건-분석.md) — 1분봉은 거래 수×슬리피지(실측 0.65%/진입)에
// 구조적으로 진다(재현 −98%). 3분봉은 거래 1/3·건당 이익 4배라 봉 주기를 3분으로 올렸다. 봉 키는 여전히 "epoch 분"이고
// 봉 시작 분(barMinutes의 배수)으로 정규화한다 — 토스 min:3 봉의 dt(봉 시작)와 같은 버킷(ET·KST 오프셋이 3의 배수라 정렬 일치).
// 도메인 문서: docs/domain/추세/2026-08-18_추세-그리드-매매-조합-plan.md
//
//  · 분 키 = floor(tsMs / 60000). 봉 마감 = 다음 분(더 큰 키)의 첫 틱 도착 시 — 타이머 없음(틱 주도).
//  · 틱 없는 분은 봉이 없다(KIS 분봉 차트와 동일 — 빈 분을 채워 넣지 않는다).
//  · seed(REST 분봉조회 워밍업)는 "seed 마지막 키 이하"의 라이브 봉·진행 중 버킷을 전부 버린다 —
//    같은 분 중복과 seed 도착 전 WS로 만든 봉의 정합을 규칙 하나로 처리한다.
// 순수 TS, 의존 0.

export interface MinuteBar {
  /** 분 키 = epoch 분(floor(epochMs / 60000)). */
  minuteKey: number;
  close: number;
}

/** ma120 2봉 판정에 122봉이 필요하다 — 여유를 둔 링 상한. */
export const MINUTE_BAR_RING_SIZE = 130;

/** 추세 봉 주기(분) — 신호·시드·봉 빌더가 같은 값을 읽는다. 1로 두면 1분봉(옛 동작)으로 한 줄 롤백. */
export const TREND_BAR_MINUTES = 3;

/** epoch ms → 봉 키(봉 시작 epoch 분, barMinutes의 배수). */
export function barKeyOf(tsMs: number, barMinutes: number): number {
  const m = Math.max(1, Math.floor(barMinutes));
  return Math.floor(tsMs / (60_000 * m)) * m;
}

/** KST(UTC+9, DST 없음) 일자·시각 문자열(YYYYMMDD, HHMMSS) → 분 키. 파싱 실패면 null. */
export function kstToMinuteKey(kymd: string, khms: string): number | null {
  if (!/^\d{8}$/.test(kymd) || !/^\d{6}$/.test(khms)) return null;
  const y = Number(kymd.slice(0, 4));
  const m = Number(kymd.slice(4, 6));
  const d = Number(kymd.slice(6, 8));
  const h = Number(khms.slice(0, 2));
  const mi = Number(khms.slice(2, 4));
  const ms = Date.UTC(y, m - 1, d, h - 9, mi, 0);
  return Number.isFinite(ms) ? Math.floor(ms / 60_000) : null;
}

export function minuteKeyOf(tsMs: number): number {
  return Math.floor(tsMs / 60_000);
}

export class MinuteBarBuilder {
  private readonly ringSize: number;
  /** 봉 주기(분). */
  readonly barMinutes: number;
  /** 닫힌 봉(오름차순). 길이는 ringSize 이하. */
  private ring: MinuteBar[] = [];
  /** 진행 중 버킷 — 아직 닫히지 않은 현재 분. */
  private current: MinuteBar | null = null;

  constructor(ringSize: number = MINUTE_BAR_RING_SIZE, barMinutes = 1) {
    this.ringSize = ringSize;
    this.barMinutes = Math.max(1, Math.floor(barMinutes));
  }

  /** 닫힌 봉 종가(오름차순). */
  get closes(): readonly number[] {
    return this.ring.map((b) => b.close);
  }

  /** 닫힌 봉 수. */
  get size(): number {
    return this.ring.length;
  }

  /** 마지막으로 닫힌 봉의 분 키(없으면 null). */
  get lastClosedKey(): number | null {
    return this.ring.length > 0 ? this.ring[this.ring.length - 1].minuteKey : null;
  }

  /** 진행 중 버킷(뷰용) — 없으면 null. */
  get inProgress(): MinuteBar | null {
    return this.current === null ? null : { ...this.current };
  }

  /**
   * 틱 1개 반영. 분 키가 진행 중 버킷보다 크면 그 버킷을 닫아 반환하고 새 버킷을 연다.
   * 같은 분이면 종가만 갱신(반환 null). 진행 중 버킷보다 과거 키(시계 역행)는 무시한다.
   */
  pushTick(price: number, tsMs: number): MinuteBar | null {
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(tsMs)) return null;
    const key = barKeyOf(tsMs, this.barMinutes);
    if (this.current === null) {
      // 닫힌 봉보다 과거 키는 버린다(seed 직후 늦게 도착한 옛 틱).
      if (this.lastClosedKey !== null && key <= this.lastClosedKey) return null;
      this.current = { minuteKey: key, close: price };
      return null;
    }
    if (key === this.current.minuteKey) {
      this.current.close = price;
      return null;
    }
    if (key < this.current.minuteKey) return null;
    const closed = this.current;
    this.append(closed);
    this.current = { minuteKey: key, close: price };
    return { ...closed };
  }

  /**
   * REST 워밍업 시드. 오름차순으로 정렬해 링을 채우고, seed 마지막 키 이하의 라이브 봉·진행 중
   * 버킷은 폐기한다. seed 마지막 키보다 큰 라이브 봉만 뒤에 살아남는다. 반영된 seed 봉 수를 돌려준다.
   */
  seed(bars: readonly MinuteBar[]): number {
    // 봉 키를 이 빌더의 버킷(봉 시작 분)으로 정규화한다 — 1분 키로 온 seed도 barMinutes 버킷에 맞춘다.
    const sorted = bars
      .filter((b) => Number.isFinite(b.minuteKey) && Number.isFinite(b.close) && b.close > 0)
      .map((b) => ({ minuteKey: Math.floor(b.minuteKey / this.barMinutes) * this.barMinutes, close: b.close }))
      .sort((a, b) => a.minuteKey - b.minuteKey);
    // 같은 키가 여러 개면 마지막 것만.
    const dedup: MinuteBar[] = [];
    for (const b of sorted) {
      if (dedup.length > 0 && dedup[dedup.length - 1].minuteKey === b.minuteKey) dedup[dedup.length - 1] = b;
      else dedup.push({ ...b });
    }
    if (dedup.length === 0) return 0;
    const lastKey = dedup[dedup.length - 1].minuteKey;
    const survivors = this.ring.filter((b) => b.minuteKey > lastKey);
    this.ring = [];
    for (const b of dedup) this.append(b);
    for (const b of survivors) this.append(b);
    if (this.current !== null && this.current.minuteKey <= lastKey) this.current = null;
    return dedup.length;
  }

  private append(bar: MinuteBar): void {
    this.ring.push(bar);
    if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize);
  }
}
