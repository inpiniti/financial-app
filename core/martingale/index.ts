// core/martingale — 물타기 시험 모드에서 출발한 ±3% 단타 규칙(2026-09-01 개정, 사용자 확정 — ADR 0007). 순수 TS, 의존 0.
//
// 2026-08-27 배수 물타기 시험(ADR 0006)에서 2026-09-01 **물타기를 제거**하고 손절로 바꿨다.
// 실거래 분석(docs/분석/2026-09-01)은 물타기가 이 기간 수익의 대부분(+$13.4 vs 손절 가정 −$0.5)을
// 만들었다고 나왔지만, 사용자가 꼬리 위험(한 종목 $1,000+ 노출, AIM 3,825주)을 직접 눈으로 확인하기 위해
// 전환을 결정했다. 진입 규칙은 그대로, 청산·세션만 바뀐다. 모듈·전략 이름은 기록 연속성을 위해 유지한다.
//
// 규칙:
//   · 봉 = 1분봉 종가. 4선 = 분봉5·20·60·120선(SMA). 기울기 up_N = ma_N(t) > ma_N(t−1).
//   · 진입: 정배열(ma5>ma20>ma60>ma120) ∧ 4선 모두 상승 ∧ 종가가 5선을 **아래→위**로 돌파한 봉(close(t−1)<ma5(t−1), close(t)>ma5(t)).
//   · 익절: 평단 +3% 도달 시 전량 매도(TAKE_PROFIT).
//   · 손절: 평단 −3% 도달 시 전량 매도(STOP_LOSS). 물타기 없음(2026-09-01 — 5선 변곡 매수 제거).
//   · 세션: 진입은 프리·정규·애프터(04:00~19:55 ET)만 — 주간거래(20:00~04:00 ET) 진입 금지(2026-09-01).
//   · 마감: 확장세션 끝 5분 전(19:55 ET)부터 20:00까지 전량 매도(SESSION_END, 유지). 재진입 허용.

import type { ConditionalDecision, ConditionalGridView, ConditionalPosition } from '../conditional';
import { etMinuteOfDay, TRADING_DAY_END_MIN, TRADING_DAY_START_MIN } from '../model/session';
import { smaSeries } from '../trend';

// ---------------------------------------------------------------------------
// 신호 (봉 종가 배열 → 진입 / 물타기 시점)
// ---------------------------------------------------------------------------

/**
 * 진입 이벤트 종류(2026-08-28, 사용자 확정) — 조건(정배열 ∧ 4선 상승 ∧ 종가 > 5선)이 **이 봉에서 성립하게 만든** 사건.
 *  cross   : 종가가 5선을 아래→위로 돌파
 *  allUp   : 4선 기울기가 이 봉에서 모두 상승으로 바뀜(배열·5선 위는 이미)
 *  ordered : 배열이 이 봉에서 5>20>60>120이 됨(기울기·5선 위는 이미)
 * 당일 이미 매매한 종목은 이 세 이벤트에서만 재진입하고, 아직 안 한 종목은 조건이 맞는 어느 봉이든(state) 진입한다.
 */
export type MartingaleEntryEvent = 'cross' | 'allUp' | 'ordered';

export interface MartingaleBarEval {
  /** 진입 조건이 이 봉에서 성립하는가 — 정배열 ∧ 4선 상승 ∧ 종가 > 5선. */
  condition: boolean;
  /** 조건 성립 봉에서 그 성립을 만든 이벤트 — 이벤트 없이(전 봉부터 계속 성립) 조건만 맞으면 null. */
  entryEvent: MartingaleEntryEvent | null;
  /** 이 봉이 이벤트 진입 봉인가(condition ∧ entryEvent≠null). 5선 돌파 단독 규칙이던 때의 이름을 유지. */
  entry: boolean;
  /** 정배열 ∧ 4선 모두 상승(진단·화면용). */
  aligned: boolean | null;
  /** 배열만 본 정배열(ma5>ma20>ma60>ma120) — 기울기 무관. 화면이 "배열은 맞는데 기울기가 아니다"를 구분하는 데 쓴다. */
  ordered: boolean | null;
  /** 각 선의 상승 여부(직전 봉 대비 strict). 판정 불가 null. */
  up: { ma5: boolean | null; ma20: boolean | null; ma60: boolean | null; ma120: boolean | null };
  ma5: number | null;
  bars: number;
}

/** 봉 수가 이보다 적으면 판정하지 않는다(ma120 2봉 + 여유). */
export const MARTINGALE_MIN_BARS = 122;

function upAt(s: readonly (number | null)[], i: number): boolean | null {
  if (i < 1) return null;
  const a = s[i];
  const b = s[i - 1];
  if (a === null || a === undefined || b === null || b === undefined) return null;
  return a > b;
}

/** 마지막 봉 기준 판정 — 입력은 오름차순 종가. 봉 부족·null이면 전부 false(fail-closed). */
export function evaluateMartingaleBars(closes: readonly number[]): MartingaleBarEval {
  const n = closes.length;
  const last = n - 1;
  const nullUp = { ma5: null, ma20: null, ma60: null, ma120: null };
  const none: MartingaleBarEval = {
    condition: false,
    entryEvent: null,
    entry: false,
    aligned: null,
    ordered: null,
    up: nullUp,
    ma5: null,
    bars: n,
  };
  if (n < 2) return none;
  const s5 = smaSeries(closes, 5);
  const s20 = smaSeries(closes, 20);
  const s60 = smaSeries(closes, 60);
  const s120 = smaSeries(closes, 120);
  const series = { s5, s20, s60, s120 };
  const ma5 = s5[last];
  const ma5Prev = s5[last - 1];
  const cur = stateAt(series, last);
  const prev = stateAt(series, last - 1);
  const close = closes[last];
  const closePrev = closes[last - 1];
  const above = ma5 !== null && Number.isFinite(close) && close > ma5;
  const abovePrev = ma5Prev !== null && Number.isFinite(closePrev) && closePrev > ma5Prev;
  const crossUp = above && ma5Prev !== null && Number.isFinite(closePrev) && closePrev < ma5Prev;
  const condition = cur.aligned === true && above;
  let entryEvent: MartingaleEntryEvent | null = null;
  if (condition) {
    // 우선순위: 돌파 > 4선 상승 성립 > 배열 성립. 세 사건이 같은 봉에 겹치면 하나만 고른다.
    if (crossUp) entryEvent = 'cross';
    else if (prev.allUp === false) entryEvent = 'allUp';
    else if (prev.ordered === false) entryEvent = 'ordered';
    else if (!abovePrev) entryEvent = 'cross'; // 직전 종가가 5선과 같았던 경계 사례 — 위로 올라섰으니 돌파로 본다.
  }
  return {
    condition,
    entryEvent,
    entry: condition && entryEvent !== null,
    aligned: cur.aligned,
    ordered: cur.ordered,
    up: cur.up,
    ma5,
    bars: n,
  };
}

type Series = { s5: (number | null)[]; s20: (number | null)[]; s60: (number | null)[]; s120: (number | null)[] };

/** i번째 봉의 배열·기울기 상태. 4선 중 하나라도 null이면 ordered/allUp/aligned 모두 null. */
function stateAt(s: Series, i: number): {
  ordered: boolean | null;
  allUp: boolean | null;
  aligned: boolean | null;
  up: MartingaleBarEval['up'];
} {
  const up = { ma5: upAt(s.s5, i), ma20: upAt(s.s20, i), ma60: upAt(s.s60, i), ma120: upAt(s.s120, i) };
  if (i < 0) return { ordered: null, allUp: null, aligned: null, up };
  const m5 = s.s5[i];
  const m20 = s.s20[i];
  const m60 = s.s60[i];
  const m120 = s.s120[i];
  if (m5 === null || m20 === null || m60 === null || m120 === null || m5 === undefined || m20 === undefined || m60 === undefined || m120 === undefined) {
    return { ordered: null, allUp: null, aligned: null, up };
  }
  const ups = [up.ma5, up.ma20, up.ma60, up.ma120];
  const allUp = ups.some((u) => u === null) ? null : ups.every((u) => u === true);
  const ordered = m5 > m20 && m20 > m60 && m60 > m120;
  return { ordered, allUp, aligned: allUp === null ? null : ordered && allUp, up };
}

/**
 * 진입 허용 봉인가 — **프리·정규·애프터**(04:00 ET ~ 마감 청산 전)에서만 진입한다(2026-09-01 사용자 확정, ADR 0007 —
 * 2026-08-28의 "모든 세션 진입"에서 주간거래(20:00~04:00 ET)를 뺐다). 마감 청산 구간(19:55~20:00)도 여전히
 * 진입하지 않는다(사자마자 마감 청산이 나간다). 판정은 봉 **종료** 분(ET). barStartMinuteKey = 봉 시작 epoch 분(1분봉).
 */
export function isMartingaleEntryBar(barStartMinuteKey: number, closeAtMin: number = MARTINGALE_CLOSE_AT_MIN): boolean {
  const m = etMinuteOfDay(barStartMinuteKey + 1);
  return m > TRADING_DAY_START_MIN && m < closeAtMin;
}

/** 하루 마감 청산 구간인가 — [closeAtMin, TRADING_DAY_END_MIN](20:00 정각 포함). 그 뒤 주간거래는 다시 매매 가능. */
export function inCloseWindow(etMin: number, closeAtMin: number = MARTINGALE_CLOSE_AT_MIN): boolean {
  return etMin >= closeAtMin && etMin <= TRADING_DAY_END_MIN;
}

// ---------------------------------------------------------------------------
// 포지션 규칙 (PositionRule 계약)
// ---------------------------------------------------------------------------

export interface MartingaleConfig {
  /** 익절 폭(소수, 0.03) — 평단 +3% 도달 시 전량 매도. */
  tpPct: number;
  /** 손절 폭(소수, 0.03) — 평단 −3% 도달 시 전량 매도(2026-09-01, 물타기 대체). */
  stopLossPct: number;
  /** 마감 청산 시각(ET 분, 19:55 = 1195). 이 시각부터 20:00까지 틱 판정이 전량 매도를 낸다. */
  closeAtMin: number;
}

/** 하루 마감 청산 시각 — 미국 확장세션 끝(20:00 ET) 5분 전. 애프터마켓까지 보유하고 그날 안에 정리한다(2026-08-28). */
export const MARTINGALE_CLOSE_AT_MIN = TRADING_DAY_END_MIN - 5;

export const MARTINGALE_CONFIG: MartingaleConfig = {
  tpPct: 0.03,
  stopLossPct: 0.03,
  closeAtMin: MARTINGALE_CLOSE_AT_MIN,
};

export type MartingaleExitKind = 'TAKE_PROFIT' | 'STOP_LOSS' | 'SESSION_END';

export interface MartingaleRuleOptions {
  config?: MartingaleConfig;
  /** 지금 시각 — 마감 판정. 없으면 마감 없음(테스트 편의). */
  clock?: { now(): number };
}

export class MartingaleRule {
  private qty: number;
  private avgPrice: number;
  private readonly entryQty: number;
  private readonly cfg: MartingaleConfig;
  private readonly clock: { now(): number } | undefined;
  private lastKind: MartingaleExitKind | null = null;
  /** 진행 중 매도가 어떤 결정이었나 — 취소선(shouldAbort) 판정용. */
  private pendingExit: MartingaleExitKind | null = null;

  constructor(position: ConditionalPosition, options: MartingaleRuleOptions = {}) {
    this.qty = position.qty;
    this.avgPrice = position.avgPrice;
    this.entryQty = position.qty;
    this.cfg = options.config ?? MARTINGALE_CONFIG;
    this.clock = options.clock;
  }

  /** 익절 목표가 = 평단 × (1 + tpPct). */
  get targetPrice(): number {
    return this.avgPrice * (1 + this.cfg.tpPct);
  }

  /** 익절 % (문구용). */
  get targetPct(): number {
    return this.cfg.tpPct;
  }

  /** 손절선 = 평단 × (1 − stopLossPct). 이 이하로 내려오면 전량 매도. */
  get stopPrice(): number {
    return this.avgPrice * (1 - this.cfg.stopLossPct);
  }

  get exitKind(): MartingaleExitKind | null {
    return this.lastKind;
  }

  get view(): ConditionalGridView {
    return {
      qty: this.qty,
      avgPrice: this.avgPrice,
      entryQty: this.entryQty,
      sellLine: this.targetPrice,
      // 물타기 제거(2026-09-01) 뒤 게이지 아래끝은 손절선 — buyLine 필드 이름은 뷰 계약 유지용.
      buyLine: this.stopPrice,
    };
  }

  /** 봉 마감 신호 판정 — 물타기 제거(2026-09-01)로 신호 매수·매도 없음. 계약 유지용 null. */
  decide(_signal: 'BUY' | 'SELL', _price: number): ConditionalDecision | null {
    return null;
  }

  /** 틱 판정 — 익절 목표·손절선 도달 또는 마감 시각이면 전량 매도. */
  onPriceAt(price: number, nowMs?: number): ConditionalDecision | null {
    this.lastKind = null;
    if (!Number.isFinite(price) || price <= 0 || this.qty <= 0) return null;
    if (price >= this.targetPrice) {
      this.lastKind = 'TAKE_PROFIT';
      this.pendingExit = 'TAKE_PROFIT';
      return { side: 'sell', qty: this.qty };
    }
    if (this.avgPrice > 0 && price <= this.stopPrice) {
      this.lastKind = 'STOP_LOSS';
      this.pendingExit = 'STOP_LOSS';
      return { side: 'sell', qty: this.qty };
    }
    if (nowMs !== undefined && inCloseWindow(etMinuteOfDay(Math.floor(nowMs / 60_000)), this.cfg.closeAtMin)) {
      this.lastKind = 'SESSION_END';
      this.pendingExit = 'SESSION_END';
      return { side: 'sell', qty: this.qty };
    }
    return null;
  }

  onPrice(price: number): ConditionalDecision | null {
    return this.onPriceAt(price, this.clock?.now());
  }

  /**
   * 취소선 — 익절 매도는 현재가가 목표가 아래로 내려가면 접고 다음 터치를 기다린다(목표가 지정가 의미론).
   * 손절·마감 청산은 무조건 판다(되돌아와도 접지 않는다 — 손실 확정이 목적). 매수 다리는 없다(물타기 제거).
   */
  shouldAbort(side: 'buy' | 'sell', price: number): boolean {
    if (!Number.isFinite(price) || price <= 0) return false;
    if (side === 'buy') return false;
    if (this.pendingExit === 'SESSION_END' || this.pendingExit === 'STOP_LOSS') return false;
    return price < this.targetPrice;
  }

  /** 체결·잔고 반영. */
  setPosition(position: ConditionalPosition): void {
    if (position.qty >= this.qty) this.pendingExit = null; // 매도가 끝나지 않았다 — 취소선 상태 초기화
    this.qty = position.qty;
    this.avgPrice = position.avgPrice;
  }
}
