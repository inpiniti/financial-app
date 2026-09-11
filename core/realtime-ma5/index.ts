// core/realtime-ma5 — 실시간 MA5 단타 전략 (2026-09-10).
//
// 기존 5선 돌파(martingale)와의 핵심 차이:
//  · 분봉 OHLC: 시가는 봉 시작 시점에 고정, 고가/저가는 매 틱 갱신, 종가는 현재가.
//  · MA5 실시간 = (직전 확정 분봉 4개 종가 + 현재틱) / 5.
//  · 기울기: 현재틱 > 5개전 확정분봉 종가 → 상승 (중간 4봉은 상쇄).
//  · 돌파: 이전틱 < MA5_realtime < 현재틱 → 상향 돌파.
//  · 진입: 기울기 상승 ∧ 돌파 → 설정 수량 매수 + 평단×1.03 매도 주문 즉시 선등록.
//  · 물타기: gapRate ≤ -3% ∧ 기울기 상승 ∧ 돌파 → 보유량×(|gapRate|-1) 추가 매수 + 매도 주문 수정.
//  · 자본 한도: 가용자본/현재가 캡핑.
//
// 순수 TS, 의존 0.

// ---------------------------------------------------------------------------
// 실시간 1분봉 OHLC 관리
// ---------------------------------------------------------------------------

export interface RealtimeCandle {
  /** 분 키 = epoch 분(floor(epochMs / 60000)). */
  minuteKey: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * 실시간 1분봉 빌더 — 매 틱마다 미완성 봉의 OHLC를 갱신한다.
 *  · 시가는 봉 시작 시점(첫 틱)에 고정.
 *  · 고가/저가는 매 틱마다 갱신.
 *  · 종가는 항상 현재 틱 가격.
 *  · 00초(분 경계) 도달 시 확정(fire) 후 새 봉 시작.
 */
export class RealtimeCandleBuilder {
  private current: RealtimeCandle | null = null;
  /** 확정된 봉 이력 (오름차순, 최대 ringSize). */
  private ring: RealtimeCandle[] = [];
  private readonly ringSize: number;

  constructor(ringSize = 130) {
    this.ringSize = ringSize;
  }

  /** 확정된 봉 종가 배열 (오름차순). */
  get closes(): readonly number[] {
    return this.ring.map((b) => b.close);
  }

  /** 확정된 봉 수. */
  get size(): number {
    return this.ring.length;
  }

  /** 진행 중(미완성) 봉 — 없으면 null. */
  get inProgress(): RealtimeCandle | null {
    return this.current === null ? null : { ...this.current };
  }

  /** 마지막 확정 봉의 분 키 — 없으면 null. */
  get lastClosedKey(): number | null {
    return this.ring.length > 0 ? this.ring[this.ring.length - 1].minuteKey : null;
  }

  /**
   * 틱 1개 반영. 새 분이면 이전 봉을 확정하고 새 봉을 연다.
   * 같은 분이면 OHLC를 갱신한다.
   * 반환값: 확정된 봉(새 분 시작 시에만). null이면 진행 중.
   */
  pushTick(price: number, tsMs: number): RealtimeCandle | null {
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(tsMs)) return null;
    const key = Math.floor(tsMs / 60_000);

    if (this.current === null) {
      this.current = { minuteKey: key, open: price, high: price, low: price, close: price };
      return null;
    }

    if (key === this.current.minuteKey) {
      // 같은 분 — OHLC 갱신
      this.current.high = Math.max(this.current.high, price);
      this.current.low = Math.min(this.current.low, price);
      this.current.close = price;
      return null;
    }

    if (key < this.current.minuteKey) return null; // 과거 틱 무시

    // 새 분 시작 — 이전 봉 확정
    const closed = { ...this.current };
    this.append(closed);
    this.current = { minuteKey: key, open: price, high: price, low: price, close: price };
    return closed;
  }

  /**
   * REST 워밍업 시드 — 확정된 봉 목록을 받아 링을 채운다.
   * seed 마지막 키 이하의 라이브 봉은 폐기. 반영된 봉 수를 돌려준다.
   */
  seed(bars: readonly { minuteKey: number; close: number }[]): number {
    const sorted = bars
      .filter((b) => Number.isFinite(b.minuteKey) && Number.isFinite(b.close) && b.close > 0)
      .sort((a, b) => a.minuteKey - b.minuteKey);
    const dedup: { minuteKey: number; close: number }[] = [];
    for (const b of sorted) {
      if (dedup.length > 0 && dedup[dedup.length - 1].minuteKey === b.minuteKey) dedup[dedup.length - 1] = b;
      else dedup.push({ ...b });
    }
    if (dedup.length === 0) return 0;
    const lastKey = dedup[dedup.length - 1].minuteKey;
    const survivors = this.ring.filter((b) => b.minuteKey > lastKey);
    this.ring = [];
    for (const b of dedup) this.append({ minuteKey: b.minuteKey, open: b.close, high: b.close, low: b.close, close: b.close });
    for (const b of survivors) this.append(b);
    if (this.current !== null && this.current.minuteKey <= lastKey) this.current = null;
    return dedup.length;
  }

  private append(bar: RealtimeCandle): void {
    this.ring.push(bar);
    if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize);
  }
}

// ---------------------------------------------------------------------------
// MA5 실시간 계산
// ---------------------------------------------------------------------------

export interface RealtimeMa5State {
  /** MA5 실시간 값 = (직전 확정 4봉 종가 + 현재틱) / 5. 계산 불가면 null. */
  ma5: number | null;
  /** 기울기: 현재틱 > 5개전 확정분봉 종가 → 'up', < → 'down', 비교 불가 → null. */
  slope: 'up' | 'down' | null;
  /** 상향 돌파: 이전틱 < 현재 MA5 < 현재틱. */
  breakout: boolean;
  /** 5개전 확정분봉 종가. 없으면 null. */
  refClose5: number | null;
}

/**
 * 실시간 MA5 계산기 — 확정 봉 4개 + 현재 틱으로 MA5를 계산한다.
 *
 * MA5_realtime = (closes[n-4] + closes[n-3] + closes[n-2] + closes[n-1] + currentTick) / 5
 *
 * 기울기: currentTick > closes[n-5] (5개전 종가) → up, down.
 * 돌파: prevTick < ma5Realtime(currentTick) < currentTick → true.
 */
export class RealtimeMa5Calculator {
  private prevTick: number | null = null;

  /**
   * 현재 틱으로 MA5·기울기·돌파를 계산한다.
   * confirmedCloses = 확정된 봉 종가 배열 (오름차순, 최소 5개 이상 권장).
   * currentTick = 현재 틱 가격.
   */
  evaluate(confirmedCloses: readonly number[], currentTick: number): RealtimeMa5State {
    const n = confirmedCloses.length;

    // MA5 = (최근 4 확정 종가 + 현재틱) / 5
    let ma5: number | null = null;
    if (n >= 4) {
      const sum4 = confirmedCloses[n - 4] + confirmedCloses[n - 3] + confirmedCloses[n - 2] + confirmedCloses[n - 1];
      ma5 = (sum4 + currentTick) / 5;
    }

    // 기울기: 현재틱 vs 5개전 확정분봉 종가
    let slope: 'up' | 'down' | null = null;
    let refClose5: number | null = null;
    if (n >= 5) {
      refClose5 = confirmedCloses[n - 5];
      slope = currentTick > refClose5 ? 'up' : currentTick < refClose5 ? 'down' : null;
    }

    // 돌파: 이전틱 < 현재 MA5 < 현재틱
    let breakout = false;
    if (this.prevTick !== null && ma5 !== null) {
      breakout = this.prevTick < ma5 && currentTick > ma5;
    }

    this.prevTick = currentTick;

    return { ma5, slope, breakout, refClose5 };
  }

  reset(): void {
    this.prevTick = null;
  }
}

// ---------------------------------------------------------------------------
// 진입·물타기 조건
// ---------------------------------------------------------------------------

export interface RealtimeMa5Config {
  /**
   * 매수 수량(주) — 진입 시 고정 수량. 미설정(0)이면 startAmountUsd/현재가로 계산.
   */
  orderQty: number;
  /**
   * 익절 목표 배율 — 평단 × 이 배율에 매도 주문을 건다. 기본 1.03 (+3%).
   */
  sellTargetMultiplier: number;
  /**
   * 물타기 낙폭 문턱(%) — gapRate ≤ 이 값일 때 물타기. 기본 -3.
   */
  averagingDownThresholdPct: number;
  /**
   * 종목당 진입금액(USD) — orderQty가 0일 때 쓰는 금액 기반 수량 계산.
   */
  startAmountUsd: number;
}

/** 추가진입은 평단 대비 -3% 조건으로 고정한다. */
export const REALTIME_MA5_AVERAGING_DOWN_THRESHOLD_PCT = -3;

export const DEFAULT_REALTIME_MA5_CONFIG: RealtimeMa5Config = {
  orderQty: 1,
  sellTargetMultiplier: 1.03,
  averagingDownThresholdPct: REALTIME_MA5_AVERAGING_DOWN_THRESHOLD_PCT,
  startAmountUsd: 100,
};

/**
 * 진입 조건 판정 — 기울기 상승 ∧ 돌파.
 */
export function shouldEnter(state: RealtimeMa5State): boolean {
  return state.slope === 'up' && state.breakout;
}

/**
 * 물타기 조건 판정.
 * gapRate = (현재가 - 평단가) / 평단가 × 100.
 * 조건: gapRate ≤ thresholdPct AND 기울기 상승 AND 돌파.
 */
export function shouldAverageDown(
  currentPrice: number,
  avgPrice: number,
  state: RealtimeMa5State,
  thresholdPct: number = DEFAULT_REALTIME_MA5_CONFIG.averagingDownThresholdPct,
): boolean {
  if (avgPrice <= 0 || currentPrice <= 0) return false;
  const gapRate = ((currentPrice - avgPrice) / avgPrice) * 100;
  return gapRate <= thresholdPct && state.slope === 'up' && state.breakout;
}

/**
 * 물타기 매수 수량 계산.
 * gapRate = (현재가 - 평단가) / 평단가 × 100.
 * 희망매수량 = (|gapRate| - 1) × 보유수량.
 * 가능최대수량 = 가용자본 / 현재가.
 * 실제매수량 = min(희망매수량, 가능최대수량).
 */
export function averagingDownQty(
  currentPrice: number,
  avgPrice: number,
  holdingQty: number,
  availableCash: number,
): number {
  if (currentPrice <= 0 || avgPrice <= 0 || holdingQty <= 0 || availableCash <= 0) return 0;
  const gapRate = Math.abs(((currentPrice - avgPrice) / avgPrice) * 100);
  const desiredQty = Math.floor((gapRate - 1) * holdingQty);
  if (desiredQty < 1) return 0;
  const maxQty = Math.floor(availableCash / currentPrice);
  if (maxQty < 1) return 0;
  return Math.min(desiredQty, maxQty);
}

/**
 * 진입 매수 수량 계산.
 * orderQty > 0이면 고정 수량, 아니면 startAmountUsd / currentPrice.
 * 가능최대수량 = 가용자본 / 현재가로 캡핑.
 */
export function entryQty(
  currentPrice: number,
  config: RealtimeMa5Config,
  availableCash: number,
): number {
  if (currentPrice <= 0 || availableCash <= 0) return 0;
  const desired = config.orderQty > 0 ? config.orderQty : Math.floor(config.startAmountUsd / currentPrice);
  const maxQty = Math.floor(availableCash / currentPrice);
  return Math.min(desired, maxQty);
}

/**
 * 매도 목표가 = 평단가 × sellTargetMultiplier.
 */
export function sellTargetPrice(avgPrice: number, multiplier: number = 1.03): number {
  return avgPrice * multiplier;
}
