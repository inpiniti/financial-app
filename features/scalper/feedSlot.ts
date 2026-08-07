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
import type { ClockLike, TickExtras } from './types';

/**
 * 진입 감지기 선택 스위치 — true면 **사다리 옵션이 주입된** 슬롯이 SG 기울기(TrendDetector) 대신
 * 가상 그리드 사다리(LadderDetector)로 변곡점을 판정한다(2026-08-07 plan L4).
 * false로 두면 기존 SG 감지로 **한 줄 롤백**된다. 사다리 옵션 미주입(기존 하네스)이면 값과 무관하게 SG다.
 */
export const LADDER_ENTRY = true;

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
  /** 틱/초 윈도우(ms, 기본 10초 — plan §4-13). */
  tickRateWindowMs?: number;
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
}

/** 변곡점 신호 콜백 — attach 시 등록. */
export type SlotSignalListener = (signal: Signal, ctx: SlotSignalContext) => void;

export interface SlotSignalContext {
  readonly ticker: string;
  readonly price: number;
  readonly slope: number;
  readonly accel: number;
  readonly at: number;
}

export interface FeedSlotView {
  readonly ticker: string;
  /** 현재 시점 틱/초(10초 윈도우 순간값). */
  readonly tickRate: number;
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
  private readonly resampler: Resampler;
  private readonly detectorOptions: {
    minBuyMomentum?: number;
    minSellMomentum?: number;
    minVolumeSpikeRatio?: number;
    minStrength?: number;
  };

  private readonly ladderOptions: LadderEntryOptions | undefined;

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

  constructor(options: FeedSlotOptions) {
    this.ticker = options.ticker;
    this.clock = options.clock;
    this.meter = new TickRateMeter(options.tickRateWindowMs);
    this.resampler = new Resampler({
      chunkSeconds: options.chunkSeconds,
      bufferSize: options.bufferSize,
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

    const closed = this.resampler.addTick({
      price,
      ts: tsMs,
      volume: extras?.volume,
      strength: extras?.strength,
    });
    if (closed === null || !this.resampler.warmedUp) return null;

    // 사다리 모드 — 마감된 청크 값(틱 평균)으로 홀 카운트를 판정한다(SG 미분 없음, plan §3).
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

    if (this.detector === null) return null;

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

  /** 실시간호가 수신 — 발주 단가용 캐시(감시·보유 종목만 구독하므로 항상 최신은 아니다). */
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
    if (LADDER_ENTRY && this.ladderOptions) {
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

  getView(): FeedSlotView {
    return {
      ticker: this.ticker,
      tickRate: this.tickRate(),
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
