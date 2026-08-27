// core/martingale — 배수 물타기 시험 모드(2026-08-27, 사용자 확정)의 신호·포지션 규칙. 순수 TS, 의존 0.
//
// ⚠ ADR 0001(고정 수량 물타기)을 **이 모드 안에서만** 뒤집는다 — ADR 0006. 백테스트(financial-analyze
//   docs/analysis/2026-08-27_물타기-변형.md)는 "감당 가능한 전략"이 아니라 "실거래 검증이 필요한 후보"로 결론냈고,
//   사용자가 소액 시험을 결정했다. 자본·횟수 상한은 사용자 결정으로 두지 않는다 — 현금 부족이면 그 물타기만 건너뛴다.
//
// 규칙(백테스트 규약 그대로):
//   · 봉 = 1분봉 종가. 4선 = 분봉5·20·60·120선(SMA). 기울기 up_N = ma_N(t) > ma_N(t−1).
//   · 진입: 정배열(ma5>ma20>ma60>ma120) ∧ 4선 모두 상승 ∧ 종가가 5선을 **아래→위**로 돌파한 봉(close(t−1)<ma5(t−1), close(t)>ma5(t)).
//   · 익절: 평단 × (1 + 사다리[물타기 횟수]) — 0회 +3% / 1회 +2% / 2회 이상 +1%. 현재가가 닿으면 전량 매도.
//   · 물타기: 5선 **변곡**(up5(t−1)=false → up5(t)=true) 봉에서, 마지막 체결 후 ≥ 5분, 현재가 ≤ 평단×(1−3%)일 때.
//            낙폭 k%(내림, 3~50)면 현재 보유량의 (k−1)배를 산다 — −3% 2배 · −4% 3배 · … · −50% 49배.
//   · 마감: 정규장 마감 5분 전(15:55 ET)부터 전량 매도(오버나이트 없음 — 백테스트가 일 단위라 검증되지 않았다).
//   · 손절 없음. 트레일 없음. 재진입 허용(청산 뒤 다음 진입 신호에서).

import type { ConditionalDecision, ConditionalGridView, ConditionalPosition } from '../conditional';
import { etMinuteOfDay, MAIN_SESSION_END_MIN, MAIN_SESSION_START_MIN } from '../model/session';
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
  /** 이 봉에서 5선이 하락(또는 보합)→상승으로 바뀌었나 — 물타기 시점. */
  ma5TurnUp: boolean;
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
    ma5TurnUp: false,
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
  const up5 = upAt(s5, last);
  const up5Prev = upAt(s5, last - 1);
  // 5선 변곡 — 직전 봉은 상승이 아니었고(하락·보합) 이번 봉은 상승. 둘 중 하나라도 모르면 변곡 아님.
  const ma5TurnUp = up5 === true && up5Prev === false;

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
    ma5TurnUp,
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
 * 진입 허용 봉인가 — 봉 **종료** 분(ET)이 정규장 안이고 마감 청산 시각 전. barStartMinuteKey = 봉 시작 epoch 분(1분봉).
 * 프리·애프터마켓 봉은 4선 계산에는 쓰되 진입은 하지 않는다(백테스트 규약).
 */
export function isMartingaleEntryBar(barStartMinuteKey: number, closeAtMin: number = MARTINGALE_CLOSE_AT_MIN): boolean {
  const endMin = etMinuteOfDay(barStartMinuteKey + 1);
  return endMin >= MAIN_SESSION_START_MIN && endMin <= MAIN_SESSION_END_MIN && endMin < closeAtMin;
}

// ---------------------------------------------------------------------------
// 포지션 규칙 (PositionRule 계약)
// ---------------------------------------------------------------------------

export interface MartingaleConfig {
  /** 첫 물타기 낙폭(소수, 0.03). 이 아래로 떨어져야 물을 탄다. */
  dropStartPct: number;
  /** 배수 계산의 낙폭 상한(소수, 0.50) — 이보다 깊어도 배수는 (상한%−1)배까지. */
  dropMaxPct: number;
  /** 익절 사다리(소수) — 인덱스 = 물타기 횟수, 마지막 값이 그 이상 횟수에 적용. */
  tpLadder: readonly number[];
  /** 물타기 최소 간격(ms) — 마지막 체결(진입 포함)로부터. */
  minGapMs: number;
  /** 마감 청산 시각(ET 분, 15:55 = 955). 이 시각부터 틱 판정이 전량 매도를 낸다. */
  closeAtMin: number;
}

/** 정규장 마감 5분 전 — 마감 동시호가·애프터 유동성 없는 구간을 피한다. */
export const MARTINGALE_CLOSE_AT_MIN = MAIN_SESSION_END_MIN - 5;

export const MARTINGALE_CONFIG: MartingaleConfig = {
  dropStartPct: 0.03,
  dropMaxPct: 0.5,
  tpLadder: [0.03, 0.02, 0.01],
  minGapMs: 5 * 60_000,
  closeAtMin: MARTINGALE_CLOSE_AT_MIN,
};

/** 낙폭(소수, 양수) → 수량 배수. −3%→2배, −4%→3배, … −k%→(k−1)배. dropStart 미만이면 0(물타기 없음). */
export function multiplierForDrop(drop: number, cfg: Pick<MartingaleConfig, 'dropStartPct' | 'dropMaxPct'> = MARTINGALE_CONFIG): number {
  if (!Number.isFinite(drop) || drop < cfg.dropStartPct - 1e-12) return 0;
  const k = Math.min(Math.floor(drop * 100 + 1e-9), Math.round(cfg.dropMaxPct * 100));
  return Math.max(0, k - 1);
}

export type MartingaleExitKind = 'TAKE_PROFIT' | 'SESSION_END';

export interface MartingaleRuleOptions {
  config?: MartingaleConfig;
  /** 지금 시각 — 물타기 간격·마감 판정. 없으면 간격 0·마감 없음(테스트 편의). */
  clock?: { now(): number };
  /** 진입 체결 시각(ms) — 첫 물타기 간격의 기준. 없으면 clock.now(). */
  entryAtMs?: number;
}

export class MartingaleRule {
  private qty: number;
  private avgPrice: number;
  private readonly entryQty: number;
  private readonly cfg: MartingaleConfig;
  private readonly clock: { now(): number } | undefined;
  /** 물타기 체결 횟수 — setPosition에서 수량이 늘면 +1. */
  private _adds = 0;
  /** 마지막 체결(진입·물타기) 시각(ms). */
  private lastFillAt: number;
  private lastKind: MartingaleExitKind | null = null;
  /** 진행 중 매도가 어떤 결정이었나 — 취소선(shouldAbort) 판정용. */
  private pendingExit: MartingaleExitKind | null = null;

  constructor(position: ConditionalPosition, options: MartingaleRuleOptions = {}) {
    this.qty = position.qty;
    this.avgPrice = position.avgPrice;
    this.entryQty = position.qty;
    this.cfg = options.config ?? MARTINGALE_CONFIG;
    this.clock = options.clock;
    this.lastFillAt = options.entryAtMs ?? this.clock?.now() ?? 0;
  }

  get adds(): number {
    return this._adds;
  }

  /** 지금 익절 목표가 = 평단 × (1 + 사다리[물타기 횟수]). */
  get targetPrice(): number {
    const ladder = this.cfg.tpLadder;
    const pct = ladder[Math.min(this._adds, ladder.length - 1)] ?? ladder[ladder.length - 1] ?? 0;
    return this.avgPrice * (1 + pct);
  }

  /** 지금 익절 % (문구용). */
  get targetPct(): number {
    const ladder = this.cfg.tpLadder;
    return ladder[Math.min(this._adds, ladder.length - 1)] ?? 0;
  }

  /** 첫 물타기 선 = 평단 × (1 − 3%). 이 아래에서 5선 변곡이 와야 산다. */
  get buyLinePrice(): number {
    return this.avgPrice * (1 - this.cfg.dropStartPct);
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
      buyLine: this.buyLinePrice,
    };
  }

  /**
   * 봉 마감 신호 판정 — BUY = "5선 변곡"(호출부가 진입 신호와 구분해 넘긴다). SELL은 없다.
   * 낙폭이 첫 물타기 선에 못 미치거나 간격이 안 찼으면 null.
   */
  decide(signal: 'BUY' | 'SELL', price: number): ConditionalDecision | null {
    if (signal !== 'BUY') return null;
    if (!Number.isFinite(price) || price <= 0 || this.qty <= 0 || !(this.avgPrice > 0)) return null;
    const now = this.clock?.now();
    if (now !== undefined && now - this.lastFillAt < this.cfg.minGapMs) return null;
    const drop = 1 - price / this.avgPrice;
    const mult = multiplierForDrop(drop, this.cfg);
    if (mult <= 0) return null;
    const addQty = Math.floor(this.qty * mult);
    if (addQty < 1) return null;
    return { side: 'buy', qty: addQty };
  }

  /** 틱 판정 — 익절 목표 도달 또는 마감 시각이면 전량 매도. */
  onPriceAt(price: number, nowMs?: number): ConditionalDecision | null {
    this.lastKind = null;
    if (!Number.isFinite(price) || price <= 0 || this.qty <= 0) return null;
    if (price >= this.targetPrice) {
      this.lastKind = 'TAKE_PROFIT';
      this.pendingExit = 'TAKE_PROFIT';
      return { side: 'sell', qty: this.qty };
    }
    if (nowMs !== undefined && etMinuteOfDay(Math.floor(nowMs / 60_000)) >= this.cfg.closeAtMin) {
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
   * 취소선 — 매수: 현재가가 첫 물타기 선 위로 되돌아오면 접는다(백테스트 체결가 = min(시가, 선가) — 선 위에서는 사지 않는다).
   * 매도: 익절은 현재가가 목표가 아래로 내려가면 접고 다음 터치를 기다린다(목표가 지정가 의미론). 마감 청산은 무조건 판다.
   */
  shouldAbort(side: 'buy' | 'sell', price: number): boolean {
    if (!Number.isFinite(price) || price <= 0) return false;
    if (side === 'buy') return price > this.buyLinePrice;
    if (this.pendingExit === 'SESSION_END') return false;
    return price < this.targetPrice;
  }

  /** 체결·잔고 반영 — 수량이 늘었으면 물타기 1회로 세고 간격 기준 시각을 갱신한다. */
  setPosition(position: ConditionalPosition): void {
    if (position.qty > this.qty) {
      this._adds += 1;
      this.lastFillAt = this.clock?.now() ?? this.lastFillAt;
    }
    if (position.qty >= this.qty) this.pendingExit = null; // 매도가 끝나지 않았거나 매수였다 — 취소선 상태 초기화
    this.qty = position.qty;
    this.avgPrice = position.avgPrice;
  }
}
