// 틱/초 계산기 — "현재 시점 기준" 순간 활발도(plan §4-13: 평균이 아니라 지금 얼마나 활발한가).
// 최근 windowMs(기본 10초) 안에 들어온 틱 수 ÷ 윈도우 초로 계산한다. 틱이 끊기면
// 시간이 흐르는 것만으로 값이 내려간다(rate 호출 시점 기준 프루닝) — 별도 감쇠 타이머 불필요.
//
// 순수 로직: 시각은 전부 인자로 받는다(ClockLike 주입 불필요 — 호출부가 clock.now()를 넘긴다).

export const DEFAULT_TICK_RATE_WINDOW_MS = 10_000;

export class TickRateMeter {
  private readonly windowMs: number;
  /** 윈도우 안 틱 시각(ms) — 오름차순 큐. 프루닝은 앞에서만 일어난다. */
  private timestamps: number[] = [];
  private head = 0; // shift() 대신 head 인덱스 전진 — 틱 폭주 시 O(1) 프루닝.

  constructor(windowMs: number = DEFAULT_TICK_RATE_WINDOW_MS) {
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error(`windowMs는 양수여야 해요: ${windowMs}`);
    }
    this.windowMs = windowMs;
  }

  /** 틱 1개 기록. atMs는 단조 증가가 원칙이지만, 역행 틱도 버리지 않고 큐 끝에 둔다(무해 — 프루닝이 걸러낸다). */
  record(atMs: number): void {
    this.timestamps.push(atMs);
    this.prune(atMs);
  }

  /** 현재 시점(nowMs) 기준 틱/초. 윈도우 밖 틱은 세지 않는다. */
  rate(nowMs: number): number {
    this.prune(nowMs);
    return (this.timestamps.length - this.head) / (this.windowMs / 1000);
  }

  /** 윈도우 안 틱 개수(진단·테스트용). */
  count(nowMs: number): number {
    this.prune(nowMs);
    return this.timestamps.length - this.head;
  }

  reset(): void {
    this.timestamps = [];
    this.head = 0;
  }

  /** (nowMs - windowMs, nowMs] 밖으로 밀려난 앞쪽 틱을 버린다. 배열 재구축은 낭비가 커질 때만. */
  private prune(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    while (this.head < this.timestamps.length && this.timestamps[this.head] <= cutoff) {
      this.head += 1;
    }
    // head가 절반을 넘으면 실제로 잘라 메모리를 되돌려준다(호출 빈도 대비 드물게).
    if (this.head > 64 && this.head * 2 > this.timestamps.length) {
      this.timestamps = this.timestamps.slice(this.head);
      this.head = 0;
    }
  }
}
