// 틱/초 계산기 — "현재 시점 기준" 순간 활발도(plan §4-13: 평균이 아니라 지금 얼마나 활발한가).
// 최근 windowMs(기본 10초) 안에 들어온 틱 수 ÷ 윈도우 초로 계산한다. 틱이 끊기면
// 시간이 흐르는 것만으로 값이 내려간다(rate 호출 시점 기준 프루닝) — 별도 감쇠 타이머 불필요.
//
// 시계열(2026-08-14): 윈도우 밖 이력을 historyMs(기본 4초)만큼 더 보존해,
// series()가 "4초전~현재" 등 과거 시점 값을 타이머 없이 조회 시점에 되계산한다.
// 그래서 값 계산은 큐 잔량이 아니라 (t−W, t] 구간 카운트다.
//
// 순수 로직: 시각은 전부 인자로 받는다(ClockLike 주입 불필요 — 호출부가 clock.now()를 넘긴다).

export const DEFAULT_TICK_RATE_WINDOW_MS = 10_000;
/** 시계열 조회용 추가 보존 기간 — series 기본 5점 × 1초 간격을 커버한다. */
export const DEFAULT_TICK_RATE_HISTORY_MS = 4_000;

export class TickRateMeter {
  private readonly windowMs: number;
  private readonly historyMs: number;
  /** 보존 구간 안 틱 시각(ms) — 오름차순 큐. 프루닝은 앞에서만 일어난다. */
  private timestamps: number[] = [];
  private head = 0; // shift() 대신 head 인덱스 전진 — 틱 폭주 시 O(1) 프루닝.

  constructor(windowMs: number = DEFAULT_TICK_RATE_WINDOW_MS, historyMs: number = DEFAULT_TICK_RATE_HISTORY_MS) {
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error(`windowMs는 양수여야 해요: ${windowMs}`);
    }
    if (!Number.isFinite(historyMs) || historyMs < 0) {
      throw new Error(`historyMs는 0 이상이어야 해요: ${historyMs}`);
    }
    this.windowMs = windowMs;
    this.historyMs = historyMs;
  }

  /** 틱 1개 기록. atMs는 단조 증가가 원칙이지만, 역행 틱도 버리지 않고 큐 끝에 둔다(무해 — 구간 카운트가 걸러낸다). */
  record(atMs: number): void {
    this.timestamps.push(atMs);
    this.prune(atMs);
  }

  /** 현재 시점(nowMs) 기준 틱/초. 윈도우 밖 틱은 세지 않는다. */
  rate(nowMs: number): number {
    this.prune(nowMs);
    return this.rateAt(nowMs);
  }

  /**
   * 과거→현재 시계열 — [rate@now−(points−1)×step, …, rate@now].
   * 프루닝은 nowMs 기준 한 번만(과거 시점 조회가 이력을 파괴하지 않게).
   * 조회 가능한 과거 폭은 historyMs까지 — 그보다 먼 시점은 과소 집계될 수 있다.
   */
  series(nowMs: number, points = 5, stepMs = 1_000): number[] {
    this.prune(nowMs);
    const out: number[] = [];
    for (let i = points - 1; i >= 0; i -= 1) {
      out.push(this.rateAt(nowMs - i * stepMs));
    }
    return out;
  }

  /** 윈도우 안 틱 개수(진단·테스트용). */
  count(nowMs: number): number {
    this.prune(nowMs);
    return this.countInWindow(nowMs);
  }

  reset(): void {
    this.timestamps = [];
    this.head = 0;
  }

  /** (atMs − windowMs, atMs] 구간 카운트 기반 틱/초 — 프루닝 없음(시계열 조회용). */
  private rateAt(atMs: number): number {
    return this.countInWindow(atMs) / (this.windowMs / 1000);
  }

  private countInWindow(atMs: number): number {
    const from = atMs - this.windowMs;
    let n = 0;
    // head부터 선형 스캔 — 보존 구간이 windowMs+historyMs(기본 14초)뿐이고 역행 틱을 허용하는 구조라 이진탐색보다 안전.
    for (let i = this.head; i < this.timestamps.length; i += 1) {
      const ts = this.timestamps[i];
      if (ts > from && ts <= atMs) n += 1;
    }
    return n;
  }

  /** (nowMs − windowMs − historyMs] 이전으로 밀려난 앞쪽 틱을 버린다. 배열 재구축은 낭비가 커질 때만. */
  private prune(nowMs: number): void {
    const cutoff = nowMs - this.windowMs - this.historyMs;
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
