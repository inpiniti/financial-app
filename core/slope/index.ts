// core/slope — 기울기 단타 규칙(2026-09-02, 사용자 확정 — ADR 0011). 순수 TS, 의존 0.
//
// 규칙(전부):
//   · 지표 = 기울기/10초(SlopeMeter v2 — 직전 10초 봉 평균 대비 현재 10초 봉 평균의 %). 봉·이동평균·확률 없음.
//   · 진입: 기울기가 문턱(+1%) **아래→이상**으로 올라선 순간 매수(BUY). 세션·시간대 조건 없음.
//   · 청산: 보유 중 기울기가 문턱(+1%) **미만**으로 내려오면 그 즉시 전량 매도(SELL). 익절·손절·물타기·마감 청산 없음.
//     판정 불가(null — 두 10초 봉 중 하나가 비었다 = 체결이 끊겼다)도 "기울기가 없다"로 보고 판다.
//   · 속도: 판정은 틱마다(스로틀 없음) + 보유 중엔 관리자 빠른 틱(SLOPE_EXIT_TICK_MS)이 창 슬라이딩까지 잰다.
//     매도는 취소선 없이 체결까지 추격한다(가차없이).
//
// ⚠ 이 값은 "기울기/10초"다 — SG 감지기의 "기울기"(%/청크, 변곡점 전용)와 다르다(docs/domain/기울기 §2).

import type { ConditionalDecision, ConditionalGridView, ConditionalPosition } from '../conditional';

export interface SlopeConfig {
  /** 진입 문턱(%, 기울기/10초) — 이 값 **이상**으로 올라서는 순간 산다. */
  entryPct: number;
  /** 청산 문턱(%, 기울기/10초) — 이 값 **미만**이면 판다. entryPct와 같게 두면 "1% 이상이면 사고 1% 아래면 판다". */
  exitPct: number;
}

export const SLOPE_CONFIG: SlopeConfig = { entryPct: 1, exitPct: 1 };

/**
 * 보유 중 청산 판정의 빠른 틱 주기(ms) — 오토파일럿의 리프라이스 타이머가 기울기 모드에서 이 값으로 돈다.
 * 기울기는 틱이 없어도 창이 미끄러지며 변하므로(직전 봉이 빠져나감) 틱 사이에도 재봐야 한다. 100ms = 사용자 요구
 * "0.1초 오차 없이". 계산은 20초치 틱 선형 스캔이라 종목당 10회/초는 가볍다.
 */
export const SLOPE_EXIT_TICK_MS = 100;

/** 기울기 상태 — 문턱 위(true)/아래(false)/모름(null). 신호는 **전환**에서만 난다(같은 상태 반복은 조용하다). */
export type SlopeState = boolean | null;

export interface SlopeTransition {
  state: SlopeState;
  /** 'BUY' = 아래·모름 → 이상, 'SELL' = 이상 → 미만·모름. 전환이 아니면 null. */
  signal: 'BUY' | 'SELL' | null;
}

/**
 * 틱 1개 판정 — 직전 상태와 지금 기울기로 전환 신호를 낸다.
 *  · rate ≥ entryPct → 위. 직전이 위가 아니었으면 BUY.
 *  · rate < exitPct 또는 null → 아래. 직전이 위였으면 SELL.
 *  · entryPct > rate ≥ exitPct(문턱을 다르게 뒀을 때의 중간 띠)는 상태 유지, 신호 없음.
 */
export function evaluateSlopeTransition(prev: SlopeState, rate: number | null, cfg: SlopeConfig = SLOPE_CONFIG): SlopeTransition {
  const above = rate !== null && Number.isFinite(rate) && rate >= cfg.entryPct;
  const below = rate === null || !Number.isFinite(rate) || rate < cfg.exitPct;
  if (above) return { state: true, signal: prev === true ? null : 'BUY' };
  if (below) return { state: false, signal: prev === true ? 'SELL' : null };
  return { state: prev, signal: null };
}

export interface SlopeRuleOptions {
  config?: SlopeConfig;
  /**
   * 지금 기울기/10초 읽기 — 슬롯의 SlopeMeter. **미주입(undefined)이면 틱 판정을 하지 않는다**(슬롯이 없는 입양
   * 포지션을 기울기 모름으로 즉시 팔지 않게). 주입됐는데 null을 주면 "체결 끊김"으로 보고 판다.
   */
  slope?: () => number | null;
}

/** 포지션 규칙(PositionRule 계약) — 신호 SELL·틱 판정 둘 다 "전량 매도"뿐이다. 매수 결정은 없다(물타기 없음). */
export class SlopeRule {
  private qty: number;
  private avgPrice: number;
  private readonly entryQty: number;
  private readonly cfg: SlopeConfig;
  private readonly slope: (() => number | null) | undefined;
  /** 마지막 틱 판정이 읽은 기울기(문구용). */
  private _lastRate: number | null = null;

  constructor(position: ConditionalPosition, options: SlopeRuleOptions = {}) {
    this.qty = position.qty;
    this.avgPrice = position.avgPrice;
    this.entryQty = position.qty;
    this.cfg = options.config ?? SLOPE_CONFIG;
    this.slope = options.slope;
  }

  get exitPct(): number {
    return this.cfg.exitPct;
  }

  /** 마지막 틱 판정 시점의 기울기 — 청산 문구용. */
  get lastRate(): number | null {
    return this._lastRate;
  }

  /** 게이지용 뷰 — 가격 조건선이 없다(sellLine·buyLine 자리는 평단). 게이지는 dayRange로 그린다. */
  get view(): ConditionalGridView {
    return { qty: this.qty, avgPrice: this.avgPrice, entryQty: this.entryQty, sellLine: this.avgPrice, buyLine: this.avgPrice };
  }

  /** 신호 판정 — SELL(기울기 문턱 아래로 전환)이면 전량 매도. BUY는 보유 중 의미 없음(물타기 없음). */
  decide(signal: 'BUY' | 'SELL', _price: number): ConditionalDecision | null {
    if (signal !== 'SELL' || this.qty <= 0) return null;
    return { side: 'sell', qty: this.qty };
  }

  /** 틱 판정 — 기울기 공급이 있고, 값이 문턱 미만이거나 null이면 전량 매도. */
  onPrice(_price: number): ConditionalDecision | null {
    if (this.qty <= 0 || this.slope === undefined) return null;
    const rate = this.slope();
    this._lastRate = rate;
    if (rate !== null && Number.isFinite(rate) && rate >= this.cfg.exitPct) return null;
    return { side: 'sell', qty: this.qty };
  }

  /** 취소선 없음 — 매도는 어떤 가격에서도 접지 않고 체결까지 따라간다(가차없이). */
  shouldAbort(_side: 'buy' | 'sell', _price: number): boolean {
    return false;
  }

  setPosition(position: ConditionalPosition): void {
    this.qty = position.qty;
    this.avgPrice = position.avgPrice;
  }
}
