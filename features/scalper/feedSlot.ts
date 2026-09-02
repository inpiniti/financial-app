// FeedSlot — 단타 리스트 종목당 1개의 경량 구독 슬롯 (plan §2-1).
//
// RunCycle 없는 얇은 수신기: WS 체결 틱을 받아
//  · 틱/초(TickRateMeter, 순간값)와
//  · 리샘플 버퍼(Resampler)를 **상시** 채운다.
// 변곡점 판정(TrendDetector)은 attach/detach로 탈부착한다 — 버퍼가 항상 차 있으므로
// 부착 즉시(워밍업 재대기 없이) 판정이 가능하다. 부착 직후 첫 청크는 기울기 기준선만
// 세우고(detector prevSlope=null → 전환 신호 없음) 그다음 청크부터 신호가 나온다.
//
// 오케스트레이션(감시 3종 선정·주문)은 autopilot 몫 — 여기는 수신·계산만 한다.

import { TrendDetector, type DetectorResult, type Signal } from '../../core/detector';
import { LadderDetector } from '../../core/ladder';
import { Resampler } from '../../core/resample';
import { MinuteBarBuilder, TREND_BAR_MINUTES, type MinuteBar } from '../../core/trend/bars';
import { bollingerBandWidthPct } from '../../core/trend/entryGate';
import {
  evaluateTrend,
  evaluateTrendLive,
  TREND_LIVE_EVAL_MS,
  TREND_LIVE_SELL,
  type TrendEval,
} from '../../core/trend/signal';
import { MODEL_MODE } from './modelMode';
import type { ModelEval } from '../../core/model/signal';
import {
  evaluateMartingaleBars,
  evaluateMartingaleLive,
  isMartingaleEntryBar,
  MARTINGALE_LIVE_ENTRY,
  MARTINGALE_LIVE_EVAL_MS,
  type MartingaleBarEval,
  type MartingaleEntryEvent,
} from '../../core/martingale';
import { MARTINGALE_BAR_MINUTES, MARTINGALE_MODE } from './martingaleMode';
import { TREND_MODE } from './trendMode';
import { TickRateMeter } from './tickRate';
import { SlopeMeter } from './slopeRate';
import type { ClockLike, TickExtras } from './types';

/**
 * 진입 감지기 선택 스위치 — true면 **사다리 옵션이 주입된** 슬롯이 SG 기울기(TrendDetector) 대신
 * 가상 그리드 사다리(LadderDetector)로 변곡점을 판정한다(2026-08-07 plan L4).
 * false로 두면 기존 SG 감지로 **한 줄 롤백**된다. 사다리 옵션 미주입(기존 하네스)이면 값과 무관하게 SG다.
 */
export const LADDER_ENTRY = true;

/**
 * 변곡점+그리드 조합(2026-08-15 도메인 문서) 스위치 — true면 **inflection이 주입된** 슬롯이
 * 사다리·기존 SG 대신 **신호 전용 SG**(문턱·게이트 전부 끔 = 기울기 부호 전환 즉시 BUY/SELL)로
 * 판정하고, 리샘플도 문서 고정값(청크 1초·버퍼 21)으로 강제한다. LADDER_ENTRY보다 우선한다.
 * false로 두면 기존 사다리 진입으로 **한 줄 롤백**된다. inflection 미주입(기존 하네스)이면 값과 무관하게 기존 동작.
 */
export const INFLECTION_ENTRY = true;
/** 조합 고정값 — 변곡점 청크(초). 문서 §5. */
export const INFLECTION_CHUNK_SECONDS = 1;
/** 조합 고정값 — SG 버퍼 크기(홀수). 문서 §5. */
export const INFLECTION_BUFFER_SIZE = 21;

/** 사다리 감지 옵션 — 간격 g(소수)·홀 횟수 N. managerProvider가 설정 탭 값에서 만든다. */
export interface LadderEntryOptions {
  interval: number;
  triggerCount: number;
}

export interface FeedSlotOptions {
  ticker: string;
  clock: ClockLike;
  /** 리샘플 청크 초(기본 3 — 기존 인스턴스와 동일). */
  chunkSeconds?: number;
  /** SG 버퍼 크기(홀수, 기본 31). */
  bufferSize?: number;
  /** 틱/초 윈도우(ms, 기본 10초 = FEED_RATE_WINDOW_MS — 시계열 간격과 동일해 겹침 0). */
  tickRateWindowMs?: number;
  /** 기울기 봉 크기(ms, 기본 10초 — 틱/초와 같은 시야). */
  slopeWindowMs?: number;
  /** detector 옵션 — 부착 시 새 detector에 그대로 주입. */
  minBuyMomentum?: number;
  minSellMomentum?: number;
  /** BUY 거래량 스파이크 게이트(배수, 0=끔) — 부착 시 새 detector에 그대로 주입. */
  minVolumeSpikeRatio?: number;
  /** BUY 체결강도 게이트(STRN, 0=끔) — 부착 시 새 detector에 그대로 주입. */
  minStrength?: number;
  /**
   * 사다리 감지 옵션 — 주입되고 LADDER_ENTRY=true면 attach 시 SG 대신 사다리 감지기를 만든다.
   * 미주입(기존 하네스·테스트)이면 항상 SG — 회귀 안전.
   */
  ladder?: LadderEntryOptions;
  /**
   * 변곡점+그리드 조합 모드 — true고 INFLECTION_ENTRY=true면 사다리·detector 옵션을 무시하고
   * 신호 전용 SG(전환 즉시 BUY/SELL)로 판정하며, 청크·버퍼도 조합 고정값(1초·21)으로 강제한다.
   * 미주입(기존 하네스·테스트)이면 기존 동작 그대로 — 회귀 안전.
   */
  inflection?: boolean;
  /**
   * 추세 모드(2026-08-18 도메인 문서) — true고 TREND_MODE=true면 리샘플/SG/사다리 대신 **분봉(TREND_BAR_MINUTES분) 로컬 합성 +
   * 분봉 이동평균 4선**으로 BUY/SELL을 낸다(봉 마감마다). 변곡점 조합·사다리보다 우선한다.
   * 미주입(기존 하네스·테스트)이면 기존 동작 그대로 — 회귀 안전.
   */
  trend?: boolean;
  /** 추세 봉 주기(분) — 기본 TREND_BAR_MINUTES(3). 테스트 하네스가 1분봉으로 고정할 때 쓴다. */
  trendBarMinutes?: number;
  /**
   * 모델 모드(2026-08-22) — true고 MODEL_MODE=true면 슬롯은 **스스로 판정하지 않는다**.
   * 봉·4선·리샘플·SG·사다리를 전부 끄고 틱/초·기울기·호가만 유지하며, 신호는 ModelScanner가
   * `emitSignal`로 밀어 넣는다(모델 Feature는 토스 5분봉으로 계산하므로 WS 봉이 필요 없다).
   * 추세·조합·사다리보다 우선한다. 미주입(기존 하네스·테스트)이면 기존 동작 그대로 — 회귀 안전.
   */
  model?: boolean;
  /**
   * 5선 물타기 단타 모드(2026-08-27 ADR 0006 → 2026-09-01 ADR 0007 → 2026-09-02 ADR 0010) —
   * true고 MARTINGALE_MODE=true면 **1분봉** 합성 + 5선으로 "5선 상승 ∧ 종가 5선 상향 돌파" 봉마다 BUY(ctx.kind='entry')를 낸다.
   * 판정은 봉 마감 + 진행 중 봉 실시간(1초 주기, 2026-09-01 — 봉당 발화는 1회) 둘 다다.
   * 같은 신호를 오토파일럿이 미보유면 진입, 보유 중이면 물타기 후보(낙폭 판정은 MartingaleRule.decide)로 나눈다.
   * 청산(익절 +3%·마감)은 포지션 규칙(MartingaleRule)의 틱 판정 몫.
   * 모델·추세·조합·사다리보다 우선한다. 미주입이면 기존 동작 그대로 — 회귀 안전.
   */
  martingale?: boolean;
}

/** 변곡점 신호 콜백 — attach 시 등록. */
export type SlotSignalListener = (signal: Signal, ctx: SlotSignalContext) => void;

/**
 * 속도·기울기 측정 윈도우(공유) — 10초 봉. 시계열 간격(FEED_SERIES_STEP_MS)과 같게 잡아
 * 5칸이 서로 겹치지 않는 독립 봉이 된다(2026-08-14 확정 — 5초는 짧다는 관찰로 10초).
 * 기울기는 봉 평균 대비 변화율(v2)이라 표기값 = 실제 그 봉의 관찰값이다.
 * 틱 미터 클래스 기본값(10초)은 순수 로직·기존 테스트 보존용 — 배선에서 명시로 넘긴다.
 * 속도 내부 단위는 여전히 틱/초 정본 — 최소 속도(minTickRate) 비교도 틱/초 그대로다.
 */
export const FEED_RATE_WINDOW_MS = 10_000;
/** 시계열 칸 간격 — 윈도우와 동일(겹침 0). 5칸 × 10초 = 최근 50초. */
export const FEED_SERIES_STEP_MS = 10_000;
export const FEED_SERIES_POINTS = 5;

export interface SlotSignalContext {
  readonly ticker: string;
  readonly price: number;
  readonly slope: number;
  readonly accel: number;
  readonly at: number;
  /**
   * 신호봉 기준 볼린저 밴드폭(%) — 추세 BUY에만 동봉(챱 차단 게이트용, 2026-08-20 지표 검증).
   * 봉 부족 등 판정 불가면 null, 추세 외 신호(사다리 등)는 undefined.
   */
  readonly bandWidthPct?: number | null;
  /**
   * 물타기 단타 모드의 BUY 종류 — 'entry'=5선 상승·상향 돌파 봉(2026-09-02). 오토파일럿이 미보유면 진입,
   * 보유 중이면 물타기 후보로 포지션 규칙에 넘긴다(낙폭 −3% 미만이면 규칙이 거른다). 다른 모드는 undefined.
   */
  readonly kind?: 'entry';
  /** 물타기 단타 모드 신호의 근거 — 지금은 'cross'(5선 상향 돌파) 하나. */
  readonly entryEvent?: MartingaleEntryEvent;
}

export interface FeedSlotView {
  readonly ticker: string;
  /** 현재 시점 틱/초(10초 윈도우 순간값 — FEED_RATE_WINDOW_MS). */
  readonly tickRate: number;
  /**
   * 현재 시점 기울기(직전 10초 봉 평균 대비 현재 봉 평균의 %변화, v2) — 판정 불가는 null(0=평균 동일과 다름).
   * ⚠ 아래 slope(SG %/청크, 감시 중에만)와 다른 값 — 도메인 문서 §2 용어 구분.
   * (시계열 5칸(tickRateSeries/slopeRateSeries)은 2026-08-29 화면 행 정리로 소비처가 사라져 2026-09-01 제거 —
   *  getView마다 슬롯당 보존 큐 풀스캔 10회를 돌리는 죽은 계산이었다.)
   */
  readonly slopeRate: number | null;
  readonly price: number | null;
  readonly warmedUp: boolean;
  /** detector 부착 여부(= 변곡점 감시 중). */
  readonly watched: boolean;
  readonly slope: number | null;
  readonly accel: number | null;
  readonly lastSignal: Signal | null;
  readonly lastTickAt: number | null;
  /**
   * 마지막 **체결** 틱 시각(서킷 감지용, 2026-08-19) — 체결량(EVOL)이 0인 틱은 호가만 바뀐 것으로 보고 갱신하지 않는다.
   * 체결량 필드가 없으면 체결로 간주(fail-open). lastTickAt과 달리 정지 중엔 멈춰 있어야 한다.
   */
  readonly lastTradeAt: number | null;
  readonly bid1: number | null;
  readonly ask1: number | null;
  /** 당일 고가·저가(체결가 틱의 HIGH/LOW, 마지막 수신값). 아직 없으면 null. */
  readonly dayHigh: number | null;
  readonly dayLow: number | null;
  /** 사다리 감시 스냅샷(사다리 모드로 감시 중일 때만) — 홀 n/N·다음 매수선. SG 모드·미감시면 null. */
  readonly ladder: { count: number; triggerCount: number; nextBuyLevel: number } | null;
  /** 추세 스냅샷(추세 모드에서만) — 마지막 봉 마감 시점 4선·상승 플래그·봉 수. 아직 봉이 없거나 다른 모드면 null. */
  readonly trend: TrendEval | null;
  /**
   * 진행 중(미완성) 봉까지 포함한 추세 스냅샷 — 차트가 그리는 것과 같은 기준(2026-08-22).
   * signal은 SELL이거나 null이다(BUY는 이 경로로 나오지 않는다). 진행 중 봉이 없으면 null.
   */
  readonly trendLive: TrendEval | null;
  /** 진행 중(미완성) 봉의 현재 종가 — 없으면 null. 화면이 "지금 그리는 봉"을 표시할 때 쓴다. */
  readonly trendInProgressClose: number | null;
  /**
   * 마지막 모델 판정 확률(모델 모드에서만, 0~1) — "지금 사면 −2% 전에 +5%에 닿을" 확률.
   * 아직 판정 전이거나 다른 모드면 null. 화면·진단 전용. (modelVerdict.prob의 지름길)
   */
  readonly modelProb: number | null;
  /**
   * 마지막 모델 판정 전체(모델 모드에서만) — 확률에 더해 **왜 판정을 못 했는지**(reject)까지.
   * 스캐너가 매 봉 밀어 넣는다. BUY가 안 나는 대부분의 시간에 화면이 상황을 설명할 유일한 근거다.
   */
  readonly modelVerdict: ModelVerdictView | null;
  /** 물타기 단타 모드의 마지막 봉 판정(5선 상승·돌파) — 다른 모드면 null. 화면·진단 전용. */
  readonly martingale: MartingaleBarEval | null;
  /**
   * 진행 중(미완성) 봉까지 포함한 ±3% 단타 판정 — 차트가 그리는 것과 같은 기준(2026-09-01 실시간 진입).
   * 엔진이 실시간으로 이걸 보고 사므로 화면도 이걸 우선 보여야 화면-엔진이 일치한다. 진행 중 봉이 없으면 null.
   */
  readonly martingaleLive: MartingaleBarEval | null;
}

/** 화면용 모델 판정 스냅샷 — ModelEval에서 화면이 쓰는 것만 + 판정 시각. */
export interface ModelVerdictView {
  readonly prob: number | null;
  readonly reject: ModelEval['reject'];
  readonly bars: number;
  readonly at: number;
  /** 판정에 쓴 마지막 봉의 시작 분 키(epoch 분) — 장이 닫혀 옛 봉 기준이면 화면이 시각을 밝힌다. */
  readonly barKey: number | null;
}

export class FeedSlot {
  readonly ticker: string;
  private readonly clock: ClockLike;
  private readonly meter: TickRateMeter;
  private readonly slopeMeter: SlopeMeter;
  private readonly resampler: Resampler;
  private readonly detectorOptions: {
    minBuyMomentum?: number;
    minSellMomentum?: number;
    minVolumeSpikeRatio?: number;
    minStrength?: number;
  };

  /**
   * 사다리 감지 옵션 — 생성 시 주입값으로 시작하고, 설정 탭 저장 후 setLadderOptions로 갈아끼운다.
   * (readonly면 이미 만들어진 슬롯이 앱을 껐다 켤 때까지 옛 간격·횟수로 계속 판정한다 — 실제 사고.)
   */
  private ladderOptions: LadderEntryOptions | undefined;

  private detector: TrendDetector | null = null;
  /** 사다리 감지기 — LADDER_ENTRY && ladderOptions일 때 detector 대신 이쪽이 부착된다(상호 배타). */
  private ladder: LadderDetector | null = null;
  /** 마지막 사다리 판정 스냅샷(뷰 노출용). */
  private ladderState: { count: number; triggerCount: number; nextBuyLevel: number } | null = null;
  private onSignal: SlotSignalListener | null = null;

  private price: number | null = null;
  private lastTickAt: number | null = null;
  private lastTradeAt: number | null = null;
  private slope: number | null = null;
  private accel: number | null = null;
  private lastSignal: Signal | null = null;
  private bid1: number | null = null;
  private ask1: number | null = null;
  private quoteAt: number | null = null;
  private dayHigh: number | null = null;
  private dayLow: number | null = null;

  /** 변곡점+그리드 조합 모드인가 — 생성 시 확정(INFLECTION_ENTRY AND inflection 주입). */
  private readonly inflectionMode: boolean;
  /** 모델 모드인가 — 생성 시 확정(MODEL_MODE AND model 주입). 추세·조합·사다리보다 우선. */
  private readonly modelMode: boolean;
  /** 추세 모드인가 — 생성 시 확정(TREND_MODE AND trend 주입). 조합·사다리보다 우선. */
  private readonly trendMode: boolean;
  /** 배수 물타기 시험 모드인가 — 생성 시 확정(MARTINGALE_MODE AND martingale 주입). 모든 모드보다 우선. */
  private readonly martingaleMode: boolean;
  /** 물타기 모드 마지막 봉 판정(뷰용). */
  private martingaleEval: MartingaleBarEval | null = null;
  /** 진행 중 봉 포함 최신 ±3% 단타 판정(뷰·실시간 진입용) — 진행 중 봉이 없으면 null. */
  private martingaleLiveEval: MartingaleBarEval | null = null;
  /** 진행 중 봉 진입 BUY를 이미 낸 봉 키 — 같은 봉 되풀이 발화·봉 마감 중복 발화 방지. */
  private liveEntryBarKey: number | null = null;
  /**
   * 분봉 빌더·마지막 추세 판정 — **슬롯 필드로 상시 누적**(리샘플과 같은 원칙). attach/detach는
   * 리스너만 붙였다 뗀다 — 재부착해도 봉 링이 유지돼 매도 직후 122봉을 다시 기다리지 않는다.
   */
  private readonly bars: MinuteBarBuilder;
  private trendEval: TrendEval | null = null;
  /** 진행 중 봉을 포함한 최신 판정(뷰용) — 차트가 그리는 것과 같은 기준. 진행 중 봉이 없으면 null. */
  private trendLiveEval: TrendEval | null = null;
  /** 진행 중 봉 재판정 마지막 시각(ms) — TREND_LIVE_EVAL_MS 스로틀. */
  private lastLiveEvalAt = Number.NEGATIVE_INFINITY;
  /** 진행 중 봉 SELL을 이미 낸 봉 키 — 같은 봉에서 되풀이 발화하지 않게. */
  private liveSellBarKey: number | null = null;
  private trendListener: SlotSignalListener | null = null;
  /** 마지막 모델 판정(모델 모드에서만) — 스캐너가 매 봉 밀어 넣는다. 화면·진단 전용, 판정에는 쓰지 않는다. */
  private modelVerdict: ModelVerdictView | null = null;

  constructor(options: FeedSlotOptions) {
    this.ticker = options.ticker;
    this.clock = options.clock;
    this.martingaleMode = MARTINGALE_MODE && options.martingale === true;
    this.modelMode = !this.martingaleMode && MODEL_MODE && options.model === true;
    this.trendMode = !this.martingaleMode && !this.modelMode && TREND_MODE && options.trend === true;
    // 물타기 모드는 봉 주기가 1분(백테스트 규약) — 주입값보다 우선한다.
    this.bars = new MinuteBarBuilder(
      undefined,
      this.martingaleMode ? MARTINGALE_BAR_MINUTES : (options.trendBarMinutes ?? TREND_BAR_MINUTES),
    );
    this.inflectionMode =
      !this.martingaleMode && !this.modelMode && !this.trendMode && INFLECTION_ENTRY && options.inflection === true;
    // 이력 보존 0 — 시계열 조회(series)를 뷰에서 제거해(2026-09-01) 과거 칸 되계산용 40초 이력이 필요 없다.
    this.meter = new TickRateMeter(options.tickRateWindowMs ?? FEED_RATE_WINDOW_MS, 0);
    this.slopeMeter = new SlopeMeter(options.slopeWindowMs ?? FEED_RATE_WINDOW_MS, 0);
    this.resampler = new Resampler({
      // 조합 모드는 문서 고정값(청크 1초·버퍼 21)을 강제한다 — 주입값이 뭐든 판정 주기가 흔들리면 안 된다.
      chunkSeconds: this.inflectionMode ? INFLECTION_CHUNK_SECONDS : options.chunkSeconds,
      bufferSize: this.inflectionMode ? INFLECTION_BUFFER_SIZE : options.bufferSize,
    });
    this.detectorOptions = {
      minBuyMomentum: options.minBuyMomentum,
      minSellMomentum: options.minSellMomentum,
      minVolumeSpikeRatio: options.minVolumeSpikeRatio,
      minStrength: options.minStrength,
    };
    this.ladderOptions = options.ladder;
  }

  /** WS 체결 틱 1개 수신 — 틱/초·리샘플은 항상, 판정은 부착 시에만. */
  pushTick(price: number, tsMs: number, extras?: TickExtras): DetectorResult | null {
    this.price = price;
    this.lastTickAt = this.clock.now();
    if (extras?.volume === undefined || extras.volume > 0) this.lastTradeAt = this.lastTickAt;
    if (extras?.dayHigh !== undefined) this.dayHigh = extras.dayHigh;
    if (extras?.dayLow !== undefined) this.dayLow = extras.dayLow;
    this.meter.record(this.lastTickAt);
    this.slopeMeter.record(this.lastTickAt, price);

    if (this.martingaleMode) {
      // ±3% 단타 모드 — 봉 마감마다 확정 판정, 봉 중간엔 진행 중 봉을 현재가로 넣은 실시간 판정(2026-09-01 실시간 진입).
      const bar = this.bars.pushTick(price, tsMs);
      if (bar !== null) this.evaluateMartingaleBar(bar, price);
      else this.evaluateMartingaleLive();
      return null;
    }

    if (this.modelMode) {
      // 모델 모드 — 판정은 ModelScanner(토스 5분봉)가 한다. 여기서는 틱/초·기울기·호가만 유지한다.
      return null;
    }

    if (this.trendMode) {
      // 추세 모드 — 봉(TREND_BAR_MINUTES분) 마감마다 4선을 다시 재고 신호를 낸다(리샘플·SG·사다리 미사용).
      const bar = this.bars.pushTick(price, tsMs);
      if (bar !== null) this.evaluateTrendBar(price);
      else this.evaluateTrendLive();
      return null;
    }

    const closed = this.resampler.addTick({
      price,
      ts: tsMs,
      volume: extras?.volume,
      strength: extras?.strength,
    });
    if (closed === null) return null;

    // 사다리 모드 — 마감된 청크 값(틱 평균)으로 홀 카운트를 판정한다(SG 미분 없음, plan §3).
    // 워밍업(버퍼 가득)을 기다리지 않는다 — 버퍼 요건은 SG 창의 것이고, 사다리는 첫 청크가
    // 앵커를 세우는 순간부터 판정 가능하다(2026-08-09 워밍업 제거).
    if (this.ladder !== null) {
      const lres = this.ladder.detect(closed, {
        volumeSpike: this.resampler.volumeSpike(),
        strength: this.resampler.lastStrength,
      });
      this.ladderState = {
        count: lres.count,
        triggerCount: this.ladderOptions?.triggerCount ?? 3,
        nextBuyLevel: lres.nextBuyLevel,
      };
      if (lres.signal) {
        this.lastSignal = lres.signal;
        this.onSignal?.(lres.signal, {
          ticker: this.ticker,
          price,
          slope: 0, // 사다리 모드엔 미분이 없다 — 스냅샷 필드 계약 유지용 0.
          accel: 0,
          at: this.lastTickAt,
        });
      }
      return null;
    }

    // SG 모드 — 미분에 창 전체가 필요하므로 워밍업(버퍼 가득)을 기다린다.
    if (this.detector === null || !this.resampler.warmedUp) return null;

    const res = this.detector.detect(this.resampler.buffer, {
      volumeSpike: this.resampler.volumeSpike(),
      strength: this.resampler.lastStrength,
    });
    if (res.warmedUp) {
      this.slope = res.slope;
      this.accel = res.accel;
    }
    if (res.signal) {
      this.lastSignal = res.signal;
      this.onSignal?.(res.signal, {
        ticker: this.ticker,
        price,
        slope: res.slope ?? 0,
        accel: res.accel ?? 0,
        at: this.lastTickAt,
      });
    }
    return res;
  }

  /** 1호가 수신(체결가 틱에 실려 오는 PBID/PASK) — 발주 단가용 캐시. */
  pushQuote(bid1: number, ask1: number): void {
    this.bid1 = Number.isFinite(bid1) && bid1 > 0 ? bid1 : null;
    this.ask1 = Number.isFinite(ask1) && ask1 > 0 ? ask1 : null;
    this.quoteAt = this.clock.now();
  }

  /** 마지막 호가(발주 참고용) — 없으면 null. */
  get quote(): { bid1: number; ask1: number; at: number } | null {
    if (this.bid1 === null || this.ask1 === null || this.quoteAt === null) return null;
    return { bid1: this.bid1, ask1: this.ask1, at: this.quoteAt };
  }

  /**
   * 변곡점 감시 시작 — 새 detector를 만들어 부착한다(이전 감시 이력과 단절).
   * 버퍼는 이미 차 있으므로 다음 청크 마감부터 바로 판정한다(워밍업 공백 없음 — plan §2-1).
   */
  attachDetector(onSignal: SlotSignalListener): void {
    if (this.modelMode || this.martingaleMode) {
      // 모델 모드 — 감지기 객체가 없다. 리스너만 등록하고 신호는 ModelScanner가 emitSignal로 민다.
      this.trendListener = onSignal;
      this.detector = null;
      this.ladder = null;
      this.ladderState = null;
      this.onSignal = onSignal;
      this.lastSignal = null;
      return;
    }
    if (this.trendMode) {
      // 추세 모드 — 감지기 객체가 없다. 봉·4선은 상시 쌓이므로 리스너만 등록하면 다음 봉 마감부터 신호가 나온다.
      this.trendListener = onSignal;
      this.detector = null;
      this.ladder = null;
      this.ladderState = null;
      this.onSignal = onSignal;
      this.lastSignal = null;
      return;
    }
    if (this.inflectionMode) {
      // 변곡점+그리드 조합 — 감지기는 "신호만" 낸다(문서 §7 역할 분리). 모멘텀 확인·게이트를 전부 꺼서
      // 기울기 부호 전환 즉시 BUY/SELL이 나오고, ±% 문턱 판정·실행은 조건부 그리드·매매가 맡는다.
      this.detector = new TrendDetector({
        minBuyMomentum: 0,
        minSellMomentum: 0,
        minVolumeSpikeRatio: 0,
        minStrength: 0,
      });
      this.ladder = null;
    } else if (LADDER_ENTRY && this.ladderOptions) {
      // 사다리 모드 — 새 감지기 = 새 앵커(이전 감시 이력과 단절, SG의 새 detector와 같은 원칙).
      this.ladder = new LadderDetector({
        interval: this.ladderOptions.interval,
        triggerCount: this.ladderOptions.triggerCount,
        minVolumeSpikeRatio: this.detectorOptions.minVolumeSpikeRatio,
        minStrength: this.detectorOptions.minStrength,
      });
      this.detector = null;
    } else {
      this.detector = new TrendDetector(this.detectorOptions);
      this.ladder = null;
    }
    this.ladderState = null;
    this.onSignal = onSignal;
    this.lastSignal = null;
  }

  /**
   * 사다리 감지 옵션 교체(설정 탭 저장 반영). 값이 그대로면 아무것도 하지 않는다.
   * 실제로 바뀌었고 지금 사다리로 감시 중이면 감지기를 새로 만든다 — 새 간격에 맞춘 새 앵커에서
   * 홀 카운트를 다시 센다(옛 앵커에 새 간격을 섞으면 어느 쪽 기준인지 알 수 없는 판정이 된다).
   * 바뀌었으면 true.
   */
  setLadderOptions(options: LadderEntryOptions | undefined): boolean {
    const prev = this.ladderOptions;
    if (prev === options) return false;
    if (
      prev !== undefined &&
      options !== undefined &&
      prev.interval === options.interval &&
      prev.triggerCount === options.triggerCount
    ) {
      return false;
    }
    this.ladderOptions = options;
    if (this.onSignal !== null) {
      // 감시 중 — 같은 리스너로 즉시 재부착해 새 옵션으로 감지기를 다시 만든다.
      this.attachDetector(this.onSignal);
    }
    return true;
  }

  /** 감시 중단 — 리샘플·틱/초는 계속 돈다(재부착 대비). */
  detachDetector(): void {
    this.detector = null;
    this.ladder = null;
    this.ladderState = null;
    this.onSignal = null;
    this.trendListener = null; // 봉 링·trendEval은 지우지 않는다(재부착 대비 상시 누적).
    this.slope = null;
    this.accel = null;
  }

  get watched(): boolean {
    return this.detector !== null || this.ladder !== null || this.trendListener !== null;
  }

  /**
   * 추세 워밍업 시드 — REST 분봉조회 결과(분 키·종가)를 넣는다. 매니저의 워밍업 큐가 부른다.
   * seed 마지막 키 이하의 라이브 봉은 폐기된다(core/trend/bars 정합 규칙). 반영 봉 수를 돌려준다.
   * 시드 직후 4선을 다시 재 스냅샷을 갱신하되 **신호는 내지 않는다**(과거 봉으로 진입/청산하지 않는다 — 다음 마감부터).
   */
  /**
   * 외부 판정기(ModelScanner)가 낸 신호를 이 슬롯의 리스너로 흘린다 — 모델 모드에서만.
   * 진입가는 **슬롯의 최신 체결가**를 우선한다(신호 봉 종가는 최대 몇 초 낡았다). 둘 다 없으면 흘리지 않는다.
   * 실제로 리스너를 부르면 true.
   */
  emitSignal(signal: Signal, fallbackPrice: number, at?: number): boolean {
    if (!this.modelMode || this.trendListener === null) return false;
    const price = this.price !== null && this.price > 0 ? this.price : fallbackPrice;
    if (!Number.isFinite(price) || price <= 0) return false;
    this.lastSignal = signal;
    this.trendListener(signal, {
      ticker: this.ticker,
      price,
      slope: 0, // 모델 모드엔 SG 미분이 없다 — 스냅샷 필드 계약 유지용 0(추세·사다리와 동일).
      accel: 0,
      at: at ?? this.clock.now(),
    });
    return true;
  }

  /** 마지막 모델 판정(화면·진단용) — 스캐너가 매 봉(BUY든 아니든) 갱신한다. */
  setModelVerdict(ev: Pick<ModelEval, 'prob' | 'reject' | 'bars'>, barKey: number | null = null): void {
    this.modelVerdict = {
      prob: ev.prob === null || !Number.isFinite(ev.prob) ? null : ev.prob,
      reject: ev.reject,
      bars: ev.bars,
      at: this.clock.now(),
      barKey,
    };
  }

  seedTrend(bars: readonly MinuteBar[]): number {
    if (this.martingaleMode) {
      // 물타기 모드 — 1분봉 시드. 판정 스냅샷만 갱신하고 신호는 내지 않는다(과거 봉으로 진입하지 않는다).
      const n = this.bars.seed(bars);
      if (n > 0) {
        this.martingaleEval = evaluateMartingaleBars(this.bars.closes);
        // 시드가 봉 링을 통째로 갈아끼웠다 — 진행 중 판정도 버리고 다음 틱에서 새로 만든다(추세 시드와 동일).
        this.martingaleLiveEval = null;
        this.liveEntryBarKey = null;
        this.lastLiveEvalAt = Number.NEGATIVE_INFINITY;
      }
      return n;
    }
    if (!this.trendMode) return 0;
    const n = this.bars.seed(bars);
    if (n > 0) {
      this.trendEval = evaluateTrend(this.bars.closes);
      // 시드가 봉 링을 통째로 갈아끼웠다 — 진행 중 판정도 버리고 다음 틱에서 새로 만든다.
      this.trendLiveEval = null;
      this.liveSellBarKey = null;
      this.lastLiveEvalAt = Number.NEGATIVE_INFINITY;
    }
    return n;
  }

  /** 추세 모드의 마지막 닫힌 봉 분 키(뷰·이음새 로그용). */
  get trendLastBarKey(): number | null {
    return this.trendMode || this.martingaleMode ? this.bars.lastClosedKey : null;
  }

  /**
   * 물타기 단타 모드 봉 마감 1회 — 5선 상승·상향 돌파 봉이면 BUY(kind='entry')를 흘린다(미보유=진입, 보유=물타기 후보 —
   * 가르는 건 오토파일럿). 세션 게이트는 진입·물타기 공통(프리·정규·애프터 봉·마감 청산 전 — isMartingaleEntryBar).
   * price = 마감을 유발한 새 분 첫 틱 가격(추세 모드와 같은 규약).
   */
  private evaluateMartingaleBar(closed: MinuteBar, price: number): void {
    const ev = evaluateMartingaleBars(this.bars.closes);
    this.martingaleEval = ev;
    this.martingaleLiveEval = null; // 새 봉이 열렸다 — 진행 중 판정은 다음 틱에서 다시 만든다.
    if (this.trendListener === null) return;
    // 봉당 신호 1회(2026-09-02 ADR 0010) — 같은 봉에서 실시간 BUY를 이미 냈으면 마감 확정 신호는 내지 않는다.
    // 2026-09-01엔 "재시도"로 다시 냈지만(중복은 오토파일럿의 보유·발주 중 가드가 무시), 물타기가 돌아오면서
    // 보유 중의 BUY는 무시되지 않고 규칙(낙폭 배수)으로 흘러가므로 — 진입 1분 뒤 다음 분 첫 틱 가격으로 물타기가
    // 나갈 수 있었다. 실시간이 꺼져 있거나(MARTINGALE_LIVE_ENTRY=false) 봉 중간 틱이 없던 봉만 마감에서 낸다.
    if (this.liveEntryBarKey === closed.minuteKey) return;
    const at = this.lastTickAt ?? this.clock.now();
    if (ev.entry && isMartingaleEntryBar(closed.minuteKey)) {
      this.lastSignal = 'BUY';
      this.trendListener('BUY', {
        ticker: this.ticker,
        price,
        slope: 0,
        accel: 0,
        at,
        kind: 'entry',
        entryEvent: 'cross',
      });
    }
  }

  /**
   * 물타기 단타 진행 중 봉 실시간 판정(2026-09-01, 사용자 확정) — 진행 중 봉을 현재가로 넣어 다시 재고,
   * 5선 상승·돌파면 봉 마감을 기다리지 않고 그 자리에서 BUY(kind='entry')를 낸다. **차트가 그리는 것과 같은 기준**이라
   * "눈으로는 돌파가 보이는데 엔진은 1분 뒤에 산다"는 지연이 사라진다(청산 evaluateTrendLive와 같은 문법).
   * 같은 진행 봉에서는 딱 한 번만 발화하고, MARTINGALE_LIVE_EVAL_MS로 재계산을 스로틀한다. 봉 마감 확정
   * 신호는 그대로 나간다(실시간 신호가 버려졌을 때의 재시도 — 중복은 오토파일럿 가드 몫).
   * 봉 중간 가짜 돌파에 물리는 위험은 물타기(낙폭 배수 매수)가 받는다 — 손절은 없다(2026-09-02).
   */
  private evaluateMartingaleLive(): void {
    const cur = this.bars.inProgress;
    if (cur === null) return;
    const now = this.lastTickAt ?? this.clock.now();
    if (now - this.lastLiveEvalAt < MARTINGALE_LIVE_EVAL_MS) return;
    this.lastLiveEvalAt = now;
    const ev = evaluateMartingaleLive(this.bars.closes, cur.close);
    this.martingaleLiveEval = ev;
    if (!MARTINGALE_LIVE_ENTRY) return;
    if (!ev.entry) return;
    if (this.liveEntryBarKey === cur.minuteKey) return; // 이 진행 봉에서 이미 냈다.
    if (this.trendListener === null) return;
    if (!isMartingaleEntryBar(cur.minuteKey)) return; // 세션 게이트는 마감 판정과 동일(프리·정규·애프터만).
    this.liveEntryBarKey = cur.minuteKey;
    this.lastSignal = 'BUY';
    this.trendListener('BUY', {
      ticker: this.ticker,
      price: cur.close,
      slope: 0,
      accel: 0,
      at: now,
      kind: 'entry',
      entryEvent: 'cross',
    });
  }

  /** 봉 마감 1회 처리 — 4선 재계산·스냅샷 갱신·신호 전달. price = 마감을 유발한 새 분 첫 틱 가격. */
  private evaluateTrendBar(price: number): void {
    const ev = evaluateTrend(this.bars.closes);
    this.trendEval = ev;
    this.trendLiveEval = null; // 새 봉이 열렸다 — 진행 중 판정은 다음 틱에서 다시 만든다.
    this.liveSellBarKey = null;
    if (ev.signal === null || this.trendListener === null) return;
    this.lastSignal = ev.signal;
    this.trendListener(ev.signal, {
      ticker: this.ticker,
      price,
      slope: 0, // 추세 모드엔 SG 미분이 없다 — 스냅샷 필드 계약 유지용 0(사다리와 동일).
      accel: 0,
      at: this.lastTickAt ?? this.clock.now(),
      // 챱 차단 게이트용(BUY에서만 소비) — 신호봉까지의 종가로 계산한 밴드폭.
      bandWidthPct: ev.signal === 'BUY' ? bollingerBandWidthPct(this.bars.closes) : undefined,
    });
  }

  /**
   * 진행 중(미완성) 봉까지 넣어 다시 잰다 — **차트가 그리는 것과 같은 기준**(2026-08-22).
   * 봉 마감을 기다리지 않으므로 최대 한 봉(5분) 늦던 청산이 눈으로 보는 순간에 나간다.
   * SELL만 낸다(BUY는 봉 마감 확정 그대로 — 봉 중간 가짜 플립 진입 방지, 사용자 확정).
   * 같은 진행 봉에서는 딱 한 번만 발화하고, TREND_LIVE_EVAL_MS로 재계산을 스로틀한다.
   */
  private evaluateTrendLive(): void {
    const cur = this.bars.inProgress;
    if (cur === null) return;
    const now = this.lastTickAt ?? this.clock.now();
    if (now - this.lastLiveEvalAt < TREND_LIVE_EVAL_MS) return;
    this.lastLiveEvalAt = now;
    const ev = evaluateTrendLive(this.bars.closes, cur.close);
    this.trendLiveEval = ev;
    if (!TREND_LIVE_SELL) return;
    if (ev.signal !== 'SELL') return;
    if (this.liveSellBarKey === cur.minuteKey) return; // 이 진행 봉에서 이미 냈다.
    if (this.trendListener === null) return;
    this.liveSellBarKey = cur.minuteKey;
    this.lastSignal = 'SELL';
    this.trendListener('SELL', {
      ticker: this.ticker,
      price: cur.close,
      slope: 0,
      accel: 0,
      at: now,
    });
  }

  /** 현재 시점 틱/초 — 감시 3종 선정 기준(plan §2-4). */
  tickRate(nowMs?: number): number {
    return this.meter.rate(nowMs ?? this.clock.now());
  }

  get warmedUp(): boolean {
    return this.resampler.warmedUp;
  }

  /** 현재 시점 기울기(직전 봉 평균 대비 %) — 판정 불가는 null. */
  slopeRate(nowMs?: number): number | null {
    return this.slopeMeter.rate(nowMs ?? this.clock.now());
  }

  getView(): FeedSlotView {
    const now = this.clock.now();
    return {
      ticker: this.ticker,
      tickRate: this.tickRate(now),
      slopeRate: this.slopeMeter.rate(now),
      price: this.price,
      warmedUp: this.resampler.warmedUp,
      watched: this.watched,
      slope: this.slope,
      accel: this.accel,
      lastSignal: this.lastSignal,
      lastTickAt: this.lastTickAt,
      lastTradeAt: this.lastTradeAt,
      bid1: this.bid1,
      ask1: this.ask1,
      dayHigh: this.dayHigh,
      dayLow: this.dayLow,
      ladder: this.ladderState === null ? null : { ...this.ladderState },
      trend: this.trendEval,
      trendLive: this.trendLiveEval,
      trendInProgressClose: this.trendMode ? (this.bars.inProgress?.close ?? null) : null,
      modelProb: this.modelMode ? (this.modelVerdict?.prob ?? null) : null,
      modelVerdict: this.modelMode ? this.modelVerdict : null,
      martingale: this.martingaleMode ? this.martingaleEval : null,
      martingaleLive: this.martingaleMode ? this.martingaleLiveEval : null,
    };
  }
}
