// 기울기 계산기 v2 — 직전 봉(윈도우) 평균 대비 현재 봉 평균의 변화율(%).
// 정본 정의: docs/domain/기울기/2026-08-14_기울기-초-개념과-설계.md §3
//   기울기 = (avg(현재 봉) − avg(직전 봉)) ÷ avg(직전 봉) × 100
//   · 봉 = (atMs−W, atMs] 슬라이딩 10초(기본) 구간, 직전 봉 = 그 앞 W 구간.
//   · v1(양끝점 %/초 환산)은 봉 끝 틱 하나에 휘둘려 같은 날 교체 — 평균 비교는 봉 안 노이즈가 상쇄된다.
//   · 두 봉 중 하나라도 틱이 없으면 null(판정 불가) — 0은 "평균이 같다"는 적극적 판정. 절대 혼용 금지.
// ⚠ 용어: 이 값은 "기울기/10초"(직전 봉 대비 %). SG 감지기 내부의 "기울기"(%/청크)와 다르다(문서 §2).
//
// 구조는 TickRateMeter 동형: 오름차순 큐 + head 프루닝, 시계열용 이력 보존,
// 타이머 없이 조회 시점 되계산. 시각은 전부 인자로 받는다.

export const DEFAULT_SLOPE_WINDOW_MS = 10_000;
/** 시계열 조회용 추가 보존 기간 — (칸수 5 − 1) × 간격 10초. 직전 봉 몫(+W)은 프루닝이 따로 더한다. */
export const DEFAULT_SLOPE_HISTORY_MS = 40_000;

export class SlopeMeter {
  private readonly windowMs: number;
  private readonly historyMs: number;
  /** 보존 구간 안 (시각, 가격) — 시각 오름차순 큐. 프루닝은 앞에서만 일어난다. */
  private ticks: { tsMs: number; price: number }[] = [];
  private head = 0; // shift() 대신 head 인덱스 전진 — 틱 폭주 시 O(1) 프루닝.

  constructor(windowMs: number = DEFAULT_SLOPE_WINDOW_MS, historyMs: number = DEFAULT_SLOPE_HISTORY_MS) {
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error(`windowMs는 양수여야 해요: ${windowMs}`);
    }
    if (!Number.isFinite(historyMs) || historyMs < 0) {
      throw new Error(`historyMs는 0 이상이어야 해요: ${historyMs}`);
    }
    this.windowMs = windowMs;
    this.historyMs = historyMs;
  }

  /** 틱 1개 기록. 역행 틱도 버리지 않고 큐 끝에 둔다(무해 — 구간 스캔이 시각으로 거른다). */
  record(atMs: number, price: number): void {
    if (!Number.isFinite(price) || price <= 0) return; // 0·음수 가격은 분모를 망가뜨린다 — 조용히 무시.
    this.ticks.push({ tsMs: atMs, price });
    this.prune(atMs);
  }

  /** 현재 시점(nowMs) 기준 기울기(직전 봉 평균 대비 %). 판정 불가는 null — 0(평균 동일)과 다르다. */
  rate(nowMs: number): number | null {
    this.prune(nowMs);
    return this.rateAt(nowMs);
  }

  /**
   * 과거→현재 시계열 — [rate@now−(points−1)×step, …, rate@now].
   * 간격 기본값 = 윈도우(봉이 겹치지 않게). 프루닝은 nowMs 기준 한 번만.
   * 조회 가능한 과거 폭은 historyMs까지 — 그보다 먼 시점은 봉이 잘려 null이 잦아진다.
   */
  series(nowMs: number, points = 5, stepMs = this.windowMs): (number | null)[] {
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

  /** 현재 봉 (atMs−W, atMs] 평균 vs 직전 봉 (atMs−2W, atMs−W] 평균 — 프루닝 없음(시계열 조회용). */
  private rateAt(atMs: number): number | null {
    const cur = this.avg(atMs - this.windowMs, atMs);
    const prev = this.avg(atMs - 2 * this.windowMs, atMs - this.windowMs);
    if (cur === null || prev === null) return null;
    return ((cur - prev) / prev) * 100;
  }

  /** (fromMs, toMs] 구간 틱 평균가 — 틱이 없으면 null. */
  private avg(fromMs: number, toMs: number): number | null {
    let sum = 0;
    let n = 0;
    // head부터 선형 스캔 — 보존 구간이 2W+historyMs(기본 60초)뿐이고 역행 틱을 허용하는 구조.
    for (let i = this.head; i < this.ticks.length; i += 1) {
      const t = this.ticks[i];
      if (t.tsMs <= fromMs || t.tsMs > toMs) continue;
      sum += t.price;
      n += 1;
    }
    return n === 0 ? null : sum / n;
  }

  /** (nowMs − 2W − historyMs] 이전으로 밀려난 앞쪽 틱을 버린다(가장 먼 칸의 직전 봉까지 보존). */
  private prune(nowMs: number): void {
    const cutoff = nowMs - 2 * this.windowMs - this.historyMs;
    while (this.head < this.ticks.length && this.ticks[this.head].tsMs <= cutoff) {
      this.head += 1;
    }
    if (this.head > 64 && this.head * 2 > this.ticks.length) {
      this.ticks = this.ticks.slice(this.head);
      this.head = 0;
    }
  }
}
