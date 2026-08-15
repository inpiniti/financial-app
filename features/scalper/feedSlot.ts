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
/** 과거 칸 계산에 필요한 이력 보존 — (칸수−1) × 간격. */
const FEED_SERIES_HISTORY_MS = (FEED_SERIES_POINTS - 1) * FEED_SERIES_STEP_MS;

export interface SlotSignalContext {
  readonly ticker: string;
  readonly price: number;
  readonly slope: number;
  readonly accel: number;
  readonly at: number;
}

export interface FeedSlotView {
  readonly ticker: string;
  /** 현재 시점 틱/초(10초 윈도우 순간값 — FEED_RATE_WINDOW_MS). */
  readonly tickRate: number;
  /** 틱/초 시계열 — 겹침 없는 10초 봉 5칸 [40초전, 30초전, 20초전, 10초전, 현재]. */
  readonly tickRateSeries: number[];
  /**
   * 현재 시점 기울기(직전 10초 봉 평균 대비 현재 봉 평균의 %변화, v2) — 판정 불가는 null(0=평균 동일과 다름).
   * ⚠ 아래 slope(SG %/청크, 감시 중에만)와 다른 값 — 도메인 문서 §2 용어 구분.
   */
  readonly slopeRate: number | null;
  /** 기울기 시계열 — 겹침 없는 10초 봉 5칸 [40초전, 30초전, 20초전, 10초전, 현재]. */
  readonly slopeRateSeries: (number | null)[];
  readonly price: number | null;
  readonly warmedUp: boolean;
  /** detector 부착 여부(= 변곡점 감시 중). */
  readonly watched: boolean;
  readonly slope: number | null;
  readonly accel: number | null;
  readonly lastSignal: Signal | null;
  readonly lastTickAt: number | null;
  readonly bid1: number | null;
  readonly ask1: number | null;
  /** 사다리 감시 스냅샷(사다리 모드로 감시 중일 때만) — 홀 n/N·다음 매수선. SG 모드·미감시면 null. */
  readonly ladder: { count: number; triggerCount: number; nextBuyLevel: number } | null;
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
  private slope: number | null = null;
  private accel: number | null = null;
  private lastSignal: Signal | null = null;
  private bid1: number | null = null;
  private ask1: number | null = null;
  private quoteAt: number | null = null;

  /** 변곡점+그리드 조합 모드인가 — 생성 시 확정(INFLECTION_ENTRY AND inflection 주입). */
  private readonly inflectionMode: boolean;

  constructor(options: FeedSlotOptions) {
    this.ticker = options.ticker;
    this.clock = options.clock;
    this.inflectionMode = INFLECTION_ENTRY && options.inflection === true;
    this.meter = new TickRateMeter(options.tickRateWindowMs ?? FEED_RATE_WINDOW_MS, FEED_SERIES_HISTORY_MS);
    this.slopeMeter = new SlopeMeter(options.slopeWindowMs ?? FEED_RATE_WINDOW_MS, FEED_SERIES_HISTORY_MS);
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
    this.meter.record(this.lastTickAt);
    this.slopeMeter.record(this.lastTickAt, price);

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
    this.slope = null;
    this.accel = null;
  }

  get watched(): boolean {
    return this.detector !== null || this.ladder !== null;
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
      tickRateSeries: this.meter.series(now, FEED_SERIES_POINTS, FEED_SERIES_STEP_MS),
      slopeRate: this.slopeMeter.rate(now),
      slopeRateSeries: this.slopeMeter.series(now, FEED_SERIES_POINTS, FEED_SERIES_STEP_MS),
      price: this.price,
      warmedUp: this.resampler.warmedUp,
      watched: this.watched,
      slope: this.slope,
      accel: this.accel,
      lastSignal: this.lastSignal,
      lastTickAt: this.lastTickAt,
      bid1: this.bid1,
      ask1: this.ask1,
      ladder: this.ladderState === null ? null : { ...this.ladderState },
    };
  }
}
