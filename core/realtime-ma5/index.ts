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
// ---------------------------------------------------------------------------
// 실시간 볼린저 밴드 및 MA5 실시간 계산
// ---------------------------------------------------------------------------

export interface RealtimeBbResult {
  /** 실시간 1분봉 20선 볼린저 하단선 (20분봉 2σ). 계산 불가면 null. */
  lowerBb: number | null;
  /** 실시간 1분봉 20선 볼린저 중심선 (MA20). 계산 불가면 null. */
  ma20: number | null;
  /** 실시간 1분봉 20선 볼린저 상단선 (20분봉 2σ). 계산 불가면 null. */
  upperBb: number | null;
}

/**
 * 실시간 1분봉 20선 볼린저 밴드(20분봉, 2.0σ) 계산.
 * 직전 확정 (period - 1)개 분봉 종가 + 현재 틱 = 총 period개 표본으로
 * 중심선(MA20), 분산, 표준편차, 상/하단선을 매 틱 실시간으로 계산한다.
 */
export function calculateRealtimeBb(
  confirmedCloses: readonly number[],
  currentTick: number,
  period = 20,
  dev = 2.0,
): RealtimeBbResult {
  const n = confirmedCloses.length;
  if (n < period - 1 || !Number.isFinite(currentTick) || currentTick <= 0) {
    return { lowerBb: null, ma20: null, upperBb: null };
  }

  const startIdx = n - (period - 1);
  let sum = currentTick;
  for (let i = startIdx; i < n; i++) {
    sum += confirmedCloses[i];
  }
  const mean = sum / period;

  let sumSqDiff = Math.pow(currentTick - mean, 2);
  for (let i = startIdx; i < n; i++) {
    sumSqDiff += Math.pow(confirmedCloses[i] - mean, 2);
  }
  const variance = sumSqDiff / period;
  const std = Math.sqrt(variance);

  return {
    lowerBb: mean - dev * std,
    ma20: mean,
    upperBb: mean + dev * std,
  };
}

export interface RealtimeMa5State {
  /** MA5 실시간 값 = (직전 확정 4봉 종가 + 현재틱) / 5. 계산 불가면 null. */
  ma5: number | null;
  /** 기울기: 현재틱 > 5개전 확정분봉 종가 → 'up', < → 'down', 비교 불가 → null. */
  slope: 'up' | 'down' | null;
  /** 상향 돌파: 볼린저 하단선(lowerBb) 하단 3초 + 상단 3초 체류 충족 시 발화. */
  breakout: boolean;
  /** 5개전 확정분봉 종가. 없으면 null. */
  refClose5: number | null;
  /** 하단 체류 시간(ms). */
  belowDwellMs?: number | null;
  /** 상단 체류 시간(ms). */
  aboveDwellMs?: number | null;
  /** 하단 체류 충족 여부 (3초 완료). */
  belowDwellOk?: boolean;
  /** 상단 체류까지 충족하여 돌파 준비 완료 상태인가. */
  isArmed?: boolean;
  /** 실시간 1분봉 20선 볼린저 하단선(2σ). */
  lowerBb?: number | null;
  /** 실시간 1분봉 20선 볼린저 중심선(MA20). */
  ma20?: number | null;
  /** 실시간 1분봉 20선 볼린저 상단선(2σ). */
  upperBb?: number | null;
}

/** 하단/상단 최소 연속 체류 시간 기본값(3초 = 3,000ms). */
export const DEFAULT_MA5_DWELL_MS = 3_000;

/** 이탈 취소 디바운스 버퍼 기본값(1초 = 1,000ms). 1초 미만의 일시적 잔파동(noise)은 취소하지 않고 무시한다. */
export const DEFAULT_CANCEL_DEBOUNCE_MS = 1_000;

/**
 * 실시간 전략 계산기 — 확정 봉들과 현재 틱으로 실시간 MA5, 실시간 볼린저 밴드(Realtime BB)를 계산하고,
 * 하단 3초 체류 + 상단 3초 체류(1초 디바운스 버퍼)를 모두 통과한 상향 돌파를 판정한다.
 */
export class RealtimeMa5Calculator {
  private prevTick: number | null = null;
  private liveTickCount = 0;
  private belowStartMs: number | null = null;
  private aboveEscapeStartMs: number | null = null;
  private belowDwellOk = false;
  private aboveStartMs: number | null = null;
  private belowDipStartMs: number | null = null;
  private isArmed = false;
  private readonly minDwellMs: number;
  private readonly cancelDebounceMs: number;

  constructor(
    minDwellMs = DEFAULT_MA5_DWELL_MS,
    cancelDebounceMs = DEFAULT_CANCEL_DEBOUNCE_MS,
  ) {
    this.minDwellMs = minDwellMs;
    this.cancelDebounceMs = cancelDebounceMs;
  }

  /**
   * 현재 틱으로 MA5·실시간BB·기울기·돌파를 계산한다.
   * confirmedCloses = 확정된 봉 종가 배열 (오름차순, 최소 5개 이상 권장, 19개 이상 시 BB 계산 활성).
   * currentTick = 현재 틱 가격.
   * isLiveTick = 실제 수신된 라이브 틱 여부 (기본 true). 시드/프로브 조회 시 false로 전달하여 돌파 오판정 방지.
   * tsMs = 체결 시각(epoch ms). 미전달 시 Date.now() 사용.
   */
  evaluate(
    confirmedCloses: readonly number[],
    currentTick: number,
    isLiveTick = true,
    tsMs?: number,
  ): RealtimeMa5State {
    const n = confirmedCloses.length;
    const nowMs = tsMs ?? (typeof Date !== 'undefined' ? Date.now() : 0);

    // 1. 실시간 MA5 = (최근 4 확정 종가 + 현재틱) / 5
    let ma5: number | null = null;
    if (n >= 4) {
      const sum4 = confirmedCloses[n - 4] + confirmedCloses[n - 3] + confirmedCloses[n - 2] + confirmedCloses[n - 1];
      ma5 = (sum4 + currentTick) / 5;
    }

    // 2. 실시간 볼린저 밴드 (19개 확정 종가 + 현재 틱 = 20개 표본)
    const bb = calculateRealtimeBb(confirmedCloses, currentTick);
    const { lowerBb, ma20, upperBb } = bb;

    // 3. 기울기: 현재틱 vs 5개전 확정분봉 종가
    let slope: 'up' | 'down' | null = null;
    let refClose5: number | null = null;
    if (n >= 5) {
      refClose5 = confirmedCloses[n - 5];
      slope = currentTick > refClose5 ? 'up' : currentTick < refClose5 ? 'down' : null;
    }

    // 4. 돌파 판정 기준선: lowerBb 우선, 워밍업(19봉 미만) 시 ma5로 유연하게 fallback
    const baseline = lowerBb ?? ma5;

    let breakout = false;
    let belowDwellMs: number | null = null;
    let aboveDwellMs: number | null = null;

    if (isLiveTick) {
      this.liveTickCount++;

      if (baseline !== null) {
        if (this.minDwellMs === 0) {
          // minDwellMs = 0이면 지연 없이 즉시 교차 돌파 (테스트 및 하위 호환)
          if (this.prevTick !== null && this.liveTickCount >= 2 && this.prevTick <= baseline && currentTick > baseline) {
            breakout = true;
          }
        } else {
          // [1단계: 하단 체류 (3초) 판정]
          if (!this.belowDwellOk) {
            if (currentTick <= baseline) {
              // 하단 영역 체류
              this.aboveEscapeStartMs = null; // 상단 이탈 타이머 해제
              if (this.belowStartMs === null) {
                this.belowStartMs = nowMs;
              }
              const elapsed = Math.max(0, nowMs - this.belowStartMs);
              belowDwellMs = elapsed;
              if (elapsed >= this.minDwellMs) {
                this.belowDwellOk = true;
              }
            } else {
              // currentTick > baseline (상단으로 일시 벗어남)
              if (this.belowStartMs !== null) {
                if (this.aboveEscapeStartMs === null) {
                  this.aboveEscapeStartMs = nowMs;
                }
                const escapeTime = nowMs - this.aboveEscapeStartMs;
                if (escapeTime >= this.cancelDebounceMs) {
                  // 1초 이상 상단 머묾 -> 진짜 이탈로 보고 리셋
                  this.belowStartMs = null;
                  this.aboveEscapeStartMs = null;
                } else {
                  // 1초 미만 일시적 튐 -> 잔파동으로 무시하고 기존 하단 체류 시간 유지
                  belowDwellMs = Math.max(0, nowMs - this.belowStartMs);
                }
              }
            }
          }

          // [2단계: 상단 체류 (3초) 및 돌파 발화 판정]
          if (this.belowDwellOk) {
            if (currentTick > baseline) {
              // 상단 영역 체류
              this.belowDipStartMs = null; // 하단 침범 타이머 해제
              if (this.aboveStartMs === null) {
                this.aboveStartMs = nowMs;
              }
              const elapsed = Math.max(0, nowMs - this.aboveStartMs);
              aboveDwellMs = elapsed;
              if (elapsed >= this.minDwellMs) {
                this.isArmed = true;
              }
            } else {
              // currentTick <= baseline (하단으로 일시 밀림)
              if (this.aboveStartMs !== null) {
                if (this.belowDipStartMs === null) {
                  this.belowDipStartMs = nowMs;
                }
                const dipTime = nowMs - this.belowDipStartMs;
                if (dipTime >= this.cancelDebounceMs) {
                  // 1초 이상 하단 머묾 -> 상단 체류 취소 및 리셋
                  this.aboveStartMs = null;
                  this.belowDipStartMs = null;
                  this.isArmed = false;
                  // 하단에 1초 이상 머물렀으므로 다시 하단 체류로 전환
                  this.belowDwellOk = false;
                  this.belowStartMs = nowMs - this.cancelDebounceMs;
                  belowDwellMs = this.cancelDebounceMs;
                } else {
                  // 1초 미만 일시적 눌림 -> 잔파동으로 무시하고 기존 상단 체류 시간 유지
                  aboveDwellMs = Math.max(0, nowMs - this.aboveStartMs);
                }
              }
            }

            // [3단계: 돌파 발화]
            if (this.isArmed && this.liveTickCount >= 2) {
              breakout = true;
              // 1회 발화 후 상태 소진
              this.isArmed = false;
              this.belowDwellOk = false;
              this.belowStartMs = null;
              this.aboveStartMs = null;
              this.aboveEscapeStartMs = null;
              this.belowDipStartMs = null;
            }
          }
        }
      } else {
        this.reset();
      }

      this.prevTick = currentTick;
    }

    return {
      ma5,
      slope,
      breakout,
      refClose5,
      belowDwellMs,
      aboveDwellMs,
      belowDwellOk: this.belowDwellOk,
      isArmed: this.isArmed,
      lowerBb,
      ma20,
      upperBb,
    };
  }

  reset(): void {
    this.prevTick = null;
    this.liveTickCount = 0;
    this.belowStartMs = null;
    this.aboveEscapeStartMs = null;
    this.belowDwellOk = false;
    this.aboveStartMs = null;
    this.belowDipStartMs = null;
    this.isArmed = false;
  }
}

// ---------------------------------------------------------------------------
// 세션 판정 (미국 정규장 및 진입/추가진입 시간 창)
// ---------------------------------------------------------------------------

// 모듈 스코프에서 한 번만 생성 — getUsEtWeekdayAndMinutes는 매 틱 처리 경로에서 호출될 수 있으므로
// 매 호출마다 new Intl.DateTimeFormat(...)을 생성하면 GC 압박이 생긴다(perf §js-hoist-intl).
const NY_WEEKDAY_HOUR_MINUTE_DTF = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function getUsEtWeekdayAndMinutes(epochMs: number): { isWeekend: boolean; mins: number } | null {
  const parts = NY_WEEKDAY_HOUR_MINUTE_DTF.formatToParts(new Date(epochMs));
  const weekday = parts.find((p) => p.type === 'weekday')?.value;
  if (weekday === 'Sat' || weekday === 'Sun') return { isWeekend: true, mins: 0 };
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? NaN) % 24;
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? NaN);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return { isWeekend: false, mins: h * 60 + m };
}

/**
 * 미국 정규장(ET 09:30~16:00, 월~금) 여부
 */
export function isUsRegularSession(epochMs: number): boolean {
  const et = getUsEtWeekdayAndMinutes(epochMs);
  if (!et || et.isWeekend) return false;
  return et.mins >= 9 * 60 + 30 && et.mins < 16 * 60;
}

/**
 * 미국 주식 신규 진입 허용 여부:
 * 프리마켓 개장(ET 04:00)부터 정규장 마감(ET 16:00)까지만 신규 진입 허용.
 * ET 16:00~20:00(애프터마켓) 및 주간거래(ATS), 주말/공휴일은 신규 진입 차단.
 */
export function isUsInitialEntryAllowed(epochMs: number): boolean {
  const et = getUsEtWeekdayAndMinutes(epochMs);
  if (!et || et.isWeekend) return false;
  return et.mins >= 4 * 60 && et.mins < 16 * 60; // ET 04:00 ~ 16:00 (프리마켓 + 정규장)
}

/**
 * 미국 주식 추가진입(물타기) 허용 여부:
 * 프리마켓, 정규장, 애프터마켓(ET 04:00 ~ 19:55) 내내 허용.
 * 마감 일괄 청산 시점(ET 19:55) 이후 및 장외/주간거래/주말은 차단.
 */
export function isUsAveragingDownAllowed(epochMs: number): boolean {
  const et = getUsEtWeekdayAndMinutes(epochMs);
  if (!et || et.isWeekend) return false;
  return et.mins >= 4 * 60 && et.mins < 19 * 60 + 55; // ET 04:00 ~ 19:55 (마감 5분 전까지)
}

/**
 * 미국 주식 마감 일괄 청산 시점(ET 19:55~20:00, 월~금) 여부
 */
export function isUsMarketCloseExitTime(epochMs: number): boolean {
  const et = getUsEtWeekdayAndMinutes(epochMs);
  if (!et || et.isWeekend) return false;
  return et.mins >= 19 * 60 + 55 && et.mins < 20 * 60;
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
 * 진입 조건 판정 — 상향 돌파 시 진입.
 * (5분 전 종가 비교 C_-5는 급락 후 바닥 반등 시 심각한 매수 지연을 유발하므로 돌파 자체를 트리거로 함)
 */
export function shouldEnter(state: RealtimeMa5State): boolean {
  return state.breakout;
}

/**
 * 물타기 조건 판정.
 * gapRate = (현재가 - 평단가) / 평단가 × 100.
 * 조건: gapRate ≤ thresholdPct AND 돌파.
 * (바닥에서 5선을 뚫는 즉시 추가 매수하여 평단을 낮추고 반등 탈출)
 */
export function shouldAverageDown(
  currentPrice: number,
  avgPrice: number,
  state: RealtimeMa5State,
  thresholdPct: number = DEFAULT_REALTIME_MA5_CONFIG.averagingDownThresholdPct,
): boolean {
  if (avgPrice <= 0 || currentPrice <= 0) return false;
  const gapRate = ((currentPrice - avgPrice) / avgPrice) * 100;
  return gapRate <= thresholdPct && state.breakout;
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
