// SurgeDetector — 급등/급락 신호 2단계 감지 (docs/domain/surge-stock-finder plan §2).
//
// 판정창은 짧게, 기준선은 길게:
//  · 1단계 조기경보(틱 레벨, ~1초 지연) — 최근 shortWindowSec초 틱속도가 롤링 기준선(baselineSec초)의
//    tickRateMultiple배 이상 + 같은 방향 연속 틱 alertRunTicks개. 호가 WS 동적 구독 트리거용(기록 아님).
//  · 2단계 확정(1초 청크, 3~5초 지연) — 청크 평균가 confirmChunks개 연속 상승(정배열)=SURGE /
//    연속 하락(역정배열)=PLUNGE. 단 틱속도 조건이 최근 rateHotWindow 안에 성립했어야 한다
//    (기둥이 4초 안에 식어도 확정을 놓치지 않게 순간값이 아니라 "최근 성립 시각"을 본다).
//
// 기준선 워밍업(minBaselineSec) 미달이면 아무것도 발화하지 않는다 — 평소 속도를 모르면 배수도 없다.
// 오탐 필터링보다 빠른 발화 + 충실한 기록이 우선(v1은 기록 전용) — 문턱은 기록을 보고 조정한다.
//
// 플랫폼 무관 순수 TS — 외부 import 없음. LadderDetector와 병렬로 붙는다(교체 아님).

export type SurgeDirection = 'up' | 'down';

export interface SurgeDetectorOptions {
  /** 조기경보·확정 공용 틱속도 배수 문턱(기준선 대비). 기본 3. */
  tickRateMultiple?: number;
  /** 틱속도 롤링 기준선 길이(초). 기본 300. */
  baselineSec?: number;
  /** 기준선 워밍업(초) — 이만큼 차기 전엔 무발화. 기본 60. */
  minBaselineSec?: number;
  /** 조기경보 틱속도 측정 창(초). 기본 2. */
  shortWindowSec?: number;
  /** 기준선 하한(틱/초) — 죽어 있던 종목의 0×배수 오발화 방지. 기본 0.5. */
  minBaselineRate?: number;
  /** 조기경보에 필요한 같은 방향 연속 틱 수. 기본 3. */
  alertRunTicks?: number;
  /** 확정(정배열/역정배열)에 필요한 연속 청크 수. 기본 4. */
  confirmChunks?: number;
  /** 확정 시 "틱속도 조건이 최근 성립했어야 하는" 창(초). 기본 10. */
  rateHotWindowSec?: number;
  /** 확정 신호 재발화 쿨다운(초, 방향별). 기본 60. */
  signalCooldownSec?: number;
  /** 조기경보 재발화 쿨다운(초, 방향별). 기본 10. */
  alertCooldownSec?: number;
}

/** 1단계 조기경보 — 호가 예열 트리거(기록 안 함). */
export interface SurgeAlert {
  kind: 'alert';
  direction: SurgeDirection;
  at: number;
  price: number;
  shortRate: number;
  baselineRate: number;
}

/** 2단계 확정 — surge(급등)/plunge(급락). 기록 대상. */
export interface SurgeSignal {
  kind: 'surge' | 'plunge';
  at: number;
  /** 확정 시점 청크 평균가(참고) — 기록용 체결가는 호출부가 최신 틱가로 잡는다. */
  chunkAvg: number;
  runLength: number;
  shortRate: number;
  baselineRate: number;
}

export interface SurgeSnapshot {
  warmedUp: boolean;
  baselineRate: number | null;
  shortRate: number;
  risingChunks: number;
  fallingChunks: number;
}

const DEFAULTS: Required<SurgeDetectorOptions> = {
  tickRateMultiple: 3,
  baselineSec: 300,
  minBaselineSec: 60,
  shortWindowSec: 2,
  minBaselineRate: 0.5,
  alertRunTicks: 3,
  confirmChunks: 4,
  rateHotWindowSec: 10,
  signalCooldownSec: 60,
  alertCooldownSec: 10,
};

export class SurgeDetector {
  private readonly opts: Required<SurgeDetectorOptions>;

  /** 초 단위 틱 카운트 링(길이 baselineSec) — 인덱스 = 초 % 길이. */
  private readonly ring: number[];
  private ringSum = 0;
  /** 링에 반영된 마지막 "초"(epoch초). null이면 첫 틱 대기. */
  private lastSec: number | null = null;
  /** 채워진 초 수(관측 시작부터, 최대 baselineSec) — 조용한 초도 데이터다(0으로 채움). */
  private filledSec = 0;

  private lastPrice: number | null = null;
  private upRun = 0;
  private downRun = 0;

  private prevChunkAvg: number | null = null;
  private risingRun = 0;
  private fallingRun = 0;

  /** 틱속도 배수 조건이 마지막으로 성립한 시각(방향 무관 — 속도엔 방향이 없다). */
  private rateHotAt: number | null = null;

  private alertCooldownUntil: Record<SurgeDirection, number> = { up: 0, down: 0 };
  private signalCooldownUntil: Record<'surge' | 'plunge', number> = { surge: 0, plunge: 0 };

  constructor(options: SurgeDetectorOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.ring = new Array<number>(Math.max(this.opts.baselineSec, this.opts.minBaselineSec, 5)).fill(0);
  }

  /**
   * 체결 틱 1개 — 틱속도 링·방향 런을 갱신하고, 조기경보 조건이면 SurgeAlert를 돌려준다.
   * 리샘플 청크와 무관하게 매 틱 호출한다(1단계는 청크를 기다리지 않는다).
   */
  onTick(price: number, tsMs: number): SurgeAlert | null {
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(tsMs)) return null;
    this.recordTickSecond(Math.floor(tsMs / 1000));

    if (this.lastPrice !== null) {
      if (price > this.lastPrice) {
        this.upRun += 1;
        this.downRun = 0;
      } else if (price < this.lastPrice) {
        this.downRun += 1;
        this.upRun = 0;
      }
      // 동가 체결은 런을 끊지도 잇지도 않는다.
    }
    this.lastPrice = price;

    if (!this.warmedUp) return null;

    const baselineRate = this.baselineRate();
    const shortRate = this.shortRate();
    const hot = shortRate >= this.opts.tickRateMultiple * Math.max(baselineRate, this.opts.minBaselineRate);
    if (hot) this.rateHotAt = tsMs;
    if (!hot) return null;

    const direction: SurgeDirection | null =
      this.upRun >= this.opts.alertRunTicks ? 'up' : this.downRun >= this.opts.alertRunTicks ? 'down' : null;
    if (direction === null) return null;
    if (tsMs < this.alertCooldownUntil[direction]) return null;

    this.alertCooldownUntil[direction] = tsMs + this.opts.alertCooldownSec * 1000;
    return { kind: 'alert', direction, at: tsMs, price, shortRate, baselineRate };
  }

  /**
   * 리샘플 청크(1초) 마감가 1개 — 정배열/역정배열 런을 갱신하고, 확정 조건이면 SurgeSignal을 돌려준다.
   * 틱속도 조건은 순간값이 아니라 "최근 rateHotWindow 안 성립"으로 본다(짧은 기둥 유실 방지).
   */
  onChunkClose(avg: number, tsMs: number): SurgeSignal | null {
    if (!Number.isFinite(avg) || avg <= 0) return null;
    if (this.prevChunkAvg !== null) {
      if (avg > this.prevChunkAvg) {
        this.risingRun += 1;
        this.fallingRun = 0;
      } else if (avg < this.prevChunkAvg) {
        this.fallingRun += 1;
        this.risingRun = 0;
      } else {
        this.risingRun = 0;
        this.fallingRun = 0;
      }
    }
    this.prevChunkAvg = avg;

    if (!this.warmedUp) return null;
    const rateHot = this.rateHotAt !== null && tsMs - this.rateHotAt <= this.opts.rateHotWindowSec * 1000;
    if (!rateHot) return null;

    const baselineRate = this.baselineRate();
    const shortRate = this.shortRate();

    if (this.risingRun >= this.opts.confirmChunks && tsMs >= this.signalCooldownUntil.surge) {
      const runLength = this.risingRun;
      this.risingRun = 0;
      this.signalCooldownUntil.surge = tsMs + this.opts.signalCooldownSec * 1000;
      return { kind: 'surge', at: tsMs, chunkAvg: avg, runLength, shortRate, baselineRate };
    }
    if (this.fallingRun >= this.opts.confirmChunks && tsMs >= this.signalCooldownUntil.plunge) {
      const runLength = this.fallingRun;
      this.fallingRun = 0;
      this.signalCooldownUntil.plunge = tsMs + this.opts.signalCooldownSec * 1000;
      return { kind: 'plunge', at: tsMs, chunkAvg: avg, runLength, shortRate, baselineRate };
    }
    return null;
  }

  /** 세션 전환 등으로 기준선이 낡았을 때 — 처음부터 다시 워밍업한다. */
  reset(): void {
    this.ring.fill(0);
    this.ringSum = 0;
    this.lastSec = null;
    this.filledSec = 0;
    this.lastPrice = null;
    this.upRun = 0;
    this.downRun = 0;
    this.prevChunkAvg = null;
    this.risingRun = 0;
    this.fallingRun = 0;
    this.rateHotAt = null;
  }

  get warmedUp(): boolean {
    return this.filledSec >= this.opts.minBaselineSec;
  }

  getSnapshot(): SurgeSnapshot {
    return {
      warmedUp: this.warmedUp,
      baselineRate: this.warmedUp ? this.baselineRate() : null,
      shortRate: this.shortRate(),
      risingChunks: this.risingRun,
      fallingChunks: this.fallingRun,
    };
  }

  // ---- 틱속도 링 ----

  private recordTickSecond(sec: number): void {
    if (this.lastSec === null) {
      this.lastSec = sec;
      this.filledSec = 1;
      this.ring[sec % this.ring.length] += 1;
      this.ringSum += 1;
      return;
    }
    if (sec < this.lastSec) {
      // 시계 역행(재연결 등) — 현재 초에 합산만 한다.
      this.ring[this.lastSec % this.ring.length] += 1;
      this.ringSum += 1;
      return;
    }
    // 건너뛴 조용한 초는 0으로 채운다 — 침묵도 기준선 데이터다.
    const advance = Math.min(sec - this.lastSec, this.ring.length);
    for (let i = 1; i <= advance; i += 1) {
      const idx = (this.lastSec + i) % this.ring.length;
      this.ringSum -= this.ring[idx];
      this.ring[idx] = 0;
    }
    this.filledSec = Math.min(this.filledSec + (sec - this.lastSec), this.ring.length);
    this.lastSec = sec;
    this.ring[sec % this.ring.length] += 1;
    this.ringSum += 1;
  }

  /** 기준선 틱/초 — 최근 shortWindow를 뺀 링 전체 평균(폭주 구간이 자기 기준선을 끌어올리지 않게). */
  private baselineRate(): number {
    if (this.lastSec === null) return 0;
    const short = Math.min(this.opts.shortWindowSec, this.filledSec);
    const shortSum = this.sumRecentSeconds(short);
    const denom = Math.max(this.filledSec - short, 1);
    return Math.max(this.ringSum - shortSum, 0) / denom;
  }

  /** 최근 shortWindowSec초 틱/초. */
  private shortRate(): number {
    if (this.lastSec === null) return 0;
    const short = Math.min(this.opts.shortWindowSec, Math.max(this.filledSec, 1));
    return this.sumRecentSeconds(short) / short;
  }

  private sumRecentSeconds(seconds: number): number {
    if (this.lastSec === null || seconds <= 0) return 0;
    let sum = 0;
    for (let i = 0; i < seconds; i += 1) {
      const idx = (this.lastSec - i) % this.ring.length;
      sum += this.ring[(idx + this.ring.length) % this.ring.length];
    }
    return sum;
  }
}
