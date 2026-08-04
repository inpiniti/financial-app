// TrendDetector: 리샘플 버퍼의 1차 미분(기울기)·2차 미분(가속도)을
// Savitzky-Golay 필터로 계산해 변곡점(기울기 부호 전환)을 판정한다.
// 플랫폼 무관 순수 TS — 유일 허용 외부 import는 ml-savitzky-golay. (PRD §4-C)
import SavitzkyGolay from 'ml-savitzky-golay';

export type Signal = 'BUY' | 'SELL';

/** 버퍼 중심에서의 1차/2차 미분값. */
export interface Derivatives {
  slope: number;
  accel: number;
}

export interface DetectorResult {
  /** 유효 창(홀수·5 이상)으로 미분을 계산했는가. */
  warmedUp: boolean;
  /** 현재 기울기(1차 미분). 워밍업 전이면 null. */
  slope: number | null;
  /** 현재 가속도(2차 미분). 워밍업 전이면 null. */
  accel: number | null;
  /** 이번 리샘플에서 발생한 변곡점 신호. 없으면 null. */
  signal: Signal | null;
  /** 선제 경고(주문과 무관, 기본 off). */
  warning: boolean;
  /**
   * 매수 모멘텀 확인 대기 중인가 — 기울기 -→+ 전환은 감지됐으나 아직 상대 기울기가 문턱에 도달하지 않아
   * BUY를 보류하고 있는 상태. minBuyMomentum<=0(끔)이면 항상 false. (2026-07-31 매수 모멘텀 확인 단계)
   */
  momentumConfirming: boolean;
  /**
   * 매도 모멘텀 확인 대기 중인가 — 기울기 +→- 전환은 감지됐으나 아직 하락 기울기 크기가 매도 문턱에 못 미쳐
   * SELL을 보류하고 있는 상태(대기 한도 만료 시 무조건 매도·급락 시 즉시 매도). minSellMomentum<=0(끔)이면 항상 false.
   * momentumConfirming(매수용)과 독립이다. (2026-07-31 매도 모멘텀 확인 단계)
   */
  sellConfirming: boolean;
  /**
   * 상대 기울기(모멘텀) — SG 1차 미분 ÷ 버퍼 마지막 가격. 단위 "%/청크"(소수, 예 0.0001=0.01%).
   * 워밍업 전이면 null. 가격 규모와 무관한 정규화 값이라 $2·$300에서 같은 %기울기면 같은 값이다.
   */
  momentum: number | null;
  /**
   * 이번 청크에 모멘텀 조건은 충족(또는 무관)인데 거래량/체결강도 게이트만 BUY를 막았는가.
   * UI 배지("거래량/체결강도 확인 중")용. 게이트 둘 다 꺼져 있으면 항상 false. (2026-08-03 BUY 게이트)
   */
  buyGateBlocked: boolean;
  /** 게이트 입력 에코 — 이번 판정에 쓴 거래량 스파이크 배율. 미제공이면 null. */
  volumeSpike: number | null;
  /** 게이트 입력 에코 — 이번 판정에 쓴 체결강도(STRN). 미제공이면 null. */
  strength: number | null;
}

/**
 * BUY 게이트 입력 — 호출부(러너)가 Resampler 집계에서 뽑아 전달한다.
 * null/미제공은 "판정 불가"로 보고 해당 게이트를 통과시킨다(fail-open — 데이터 유실이 매매를 전면 중단시키지 않게).
 */
export interface GateInput {
  /** 마지막 청크 거래량 ÷ 과거 평균(Resampler.volumeSpike()). */
  volumeSpike?: number | null;
  /** 마지막 체결강도(Resampler.lastStrength). 100=매수·매도 균형. */
  strength?: number | null;
}

export interface TrendDetectorOptions {
  /** SG 다항식 차수. 기본 2 */
  polynomial?: number;
  /** 경고 이벤트 사용 여부. 기본 false */
  enableWarning?: boolean;
  /** 기울기>0 이면서 가속도<=이 값이면 경고. 기본 0 (enableWarning 시에만 평가) */
  warningAccelThreshold?: number;
  /**
   * 매수 모멘텀 문턱(상대 기울기, "%/청크" 소수). 기본 0.0001(0.01%/청크).
   * -→+ 전환 감지 후 상대 기울기가 이 값 이상이어야 BUY를 발동한다.
   * **0(또는 음수)이면 끔** — 전환 즉시 BUY(기존 동작·하위호환). 매도는 이 값과 무관하게 즉시(비대칭).
   */
  minBuyMomentum?: number;
  /**
   * 매수 모멘텀 확인 윈도(청크 수). 기본 5. 전환 후 이 청크 수 안에 문턱에 도달하지 못하면
   * 확인 대기를 폐기하고 전환 감지로 복귀한다(재전환 시 다시 대기 진입).
   */
  confirmWindowChunks?: number;
  /**
   * 매도 모멘텀 문턱(하락 상대 기울기 크기, "%/청크" 소수). 기본 0.00005(0.005%/청크).
   * +→- 전환 감지 후 하락 기울기 크기가 이 값 이상이어야 SELL을 발동한다(그 전엔 매도 확인 대기).
   * **0(또는 음수)이면 끔** — 전환 즉시 SELL(기존 동작·하위호환).
   * ⚠ 매수 문턱과 의미가 다르다: 매도는 대기 만료 시 반드시 팔린다(폐기하지 않는다).
   */
  minSellMomentum?: number;
  /**
   * 매도 확인 대기 한도(청크 수). 기본 2(청크 3초 기준 6초). 전환 후 이 청크 수 안에 문턱에 도달하지도
   * 기울기가 회복하지도 않으면 만료 시점에 **무조건 SELL**한다(방어선 보존 — 지연 상한만 존재).
   */
  sellConfirmWindowChunks?: number;
  /**
   * 급락 예외 임계(상대 가속도 accel/price, "%/청크²" 소수, 음수). 기본 -0.02(=-2%/청크²).
   * 매도 확인 대기 중이라도 상대 가속도가 이 값 이하(더 급락)면 대기를 무시하고 즉시 SELL한다.
   *
   * 캘리브레이션 근거(합성 시나리오, 버퍼 7·청크 3초, SG 2차 미분 ÷ 가격):
   *  · 평범한 둥근 정점·완만한 하락의 상대 가속도는 최악 ≈ -0.008~-0.009/청크²에 그친다.
   *  · 진짜 폭락(정점 직후 매 청크 수%씩 손실 가속)은 -0.013을 넘어 -0.02, -0.05로 깊어진다.
   *  · 기본 -0.02는 평범한 반전 가속도의 약 2.5배 아래라 일상적 되돌림엔 잠자코 있고(보수적) 진짜 붕괴에서만 발동한다.
   *  · 만료 시 무조건 매도(기본 2청크=6초)라는 방어선이 이미 있으므로, 임계를 조금 보수적으로 잡아 조기
   *    발동을 놓쳐도 손실 노출은 최대 6초로 제한된다 — 따라서 보수적(더 음수) 쪽으로 잡는 게 안전하다.
   * 매우 음수(예 -Infinity)로 두면 급락 예외를 끈다.
   */
  crashAccelThreshold?: number;
  /**
   * BUY 거래량 스파이크 게이트(배수). 기본 0=끔. 켜면 마지막 청크 거래량이 과거 평균의 이 배수 이상일 때만
   * BUY를 허용한다(미달 시 확인 대기 유지 — 윈도 소진 시 폐기). SELL과 무관. (2026-08-03 BUY 게이트)
   */
  minVolumeSpikeRatio?: number;
  /**
   * BUY 체결강도 게이트(STRN, 100=매수·매도 균형). 기본 0=끔. 켜면 체결강도가 이 값 이상일 때만
   * BUY를 허용한다. SELL과 무관. (2026-08-03 BUY 게이트)
   */
  minStrength?: number;
}

const MIN_WINDOW = 5;

function isValidWindow(buffer: readonly number[]): boolean {
  return buffer.length >= MIN_WINDOW && buffer.length % 2 === 1;
}

/**
 * 버퍼(홀수·5 이상) 중심점의 1차/2차 미분을 반환한다.
 * 창 전체를 SG 윈도로 써서 중심 1개 값을 얻는다 — 평활 최적점이 중심이다.
 * h=1: 리샘플 점 간 간격을 단위로 둔다.
 */
export function computeDerivatives(
  buffer: readonly number[],
  polynomial = 2,
): Derivatives {
  const data = buffer as number[];
  const w = buffer.length;
  const slope = SavitzkyGolay(data, 1, { windowSize: w, derivative: 1, polynomial })[0];
  const accel = SavitzkyGolay(data, 1, { windowSize: w, derivative: 2, polynomial })[0];
  return { slope, accel };
}

export class TrendDetector {
  private readonly polynomial: number;
  private readonly enableWarning: boolean;
  private readonly warningAccelThreshold: number;
  private readonly minBuyMomentum: number;
  private readonly confirmWindowChunks: number;
  private readonly minSellMomentum: number;
  private readonly sellConfirmWindowChunks: number;
  private readonly crashAccelThreshold: number;
  private readonly minVolumeSpikeRatio: number;
  private readonly minStrength: number;
  private prevSlope: number | null = null;
  /**
   * 매수 모멘텀 확인 대기 상태 — 전환 감지 후 문턱 도달을 기다리는 중이면 true.
   * minBuyMomentum<=0(끔)일 땐 절대 켜지지 않는다.
   */
  private confirming = false;
  /** 확인 대기 잔여 청크 수 — 0 이하가 되면 폐기하고 전환 감지로 복귀. */
  private confirmChunksLeft = 0;
  /**
   * 매도 모멘텀 확인 대기 상태 — +→- 전환 감지 후 매도 문턱/만료/급락을 기다리는 중이면 true.
   * minSellMomentum<=0(끔)일 땐 절대 켜지지 않는다. confirming(매수)과 완전 독립.
   */
  private sellConfirming = false;
  /** 매도 확인 대기 잔여 청크 수 — 0 이하가 되면 **폐기가 아니라 무조건 매도**(매수와 반대). */
  private sellChunksLeft = 0;

  constructor(options: TrendDetectorOptions = {}) {
    this.polynomial = options.polynomial ?? 2;
    this.enableWarning = options.enableWarning ?? false;
    this.warningAccelThreshold = options.warningAccelThreshold ?? 0;
    this.minBuyMomentum = options.minBuyMomentum ?? 0.0001;
    this.confirmWindowChunks = options.confirmWindowChunks ?? 5;
    this.minSellMomentum = options.minSellMomentum ?? 0.00005;
    this.sellConfirmWindowChunks = options.sellConfirmWindowChunks ?? 2;
    this.crashAccelThreshold = options.crashAccelThreshold ?? -0.02;
    this.minVolumeSpikeRatio = options.minVolumeSpikeRatio ?? 0;
    this.minStrength = options.minStrength ?? 0;
  }

  /**
   * 리샘플 버퍼 1개를 판정한다. 유효 창이 아니면 warmedUp=false로 무판정.
   * 직전 유효 기울기와 부호를 비교해 SELL 변곡점(즉시)·BUY 변곡점(모멘텀 확인 후)을 낸다.
   *
   * 상태기계(매수만, minBuyMomentum>0일 때):
   *  · 전환 감지(prevSlope<0 && slope>=0) → 확인 대기 진입(confirming=true, 잔여=confirmWindowChunks). 이 청크엔 BUY 없음.
   *  · 대기 중 매 청크:
   *      - 기울기 음전(slope<0) → 폐기(전환 감지로 복귀).
   *      - 상대 기울기 ≥ 문턱 → BUY 발동, 대기 해제.
   *      - 그 외(양의 약한 기울기) → 잔여 -1, 0 이하면 폐기.
   *  · SELL(prevSlope>0 && slope<=0)은 문턱과 무관하게 즉시 발동하고 진행 중 대기를 폐기한다(비대칭).
   *
   * BUY 게이트(minVolumeSpikeRatio/minStrength>0일 때, gates 인자):
   *  · BUY 발동 조건에 게이트 통과가 AND로 붙는다. 미통과면 buyGateBlocked=true로 확인 대기를 유지한다.
   *  · 게이트 입력이 null(판정 불가)이면 통과(fail-open).
   *  · 게이트만 켠 구성(minBuyMomentum<=0)에서는 전환 청크에서 즉시 게이트를 검사해 통과 시 그 청크에 BUY(지연 0).
   *    minBuyMomentum>0이면 기존 흐름(전환 청크엔 대기 진입만) 그대로다 — 하위호환.
   */
  detect(buffer: readonly number[], gates?: GateInput): DetectorResult {
    if (!isValidWindow(buffer)) {
      return {
        warmedUp: false,
        slope: null,
        accel: null,
        signal: null,
        warning: false,
        momentumConfirming: false,
        sellConfirming: false,
        momentum: null,
        buyGateBlocked: false,
        volumeSpike: null,
        strength: null,
      };
    }
    const { slope, accel } = computeDerivatives(buffer, this.polynomial);
    const lastPrice = buffer[buffer.length - 1];
    // 상대 기울기(모멘텀) — 가격 규모 정규화. lastPrice가 0이면 정의 불가라 0으로 둔다(문턱 미달 취급).
    const momentum = lastPrice !== 0 ? slope / lastPrice : 0;
    // 상대 가속도 — 급락 예외 판정용. 가격 규모 정규화(0이면 급락 아님 취급).
    const relAccel = lastPrice !== 0 ? accel / lastPrice : 0;
    // 게이트 판정 — 문턱 꺼짐(<=0) 또는 입력 null(판정 불가)이면 통과(fail-open).
    const volumeSpike = gates?.volumeSpike ?? null;
    const strength = gates?.strength ?? null;
    const gatesPass =
      (this.minVolumeSpikeRatio <= 0 ||
        volumeSpike === null ||
        volumeSpike >= this.minVolumeSpikeRatio) &&
      (this.minStrength <= 0 || strength === null || strength >= this.minStrength);
    // 게이트가 하나라도 켜져 있으면 minBuyMomentum=0이어도 매수 확인 상태기계를 쓴다(발동 지점 통합).
    const buyConfirmActive =
      this.minBuyMomentum > 0 || this.minVolumeSpikeRatio > 0 || this.minStrength > 0;
    const sellGated = this.minSellMomentum > 0;

    let signal: Signal | null = null;
    let buyGateBlocked = false;
    if (this.prevSlope !== null) {
      const crossedUp = this.prevSlope < 0 && slope >= 0;
      const crossedDown = this.prevSlope > 0 && slope <= 0;

      // ── 매도 상태기계 (매수와 독립) ──
      // 대기 중이던 청크는 매도 기계가 소유하고 매수 기계는 건너뛴다(회복=+ 전환을 매수 진입으로 오해하지 않도록).
      if (this.sellConfirming) {
        if (relAccel <= this.crashAccelThreshold) {
          // 급락 예외 — 대기 무시 즉시 매도.
          signal = 'SELL';
          this.sellConfirming = false;
        } else if (slope > 0) {
          // 기울기 +로 회복 → 매도 폐기, 계속 홀딩(핵심 구제 경로).
          this.sellConfirming = false;
        } else if (-momentum >= this.minSellMomentum) {
          // 하락 기울기 크기가 문턱 도달 → 매도 발동, 대기 해제.
          signal = 'SELL';
          this.sellConfirming = false;
        } else {
          // 아직 얕음 — 대기 한도 소진 시 **무조건 매도**(매수와 반대: 폐기하지 않는다).
          this.sellChunksLeft -= 1;
          if (this.sellChunksLeft <= 0) {
            signal = 'SELL';
            this.sellConfirming = false;
          }
        }
      } else if (crossedDown) {
        // 하락 전환 감지 — 진행 중이던 매수 확인 대기는 시장이 꺾였으므로 폐기.
        this.confirming = false;
        if (!sellGated) {
          // 매도 문턱 끔 — 전환 즉시 SELL(기존 동작·하위호환).
          signal = 'SELL';
        } else {
          // 즉시 팔지 않고 매도 확인 대기 진입(이 청크엔 매도 없음).
          this.sellConfirming = true;
          this.sellChunksLeft = this.sellConfirmWindowChunks;
        }
      } else if (!buyConfirmActive) {
        // 모멘텀·게이트 전부 끔 — 전환 즉시 BUY(기존 동작·하위호환).
        if (crossedUp) signal = 'BUY';
      } else if (this.confirming) {
        if (slope < 0) {
          // 기울기 재음전 → 즉시 폐기.
          this.confirming = false;
        } else if (momentum >= this.minBuyMomentum && gatesPass) {
          // 모멘텀 문턱·게이트 모두 통과 → BUY 발동, 대기 해제.
          signal = 'BUY';
          this.confirming = false;
        } else {
          // 아직 약하거나 게이트 미통과 — 윈도 소진 시 폐기.
          if (momentum >= this.minBuyMomentum) buyGateBlocked = true;
          this.confirmChunksLeft -= 1;
          if (this.confirmChunksLeft <= 0) this.confirming = false;
        }
      } else if (crossedUp) {
        // 전환 감지 — 즉시 매수하지 않고 확인 대기 진입.
        this.confirming = true;
        this.confirmChunksLeft = this.confirmWindowChunks;
        if (this.minBuyMomentum <= 0) {
          // 게이트만 켠 구성 — 전환 청크에서 즉시 검사(모멘텀 대기가 없으므로 게이트 통과 시 지연 0).
          if (gatesPass) {
            signal = 'BUY';
            this.confirming = false;
          } else {
            buyGateBlocked = true;
          }
        }
      }
    }
    this.prevSlope = slope;

    const warning =
      this.enableWarning && slope > 0 && accel <= this.warningAccelThreshold;

    return {
      warmedUp: true,
      slope,
      accel,
      signal,
      warning,
      momentumConfirming: this.confirming,
      sellConfirming: this.sellConfirming,
      momentum,
      buyGateBlocked,
      volumeSpike,
      strength,
    };
  }

  /** 이전 기울기·매수/매도 확인 대기 상태를 모두 초기화한다(새 Run 시작 시). */
  reset(): void {
    this.prevSlope = null;
    this.confirming = false;
    this.confirmChunksLeft = 0;
    this.sellConfirming = false;
    this.sellChunksLeft = 0;
  }
}
