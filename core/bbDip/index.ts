// core/bbDip/index.ts — 볼린저 하단 투매 반등(BB Dip Snapback) 퀀트 규칙 (순수 TS, 의존 0)
//
// 규칙 개요:
// 1. 진입 (BUY):
//    - 20틱 볼린저 밴드 하단 대비 -0.4% 이하로 투매 오버슈팅 (p <= lowerBb * 0.996)
//    - 10초 가격 기울기 s10 > +0.05% (바닥 찍고 첫 반등 확인)
//    - 분당 틱속도 rm >= 50 (유령 종목 제외, 초당 약 0.83건)
//    - 체결강도 FlowRatio >= +10% (0.10)
//
// 2. 청산 (SELL / 맞춤 대칭 청산 엔진):
//    - 1순위: 볼린저 중심선(MA20) 도달 시 즉시 전량 익절 (p >= ma20)
//    - 2순위: 목표 익절 도달 (+1.2%)
//    - 3순위: 홈런 트레일링 익절 (+1.0% 이상 상승 후 최고점 대비 0.5% 반납 시)
//    - 4순위: 본절 보호 (+0.6% 찍고 원금 +0.05%로 밀리면 원금 보존 매도)
//    - 5순위: 조기 칼손절 (-0.8% 도달 시 즉시 탈출)

import type { ConditionalDecision, ConditionalGridView, ConditionalPosition } from '../conditional';

export interface BbDipConfig {
  /** 20틱 볼린저 기간 */
  bbPeriod: number;
  /** 볼린저 표준편차 배수 (기본 2.0) */
  bbDev: number;
  /** 하단 밴드 이탈 문턱 (기본 -0.004 = -0.4%) */
  dipThreshold: number;
  /** 10초 가격 기울기 반등 문턱 (기본 +0.05%) */
  s10Min: number;
  /** 최소 틱속도 (건/분, 기본 50) */
  minRm: number;
  /** 최소 체결강도 FlowRatio (기본 0.10 = +10%) */
  minFr: number;
  /** 목표 익절률 (기본 0.012 = +1.2%) */
  takeProfitPct: number;
  /** 조기 칼손절률 (기본 0.008 = -0.8%) */
  stopLossPct: number;
  /** 홈런 트레일링 발동 수익률 (기본 0.010 = +1.0%) */
  trailingTriggerPct: number;
  /** 트레일링 고점 대비 반납폭 (기본 0.005 = 0.5%) */
  trailingDropPct: number;
  /** 본절 보호 발동 수익률 (기본 0.006 = +0.6%) */
  breakevenTriggerPct: number;
}

export const DEFAULT_BBDIP_CONFIG: BbDipConfig = {
  bbPeriod: 20,
  bbDev: 2.0,
  dipThreshold: -0.004,
  s10Min: 0.05,
  minRm: 50,
  minFr: 0.10,
  takeProfitPct: 0.012,
  stopLossPct: 0.008,
  trailingTriggerPct: 0.010,
  trailingDropPct: 0.005,
  breakevenTriggerPct: 0.006,
};

/** 20틱 볼린저 밴드 실시간 계산기 */
export class BollingerBandMeter {
  private readonly period: number;
  private readonly dev: number;
  private readonly window: number[] = [];

  constructor(period = 20, dev = 2.0) {
    this.period = period;
    this.dev = dev;
  }

  record(price: number): void {
    if (!Number.isFinite(price) || price <= 0) return;
    this.window.push(price);
    if (this.window.length > this.period) {
      this.window.shift();
    }
  }

  get isReady(): boolean {
    return this.window.length >= this.period;
  }

  get ma20(): number | null {
    if (this.window.length === 0) return null;
    const sum = this.window.reduce((a, b) => a + b, 0);
    return sum / this.window.length;
  }

  get lowerBb(): number | null {
    if (!this.isReady) return null;
    const mean = this.ma20!;
    const variance = this.window.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / this.period;
    const std = Math.sqrt(variance);
    return mean - this.dev * std;
  }

  get upperBb(): number | null {
    if (!this.isReady) return null;
    const mean = this.ma20!;
    const variance = this.window.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / this.period;
    const std = Math.sqrt(variance);
    return mean + this.dev * std;
  }
}

/** 틱 1개 진입 판정 */
export function evaluateBbDipEntry(
  currentPrice: number,
  lowerBb: number | null,
  s10: number | null,
  rm: number,
  flowRatio: number,
  cfg: BbDipConfig = DEFAULT_BBDIP_CONFIG
): boolean {
  if (lowerBb === null || lowerBb <= 0) return false;
  if (s10 === null || !Number.isFinite(s10)) return false;

  // 1. 볼린저 하단 대비 -0.4% 이하 투매 오버슈팅
  const distToLowerBb = (currentPrice - lowerBb) / lowerBb;
  if (distToLowerBb > cfg.dipThreshold) return false;

  // 2. 10초 가격 기울기 반등 (+0.05% 이상)
  if (s10 <= cfg.s10Min) return false;

  // 3. 최소 틱속도 (건/분 >= 50)
  if (rm < cfg.minRm) return false;

  // 4. 최소 체결강도 FlowRatio (>= +10%)
  if (flowRatio < cfg.minFr) return false;

  return true;
}

export type BbDipExitKind = 'TP_MA20' | 'TAKE_PROFIT' | 'TRAILING_STOP' | 'BREAKEVEN' | 'STOP_LOSS';

export interface BbDipRuleOptions {
  config?: BbDipConfig;
  getMa20?: () => number | null;
  ma20?: () => number | null;
}

/** 진입 후 포지션 규칙 (맞춤 대칭 청산 엔진) */
export class BbDipExitRule {
  private qty: number;
  private avgPrice: number;
  private readonly entryQty: number;
  private readonly cfg: BbDipConfig;
  private readonly getMa20?: () => number | null;
  private maxPriceSinceEntry: number;
  private _lastExitReason: string | null = null;
  private _exitKind: BbDipExitKind | null = null;
  private _lastMa20: number | null = null;

  constructor(position: ConditionalPosition, options: BbDipRuleOptions = {}) {
    this.qty = position.qty;
    this.avgPrice = position.avgPrice;
    this.entryQty = position.qty;
    this.cfg = options.config ?? DEFAULT_BBDIP_CONFIG;
    this.getMa20 = options.ma20 ?? options.getMa20;
    this.maxPriceSinceEntry = position.avgPrice;
  }

  get lastExitReason(): string | null {
    return this._lastExitReason;
  }

  get exitKind(): BbDipExitKind | null {
    return this._exitKind;
  }

  get lastMa20(): number | null {
    return this._lastMa20;
  }

  get view(): ConditionalGridView {
    return {
      qty: this.qty,
      avgPrice: this.avgPrice,
      entryQty: this.entryQty,
      sellLine: this.avgPrice * (1 + this.cfg.takeProfitPct),
      buyLine: this.avgPrice * (1 - this.cfg.stopLossPct),
    };
  }

  decide(signal: 'BUY' | 'SELL', price: number): ConditionalDecision | null {
    if (signal === 'SELL' && this.qty > 0) {
      this._exitKind = 'STOP_LOSS';
      this._lastExitReason = 'SELL 신호 수신';
      return { side: 'sell', qty: this.qty };
    }
    return this.onPrice(price);
  }

  onPrice(price: number): ConditionalDecision | null {
    if (this.qty <= 0 || !Number.isFinite(price) || price <= 0) return null;

    if (price > this.maxPriceSinceEntry) {
      this.maxPriceSinceEntry = price;
    }

    const curRet = (price - this.avgPrice) / this.avgPrice;
    const maxRet = (this.maxPriceSinceEntry - this.avgPrice) / this.avgPrice;

    // 1. 조기 칼손절 (-0.8%)
    if (curRet <= -this.cfg.stopLossPct + 1e-6) {
      this._exitKind = 'STOP_LOSS';
      this._lastExitReason = `조기 칼손절 (${(curRet * 100).toFixed(2)}%)`;
      return { side: 'sell', qty: this.qty };
    }

    // 2. 목표 익절 (+1.2%)
    if (curRet >= this.cfg.takeProfitPct - 1e-6) {
      this._exitKind = 'TAKE_PROFIT';
      this._lastExitReason = `목표 익절 도달 (+${(curRet * 100).toFixed(2)}%)`;
      return { side: 'sell', qty: this.qty };
    }

    // 3. 핵심 대칭 익절: 20틱 이동평균 중심선(MA20) 도달
    if (this.getMa20) {
      const ma20 = this.getMa20();
      this._lastMa20 = ma20;
      if (ma20 !== null && Number.isFinite(ma20) && price >= ma20) {
        this._exitKind = 'TP_MA20';
        this._lastExitReason = `볼린저 중심선(MA20) 회귀 익절 (+${(curRet * 100).toFixed(2)}%)`;
        return { side: 'sell', qty: this.qty };
      }
    }

    // 4. 홈런 트레일링 익절 (+1.0% 이상 찍고 고점 대비 0.5% 반납)
    if (maxRet >= this.cfg.trailingTriggerPct && curRet <= maxRet - this.cfg.trailingDropPct) {
      this._exitKind = 'TRAILING_STOP';
      this._lastExitReason = `트레일링 익절 (+${(curRet * 100).toFixed(2)}% / 최고 +${(maxRet * 100).toFixed(2)}%)`;
      return { side: 'sell', qty: this.qty };
    }

    // 5. 본절 보호 (+0.6% 이상 터치 후 원금 +0.05%로 밀릴 때)
    if (maxRet >= this.cfg.breakevenTriggerPct && curRet <= 0.0005) {
      this._exitKind = 'BREAKEVEN';
      this._lastExitReason = `본절 보호 (+${(curRet * 100).toFixed(2)}%)`;
      return { side: 'sell', qty: this.qty };
    }

    return null;
  }

  shouldAbort(_side: 'buy' | 'sell', _price: number): boolean {
    return false;
  }

  setPosition(position: ConditionalPosition): void {
    this.qty = position.qty;
    this.avgPrice = position.avgPrice;
  }
}
