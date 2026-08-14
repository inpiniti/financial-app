// 기울기/초 계산기 — 최근 윈도우의 가격 변화율을 초당 %로 환산한 순간값.
// 정본 정의: docs/domain/기울기/2026-08-14_기울기-초-개념과-설계.md §3
//   기울기/초 = ((p_last − p_first) / p_first × 100) ÷ 실경과초   (윈도우 안 양끝 틱)
//   · 분모는 윈도우 크기가 아니라 실제 경과시간 — 틱 없는 시간은 정보가 없다.
//   · 스팬 < minSpanMs(기본 1초)면 null(판정 불가) — 순간 점프의 초당 환산 폭주 방지.
//   · null ≠ 0 — 0은 "횡보" 판정, null은 "모름". 절대 혼용 금지.
// ⚠ 용어: 이 값은 "기울기/초"(%/초). SG 감지기 내부의 "기울기"(%/청크)와 다르다(문서 §2).
//
// 구조는 TickRateMeter 동형: 오름차순 큐 + head 프루닝, historyMs만큼 이력 보존해
// series()가 과거 시점 값을 타이머 없이 되계산한다. 시각은 전부 인자로 받는다.

export const DEFAULT_SLOPE_WINDOW_MS = 10_000;
export const DEFAULT_SLOPE_MIN_SPAN_MS = 1_000;
/** 시계열 조회용 추가 보존 기간 — series 기본 5점 × 1초 간격을 커버한다. */
export const DEFAULT_SLOPE_HISTORY_MS = 4_000;

export class SlopeMeter {
  private readonly windowMs: number;
  private readonly minSpanMs: number;
  private readonly historyMs: number;
  /** 보존 구간 안 (시각, 가격) — 시각 오름차순 큐. 프루닝은 앞에서만 일어난다. */
  private ticks: { tsMs: number; price: number }[] = [];
  private head = 0; // shift() 대신 head 인덱스 전진 — 틱 폭주 시 O(1) 프루닝.

  constructor(
    windowMs: number = DEFAULT_SLOPE_WINDOW_MS,
    minSpanMs: number = DEFAULT_SLOPE_MIN_SPAN_MS,
    historyMs: number = DEFAULT_SLOPE_HISTORY_MS,
  ) {
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error(`windowMs는 양수여야 해요: ${windowMs}`);
    }
    if (!Number.isFinite(minSpanMs) || minSpanMs <= 0) {
      throw new Error(`minSpanMs는 양수여야 해요: ${minSpanMs}`);
    }
    if (!Number.isFinite(historyMs) || historyMs < 0) {
      throw new Error(`historyMs는 0 이상이어야 해요: ${historyMs}`);
    }
    this.windowMs = windowMs;
    this.minSpanMs = minSpanMs;
    this.historyMs = historyMs;
  }

  /** 틱 1개 기록. 역행 틱도 버리지 않고 큐 끝에 둔다(무해 — 구간 스캔이 시각으로 거른다). */
  record(atMs: number, price: number): void {
    if (!Number.isFinite(price) || price <= 0) return; // 0·음수 가격은 분모를 망가뜨린다 — 조용히 무시.
    this.ticks.push({ tsMs: atMs, price });
    this.prune(atMs);
  }

  /** 현재 시점(nowMs) 기준 기울기/초(%/초). 판정 불가는 null — 0(횡보)과 다르다. */
  rate(nowMs: number): number | null {
    this.prune(nowMs);
    return this.rateAt(nowMs);
  }

  /**
   * 과거→현재 시계열 — [rate@now−(points−1)×step, …, rate@now].
   * 프루닝은 nowMs 기준 한 번만(과거 시점 조회가 이력을 파괴하지 않게).
   * 조회 가능한 과거 폭은 historyMs까지 — 그보다 먼 시점은 스팬이 잘려 null이 잦아진다.
   */
  series(nowMs: number, points = 5, stepMs = 1_000): (number | null)[] {
    this.prune(nowMs);
    const out: (number | null)[] = [];
    for (let i = points - 1; i >= 0; i -= 1) {
      out.push(this.rateAt(nowMs - i * stepMs));
    }
    return out;
  }

  reset(): void {
    this.ticks = [];
    this.head = 0;
  }

  /** (atMs − windowMs, atMs] 구간의 양끝 틱으로 %/초 계산 — 프루닝 없음(시계열 조회용). */
  private rateAt(atMs: number): number | null {
    const from = atMs - this.windowMs;
    let first: { tsMs: number; price: number } | null = null;
    let last: { tsMs: number; price: number } | null = null;
    // head부터 선형 스캔 — 보존 구간이 windowMs+historyMs(기본 14초)뿐이고 역행 틱을 허용하는 구조.
    for (let i = this.head; i < this.ticks.length; i += 1) {
      const t = this.ticks[i];
      if (t.tsMs <= from || t.tsMs > atMs) continue;
      if (first === null || t.tsMs < first.tsMs) first = t;
      if (last === null || t.tsMs >= last.tsMs) last = t;
    }
    if (first === null || last === null) return null;
    const spanMs = last.tsMs - first.tsMs;
    if (spanMs < this.minSpanMs) return null;
    const changePct = ((last.price - first.price) / first.price) * 100;
    return changePct / (spanMs / 1000);
  }

  /** (nowMs − windowMs − historyMs] 이전으로 밀려난 앞쪽 틱을 버린다. 배열 재구축은 낭비가 커질 때만. */
  private prune(nowMs: number): void {
    const cutoff = nowMs - this.windowMs - this.historyMs;
    while (this.head < this.ticks.length && this.ticks[this.head].tsMs <= cutoff) {
      this.head += 1;
    }
    if (this.head > 64 && this.head * 2 > this.ticks.length) {
      this.ticks = this.ticks.slice(this.head);
      this.head = 0;
    }
  }
}
