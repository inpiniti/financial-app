// core/martingale — 5선 돌파 기반 물타기 단타 규칙(2026-09-02 개정, 사용자 확정). 순수 TS, 의존 0.
//
// 2026-09-01의 ±3% 손절 규칙에서 **물타기를 복원**했다.
// 진입 조건을 단순화: 정배열·4선 상승 제거 → 5선 상승 + 5선 돌파만.
// 물타기: 5선 돌파 + 평단 대비 낙폭 k%(k≥3)일 때 보유량의 (k−1)배 추가 진입.
//
// 규칙:
//   · 봉 = 1분봉 종가. 5선 = 분봉5선(SMA). 기울기 up5 = ma5(t) > ma5(t−1).
//   · 초기 진입: 5선 상승 ∧ 종가가 5선을 **아래→위**로 돌파한 봉(close(t−1)<ma5(t−1), close(t)>ma5(t)).
//     판정은 봉 마감을 기다리지 않는다 — 진행 중 봉을 현재가로 넣어 실시간(1초 주기)으로도 잰다(evaluateMartingaleLive, 사용자 확정).
//   · 익절: 평단 +3% 도달 시 전량 매도(TAKE_PROFIT).
//   · 물타기: 같은 5선 돌파 봉에서 현재가 ≤ 평단×(1−3%)면 낙폭 k%(내림, 3~50)에 대해 **현재 보유량의 (k−1)배**를 산다.
//            −3% 2배 · −4% 3배 · … · −50% 49배. 횟수·투입 상한 없음(현금 부족이면 그 물타기만 건너뜀 — 포지션 관리자 몫).
//   · 손절 없음(2026-09-01의 −3% 손절은 이 개정으로 제거 — ADR 0010).
//   · 세션: 진입은 프리·정규·애프터(04:00~19:55 ET)만 — 주간거래(20:00~04:00 ET) 진입 금지.
//   · 마감: 확장세션 끝 5분 전(19:55 ET)부터 20:00까지 전량 매도(SESSION_END). 재진입 허용.

import type { ConditionalDecision, ConditionalGridView, ConditionalPosition } from '../conditional';
import { etMinuteOfDay, TRADING_DAY_END_MIN, TRADING_DAY_START_MIN } from '../model/session';
import { smaSeries } from '../trend';

// ---------------------------------------------------------------------------
// 신호 (봉 종가 배열 → 진입 / 물타기 시점)
// ---------------------------------------------------------------------------

/** 매수 신호의 근거 — 지금은 'cross'(5선 상승 중 종가가 5선을 아래→위로 돌파) 하나. 2026-08-28의 allUp·ordered는 ADR 0010으로 폐기. */
export type MartingaleEntryEvent = 'cross';

export interface MartingaleBarEval {
  /** 이 봉이 매수 신호 봉인가 — 5선 상승 ∧ 종가 5선 상향 돌파. 미보유면 진입, 보유 중이면 물타기 후보(낙폭은 MartingaleRule이 판정). */
  entry: boolean;
  /** 이 봉에서 5선이 상승으로 바뀌었나 — 5선 변곡. */
  ma5TurnUp: boolean;
  /** 5선 상승 여부(직전 봉 대비). 판정 불가 null. */
  ma5Up: boolean | null;
  ma5: number | null;
  bars: number;
}

/** 봉 수가 이보다 적으면 판정하지 않는다 — 5선만 쓰지만 차트 4선·시드 길이와 맞춰 122봉 유지(ADR 0010, 화면 "계산 중" 문턱). */
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
  const none: MartingaleBarEval = {
    entry: false,
    ma5TurnUp: false,
    ma5Up: null,
    ma5: null,
    bars: n,
  };
  // 봉 부족은 fail-closed — 5선만 쓰지만 문턱은 MARTINGALE_MIN_BARS(옛 4선 규칙과 같은 122봉)로 유지한다.
  if (n < MARTINGALE_MIN_BARS) return none;
  const s5 = smaSeries(closes, 5);
  const ma5 = s5[last];
  const ma5Prev = s5[last - 1];
  const up5 = upAt(s5, last);
  const up5Prev = upAt(s5, last - 1);
  // 5선 변곡 — 직전 봉은 상승이 아니었고(하락·보합) 이번 봉은 상승. 둘 중 하나라도 모르면 변곡 아님.
  const ma5TurnUp = up5 === true && up5Prev === false;
  const close = closes[last];
  const closePrev = closes[last - 1];
  // 5선 상향 돌파 — 종가가 5선을 아래→위로 지나감.
  const crossUp =
    ma5 !== null && ma5Prev !== null && Number.isFinite(close) && Number.isFinite(closePrev) && closePrev < ma5Prev && close > ma5;
  // 초기 진입: 5선 상승 + 5선 돌파
  const entry = up5 === true && crossUp;
  return {
    entry,
    ma5TurnUp,
    ma5Up: up5,
    ma5,
    bars: n,
  };
}

/**
 * 진행 중(미완성) 봉을 마지막 봉으로 덧붙여 다시 잰 진입 판정 — **차트가 그리는 것과 같은 기준**(2026-09-01, 사용자 확정).
 *
 * 왜: 봉 마감 판정만 쓰면 진입 지연의 하한이 봉 주기 1개(1분) + 다음 분 첫 틱까지다. 토스 차트는 진행 중 봉을
 * 포함해 4선을 실시간으로 그리므로 눈으로는 돌파가 보이는데 엔진은 최대 1분 뒤에 사서 고점을 잡았다.
 * 청산(추세 모드 evaluateTrendLive)이 이미 쓰는 방식 그대로 진입도 실시간으로 당긴다 — 봉 중간 가짜 돌파에
 * 물리는 위험은 ±3% 손절이 받는다(2026-08-22의 "진입은 봉 확정" 결정을 사용자가 직접 뒤집음).
 *
 * closedCloses = 닫힌 봉 종가(오름차순), provisionalClose = 진행 중 봉의 현재 종가.
 * 반환값은 "진행 중 봉을 마지막 봉으로 친" evaluateMartingaleBars 그대로다(entryEvent 의미 동일).
 */
export function evaluateMartingaleLive(
  closedCloses: readonly number[],
  provisionalClose: number,
): MartingaleBarEval {
  if (!Number.isFinite(provisionalClose) || provisionalClose <= 0) {
    return evaluateMartingaleBars([]);
  }
  return evaluateMartingaleBars([...closedCloses, provisionalClose]);
}

/** 진행 중 봉 재판정 주기(ms) — 틱마다 130봉×4선 재계산 방지(추세 TREND_LIVE_EVAL_MS와 같은 근거). 0이면 매 틱(테스트용). */
export const MARTINGALE_LIVE_EVAL_MS = 1_000;

/** 진행 중 봉 진입 스위치 — false로 두면 봉 마감 판정만 하던 2026-09-01 이전 동작으로 한 줄 롤백. */
export const MARTINGALE_LIVE_ENTRY = true;


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
  /** 첫 물타기 낙폭(소수, 0.03) — 이 아래로 떨어져야 물을 탄다. */
  dropStartPct: number;
  /** 배수 계산의 낙폭 상한(소수, 0.50) — 이보다 깊어도 배수는 (상한%−1)배까지. */
  dropMaxPct: number;
  /** 마감 청산 시각(ET 분, 19:55 = 1195). 이 시각부터 20:00까지 틱 판정이 전량 매도를 낸다. */
  closeAtMin: number;
}

/** 하루 마감 청산 시각 — 미국 확장세션 끝(20:00 ET) 5분 전. 애프터마켓까지 보유하고 그날 안에 정리한다(2026-08-28). */
export const MARTINGALE_CLOSE_AT_MIN = TRADING_DAY_END_MIN - 5;

export const MARTINGALE_CONFIG: MartingaleConfig = {
  tpPct: 0.03,
  dropStartPct: 0.03,
  dropMaxPct: 0.5,
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
  /** 지금 시각 — 마감 판정. 없으면 마감 없음(테스트 편의). */
  clock?: { now(): number };
}

export class MartingaleRule {
  private qty: number;
  private avgPrice: number;
  private readonly entryQty: number;
  private readonly cfg: MartingaleConfig;
  private readonly clock: { now(): number } | undefined;
  /** 물타기 횟수(추가 진입 count) — setPosition에서 수량이 늘면 +1. */
  private _adds = 0;
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

  get adds(): number {
    return this._adds;
  }

  /** 익절 목표가 = 평단 × (1 + tpPct). */
  get targetPrice(): number {
    return this.avgPrice * (1 + this.cfg.tpPct);
  }

  /** 익절 % (문구용). */
  get targetPct(): number {
    return this.cfg.tpPct;
  }

  /** 첫 물타기 선 = 평단 × (1 − dropStartPct). 이 아래에서 5선 돌파가 와야 산다. */
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
   * 봉 신호 판정 — BUY = "5선 상승·상향 돌파" 봉(오토파일럿이 보유 종목의 신호를 여기로 넘긴다). SELL은 없다.
   * 낙폭이 첫 물타기 선(−3%)에 못 미치면 null. 수량 = 현재 보유량 × (k−1), 1주 미만이면 null.
   */
  decide(signal: 'BUY' | 'SELL', price: number): ConditionalDecision | null {
    if (signal !== 'BUY') return null;
    if (!Number.isFinite(price) || price <= 0 || this.qty <= 0 || !(this.avgPrice > 0)) return null;
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
   * 마감 청산은 무조건 판다(되돌아와도 접지 않는다). 물타기는 잔고 반영됨.
   */
  shouldAbort(side: 'buy' | 'sell', price: number): boolean {
    if (!Number.isFinite(price) || price <= 0) return false;
    if (side === 'buy') return false;
    if (this.pendingExit === 'SESSION_END') return false;
    return price < this.targetPrice;
  }

  /** 체결·잔고 반영 — 수량이 늘면 물타기 1회로 센다(adds). 익절 목표는 새 평단에서 다시 계산된다. */
  setPosition(position: ConditionalPosition): void {
    if (position.qty > this.qty) this._adds += 1;
    if (position.qty >= this.qty) this.pendingExit = null; // 매도가 끝나지 않았다 — 취소선 상태 초기화
    this.qty = position.qty;
    this.avgPrice = position.avgPrice;
  }
}
