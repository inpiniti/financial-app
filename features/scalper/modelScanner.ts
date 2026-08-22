// 모델 스캐너 — "모델 감지" 한 층. 봉 마감마다 트레이딩 리스트 전 종목을 훑어 BUY 신호를 낸다.
//
// 왜 슬롯(WS 틱)이 아니라 여기서 도나(추세와 갈라지는 설계):
//  · 모델 Feature는 토스 5분봉 OHLCV로 배웠다. WS 체결 틱으로 봉을 만들면 거래량 눈금이 달라져
//    거래량 비율 Feature 3개가 학습과 어긋난다(core/model/bars.ts 주석). 그래서 봉은 끝까지 토스에서 읽는다.
//  · 백테스트도 "봉 마감 → 다음 봉 시가 진입"이었다. 봉 마감 직후 스캔이 그 리듬과 같다.
//  · 부수 효과로 판정이 30종목 × 5분에 1회로 묶여 배터리·연산이 예측 가능해진다(800트리 × 30 = 5분에 한 번).
//
// 조회량: 첫 조회만 그날치(기본 150봉 = 04:00~16:00 ET를 항상 덮는다), 이후 봉 마감마다 4봉씩만 덧붙인다.
// 30종목이면 정상 구간에서 5분당 30회 × 4봉 ≈ 수십 KB — 하루 종일 돌려도 부담이 없다.

import { ModelDayBars, type OhlcvBar } from '../../core/model/bars';
import { etDateString } from '../../core/model/session';
import { evaluateModel, type ModelEval } from '../../core/model/signal';
import type { GbdtModel } from '../../core/model/gbdt';
import type { ClockLike } from './types';

/** 첫 조회 봉 수 — 5분봉 150개 = 12.5시간. 정규장 어느 시점에 켜도 그날 04:00까지 닿는다. */
export const MODEL_SEED_BAR_COUNT = 150;
/** 이후 조회 봉 수 — 마감 직후 몇 봉만. 놓친 봉(앱 절전·네트워크 끊김)까지 흡수하도록 여유를 둔다. */
export const MODEL_INCREMENTAL_BAR_COUNT = 6;
/** 스캔 점검 주기(ms) — 봉 마감을 놓치지 않을 만큼만 자주 본다. */
export const MODEL_SCAN_TICK_MS = 20_000;
/** 봉 마감 후 조회까지의 유예(ms) — 토스에 마지막 봉이 올라올 시간. */
export const MODEL_SCAN_DELAY_MS = 5_000;
/** 조회 실패가 이만큼 연속되면 그 종목은 다음 봉까지 쉰다(무한 재시도 방지). */
export const MODEL_MAX_CONSECUTIVE_FAILS = 3;

export interface ModelScannerDeps {
  model: GbdtModel;
  clock: ClockLike;
  scheduler: { setInterval(fn: () => void, ms: number): unknown; clearInterval(handle: unknown): void };
  /** 봉 주기(분) — 학습 채택값 5. */
  barMinutes: number;
  /** 지금 스캔할 티커들(트레이딩 리스트). 매 스캔마다 다시 읽는다. */
  tickers: () => string[];
  /** 종목의 최근 count개 봉(오름차순·원시가·진행 중 봉 제외). 실패는 throw. */
  fetchBars: (ticker: string, count: number) => Promise<OhlcvBar[]>;
  /** 종목의 최근 일봉 종가(날짜 오름차순, 원시가) — 전일·전전일 종가용. 하루 한 번만 부른다. */
  fetchDailyCloses: (ticker: string) => Promise<Array<{ date: string; close: number }>>;
  /** BUY 신호 — 신호 봉과 판정 결과를 함께 넘긴다. */
  onSignal: (ticker: string, ev: ModelEval, bar: OhlcvBar) => void;
  /** 진단 이벤트(선택). */
  onEvent?: (text: string) => void;
}

interface SymbolState {
  bars: ModelDayBars;
  /** 판정을 끝낸 마지막 봉 키 — 같은 봉을 두 번 판정하지 않는다. */
  evaluatedKey: number | null;
  /** 전일·전전일 종가를 받아 둔 ET 날짜 — 날짜가 바뀌면 다시 받는다. */
  dailyForDate: string | null;
  prevClose: number | null;
  prevPrevClose: number | null;
  fails: number;
}

export class ModelScanner {
  private readonly deps: ModelScannerDeps;
  private readonly states = new Map<string, SymbolState>();
  private timer: unknown = null;
  private pumping = false;

  constructor(deps: ModelScannerDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = this.deps.scheduler.setInterval(() => void this.pump(), MODEL_SCAN_TICK_MS);
    void this.pump();
  }

  stop(): void {
    if (this.timer === null) return;
    this.deps.scheduler.clearInterval(this.timer);
    this.timer = null;
  }

  /** 종목이 리스트에서 빠졌을 때 — 봉·맥락을 버린다. */
  drop(ticker: string): void {
    this.states.delete(ticker);
  }

  /** 화면·진단용 — 그 종목의 마지막 판정 시점 봉 수. 아직 없으면 null. */
  barCount(ticker: string): number | null {
    return this.states.get(ticker)?.bars.size ?? null;
  }

  /** 마지막으로 닫힌 봉의 키(봉 시작 epoch 분). 유예 시간 전이면 그 앞 봉을 돌려준다. */
  private lastClosedBarKey(nowMs: number): number {
    const m = this.deps.barMinutes;
    const cur = Math.floor(nowMs / (60_000 * m)) * m;
    const sinceOpen = nowMs - cur * 60_000;
    return sinceOpen >= MODEL_SCAN_DELAY_MS ? cur - m : cur - 2 * m;
  }

  /** 한 바퀴 — 아직 이번 봉을 판정하지 않은 종목만 순서대로 처리한다(직렬, 겹침 방지). */
  async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      const now = this.deps.clock.now();
      const targetKey = this.lastClosedBarKey(now);
      const live = new Set(this.deps.tickers());
      for (const t of [...this.states.keys()]) if (!live.has(t)) this.states.delete(t);

      for (const ticker of live) {
        const state = this.stateOf(ticker);
        if (state.evaluatedKey === targetKey) continue;
        if (state.fails >= MODEL_MAX_CONSECUTIVE_FAILS) {
          // 이번 봉은 건너뛰되 다음 봉엔 다시 시도한다.
          state.evaluatedKey = targetKey;
          state.fails = 0;
          continue;
        }
        try {
          await this.scanOne(ticker, state, targetKey);
          state.fails = 0;
        } catch (err) {
          state.fails += 1;
          if (state.fails === MODEL_MAX_CONSECUTIVE_FAILS) {
            this.deps.onEvent?.(`${ticker} 모델 봉 조회 실패 · ${summarize(err)} — 다음 봉에 다시 시도해요`);
          }
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private stateOf(ticker: string): SymbolState {
    let s = this.states.get(ticker);
    if (!s) {
      s = {
        bars: new ModelDayBars(this.deps.barMinutes),
        evaluatedKey: null,
        dailyForDate: null,
        prevClose: null,
        prevPrevClose: null,
        fails: 0,
      };
      this.states.set(ticker, s);
    }
    return s;
  }

  private async scanOne(ticker: string, state: SymbolState, targetKey: number): Promise<void> {
    // 첫 조회이거나 봉이 끊겼으면 그날치를 다시 받는다(앱 절전 복귀·거래일 전환).
    const gap = state.bars.lastKey === null ? Infinity : (targetKey - state.bars.lastKey) / this.deps.barMinutes;
    const count = gap > MODEL_INCREMENTAL_BAR_COUNT - 1 ? MODEL_SEED_BAR_COUNT : MODEL_INCREMENTAL_BAR_COUNT;
    const fetched = await this.deps.fetchBars(ticker, count);
    state.bars.merge(fetched);

    const last = state.bars.bars[state.bars.size - 1];
    if (!last) {
      state.evaluatedKey = targetKey;
      return;
    }
    // 아직 목표 봉이 안 올라왔으면 다음 점검 때 다시 본다(evaluatedKey를 올리지 않는다).
    if (last.minuteKey < targetKey) return;

    await this.ensureDaily(ticker, state, last.minuteKey);
    const dayOpen = state.bars.dayOpen;
    state.evaluatedKey = targetKey;
    if (dayOpen === null || !(dayOpen > 0)) return;

    const ev = evaluateModel(this.deps.model, {
      bars: state.bars.bars,
      ctx: { dayOpen, prevClose: state.prevClose, prevPrevClose: state.prevPrevClose },
      cumDollarVolume: state.bars.cumDollarVolume,
      barMinutes: this.deps.barMinutes,
    });
    if (ev.signal === 'BUY') this.deps.onSignal(ticker, ev, last);
  }

  /** 전일·전전일 종가 — 거래일당 1회. 실패하면 null로 두고(전일 Feature는 null) 신호는 계속 낸다. */
  private async ensureDaily(ticker: string, state: SymbolState, minuteKey: number): Promise<void> {
    const today = etDateString(minuteKey);
    if (state.dailyForDate === today) return;
    state.dailyForDate = today;
    state.prevClose = null;
    state.prevPrevClose = null;
    try {
      const rows = await this.deps.fetchDailyCloses(ticker);
      const past = rows.filter((r) => r.date < today);
      state.prevClose = past.length > 0 ? past[past.length - 1].close : null;
      state.prevPrevClose = past.length > 1 ? past[past.length - 2].close : null;
    } catch {
      // 전일 계열 Feature 3개만 null이 된다 — 학습도 결측을 그대로 배웠으므로 신호는 계속 낼 수 있다.
    }
  }
}

function summarize(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
