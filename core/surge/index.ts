// SurgeDetector v2 — σ 기반 급등 상태 판정 + 3경로 이탈 (docs/domain/surge-stock-finder v2 plan).
//
// v1(4청크 정배열)의 실패 진단: 폭 조건이 없어 4초짜리 미세 발작을 급등으로 판정했다(수집 데이터
// 1호가 왕복 평균 −1.94%, 세트 수명 중앙값 20초). v2는 급등을 "초 단위 이벤트"가 아니라
// **분 단위 상태**로 판정하고, 모든 문턱을 그 종목의 변동성(σ) 단위로 잰다.
//
// 급등 지점 = 3조건 AND의 최초 동시 성립 틱:
//  · 폭   — 최근 sigmaWindowSec(60초) 수익률 ≥ surgeSigmaK(4)×σ. σ = 60초-수익률의 롤링 표준편차
//           (sigmaLookbackSec=20분 창, 미달 시 무발화). minSigma 하한 — 무변동 종목의 0×배수 오발화 방지.
//  · 구조 — 현재가가 최근 highLookbackSec(5분) 신고가 돌파.
//  · 참여 — 틱속도 ≥ 기준선 tickRateMultiple(3)배 AND 체결강도 ≥ minStrn(100, null이면 fail-open).
// 성립 시 앵커(60초 전 가격)·σ를 신호에 실어 기록한다 — MFE 분석의 기준선.
//
// 이탈 지점 = 급등 후 추적 모드에서 3경로 OR (먼저 닿는 것, 사유 기록):
//  · breakout_fail — 돌파했던 5분 신고가 선 아래로 복귀(가짜 돌파 — 즉시).
//  · soft — 참여 식음(최근 rateHotWindow 내 폭주 없음) + 트레일링 고점 대비 exitSoftSigmaK(1.5)×σ 하락.
//  · hard — 고점 대비 exitHardSigmaK(3)×σ 하락, 참여 무관(투매 안전선).
// 이탈 문턱에는 스프레드×spreadFloorMult(2) 하한 — σ < 스프레드면 호가 왕복이 하락으로 찍힌다.
//
// 조기경보(호가 예열 트리거)는 확정의 완화판: 폭 alertSigmaK(2)σ + 참여. σ 워밍업 전에는
// v1 속도 정배열(직전 완결 5초 틱수 엄격 증가)이 경보를 대신한다 — **경보 전용**(확정에는 불가:
// 폭 조건이 없는 경로라 v1 실패의 재발 통로).
//
// 급등과 이탈은 항상 세트 — 단독 하락은 감지하지 않는다. 추적 중 새 급등 억제.
// 플랫폼 무관 순수 TS — 외부 import 없음. 틱 구동(v1의 청크 의존 제거).

export interface SurgeTickInput {
  /** 체결강도(KIS STRN, 100=균형). null/미제공이면 참여 게이트 fail-open. */
  strength?: number | null;
  /** 현재 스프레드(소수, (ask1−bid1)/mid). 미제공이면 이탈 스프레드 하한 생략. */
  spreadPct?: number | null;
}

export interface SurgeDetectorOptions {
  /** 급등 폭 문턱(σ 배수). 기본 4. */
  surgeSigmaK?: number;
  /** 조기경보 폭 문턱(σ 배수). 기본 2. */
  alertSigmaK?: number;
  /** 수익률 측정 창(초). 기본 60. */
  sigmaWindowSec?: number;
  /** σ 롤링 창(초) — 이만큼 수익률 표본이 차기 전엔 확정 무발화. 기본 1200(20분). */
  sigmaLookbackSec?: number;
  /** σ 하한(소수) — 무변동 종목의 0×배수 오발화 방지. 기본 0.001(0.1%). */
  minSigma?: number;
  /** 신고가 창(초). 기본 300(5분). */
  highLookbackSec?: number;
  /** 참여(매수 주도) 체결강도 하한. 기본 100. null 입력이면 fail-open. */
  minStrn?: number;
  /** 참여(틱속도) 배수 — v1 유지. 기본 3. */
  tickRateMultiple?: number;
  /** 틱속도 롤링 기준선 길이(초). 기본 300. */
  baselineSec?: number;
  /** 틱속도 기준선 워밍업(초). 기본 60. */
  minBaselineSec?: number;
  /** 틱속도 측정 창(초). 기본 2. */
  shortWindowSec?: number;
  /** 틱속도 기준선 하한(틱/초). 기본 0.5. */
  minBaselineRate?: number;
  /** 참여 신선도 창(초) — 이 안에 참여 성립이 있어야 확정, 소프트 이탈은 이게 식었을 때. 기본 10. */
  rateHotWindowSec?: number;
  /** 속도 정배열(경보 전용) 판정 초 수. 기본 5. */
  speedAscendSeconds?: number;
  /** 소프트 이탈 낙폭(σ 배수) — 참여 식음 시. 기본 1.5. */
  exitSoftSigmaK?: number;
  /** 하드 이탈 낙폭(σ 배수) — 참여 무관. 기본 3. */
  exitHardSigmaK?: number;
  /** 이탈 문턱의 스프레드 하한 배수. 기본 2. */
  spreadFloorMult?: number;
  /** 조기경보 재발화 쿨다운(초). 기본 10. */
  alertCooldownSec?: number;
  /** 이탈 후 재급등 확정 쿨다운(초). 기본 60. */
  signalCooldownSec?: number;
}

/** 조기경보 — 호가 예열 트리거(기록 안 함). */
export interface SurgeAlert {
  kind: 'alert';
  at: number;
  price: number;
  shortRate: number;
  baselineRate: number;
}

export type SurgeExitReason = 'breakout_fail' | 'soft' | 'hard';

/** 확정 신호 — surge(급등=진입시점) / exit(하락=이탈시점). exit는 반드시 직전 surge와 세트. */
export interface SurgeSignal {
  kind: 'surge' | 'exit';
  at: number;
  /** 확정 시점 체결가. */
  price: number;
  /** surge: 앵커(60초 전 가격 — 급등 출발점). exit: null. */
  anchorPrice: number | null;
  /** surge: 확정 시점 σ(60초-수익률 표준편차, 소수). exit: 진입 시점에 고정한 σ. */
  sigma: number;
  /** surge: 돌파한 5분 신고가 선. exit: null. */
  breakoutLevel: number | null;
  /** exit: 추적 중 트레일링 고점(MFE 기준). surge: null. */
  trailingHigh: number | null;
  /** exit 전용 사유. surge: null. */
  exitReason: SurgeExitReason | null;
  shortRate: number;
  baselineRate: number;
}

export interface SurgeSnapshot {
  /** σ 표본이 롤링 창만큼 찼는가(확정 가능 상태). */
  warmedUp: boolean;
  /** 현재 σ(소수) — 워밍업 미달이면 null. */
  sigma: number | null;
  /** 최근 60초 수익률(소수) — 표본 부족이면 null. */
  ret60: number | null;
  shortRate: number;
  tracking: boolean;
  trailingHigh: number | null;
}

const DEFAULTS: Required<SurgeDetectorOptions> = {
  surgeSigmaK: 4,
  alertSigmaK: 2,
  sigmaWindowSec: 60,
  sigmaLookbackSec: 1200,
  minSigma: 0.001,
  highLookbackSec: 300,
  minStrn: 100,
  tickRateMultiple: 3,
  baselineSec: 300,
  minBaselineSec: 60,
  shortWindowSec: 2,
  minBaselineRate: 0.5,
  rateHotWindowSec: 10,
  speedAscendSeconds: 5,
  exitSoftSigmaK: 1.5,
  exitHardSigmaK: 3,
  spreadFloorMult: 2,
  alertCooldownSec: 10,
  signalCooldownSec: 60,
};

export class SurgeDetector {
  private readonly opts: Required<SurgeDetectorOptions>;

  // ---- 초 단위 링들 (조용한 초는 직전 값/0으로 채운다 — 침묵도 데이터) ----
  /** 초당 틱수 링(길이 baselineSec) — 참여(틱속도) 판정. */
  private readonly tickRing: number[];
  private tickRingSum = 0;
  /** 초당 마감가 링(길이 sigmaWindowSec+1) — 60초 전 가격 조회(수익률·앵커). */
  private readonly priceRing: number[];
  /** 초당 고가 링(길이 highLookbackSec) — 5분 신고가 판정. */
  private readonly highRing: number[];
  /** 60초-수익률 링(길이 sigmaLookbackSec) — σ 계산(합·제곱합 롤링). */
  private readonly retRing: number[];
  private retCount = 0;
  private retSum = 0;
  private retSumSq = 0;
  /** 지난 완결 5분 고가의 캐시(초 경계마다 재계산) — 틱마다 O(300) 스캔 방지. */
  private high5mCache = 0;

  private lastSec: number | null = null;
  private filledSec = 0;
  /** 진행 중인 현재 초의 상태(경계에서 링으로 밀어 넣는다). */
  private curSecHigh = 0;
  private lastPrice: number | null = null;
  private upRun = 0;
  private lastStrn: number | null = null;
  private lastSpread: number | null = null;

  /** 참여(틱속도 배수)가 마지막으로 성립한 시각. */
  private rateHotAt: number | null = null;

  // ---- 추적(이탈 대기) 상태 ----
  private tracking = false;
  private trailingHigh: number | null = null;
  private entrySigma = 0;
  private entryBreakoutLevel = 0;

  private alertCooldownUntil = 0;
  private surgeCooldownUntil = 0;

  constructor(options: SurgeDetectorOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.tickRing = new Array<number>(Math.max(this.opts.baselineSec, this.opts.speedAscendSeconds + 1, 5)).fill(0);
    this.priceRing = new Array<number>(this.opts.sigmaWindowSec + 1).fill(0);
    this.highRing = new Array<number>(this.opts.highLookbackSec).fill(0);
    this.retRing = new Array<number>(this.opts.sigmaLookbackSec).fill(0);
  }

  /** 체결 틱 1개 — 모든 판정이 여기서 돈다(청크 불요). 경보/급등/이탈 중 하나를 돌려줄 수 있다. */
  onTick(price: number, tsMs: number, input?: SurgeTickInput): SurgeAlert | SurgeSignal | null {
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(tsMs)) return null;
    this.advanceTo(Math.floor(tsMs / 1000), price);

    // 현재 초 상태 갱신.
    this.tickRing[this.idx(this.tickRing, this.lastSec!)] += 1;
    this.tickRingSum += 1;
    if (price > this.curSecHigh) this.curSecHigh = price;
    if (this.lastPrice !== null) {
      if (price > this.lastPrice) this.upRun += 1;
      else if (price < this.lastPrice) this.upRun = 0;
    }
    this.lastPrice = price;
    if (input?.strength !== undefined && input.strength !== null && Number.isFinite(input.strength)) {
      this.lastStrn = input.strength;
    }
    if (input?.spreadPct !== undefined && input.spreadPct !== null && Number.isFinite(input.spreadPct)) {
      this.lastSpread = input.spreadPct;
    }

    // 참여 — 틱속도 배수(기준선 워밍업 후) AND 체결강도(fail-open).
    const shortRate = this.shortRate();
    const baselineRate = this.tickBaselineWarmed ? this.baselineRate() : 0;
    const rateHot =
      this.tickBaselineWarmed &&
      shortRate >= this.opts.tickRateMultiple * Math.max(baselineRate, this.opts.minBaselineRate);
    const strnOk = this.opts.minStrn <= 0 || this.lastStrn === null || this.lastStrn >= this.opts.minStrn;
    const participating = rateHot && strnOk;
    if (participating) this.rateHotAt = tsMs;
    const participatingRecently =
      this.rateHotAt !== null && tsMs - this.rateHotAt <= this.opts.rateHotWindowSec * 1000;

    // ---- 이탈(추적 모드) — 폭·구조 조건과 무관하게 최우선 판정 ----
    if (this.tracking) {
      if (this.trailingHigh === null || price > this.trailingHigh) this.trailingHigh = price;
      const spreadFloor = this.lastSpread !== null ? this.lastSpread * this.opts.spreadFloorMult : 0;
      const softDrop = Math.max(this.entrySigma * this.opts.exitSoftSigmaK, spreadFloor);
      const hardDrop = Math.max(this.entrySigma * this.opts.exitHardSigmaK, spreadFloor);
      const drop = 1 - price / this.trailingHigh;
      let reason: SurgeExitReason | null = null;
      if (price < this.entryBreakoutLevel) reason = 'breakout_fail';
      else if (drop >= hardDrop) reason = 'hard';
      else if (!participatingRecently && drop >= softDrop) reason = 'soft';
      if (reason !== null) {
        const high = this.trailingHigh;
        this.tracking = false;
        this.trailingHigh = null;
        this.surgeCooldownUntil = tsMs + this.opts.signalCooldownSec * 1000;
        return {
          kind: 'exit',
          at: tsMs,
          price,
          anchorPrice: null,
          sigma: this.entrySigma,
          breakoutLevel: null,
          trailingHigh: high,
          exitReason: reason,
          shortRate,
          baselineRate,
        };
      }
      return null; // 추적 중엔 경보·재확정 없음(세트 유지 — 호가는 이미 에피소드가 잡고 있다).
    }

    // ---- 폭·구조 (σ 워밍업 후에만) ----
    const sigma = this.sigmaWarmed ? Math.max(this.sigma(), this.opts.minSigma) : null;
    const anchor = this.priceAgo(this.opts.sigmaWindowSec);
    const ret60 = anchor !== null && anchor > 0 ? price / anchor - 1 : null;

    // ---- 급등 확정 — 3조건 AND ----
    if (
      sigma !== null &&
      ret60 !== null &&
      ret60 >= this.opts.surgeSigmaK * sigma &&
      price > this.high5mCache &&
      participating &&
      tsMs >= this.surgeCooldownUntil
    ) {
      this.tracking = true;
      this.trailingHigh = price;
      this.entrySigma = sigma;
      this.entryBreakoutLevel = this.high5mCache;
      return {
        kind: 'surge',
        at: tsMs,
        price,
        anchorPrice: anchor,
        sigma,
        breakoutLevel: this.high5mCache,
        trailingHigh: null,
        exitReason: null,
        shortRate,
        baselineRate,
      };
    }

    // ---- 조기경보 — 확정의 완화판(호가 예열). σ 워밍업 전엔 속도 정배열이 대신한다. ----
    const widthAlert = sigma !== null && ret60 !== null && ret60 >= this.opts.alertSigmaK * sigma;
    const preWarmupAlert = sigma === null && this.speedAscending() && this.upRun >= 3 && strnOk;
    if ((widthAlert && participating) || preWarmupAlert) {
      if (tsMs >= this.alertCooldownUntil) {
        this.alertCooldownUntil = tsMs + this.opts.alertCooldownSec * 1000;
        return { kind: 'alert', at: tsMs, price, shortRate, baselineRate };
      }
    }
    return null;
  }

  /** 세션 전환 등으로 기준선이 낡았을 때 — 전부 처음부터 다시 관측한다(추적도 해제). */
  reset(): void {
    this.tickRing.fill(0);
    this.tickRingSum = 0;
    this.priceRing.fill(0);
    this.highRing.fill(0);
    this.retRing.fill(0);
    this.retCount = 0;
    this.retSum = 0;
    this.retSumSq = 0;
    this.high5mCache = 0;
    this.lastSec = null;
    this.filledSec = 0;
    this.curSecHigh = 0;
    this.lastPrice = null;
    this.upRun = 0;
    this.lastStrn = null;
    this.lastSpread = null;
    this.rateHotAt = null;
    this.tracking = false;
    this.trailingHigh = null;
  }

  /** σ 표본이 롤링 창만큼 찼는가 — 급등 확정 가능 상태. */
  get warmedUp(): boolean {
    return this.sigmaWarmed;
  }

  getSnapshot(): SurgeSnapshot {
    const sigma = this.sigmaWarmed ? Math.max(this.sigma(), this.opts.minSigma) : null;
    const anchor = this.priceAgo(this.opts.sigmaWindowSec);
    return {
      warmedUp: this.sigmaWarmed,
      sigma,
      ret60: anchor !== null && anchor > 0 && this.lastPrice !== null ? this.lastPrice / anchor - 1 : null,
      shortRate: this.shortRate(),
      tracking: this.tracking,
      trailingHigh: this.trailingHigh,
    };
  }

  // ---- 초 경계 전진 — 모든 초 단위 링을 한 곳에서 민다 ----

  /**
   * lastSec → sec까지 초 경계를 전진시킨다. 건너뛴 조용한 초는 "가격 유지·틱 0"으로 채운다.
   * 각 완결 초마다: 마감가·고가를 링에 넣고, 60초 수익률 표본을 σ 롤링 합에 반영하고, 5분 고가 캐시 갱신.
   */
  private advanceTo(sec: number, price: number): void {
    if (this.lastSec === null) {
      this.lastSec = sec;
      this.filledSec = 1;
      this.curSecHigh = price;
      return;
    }
    if (sec <= this.lastSec) return; // 같은 초 또는 시계 역행 — 현재 초에 계속 누적.

    const advance = sec - this.lastSec;
    const loop = Math.min(advance, this.opts.sigmaLookbackSec + this.opts.sigmaWindowSec + 1);
    for (let i = 0; i < loop; i += 1) {
      const closingSec = this.lastSec + i;
      const closePrice = this.lastPrice ?? price;
      const closeHigh = i === 0 ? Math.max(this.curSecHigh, closePrice) : closePrice;

      // 가격·고가 링.
      this.priceRing[this.idx(this.priceRing, closingSec)] = closePrice;
      this.highRing[this.idx(this.highRing, closingSec)] = closeHigh;

      // 60초 수익률 표본 — 60초 전 마감가가 있어야 한다.
      const done = this.filledSec + i + 1; // closingSec까지 완결된 초 수(근사 — 캡 이내에서 정확).
      if (done > this.opts.sigmaWindowSec) {
        const ago = this.priceRing[this.idx(this.priceRing, closingSec - this.opts.sigmaWindowSec)];
        if (ago > 0) this.pushReturn(closePrice / ago - 1);
      }
    }

    // 다음 틱수 링 구간을 0으로 리셋(전진 구간만).
    const tickLoop = Math.min(advance, this.tickRing.length);
    for (let i = 1; i <= tickLoop; i += 1) {
      const idx = this.idx(this.tickRing, this.lastSec + i);
      this.tickRingSum -= this.tickRing[idx];
      this.tickRing[idx] = 0;
    }

    this.filledSec = Math.min(this.filledSec + advance, Number.MAX_SAFE_INTEGER);
    this.lastSec = sec;
    this.curSecHigh = price;
    // 5분 고가 캐시 — 초 경계에서만 O(창 크기) 재계산(틱 경로는 캐시 비교만).
    this.high5mCache = this.recomputeHigh5m();
  }

  private pushReturn(r: number): void {
    const idx = this.retCount % this.retRing.length;
    if (this.retCount >= this.retRing.length) {
      const old = this.retRing[idx];
      this.retSum -= old;
      this.retSumSq -= old * old;
    }
    this.retRing[idx] = r;
    this.retSum += r;
    this.retSumSq += r * r;
    this.retCount += 1;
  }

  private recomputeHigh5m(): number {
    const n = Math.min(this.filledSec, this.highRing.length);
    let max = 0;
    for (let i = 1; i <= n; i += 1) {
      const v = this.highRing[this.idx(this.highRing, this.lastSec! - i)];
      if (v > max) max = v;
    }
    return max;
  }

  private get sigmaWarmed(): boolean {
    return this.retCount >= this.retRing.length;
  }

  private sigma(): number {
    const n = Math.min(this.retCount, this.retRing.length);
    if (n < 2) return 0;
    const mean = this.retSum / n;
    return Math.sqrt(Math.max(0, this.retSumSq / n - mean * mean));
  }

  /** seconds초 전의 초 마감가 — 관측이 모자라면 null. */
  private priceAgo(seconds: number): number | null {
    if (this.lastSec === null || this.filledSec <= seconds) return null;
    const v = this.priceRing[this.idx(this.priceRing, this.lastSec - seconds)];
    return v > 0 ? v : null;
  }

  private get tickBaselineWarmed(): boolean {
    return this.filledSec >= this.opts.minBaselineSec;
  }

  private baselineRate(): number {
    if (this.lastSec === null) return 0;
    const usable = Math.min(this.filledSec, this.tickRing.length);
    const short = Math.min(this.opts.shortWindowSec, usable);
    const shortSum = this.sumRecentTickSeconds(short);
    const denom = Math.max(usable - short, 1);
    return Math.max(this.tickRingSum - shortSum, 0) / denom;
  }

  private shortRate(): number {
    if (this.lastSec === null) return 0;
    const short = Math.min(this.opts.shortWindowSec, Math.max(this.filledSec, 1));
    return this.sumRecentTickSeconds(short) / short;
  }

  private sumRecentTickSeconds(seconds: number): number {
    if (this.lastSec === null || seconds <= 0) return 0;
    let sum = 0;
    for (let i = 0; i < seconds; i += 1) sum += this.tickRing[this.idx(this.tickRing, this.lastSec - i)];
    return sum;
  }

  /** 속도 정배열(경보 전용) — 직전 완결 N초의 틱수가 엄격 증가. 현재 초는 제외(부분 카운트). */
  private speedAscending(): boolean {
    const n = this.opts.speedAscendSeconds;
    if (this.lastSec === null || this.filledSec < n + 1) return false;
    let prev = -1;
    for (let i = n; i >= 1; i -= 1) {
      const count = this.tickRing[this.idx(this.tickRing, this.lastSec - i)];
      if (count <= prev) return false;
      prev = count;
    }
    return true;
  }

  private idx(ring: readonly unknown[], sec: number): number {
    return ((sec % ring.length) + ring.length) % ring.length;
  }
}
