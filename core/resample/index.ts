// 틱 리샘플러: WS 체결 틱(초당 수십 건)을 직접 연산하지 않고,
// 청크 초(기본 3초) 동안의 평균가 1개로 줄여 홀수 크기 원형 버퍼에 유지한다.
// 플랫폼 무관 순수 TS — RN/KIS를 모른다. (PRD §4-B)

/** 체결 틱. ts는 epoch 밀리초. volume·strength는 게이트용 옵션(미제공 시 집계에서 제외). */
export interface Tick {
  price: number;
  ts: number;
  /** 이 틱의 체결량(KIS EVOL). 유한값일 때만 청크 거래량에 합산된다. */
  volume?: number;
  /** 체결강도(KIS STRN, 100=매수·매도 균형). 유한값일 때만 lastStrength로 갱신된다. */
  strength?: number;
}

export interface ResamplerOptions {
  /** 리샘플 청크 길이(초). 기본 3 */
  chunkSeconds?: number;
  /** 원형 버퍼(=SG 창) 크기. 홀수 강제, 5 이상. 기본 31 */
  bufferSize?: number;
}

const DEFAULT_CHUNK_SECONDS = 3;
const DEFAULT_BUFFER_SIZE = 31;
const MIN_BUFFER_SIZE = 5; // Savitzky-Golay 최소 창

/** 짝수면 다음 홀수로 올림. */
function forceOdd(n: number): number {
  return n % 2 === 0 ? n + 1 : n;
}

export class Resampler {
  /** 청크 길이(ms). */
  readonly chunkMs: number;
  /** 실효 버퍼 크기(홀수 강제 후). */
  readonly bufferSize: number;

  private readonly ring: number[] = [];
  /** 청크별 거래량 링 — 가격 링과 같은 크기·같은 push 타이밍. 청크에 유한 volume이 없었으면 null. */
  private readonly volRing: (number | null)[] = [];
  private chunkStart: number | null = null;
  private sum = 0;
  private count = 0;
  private volumeSum = 0;
  private hasVolume = false;
  private lastStrengthValue: number | null = null;

  constructor(options: ResamplerOptions = {}) {
    const chunkSeconds = options.chunkSeconds ?? DEFAULT_CHUNK_SECONDS;
    const requested = options.bufferSize ?? DEFAULT_BUFFER_SIZE;
    const effective = forceOdd(requested);
    if (effective < MIN_BUFFER_SIZE) {
      throw new RangeError(
        `bufferSize는 최소 ${MIN_BUFFER_SIZE} 이상이어야 합니다 (요청: ${requested}).`,
      );
    }
    this.chunkMs = chunkSeconds * 1000;
    this.bufferSize = effective;
  }

  /**
   * 틱 1개를 수신한다. 이 틱이 현재 청크의 경계를 넘으면 직전 청크를 마감해
   * 평균가를 버퍼에 넣고 그 값을 반환한다. 아니면 누적만 하고 null을 반환한다.
   */
  addTick(tick: Tick): number | null {
    if (this.chunkStart === null) {
      this.chunkStart = tick.ts;
      this.accumulate(tick);
      return null;
    }
    if (tick.ts >= this.chunkStart + this.chunkMs) {
      const closed = this.closeChunk();
      // 경계를 넘긴 이 틱은 새 청크의 첫 틱이 된다(volume도 새 청크 귀속).
      this.chunkStart = tick.ts;
      this.accumulate(tick);
      return closed;
    }
    this.accumulate(tick);
    return null;
  }

  /** 아직 경계를 넘지 않은 현재 청크를 강제로 마감한다(데이터 없으면 null). */
  flush(): number | null {
    if (this.count === 0) return null;
    const closed = this.closeChunk();
    this.chunkStart = null;
    return closed;
  }

  /** 상태 초기화 — 새 Run이 이전 사이클의 잔여 버퍼로 오판하지 않도록 워밍업을 처음부터 다시 한다. */
  reset(): void {
    this.ring.length = 0;
    this.volRing.length = 0;
    this.chunkStart = null;
    this.sum = 0;
    this.count = 0;
    this.volumeSum = 0;
    this.hasVolume = false;
    this.lastStrengthValue = null;
  }

  /** 현재 버퍼(오래된→최신 순)의 읽기 전용 뷰. */
  get buffer(): readonly number[] {
    return this.ring;
  }

  /** 청크별 거래량(오래된→최신 순). 유한 volume이 없던 청크는 null. */
  get volumeBuffer(): readonly (number | null)[] {
    return this.volRing;
  }

  /** 마지막으로 수신한 유한 체결강도(STRN). 없으면 null. */
  get lastStrength(): number | null {
    return this.lastStrengthValue;
  }

  /** volumeSpike 판정에 필요한 최소 non-null 거래량 이력(마지막 청크 제외). */
  private static readonly MIN_VOLUME_HISTORY = 5;

  /**
   * 거래량 스파이크 배율 — 마지막 청크 거래량 ÷ 이전 청크들(non-null)의 평균.
   * 마지막 청크가 null, non-null 이력이 5개 미만, 평균이 0이면 null(판정 불가 → 게이트는 fail-open).
   */
  volumeSpike(): number | null {
    if (this.volRing.length < 2) return null;
    const last = this.volRing[this.volRing.length - 1];
    if (last === null) return null;
    const history = this.volRing.slice(0, -1).filter((v): v is number => v !== null);
    if (history.length < Resampler.MIN_VOLUME_HISTORY) return null;
    const avg = history.reduce((a, b) => a + b, 0) / history.length;
    if (avg <= 0) return null;
    return last / avg;
  }

  /** 버퍼가 창 크기만큼 차 신호 판정이 가능한 상태인가. */
  get warmedUp(): boolean {
    return this.ring.length === this.bufferSize;
  }

  private accumulate(tick: Tick): void {
    this.sum += tick.price;
    this.count += 1;
    if (tick.volume !== undefined && Number.isFinite(tick.volume)) {
      this.volumeSum += tick.volume;
      this.hasVolume = true;
    }
    if (tick.strength !== undefined && Number.isFinite(tick.strength)) {
      this.lastStrengthValue = tick.strength;
    }
  }

  private closeChunk(): number {
    const avg = this.sum / this.count;
    this.sum = 0;
    this.count = 0;
    this.ring.push(avg);
    if (this.ring.length > this.bufferSize) this.ring.shift();
    this.volRing.push(this.hasVolume ? this.volumeSum : null);
    if (this.volRing.length > this.bufferSize) this.volRing.shift();
    this.volumeSum = 0;
    this.hasVolume = false;
    return avg;
  }
}
