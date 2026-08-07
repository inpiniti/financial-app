// LadderDetector — 가상 그리드 사다리(홀 카운트) 진입 감지 (plan: 2026-08-07_변곡점-그리드감지).
//
// 매도실행기(core/grid)의 사다리 논리를 주문 없는 가상 버전으로 감지에 쓴다:
//  · 감시 시작가(트레일링 고점)를 앵커로, 간격 g%씩 떨어질 때마다 가상 매수(홀) 1회를 기록한다.
//  · 직전 레벨에서 g% 반등하면 가상 익절로 보고 사다리를 리셋한다(잔파동 해소 — 신호 없음).
//  · 홀이 triggerCount(기본 3)번 쌓이면 진짜 하락으로 인정해 BUY를 발화한다 — 누적 낙폭이
//    최소 N×g% 있어야 하므로 "찔끔 하락→찔끔 반등" 잔파동은 구조적으로 걸러진다.
// 체결 후 관리는 기존대로 매도그리드(core/grid)가 인계한다 — 여기는 진입 신호만 낸다(BUY 전용).
//
// 플랫폼 무관 순수 TS — 외부 import 없음. 판정 입력은 리샘플 청크 마감가(기존 detector와 같은 주기).

import type { GateInput } from '../detector';

export interface LadderOptions {
  /** 간격 g — 소수(0.01=1%). 다음 가상 매수선 = 직전 레벨×(1−g). 0 이하면 기본 0.01. */
  interval: number;
  /** 홀 횟수 N — 이 횟수째 가상 매수가 찍히면 BUY. 1 미만이면 기본 3. */
  triggerCount: number;
  /** BUY 거래량 스파이크 게이트(배수). 기본 0=끔. detector와 같은 계약(fail-open). */
  minVolumeSpikeRatio?: number;
  /** BUY 체결강도 게이트(STRN). 기본 0=끔. detector와 같은 계약(fail-open). */
  minStrength?: number;
}

export const DEFAULT_LADDER_INTERVAL = 0.01;
export const DEFAULT_LADDER_TRIGGER_COUNT = 3;

export interface LadderResult {
  /** 현재 홀(가상 매수) 카운트 — BUY·리셋 직후엔 0. */
  count: number;
  /** 직전 레벨 가격(마지막 가상 매수가, 카운트 0이면 트레일링 고점). */
  level: number;
  /** 다음 가상 매수선 = level×(1−g). */
  nextBuyLevel: number;
  /** 가상 익절(리셋)선 = level×(1+g). 카운트 0이면 앵커 상향선. */
  resetLevel: number;
  /** 이번 청크에 홀 카운트가 N에 닿아 발화한 매수 신호. 없으면 null. */
  signal: 'BUY' | null;
  /** 홀 카운트는 N 이상인데 거래량/체결강도 게이트만 BUY를 막았는가(UI 배지용). */
  buyGateBlocked: boolean;
  /** 게이트 입력 에코. */
  volumeSpike: number | null;
  strength: number | null;
}

export class LadderDetector {
  private readonly interval: number;
  private readonly triggerCount: number;
  private readonly minVolumeSpikeRatio: number;
  private readonly minStrength: number;

  /** 직전 레벨(마지막 가상 매수가 또는 트레일링 고점). null이면 첫 청크에서 앵커를 세운다. */
  private level: number | null = null;
  private count = 0;

  constructor(options: LadderOptions) {
    this.interval =
      Number.isFinite(options.interval) && options.interval > 0 ? options.interval : DEFAULT_LADDER_INTERVAL;
    this.triggerCount =
      Number.isFinite(options.triggerCount) && options.triggerCount >= 1
        ? Math.floor(options.triggerCount)
        : DEFAULT_LADDER_TRIGGER_COUNT;
    this.minVolumeSpikeRatio = options.minVolumeSpikeRatio ?? 0;
    this.minStrength = options.minStrength ?? 0;
  }

  /**
   * 청크 마감가 1개를 판정한다. 상태기계(plan §3):
   *  1. 첫 청크 → 앵커만 세운다(레벨=가격, 카운트 0 — 신호 없음).
   *  2. 카운트 0에서 가격이 레벨보다 높으면 → 트레일링 고점 갱신(낙폭 기준이 낡지 않게).
   *  3. 가격 ≤ 레벨×(1−g) → 관통한 레벨 수만큼 홀 카운트(급락 1청크 = 여러 홀).
   *  4. 카운트 진행 중 가격 ≥ 레벨×(1+g) → 가상 익절 = 사다리 전체 리셋(신호 없음 — 잔파동 해소).
   *  5. 카운트 ≥ N → 게이트(fail-open) 통과 시 BUY 발화 + 리셋. 게이트 미통과면 buyGateBlocked로
   *     카운트를 유지한 채 다음 청크를 기다린다(그 사이 반등하면 4의 리셋이 우선).
   */
  detect(price: number, gates?: GateInput): LadderResult {
    if (!Number.isFinite(price) || price <= 0) return this.result(null, false, gates);
    if (this.level === null) {
      this.level = price;
      return this.result(null, false, gates);
    }

    if (this.count === 0) {
      // 트레일링 고점 — 상승분을 즉시 반영해 낙폭을 항상 "최근 고점 대비"로 잰다.
      if (price > this.level) this.level = price;
    } else if (price >= this.level * (1 + this.interval)) {
      // 가상 익절 — 실행기의 "매도 체결→SCANNING 복귀"에 해당. 카운트 폐기, 앵커=현재가.
      this.level = price;
      this.count = 0;
    }

    // 가상 매수 — 실행기의 "매수 체결→리브래킷"에 해당. 급락 청크는 관통 레벨 수만큼 센다.
    while (price <= this.level * (1 - this.interval)) {
      this.level = this.level * (1 - this.interval);
      this.count += 1;
    }

    if (this.count >= this.triggerCount) {
      const { pass, blocked } = this.gatesPass(gates);
      if (pass) {
        const res = this.result('BUY', false, gates);
        this.level = price;
        this.count = 0;
        return res;
      }
      return this.result(null, blocked, gates);
    }
    return this.result(null, false, gates);
  }

  /** 사다리 초기화 — 다음 청크에서 앵커를 새로 세운다(감시 재부착 시). */
  reset(): void {
    this.level = null;
    this.count = 0;
  }

  /** 게이트 판정 — 문턱 꺼짐(<=0) 또는 입력 null(판정 불가)이면 통과(fail-open, detector와 동일). */
  private gatesPass(gates?: GateInput): { pass: boolean; blocked: boolean } {
    const volumeSpike = gates?.volumeSpike ?? null;
    const strength = gates?.strength ?? null;
    const pass =
      (this.minVolumeSpikeRatio <= 0 || volumeSpike === null || volumeSpike >= this.minVolumeSpikeRatio) &&
      (this.minStrength <= 0 || strength === null || strength >= this.minStrength);
    return { pass, blocked: !pass };
  }

  private result(signal: 'BUY' | null, buyGateBlocked: boolean, gates?: GateInput): LadderResult {
    const level = this.level ?? 0;
    return {
      count: this.count,
      level,
      nextBuyLevel: level * (1 - this.interval),
      resetLevel: level * (1 + this.interval),
      signal,
      buyGateBlocked,
      volumeSpike: gates?.volumeSpike ?? null,
      strength: gates?.strength ?? null,
    };
  }
}
