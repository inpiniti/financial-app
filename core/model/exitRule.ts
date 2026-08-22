// 모델 청산 규칙 — 백테스트가 쓴 **기하 그대로**. autopilot의 PositionRule 계약을 구조적으로 만족한다.
//
// 근거(financial-analyze docs/analysis/2026-08-21_final-test-결과.md):
//   백테스트·워크포워드·FINAL TEST의 숫자(PF 1.301, 순 +0.42%/거래)는 전부 이 청산으로 나왔다.
//     · 상단 장벽 +5% 선터치 → 전량 (TAKE_PROFIT)
//     · 하단 장벽 −2% 선터치 → 전량 (STOP_LOSS)
//     · 120분 안에 어느 쪽도 안 닿으면 → 전량 (TIMEOUT)
//     · 물타기 없음(라벨이 "진입가 기준" 선터치라 평단을 낮추면 라벨과 다른 게임이 된다)
//   ⚠ 장벽 기준가는 **진입 평단**이다. 백테스트는 "다음 봉 시가"였고 앱은 실제 체결 평단이다 —
//     이 차이가 실거래 괴리의 1순위 후보다(§남은 리스크 2 "터치 체결 가정은 낙관").
//   ⚠ 백테스트는 봉 고가/저가로 터치를 판정했다. 앱은 체결 틱 현재가로 판정하므로 봉 안 스파이크를
//     놓칠 수 있다(불리한 방향으로도, 유리한 방향으로도). 이것도 페이퍼 단계에서 재는 항목이다.
//
// 판정은 전부 onPrice(현재가) — 봉 마감을 기다리지 않는다. decide(신호)는 아무것도 하지 않는다
// (모델은 청산 신호를 내지 않는다 — 진입 전용 분류기다).

import type { ConditionalDecision, ConditionalGridView, ConditionalPosition } from '../conditional';

/** 청산 기하 — 백테스트 walkforward.py의 UP/DN/HORIZON과 같은 값. */
export interface ModelExitConfig {
  /** 익절 상단(소수, 0.05 = +5%). */
  takeProfitPct: number;
  /** 손절 하단(소수, 0.02 = −2%). */
  stopLossPct: number;
  /** 시간 청산(분). */
  timeoutMinutes: number;
}

export const MODEL_EXIT_CONFIG: ModelExitConfig = {
  takeProfitPct: 0.05,
  stopLossPct: 0.02,
  timeoutMinutes: 120,
};

/** 이번 청산이 어느 장벽이었나 — 호출부가 청산 사유(ExitReason)로 옮긴다. */
export type ModelExitKind = 'TAKE_PROFIT' | 'STOP_LOSS' | 'TIMEOUT';

export interface ModelExitRuleOptions extends ModelExitConfig {
  /** 진입 시각(epoch ms) — 시간 청산의 기준. */
  entryAtMs: number;
  /** 지금 시각 — PositionRule의 onPrice(price)에는 시각 인자가 없어 여기로 받는다. 없으면 시간 청산 없음. */
  clock?: { now(): number };
}

export class ModelExitRule {
  private qty: number;
  private avgPrice: number;
  private readonly entryQty: number;
  private readonly cfg: ModelExitConfig;
  private readonly entryAtMs: number;
  private readonly clock: { now(): number } | undefined;
  /** 마지막 onPrice가 낸 결정의 종류 — 호출부가 청산 사유를 읽어 간다. */
  private lastKind: ModelExitKind | null = null;

  constructor(position: ConditionalPosition, options: ModelExitRuleOptions) {
    this.qty = position.qty;
    this.avgPrice = position.avgPrice;
    this.entryQty = position.qty;
    this.entryAtMs = options.entryAtMs;
    this.clock = options.clock;
    this.cfg = {
      takeProfitPct: options.takeProfitPct,
      stopLossPct: options.stopLossPct,
      timeoutMinutes: options.timeoutMinutes,
    };
  }

  /** 익절선(평단×(1+p)). */
  get takeProfitPrice(): number {
    return this.avgPrice * (1 + this.cfg.takeProfitPct);
  }

  /** 손절선(평단×(1−p)). */
  get stopLossPrice(): number {
    return this.avgPrice * (1 - this.cfg.stopLossPct);
  }

  /** 시간 청산 시각(epoch ms). */
  get timeoutAtMs(): number {
    return this.entryAtMs + this.cfg.timeoutMinutes * 60_000;
  }

  /** 직전 결정의 장벽 종류 — 결정이 없었으면 null. */
  get exitKind(): ModelExitKind | null {
    return this.lastKind;
  }

  /**
   * 틱 판정 — 세 장벽 중 하나라도 닿으면 전량 매도.
   * 동시 판정 순서는 백테스트와 같은 보수 규약: **하단 먼저**(같은 순간 양쪽이면 패로 본다).
   * nowMs를 주지 않으면 시간 청산은 판정하지 않는다(순수 가격 판정만).
   */
  onPriceAt(price: number, nowMs?: number): ConditionalDecision | null {
    this.lastKind = null;
    if (!Number.isFinite(price) || price <= 0 || this.qty <= 0) return null;
    if (price <= this.stopLossPrice) {
      this.lastKind = 'STOP_LOSS';
      return { side: 'sell', qty: this.qty };
    }
    if (price >= this.takeProfitPrice) {
      this.lastKind = 'TAKE_PROFIT';
      return { side: 'sell', qty: this.qty };
    }
    if (nowMs !== undefined && nowMs >= this.timeoutAtMs) {
      this.lastKind = 'TIMEOUT';
      return { side: 'sell', qty: this.qty };
    }
    return null;
  }

  // ---- PositionRule 계약 ----

  /** 관리자가 매 틱 부르는 판정 — 시간 청산은 주입된 clock으로 잰다. */
  onPrice(price: number): ConditionalDecision | null {
    return this.onPriceAt(price, this.clock?.now());
  }

  get view(): ConditionalGridView {
    return {
      qty: this.qty,
      avgPrice: this.avgPrice,
      entryQty: this.entryQty,
      sellLine: this.takeProfitPrice,
      buyLine: this.stopLossPrice,
    };
  }

  /** 모델은 청산 신호를 내지 않는다 — 신호 경로로는 아무 결정도 하지 않는다. */
  decide(_signal: 'BUY' | 'SELL', _price: number): ConditionalDecision | null {
    return null;
  }

  /** 취소선 없음 — 장벽에 닿았으면 체결될 때까지 따라간다. */
  shouldAbort(_side: 'buy' | 'sell', _price: number): boolean {
    return false;
  }

  setPosition(position: ConditionalPosition): void {
    this.qty = position.qty;
    this.avgPrice = position.avgPrice;
  }
}
