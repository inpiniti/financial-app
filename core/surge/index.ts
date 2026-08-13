// SurgeDetector — 급등(진입시점) + 하락(이탈시점) 세트 감지 (docs/domain/surge-stock-finder plan §2).
//
// 급등과 하락은 항상 콤보로 다닌다(2026-08-13 사용자 확정) — 단독 하락은 감지하지 않는다.
//  · 1단계 조기경보(틱 레벨, ~1초 지연) — "틱속도 폭주" + 연속 업틱 alertRunTicks개.
//    호가 WS 동적 구독 트리거용(기록 아님).
//  · 2단계 급등 확정(1초 청크, 3~5초 지연) — 청크 평균가 confirmChunks개 연속 상승(정배열).
//    단 틱속도 폭주가 최근 rateHotWindow 안에 성립했어야 한다(기둥이 4초 안에 식어도 놓치지 않게
//    순간값이 아니라 "최근 성립 시각"을 본다). 확정 = 진입시점 → 추적 모드 진입.
//  · 3단계 이탈 확정(틱 레벨, 즉시) — 2단 트레일링(2026-08-13 사용자 확정):
//     소프트: 폭주가 식었고(최근 rateHotWindow 내 폭주 없음) 고점 대비 exitSoftDropPct(1%) 하락 →
//            "급등인 줄 알았는데 힘이 빠진" 세트를 빨리 끊는다. 폭주 중의 1% 눌림은 잔파동으로 참는다.
//     하드: 고점 대비 exitDropPct(3%) 하락 → 속도 무관 무조건 이탈. 투매는 속도가 폭발하며
//           떨어지므로 "식으면"류 조건만으론 폭락 중 이탈을 못 낸다 — 그 구멍을 막는 안전선.
//    추적 중에는 새 급등을 내지 않는다(세트 유지).
//
// 틱속도 폭주는 두 경로의 OR — 서로의 사각을 메운다:
//  (A) 기준선 배수 — 최근 shortWindowSec초 틱속도 ≥ 롤링 기준선(baselineSec초)의 tickRateMultiple배.
//      워밍업(minBaselineSec) 필요. 계단식 점프(1→30틱/초로 뛰어 유지)를 잡는다.
//  (B) 속도 정배열 — 직전 완결 speedAscendSeconds초의 초당 틱수가 엄격 증가(점진 가속).
//      기준선 불필요 → 워밍업 전(리스트 진입 직후)에도 눈 역할. 엄격 증가 5개는 마지막 초가
//      첫 초보다 최소 +4틱이라 절대 하한이 내장돼 있다(조용한 종목 잔파동 통과 불가).
//
// 오탐 필터링보다 빠른 발화 + 충실한 기록이 우선(v1은 기록 전용) — 문턱은 기록을 보고 조정한다.
// 플랫폼 무관 순수 TS — 외부 import 없음. LadderDetector와 병렬로 붙는다(교체 아님).

export interface SurgeDetectorOptions {
  /** 조기경보·급등 확정 공용 틱속도 배수 문턱(기준선 대비). 기본 3. */
  tickRateMultiple?: number;
  /** 틱속도 롤링 기준선 길이(초). 기본 300. */
  baselineSec?: number;
  /** 기준선 워밍업(초) — (A) 경로는 이만큼 차기 전엔 판정하지 않는다. 기본 60. */
  minBaselineSec?: number;
  /** 조기경보 틱속도 측정 창(초). 기본 2. */
  shortWindowSec?: number;
  /** 기준선 하한(틱/초) — 죽어 있던 종목의 0×배수 오발화 방지. 기본 0.5. */
  minBaselineRate?: number;
  /** 조기경보에 필요한 연속 업틱 수. 기본 3. */
  alertRunTicks?: number;
  /** 급등 확정(정배열)에 필요한 연속 청크 수. 기본 4. */
  confirmChunks?: number;
  /** 급등 확정 시 "틱속도 폭주가 최근 성립했어야 하는" 창(초). 기본 10. */
  rateHotWindowSec?: number;
  /** 급등 확정 재발화 쿨다운(초) — 이탈로 추적이 끝난 뒤부터 적용. 기본 60. */
  signalCooldownSec?: number;
  /** 조기경보 재발화 쿨다운(초). 기본 10. */
  alertCooldownSec?: number;
  /** 속도 정배열 판정 초 수 — 직전 완결 N초 틱수가 엄격 증가면 폭주(기준선·워밍업 불필요). 기본 5. */
  speedAscendSeconds?: number;
  /**
   * 하드 이탈 낙폭(소수) — 트레일링 고점 대비 이만큼 내려오면 폭주 여부와 무관하게 EXIT. 기본 0.03(3%).
   * 트레일링 스탑과 같은 정의 — 기록되는 왕복 변동율이 곧 "확정 매수→트레일링 청산" 전략의 성적이 된다.
   */
  exitDropPct?: number;
  /**
   * 소프트 이탈 낙폭(소수) — **폭주가 식은 상태**(최근 rateHotWindow 내 폭주 없음)에서 고점 대비
   * 이만큼 내려오면 EXIT. 기본 0.01(1%). 힘 빠진 급등을 3% 되돌림까지 기다리지 않고 끊는다.
   */
  exitSoftDropPct?: number;
}

/** 1단계 조기경보 — 호가 예열 트리거(기록 안 함). 급등 방향(업틱)만 있다 — 하락은 세트로만 다룬다. */
export interface SurgeAlert {
  kind: 'alert';
  at: number;
  price: number;
  shortRate: number;
  baselineRate: number;
}

/**
 * 확정 신호 — surge(급등 = 진입시점) / exit(하락 = 이탈시점). 기록 대상.
 * exit는 반드시 직전 surge와 세트다(추적 모드에서만 발화) — 단독 하락 신호는 존재하지 않는다.
 */
export interface SurgeSignal {
  kind: 'surge' | 'exit';
  at: number;
  /** surge: 확정 시점 청크 평균가 / exit: 이탈 확정 틱가(참고) — 기록용 체결가는 호출부의 최신 틱가. */
  price: number;
  /** surge: 정배열 런 길이 / exit: 0. */
  runLength: number;
  shortRate: number;
  baselineRate: number;
  /** exit 전용 — 추적 중 트레일링 고점(이탈 기준가). surge에선 null. */
  trailingHigh: number | null;
  /** exit 전용 — soft(폭주 식음+1%) / hard(3%, 속도 무관). surge에선 null. */
  exitReason: 'soft' | 'hard' | null;
}

export interface SurgeSnapshot {
  warmedUp: boolean;
  baselineRate: number | null;
  shortRate: number;
  risingChunks: number;
  /** 급등 확정 후 이탈 대기 중인가(추적 모드). */
  tracking: boolean;
  trailingHigh: number | null;
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
  speedAscendSeconds: 5,
  exitDropPct: 0.03,
  exitSoftDropPct: 0.01,
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

  private prevChunkAvg: number | null = null;
  private risingRun = 0;

  /** 틱속도 폭주가 마지막으로 성립한 시각. */
  private rateHotAt: number | null = null;

  /** 이탈 추적 모드 — 급등 확정 시 켜지고 EXIT 발화로 꺼진다. 추적 중엔 새 급등을 내지 않는다. */
  private tracking = false;
  private trailingHigh: number | null = null;

  private alertCooldownUntil = 0;
  private surgeCooldownUntil = 0;

  constructor(options: SurgeDetectorOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.ring = new Array<number>(
      Math.max(this.opts.baselineSec, this.opts.minBaselineSec, this.opts.speedAscendSeconds + 1, 5),
    ).fill(0);
  }

  /**
   * 체결 틱 1개 — 틱속도 링·업틱 런·이탈 추적을 갱신한다.
   * 추적 중이면 이탈(EXIT) 판정이 최우선(폭주 조건 없음), 아니면 조기경보 판정.
   */
  onTick(price: number, tsMs: number): SurgeAlert | SurgeSignal | null {
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(tsMs)) return null;
    this.recordTickSecond(Math.floor(tsMs / 1000));

    if (this.lastPrice !== null) {
      if (price > this.lastPrice) this.upRun += 1;
      else if (price < this.lastPrice) this.upRun = 0;
      // 동가 체결은 런을 끊지도 잇지도 않는다.
    }
    this.lastPrice = price;

    // 틱속도 폭주 — (A) 기준선 배수(워밍업 후) OR (B) 속도 정배열(워밍업 무관).
    const baselineRate = this.warmedUp ? this.baselineRate() : 0;
    const shortRate = this.shortRate();
    const multipleHot =
      this.warmedUp && shortRate >= this.opts.tickRateMultiple * Math.max(baselineRate, this.opts.minBaselineRate);
    const hot = multipleHot || this.speedAscending();
    if (hot) this.rateHotAt = tsMs;

    // 이탈 추적 — 2단 트레일링. 하드(3%, 속도 무관)가 투매를, 소프트(폭주 식음+1%)가 힘 빠진 급등을 끊는다.
    if (this.tracking) {
      if (this.trailingHigh === null || price > this.trailingHigh) this.trailingHigh = price;
      const stillHot = this.rateHotAt !== null && tsMs - this.rateHotAt <= this.opts.rateHotWindowSec * 1000;
      const hardExit = price <= this.trailingHigh * (1 - this.opts.exitDropPct);
      const softExit = !stillHot && price <= this.trailingHigh * (1 - this.opts.exitSoftDropPct);
      if (hardExit || softExit) {
        const high = this.trailingHigh;
        this.tracking = false;
        this.trailingHigh = null;
        this.surgeCooldownUntil = tsMs + this.opts.signalCooldownSec * 1000;
        return {
          kind: 'exit',
          at: tsMs,
          price,
          runLength: 0,
          shortRate,
          baselineRate,
          trailingHigh: high,
          exitReason: hardExit ? 'hard' : 'soft',
        };
      }
      return null; // 추적 중엔 조기경보도 내지 않는다 — 호가는 이미 에피소드가 잡고 있다.
    }

    if (!hot) return null;
    if (this.upRun < this.opts.alertRunTicks) return null;
    if (tsMs < this.alertCooldownUntil) return null;

    this.alertCooldownUntil = tsMs + this.opts.alertCooldownSec * 1000;
    return { kind: 'alert', at: tsMs, price, shortRate, baselineRate };
  }

  /**
   * 리샘플 청크(1초) 마감가 1개 — 정배열 런을 갱신하고, 급등 확정 조건이면 SURGE를 돌려준다.
   * 틱속도 폭주는 순간값이 아니라 "최근 rateHotWindow 안 성립"으로 본다(짧은 기둥 유실 방지).
   * 추적 중(이탈 대기)에는 새 급등을 내지 않는다.
   */
  onChunkClose(avg: number, tsMs: number): SurgeSignal | null {
    if (!Number.isFinite(avg) || avg <= 0) return null;
    if (this.prevChunkAvg !== null) {
      if (avg > this.prevChunkAvg) this.risingRun += 1;
      else this.risingRun = 0;
    }
    this.prevChunkAvg = avg;

    if (this.tracking) return null;
    const rateHot = this.rateHotAt !== null && tsMs - this.rateHotAt <= this.opts.rateHotWindowSec * 1000;
    if (!rateHot) return null;
    if (this.risingRun < this.opts.confirmChunks || tsMs < this.surgeCooldownUntil) return null;

    const runLength = this.risingRun;
    this.risingRun = 0;
    // 급등 확정 = 진입시점 → 이탈 추적 시작. 추적 기준 고점은 확정 시점 최신 틱가(없으면 청크 평균).
    this.tracking = true;
    this.trailingHigh = this.lastPrice ?? avg;
    return {
      kind: 'surge',
      at: tsMs,
      price: avg,
      runLength,
      shortRate: this.shortRate(),
      baselineRate: this.warmedUp ? this.baselineRate() : 0,
      trailingHigh: null,
      exitReason: null,
    };
  }

  /** 세션 전환 등으로 기준선이 낡았을 때 — 처음부터 다시 워밍업한다(추적도 해제). */
  reset(): void {
    this.ring.fill(0);
    this.ringSum = 0;
    this.lastSec = null;
    this.filledSec = 0;
    this.lastPrice = null;
    this.upRun = 0;
    this.prevChunkAvg = null;
    this.risingRun = 0;
    this.rateHotAt = null;
    this.tracking = false;
    this.trailingHigh = null;
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
      tracking: this.tracking,
      trailingHigh: this.trailingHigh,
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

  /**
   * 속도 정배열 — 직전 **완결** speedAscendSeconds초의 초당 틱수가 엄격 증가인가.
   * 진행 중인 현재 초는 아직 덜 세어졌으므로 제외한다(부분 카운트가 배열을 헛되이 끊지 않게).
   * 관측이 N+1초 미만이면 false — 링에 없는 초를 0으로 잘못 읽는 것을 막는다.
   */
  private speedAscending(): boolean {
    const n = this.opts.speedAscendSeconds;
    if (this.lastSec === null || this.filledSec < n + 1) return false;
    let prev = -1;
    for (let i = n; i >= 1; i -= 1) {
      const idx = (((this.lastSec - i) % this.ring.length) + this.ring.length) % this.ring.length;
      const count = this.ring[idx];
      if (count <= prev) return false;
      prev = count;
    }
    return true;
  }
}
