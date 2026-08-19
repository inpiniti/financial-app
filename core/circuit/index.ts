// core/circuit — 서킷(LULD 정지) 감지·정지 수열·청산 판정 (순수 TS, 의존 0).
//
// 도메인 문서: docs/domain/서킷/2026-08-19_서킷-개념과-설계.md (§3 규칙 정본)
// 구현 계획: docs/domain/서킷/2026-08-19_서킷-감지-재개매도-plan.md
//
//  · HaltDetector  — 체결 시각·가격만 보고 "정지 의심(무체결 ≥ quietMs, 직전 activeWindowMs 안 체결 ≥ minActiveTicks)"과
//                    "재개(정지 뒤 첫 체결, 갭 %)"를 낸다. 세션 필터(정규장만)는 호출부가 건다.
//  · HaltSequence  — 정지 직전가 수열 p_k·방향 d_k·재개 창 w_k(재개 첫 체결~마지막 체결 초)를 쌓고
//                    "서킷 상태"(w_k < shortWindowSec 인 채 재정지 → 진입, 재개 뒤 releaseSec 무정지 → 해제)를 판정한다.
//  · CircuitExitRule — 추세 청산 규칙(PositionRule)을 감싸는 데코레이터. 서킷 상태면 ma5 SELL을 무시하고,
//                    하킷 2연속 or 손절선이면 정지 중 "정지 직전가 × (1−sellDiscountPct)" 지정가 매도 결정을 낸다
//                    (재개 단일가에 소화 — 경매가 ≥ 지정가면 경매가로 체결). act=false면 관측(이벤트)만 하고 결정은 안 낸다.
//
// 상수는 08-18 AIXC 실측(정지 24회·창 60초 미만·하킷 재개 갭 −1~−10%)과 사용자 확정값 — 문서 §5 재검토 대상.

import type { ConditionalDecision, ConditionalGridView, ConditionalPosition } from '../conditional';

export interface HaltDetectorOptions {
  /** 무체결 판정 시간(ms, 기본 45초). */
  quietMs?: number;
  /** 활발함 판정 창(ms, 기본 3분) — 마지막 체결 직전 이 창 안의 체결 수를 센다. */
  activeWindowMs?: number;
  /** 활발함 판정 최소 체결 수(기본 30). 저유동 종목의 자연 공백을 정지로 오판하지 않기 위한 문턱. */
  minActiveTicks?: number;
  /**
   * 직전 정지 감지 뒤 이 시간(ms, 기본 15분) 안에는 활발함 문턱을 풀어 "재개 뒤 체결 1건 이상 + 무체결"만으로 정지를 본다 —
   * 서킷 연속 구간은 재개 창이 몇 초라 3분 창에 체결 30건이 안 쌓인다(AIXC 08-18). 첫 정지만 활발함 문턱을 넘으면 된다.
   */
  relaxAfterHaltMs?: number;
}

export type HaltEvent =
  | {
      kind: 'HALT_SUSPECT';
      /** 정지 직전 체결가(p_k). */
      price: number;
      /** 마지막 체결 시각(ms). */
      lastTradeAt: number;
      /** 감지 시각(ms). */
      at: number;
      /** 활발함 창 첫 체결가 — 첫 정지의 방향 기준(문서 §3 k=1). */
      refPrice: number;
      /** 활발함 창 안 체결 수. */
      activeTicks: number;
    }
  | {
      kind: 'RESUME';
      /** 재개 첫 체결가. */
      price: number;
      at: number;
      /** 정지 직전가 대비 갭(소수). */
      gapPct: number;
      /** 정지 길이(ms) — 마지막 체결 ~ 재개 첫 체결. */
      haltedMs: number;
    };

/**
 * 정지 감지기 — 호출부가 (a) 체결마다 pushTrade (b) 주기적으로 poll 을 부른다.
 * 1초 폴에서 슬롯의 (마지막 체결가, 마지막 체결 시각)만 넘겨도 된다 — 같은 시각은 중복 기록하지 않는다.
 */
export class HaltDetector {
  private readonly quietMs: number;
  private readonly activeWindowMs: number;
  private readonly minActiveTicks: number;
  private readonly relaxAfterHaltMs: number;
  private lastHaltDetectedAt: number | null = null;
  /** 최근 체결 (시각, 가격) — activeWindowMs×2 보존. */
  private trades: { at: number; price: number }[] = [];
  private lastAt: number | null = null;
  private lastPrice: number | null = null;
  private halted = false;
  private haltPrice: number | null = null;
  private haltLastTradeAt: number | null = null;

  constructor(options: HaltDetectorOptions = {}) {
    this.quietMs = options.quietMs ?? 45_000;
    this.activeWindowMs = options.activeWindowMs ?? 180_000;
    this.minActiveTicks = options.minActiveTicks ?? 30;
    this.relaxAfterHaltMs = options.relaxAfterHaltMs ?? 900_000;
  }

  get state(): 'TRADING' | 'HALTED' {
    return this.halted ? 'HALTED' : 'TRADING';
  }

  get lastTradeAt(): number | null {
    return this.lastAt;
  }

  /** 체결 1건 — 정지 중이면 RESUME 을 돌려준다. 같은/과거 시각은 무시(null). */
  pushTrade(price: number, atMs: number): HaltEvent | null {
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(atMs)) return null;
    if (this.lastAt !== null && atMs <= this.lastAt) return null;
    this.lastAt = atMs;
    this.lastPrice = price;
    this.trades.push({ at: atMs, price });
    this.prune(atMs);
    if (!this.halted) return null;
    this.halted = false;
    const hp = this.haltPrice ?? price;
    const ev: HaltEvent = {
      kind: 'RESUME',
      price,
      at: atMs,
      gapPct: hp > 0 ? price / hp - 1 : 0,
      haltedMs: this.haltLastTradeAt !== null ? atMs - this.haltLastTradeAt : 0,
    };
    this.haltPrice = null;
    this.haltLastTradeAt = null;
    return ev;
  }

  /** 주기 폴 — 무체결이 quietMs 를 넘고 직전 창이 활발했으면 HALT_SUSPECT 1회. */
  poll(nowMs: number): HaltEvent | null {
    if (this.halted || this.lastAt === null || this.lastPrice === null) return null;
    if (nowMs - this.lastAt < this.quietMs) return null;
    const last = this.lastAt;
    const windowStart = last - this.activeWindowMs;
    const active = this.trades.filter((t) => t.at >= windowStart && t.at <= last);
    const relaxed = this.lastHaltDetectedAt !== null && nowMs - this.lastHaltDetectedAt <= this.relaxAfterHaltMs;
    if (active.length < (relaxed ? 1 : this.minActiveTicks)) return null;
    this.halted = true;
    this.lastHaltDetectedAt = nowMs;
    this.haltPrice = this.lastPrice;
    this.haltLastTradeAt = last;
    return {
      kind: 'HALT_SUSPECT',
      price: this.lastPrice,
      lastTradeAt: last,
      at: nowMs,
      refPrice: active[0].price,
      activeTicks: active.length,
    };
  }

  private prune(nowMs: number): void {
    const cut = nowMs - this.activeWindowMs * 2;
    let i = 0;
    while (i < this.trades.length && this.trades[i].at < cut) i++;
    if (i > 0) this.trades = this.trades.slice(i);
  }
}

export interface HaltSequenceOptions {
  /** 재개 창이 이보다 짧은 채 재정지면 서킷 상태 진입(초, 기본 60). */
  shortWindowSec?: number;
  /** 재개 뒤 이만큼 정지 없으면 서킷 상태 해제(초, 기본 300). */
  releaseSec?: number;
}

export interface HaltRecord {
  /** 정지 직전 체결가 p_k. */
  price: number;
  /** 마지막 체결 시각(ms). */
  lastTradeAt: number;
  /** 방향 d_k = sign(p_k − p_{k−1}) (k=1은 refPrice 대비). */
  dir: -1 | 0 | 1;
  /** 직전 재개 창 길이(초) — 첫 정지는 null. */
  windowSec: number | null;
}

/** 정지 수열·서킷 상태 — 방향·연속 하킷·재개 창을 기록한다. */
export class HaltSequence {
  private readonly shortWindowMs: number;
  private readonly releaseMs: number;
  readonly halts: HaltRecord[] = [];
  private resumedAt: number | null = null;
  private inCircuitFlag = false;

  constructor(options: HaltSequenceOptions = {}) {
    this.shortWindowMs = (options.shortWindowSec ?? 60) * 1000;
    this.releaseMs = (options.releaseSec ?? 300) * 1000;
  }

  /** 정지 1건 — 직전 재개가 있었으면 창 길이를 확정하고, 짧은 창이면 서킷 상태 진입. */
  onHalt(price: number, lastTradeAt: number, refPrice: number): HaltRecord {
    const prev = this.halts[this.halts.length - 1];
    const base = prev ? prev.price : refPrice;
    const dir: -1 | 0 | 1 = price > base ? 1 : price < base ? -1 : 0;
    const windowSec = this.resumedAt !== null ? Math.max(0, (lastTradeAt - this.resumedAt) / 1000) : null;
    if (windowSec !== null && windowSec * 1000 < this.shortWindowMs) this.inCircuitFlag = true;
    const rec: HaltRecord = { price, lastTradeAt, dir, windowSec };
    this.halts.push(rec);
    this.resumedAt = null;
    return rec;
  }

  onResume(atMs: number): void {
    this.resumedAt = atMs;
  }

  /** 서킷 상태(nowMs 기준) — 재개 뒤 releaseSec 무정지면 해제(해제는 여기서 반영). */
  circuitActive(nowMs: number): boolean {
    if (!this.inCircuitFlag) return false;
    if (this.resumedAt !== null && nowMs - this.resumedAt >= this.releaseMs) {
      this.inCircuitFlag = false;
      return false;
    }
    return true;
  }

  /** 마지막 정지부터 거슬러 연속 하락 정지 수. */
  get consecutiveDown(): number {
    let n = 0;
    for (let i = this.halts.length - 1; i >= 0 && this.halts[i].dir < 0; i--) n++;
    return n;
  }

  get count(): number {
    return this.halts.length;
  }

  get last(): HaltRecord | null {
    return this.halts[this.halts.length - 1] ?? null;
  }
}

/** 감싸는 규칙이 만족해야 하는 최소 계약(autopilot PositionRule과 구조 동일 + 손절선 노출). */
export interface InnerExitRule {
  readonly view: ConditionalGridView;
  decide(signal: 'BUY' | 'SELL', price: number): ConditionalDecision | null;
  onPrice?(price: number): ConditionalDecision | null;
  shouldAbort(side: 'buy' | 'sell', price: number): boolean;
  setPosition(position: ConditionalPosition): void;
  readonly stopLossPrice?: number | null;
}

export interface CircuitExitRuleOptions extends HaltDetectorOptions, HaltSequenceOptions {
  /** 정지 중 매도 지정가 할인(소수, 기본 0.12) — 지정가 = 정지 직전가 × (1−p). */
  sellDiscountPct?: number;
  /** 결정을 실제로 낼 것인가(CIRCUIT_MODE). false면 감지·수열·이벤트만(관측 단계). */
  act?: boolean;
}

/** 관측 입력 — 호출부(1초 폴)가 슬롯의 마지막 체결가·체결 시각을 넘긴다. */
export interface CircuitHeartbeat {
  nowMs: number;
  price: number | null;
  lastTradeAt: number | null;
  /** 정규장(LULD 적용 시간)인가 — false면 새 정지를 감지하지 않는다(진행 중 상태는 유지). */
  regularSession: boolean;
}

export type CircuitEvent =
  | {
      kind: 'HALT';
      record: HaltRecord;
      count: number;
      consecutiveDown: number;
      inCircuit: boolean;
      activeTicks: number;
    }
  | { kind: 'RESUME'; price: number; gapPct: number; haltedMs: number; inCircuit: boolean }
  | { kind: 'CIRCUIT_RELEASED' }
  | { kind: 'SELL'; reason: 'CIRCUIT' | 'STOP_LOSS'; limitPrice: number; haltPrice: number; acted: boolean };

export interface CircuitHeartbeatResult {
  events: CircuitEvent[];
  /** 매도 결정(정지 중 지정가) — 없으면 null. act=false면 항상 null. */
  decision: ConditionalDecision | null;
  /** 결정의 사유(decision이 있을 때). */
  reason: 'CIRCUIT' | 'STOP_LOSS' | null;
}

export class CircuitExitRule {
  readonly inner: InnerExitRule;
  readonly detector: HaltDetector;
  readonly seq: HaltSequence;
  private readonly sellDiscountPct: number;
  private readonly act: boolean;
  private wasCircuit = false;
  private lastPolledTradeAt: number | null = null;

  constructor(inner: InnerExitRule, options: CircuitExitRuleOptions = {}) {
    this.inner = inner;
    this.detector = new HaltDetector(options);
    this.seq = new HaltSequence(options);
    this.sellDiscountPct = options.sellDiscountPct ?? 0.12;
    this.act = options.act ?? true;
  }

  get view(): ConditionalGridView {
    return this.inner.view;
  }

  /** 서킷 상태(마지막 heartbeat 기준). */
  get inCircuit(): boolean {
    return this.wasCircuit;
  }

  get haltCount(): number {
    return this.seq.count;
  }

  /** 봉 신호 — 서킷 상태(act)면 SELL 을 무시한다(문서 §3: 봉이 시간축에서 안 맞고 첫 하킷에서 털린다). */
  decide(signal: 'BUY' | 'SELL', price: number): ConditionalDecision | null {
    if (this.act && this.wasCircuit && signal === 'SELL') return null;
    return this.inner.decide(signal, price);
  }

  onPrice(price: number): ConditionalDecision | null {
    return this.inner.onPrice?.(price) ?? null;
  }

  shouldAbort(side: 'buy' | 'sell', price: number): boolean {
    return this.inner.shouldAbort(side, price);
  }

  setPosition(position: ConditionalPosition): void {
    this.inner.setPosition(position);
  }

  /**
   * 관측 1회(1초 폴) — 체결 반영 → 정지/재개 판정 → 서킷 상태 → 매도 결정.
   * 결정은 정지 감지 시점에 한 번 난다(같은 정지에서 반복 발화 없음 — poll이 정지당 1회만 HALT_SUSPECT를 낸다).
   */
  heartbeat(input: CircuitHeartbeat): CircuitHeartbeatResult {
    const events: CircuitEvent[] = [];
    let decision: ConditionalDecision | null = null;
    let reason: 'CIRCUIT' | 'STOP_LOSS' | null = null;

    if (input.price !== null && input.lastTradeAt !== null && input.lastTradeAt !== this.lastPolledTradeAt) {
      this.lastPolledTradeAt = input.lastTradeAt;
      const ev = this.detector.pushTrade(input.price, input.lastTradeAt);
      if (ev?.kind === 'RESUME') {
        this.seq.onResume(ev.at);
        events.push({
          kind: 'RESUME',
          price: ev.price,
          gapPct: ev.gapPct,
          haltedMs: ev.haltedMs,
          inCircuit: this.seq.circuitActive(input.nowMs),
        });
      }
    }

    if (input.regularSession) {
      const ev = this.detector.poll(input.nowMs);
      if (ev?.kind === 'HALT_SUSPECT') {
        const rec = this.seq.onHalt(ev.price, ev.lastTradeAt, ev.refPrice);
        const inCircuit = this.seq.circuitActive(input.nowMs);
        events.push({
          kind: 'HALT',
          record: rec,
          count: this.seq.count,
          consecutiveDown: this.seq.consecutiveDown,
          inCircuit,
          activeTicks: ev.activeTicks,
        });
        if (inCircuit) {
          const stop = this.inner.stopLossPrice ?? null;
          const qty = this.inner.view.qty;
          let why: 'CIRCUIT' | 'STOP_LOSS' | null = null;
          if (qty > 0) {
            if (stop !== null && rec.price <= stop) why = 'STOP_LOSS';
            else if (this.seq.consecutiveDown >= 2) why = 'CIRCUIT';
          }
          if (why !== null) {
            const limitPrice = rec.price * (1 - this.sellDiscountPct);
            events.push({ kind: 'SELL', reason: why, limitPrice, haltPrice: rec.price, acted: this.act });
            if (this.act) {
              decision = { side: 'sell', qty, limitPrice, chaseAfterTradeAt: ev.lastTradeAt };
              reason = why;
            }
          }
        }
      }
    }

    const nowCircuit = this.seq.circuitActive(input.nowMs);
    if (this.wasCircuit && !nowCircuit) events.push({ kind: 'CIRCUIT_RELEASED' });
    this.wasCircuit = nowCircuit;
    return { events, decision, reason };
  }
}
