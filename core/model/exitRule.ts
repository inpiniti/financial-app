// 모델 청산 규칙 — **트레일링 스톱**(2026-08-24 전환). 백테스트가 쓴 기하 그대로.
//
// 왜 바뀌었나(financial-analyze docs/analysis/2026-08-24_청산-연구.md):
//   옛 규칙은 평단 +5% 고정 익절이었다. 그런데 +5%에 판 거래의 **72.6%가 그날 +10% 이상까지** 갔다
//   (중앙 +15.2%, 최대 +1031%). 이기는 거래를 매번 상한에서 잘라내고 있었다.
//   진입 신호를 그대로 두고 청산만 바꿔 4폴드(2024-07~2026-04) 비교한 결과:
//     +5%/−2%/120분 : 거래당 +0.33% · PF 1.239 · 합계 +21.9
//     트레일 −5%     : 거래당 +0.62% · PF 1.458 · 합계 +38.1   ← 1.74배, 4폴드 전부 우세
//   **최악 1건은 −2.4%로 동일하다** — 위험을 더 지는 게 아니라 이기는 거래를 안 자르는 것이다.
//   대가: 승률이 38.3% → 33.6%로 내려간다(간신히 +5% 찍고 되돌아온 거래가 이김→짐으로 넘어간다).
//
// 규칙 — 둘 중 **먼저** 닿는 것으로 전량 매도. 익절 상한은 없다.
//   ① 트레일링: 현재가 ≤ 진입 후 고점 × (1 − 0.05)
//   ② 하드 손절: 현재가 ≤ 평단 × (1 − 0.02)
//   ③ 장 마감(20:00 ET): 어느 쪽에도 안 닿으면 청산
//   실효 손절선 = max(평단×0.98, 고점×0.95) — 고점이 오르면 따라 올라가고 **절대 내려오지 않는다**.
//   그래서 진입 직후(고점이 평단 대비 +3.2% 미만)에는 하드 손절 −2%가 그대로 작동한다.
//
// ⚠ 이상치 방어(필수, 같은 문서 §2): 백테스트에서 액면분할 잔재 고가(NVDA·AVGO·NFLX ×10~11) 한 봉이
//   트레일링 총이익의 절반을 가짜로 만든 사고가 있었다. 실거래에도 같은 위험이 있다 — KIS 체결가에
//   오체결이 한 건 오면 고점이 튀어 **즉시 매도**된다. 그래서 급변 틱은 **다음 틱이 확인해 줄 때까지**
//   반영하지 않는다(acceptPrice). 진짜 급등·급락은 다음 틱에서 확인되므로 최대 1틱만 늦어진다.
//
// 물타기는 없다 — decide(신호)는 항상 null이다(모델은 청산 신호를 내지 않는다).

import type { ConditionalDecision, ConditionalGridView, ConditionalPosition } from '../conditional';
import { etMinuteOfDay, TRADING_DAY_END_MIN } from './session';

/** 청산 기하 — financial-analyze의 A2c(트레일 −5%) + 하드 손절 −2%. */
export interface ModelExitConfig {
  /** 트레일링 폭(소수, 0.05 = 고점 대비 −5%). */
  trailPct: number;
  /** 하드 손절(소수, 0.02 = 평단 대비 −2%). */
  stopLossPct: number;
}

export const MODEL_EXIT_CONFIG: ModelExitConfig = {
  trailPct: 0.05,
  stopLossPct: 0.02,
};

// ---------------------------------------------------------------------------
// ±3% 대칭 청산 (2026-09-01 — 1분봉 × ±3% 대칭 라벨 재학습과 세트)
// ---------------------------------------------------------------------------

/**
 * 대칭 청산 스위치 — 모델이 예측하는 사건(+3%가 −3%보다 먼저)과 청산 규칙을 한 몸으로 묶는다(학습-실행 일치).
 * 검증: financial-analyze docs/analysis/2026-09-01_1분봉-대칭-3퍼센트-워크포워드.md — 4폴드 전부 흑자
 * (승률 58.0~58.4% · PF 1.136~1.164 · 합계 +39.2, 현행 트레일 기하의 +5/−2 모델 +21.9 대비 1.8배).
 * false로 두면 트레일 −5%/하드 −2%(위 MODEL_EXIT_CONFIG)로 **한 줄 롤백** — 단 그 경우 model.json도
 * +5/−2 라벨 모델로 되돌려야 학습-실행이 일치한다(2026-08-31 이전 커밋의 model.json).
 */
export const MODEL_EXIT_SYMMETRIC = true;

/** 대칭 청산 기하 — 워크포워드가 검증한 값 그대로(±3%/120분). 바꾸면 그 숫자가 근거가 아니게 된다. */
export interface ModelSymmetricExitConfig {
  /** 익절 폭(소수, 0.03) — 평단 +3% 도달 시 전량 매도. */
  tpPct: number;
  /** 손절 폭(소수, 0.03) — 평단 −3% 도달 시 전량 매도. */
  stopLossPct: number;
  /** 최장 보유(분, 120) — 진입 후 이 시간이 지나면 어느 선에도 안 닿았어도 전량 매도(백테스트 horizon). */
  maxHoldMin: number;
}

export const MODEL_SYMMETRIC_EXIT_CONFIG: ModelSymmetricExitConfig = {
  tpPct: 0.03,
  stopLossPct: 0.03,
  maxHoldMin: 120,
};

/**
 * 이상치로 보는 1틱 변동폭. 이보다 크게 튀면 **다음 틱이 같은 방향을 확인할 때까지** 무시한다.
 * 백테스트 세정(bars_io.py)의 꼬리 허용 폭 30%와 같은 값 — 급등주의 진짜 1분 급등은 이 안에 들어온다.
 */
export const OUTLIER_JUMP_PCT = 0.30;

/** 이번 청산이 어느 조건이었나 — 호출부가 청산 사유(ExitReason)로 옮긴다. */
export type ModelExitKind = 'TRAIL' | 'STOP_LOSS' | 'SESSION_END';

/** 대칭 청산의 결정 종류 — TAKE_PROFIT(+3%) / STOP_LOSS(−3%) / TIMEOUT(120분) / SESSION_END(20:00 ET). */
export type ModelSymmetricExitKind = 'TAKE_PROFIT' | 'STOP_LOSS' | 'TIMEOUT' | 'SESSION_END';

export interface ModelExitRuleOptions extends ModelExitConfig {
  /** 진입 시각(epoch ms) — 기록·진단용. */
  entryAtMs: number;
  /** 지금 시각 — PositionRule의 onPrice(price)에는 시각 인자가 없어 여기로 받는다. 없으면 장 마감 청산 없음. */
  clock?: { now(): number };
}

export class ModelExitRule {
  private qty: number;
  private avgPrice: number;
  private readonly entryQty: number;
  private readonly cfg: ModelExitConfig;
  private readonly entryAtMs: number;
  private readonly clock: { now(): number } | undefined;

  /** 진입 후 고점 — 트레일링의 기준. 평단에서 시작해 올라가기만 한다. */
  private peak: number;
  /** 마지막으로 **받아들인** 가격 — 이상치 판정의 기준선. */
  private lastAccepted: number;
  /** 직전에 이상치로 보류한 가격(다음 틱이 확인해 주면 받아들인다). */
  private pending: number | null = null;
  private lastKind: ModelExitKind | null = null;

  constructor(position: ConditionalPosition, options: ModelExitRuleOptions) {
    this.qty = position.qty;
    this.avgPrice = position.avgPrice;
    this.entryQty = position.qty;
    this.entryAtMs = options.entryAtMs;
    this.clock = options.clock;
    this.cfg = { trailPct: options.trailPct, stopLossPct: options.stopLossPct };
    this.peak = position.avgPrice;
    this.lastAccepted = position.avgPrice;
  }

  /** 하드 손절선(평단×(1−p)) — 절대 하한. */
  get hardStopPrice(): number {
    return this.avgPrice * (1 - this.cfg.stopLossPct);
  }

  /** 지금 유효한 매도선 = max(하드 손절선, 고점×(1−트레일폭)). 올라가기만 한다. */
  get stopPrice(): number {
    return Math.max(this.hardStopPrice, this.peak * (1 - this.cfg.trailPct));
  }

  /** 진입 후 고점(뷰·진단용). */
  get peakPrice(): number {
    return this.peak;
  }

  get entryAt(): number {
    return this.entryAtMs;
  }

  /** 직전 결정의 종류 — 결정이 없었으면 null. */
  get exitKind(): ModelExitKind | null {
    return this.lastKind;
  }

  /**
   * 이상치 필터 — 받아들일 가격이면 그 값을, 보류하면 null.
   * 직전 채택가 대비 ±OUTLIER_JUMP_PCT를 넘으면 한 틱 보류하고, **다음 틱이 같은 수준을 확인**하면 받아들인다.
   * (오체결은 한 틱으로 끝나고, 진짜 급변은 다음 틱에서도 그 근처에 있다.)
   */
  private acceptPrice(price: number): number | null {
    const lo = this.lastAccepted * (1 - OUTLIER_JUMP_PCT);
    const hi = this.lastAccepted * (1 + OUTLIER_JUMP_PCT);
    if (price >= lo && price <= hi) {
      this.pending = null;
      this.lastAccepted = price;
      return price;
    }
    // 밴드 밖 — 직전에 보류한 값과 같은 방향·비슷한 수준이면 진짜 급변으로 인정한다.
    if (this.pending !== null) {
      const confirmLo = this.pending * (1 - OUTLIER_JUMP_PCT);
      const confirmHi = this.pending * (1 + OUTLIER_JUMP_PCT);
      if (price >= confirmLo && price <= confirmHi) {
        this.pending = null;
        this.lastAccepted = price;
        return price;
      }
    }
    this.pending = price;
    return null;
  }

  /**
   * 틱 판정. nowMs를 주면 장 마감(20:00 ET) 청산도 본다.
   * 판정 순서는 백테스트와 같은 보수 규약 — **매도선(하단) 먼저**.
   */
  onPriceAt(price: number, nowMs?: number): ConditionalDecision | null {
    this.lastKind = null;
    if (!Number.isFinite(price) || price <= 0 || this.qty <= 0) return null;

    const accepted = this.acceptPrice(price);
    if (accepted === null) return null; // 이상치 보류 — 이 틱으로는 아무 판정도 하지 않는다.

    // 매도선 판정은 **고점을 갱신하기 전** 값으로 한다(백테스트: 직전까지의 고점 기준).
    const stop = this.stopPrice;
    if (accepted <= stop) {
      this.lastKind = accepted <= this.hardStopPrice ? 'STOP_LOSS' : 'TRAIL';
      return { side: 'sell', qty: this.qty };
    }
    if (accepted > this.peak) this.peak = accepted;

    if (nowMs !== undefined && etMinuteOfDay(Math.floor(nowMs / 60_000)) >= TRADING_DAY_END_MIN) {
      this.lastKind = 'SESSION_END';
      return { side: 'sell', qty: this.qty };
    }
    return null;
  }

  // ---- PositionRule 계약 ----

  /** 관리자가 매 틱 부르는 판정 — 장 마감은 주입된 clock으로 잰다. */
  onPrice(price: number): ConditionalDecision | null {
    return this.onPriceAt(price, this.clock?.now());
  }

  get view(): ConditionalGridView {
    return {
      qty: this.qty,
      avgPrice: this.avgPrice,
      entryQty: this.entryQty,
      // 게이지 위끝은 진입 후 고점(익절 상한이 없으므로 "여기까지 올랐다"를 보여준다), 아래끝은 지금 매도선.
      sellLine: this.peak,
      buyLine: this.stopPrice,
    };
  }

  /** 모델은 청산 신호를 내지 않는다 — 신호 경로로는 아무 결정도 하지 않는다(물타기 없음). */
  decide(_signal: 'BUY' | 'SELL', _price: number): ConditionalDecision | null {
    return null;
  }

  /** 취소선 없음 — 매도선에 닿았으면 체결될 때까지 따라간다. */
  shouldAbort(_side: 'buy' | 'sell', _price: number): boolean {
    return false;
  }

  /**
   * 잔고 재조회 반영. 평단이 바뀌면 하드 손절선도 따라 움직인다.
   * 고점은 **낮추지 않는다** — 트레일링 기준은 진입 후 실제로 도달한 최고가다.
   */
  setPosition(position: ConditionalPosition): void {
    this.qty = position.qty;
    this.avgPrice = position.avgPrice;
    if (position.avgPrice > this.peak) this.peak = position.avgPrice;
  }
}

export interface ModelSymmetricExitRuleOptions extends ModelSymmetricExitConfig {
  /** 진입 시각(epoch ms) — 최장 보유(120분) 판정의 기준. */
  entryAtMs: number;
  /** 지금 시각 — 최장 보유·장 마감 판정. 없으면 시간 청산 없음(테스트 편의). */
  clock?: { now(): number };
}

/**
 * ±3% 대칭 청산 규칙(2026-09-01) — 모델 라벨(+3%가 −3%보다 먼저, 120분)과 같은 기하로 판다.
 * 판정 순서는 백테스트(walkforward.simulate)와 같은 보수 규약 — **손절(하단) 먼저**, 동시 터치는 손절.
 * 익절 매도는 목표가 지정가 의미론(현재가가 목표 아래로 내려가면 접는다 — MartingaleRule과 동일),
 * 손절·시간·마감 매도는 무조건 체결까지 따라간다. 이상치 방어(acceptPrice)는 트레일링 규칙과 같은 이유로 유지.
 */
export class ModelSymmetricExitRule {
  private qty: number;
  private avgPrice: number;
  private readonly entryQty: number;
  private readonly cfg: ModelSymmetricExitConfig;
  private readonly entryAtMs: number;
  private readonly clock: { now(): number } | undefined;

  /** 마지막으로 받아들인 가격 — 이상치 판정 기준선(ModelExitRule.acceptPrice와 같은 규약). */
  private lastAccepted: number;
  private pending: number | null = null;
  private lastKind: ModelSymmetricExitKind | null = null;
  /** 진행 중 매도가 어떤 결정이었나 — 취소선(shouldAbort) 판정용. */
  private pendingExit: ModelSymmetricExitKind | null = null;

  constructor(position: ConditionalPosition, options: ModelSymmetricExitRuleOptions) {
    this.qty = position.qty;
    this.avgPrice = position.avgPrice;
    this.entryQty = position.qty;
    this.entryAtMs = options.entryAtMs;
    this.clock = options.clock;
    this.cfg = { tpPct: options.tpPct, stopLossPct: options.stopLossPct, maxHoldMin: options.maxHoldMin };
    this.lastAccepted = position.avgPrice;
  }

  /** 익절 목표가 = 평단 × (1 + tpPct). */
  get targetPrice(): number {
    return this.avgPrice * (1 + this.cfg.tpPct);
  }

  /** 손절선 = 평단 × (1 − stopLossPct). */
  get stopPrice(): number {
    return this.avgPrice * (1 - this.cfg.stopLossPct);
  }

  /** 최장 보유 만료 시각(epoch ms). */
  get holdUntilMs(): number {
    return this.entryAtMs + this.cfg.maxHoldMin * 60_000;
  }

  get entryAt(): number {
    return this.entryAtMs;
  }

  get exitKind(): ModelSymmetricExitKind | null {
    return this.lastKind;
  }

  /** 이상치 필터 — ModelExitRule.acceptPrice와 같은 규약(±30% 튐은 다음 틱 확인까지 보류). */
  private acceptPrice(price: number): number | null {
    const lo = this.lastAccepted * (1 - OUTLIER_JUMP_PCT);
    const hi = this.lastAccepted * (1 + OUTLIER_JUMP_PCT);
    if (price >= lo && price <= hi) {
      this.pending = null;
      this.lastAccepted = price;
      return price;
    }
    if (this.pending !== null) {
      const confirmLo = this.pending * (1 - OUTLIER_JUMP_PCT);
      const confirmHi = this.pending * (1 + OUTLIER_JUMP_PCT);
      if (price >= confirmLo && price <= confirmHi) {
        this.pending = null;
        this.lastAccepted = price;
        return price;
      }
    }
    this.pending = price;
    return null;
  }

  /** 틱 판정 — 손절(보수, 동시 터치는 손절) → 익절 → 최장 보유(120분) → 장 마감(20:00 ET). */
  onPriceAt(price: number, nowMs?: number): ConditionalDecision | null {
    this.lastKind = null;
    if (!Number.isFinite(price) || price <= 0 || this.qty <= 0) return null;
    const accepted = this.acceptPrice(price);
    if (accepted === null) return null;

    if (accepted <= this.stopPrice) {
      this.lastKind = 'STOP_LOSS';
      this.pendingExit = 'STOP_LOSS';
      return { side: 'sell', qty: this.qty };
    }
    if (accepted >= this.targetPrice) {
      this.lastKind = 'TAKE_PROFIT';
      this.pendingExit = 'TAKE_PROFIT';
      return { side: 'sell', qty: this.qty };
    }
    if (nowMs !== undefined) {
      if (nowMs >= this.holdUntilMs) {
        this.lastKind = 'TIMEOUT';
        this.pendingExit = 'TIMEOUT';
        return { side: 'sell', qty: this.qty };
      }
      if (etMinuteOfDay(Math.floor(nowMs / 60_000)) >= TRADING_DAY_END_MIN) {
        this.lastKind = 'SESSION_END';
        this.pendingExit = 'SESSION_END';
        return { side: 'sell', qty: this.qty };
      }
    }
    return null;
  }

  // ---- PositionRule 계약 ----

  onPrice(price: number): ConditionalDecision | null {
    return this.onPriceAt(price, this.clock?.now());
  }

  get view(): ConditionalGridView {
    return {
      qty: this.qty,
      avgPrice: this.avgPrice,
      entryQty: this.entryQty,
      sellLine: this.targetPrice,
      buyLine: this.stopPrice,
    };
  }

  /** 모델은 청산 신호를 내지 않는다 — 물타기도 없다. */
  decide(_signal: 'BUY' | 'SELL', _price: number): ConditionalDecision | null {
    return null;
  }

  /** 취소선 — 익절 매도만 목표가 아래로 내려가면 접는다. 손절·시간·마감은 무조건 판다. */
  shouldAbort(side: 'buy' | 'sell', price: number): boolean {
    if (!Number.isFinite(price) || price <= 0) return false;
    if (side === 'buy') return false;
    if (this.pendingExit !== 'TAKE_PROFIT') return false;
    return price < this.targetPrice;
  }

  /** 체결·잔고 반영. */
  setPosition(position: ConditionalPosition): void {
    if (position.qty >= this.qty) this.pendingExit = null; // 매도가 끝나지 않았다 — 취소선 상태 초기화
    this.qty = position.qty;
    this.avgPrice = position.avgPrice;
  }
}
