/**
 * watchlistSelector.ts — 단타 감시 후보군 선별 및 히스테리시스 교체 순수 모듈.
 *
 * AutoPilot의 거대 클래스에서 감시 종목 선별(속도 자격, 상위 N개, 히스테리시스 교체)
 * 책임을 깊은 독립 모듈로 격리하여 테스트 가능성과 응집도를 극대화한다.
 */

export interface WatchlistSelectorSlot {
  ticker: string;
  tickRate(nowMs: number): number;
}

export interface SelectWatchedParams {
  slots: readonly WatchlistSelectorSlot[];
  currentlyWatched: readonly string[];
  minTickRate: number;
  watchCount: number;
  hysteresisRatio: number;
  isExcluded: (ticker: string) => boolean;
  nowMs: number;
}

/**
 * 자격자(틱/초 >= minTickRate) 중 상위 watchCount 재평가.
 * - 자격 미달 종목은 즉시 제거 (저유동성 방어)
 * - 빈 자리는 상위 후보로 충원
 * - 교체는 최저 감시 종목 대비 히스테리시스 배율(기본 1.2배) 초과 시에만 발생
 */
export function selectWatchedTickers({
  slots,
  currentlyWatched,
  minTickRate,
  watchCount,
  hysteresisRatio,
  isExcluded,
  nowMs,
}: SelectWatchedParams): { next: string[]; changed: boolean } {
  const byTicker = new Map(slots.map((s) => [s.ticker, s]));
  const rateOf = (t: string) => byTicker.get(t)?.tickRate(nowMs) ?? 0;

  const eligible = (t: string) =>
    byTicker.has(t) &&
    rateOf(t) >= minTickRate &&
    !isExcluded(t);

  // 1. 자격 유지 중인 기존 감시 종목 필터링
  const watched = currentlyWatched.filter(eligible);

  // 2. 신규 편입 가능한 후보군 정렬 (틱속도 내림차순)
  const candidates = slots
    .map((s) => s.ticker)
    .filter((t) => !watched.includes(t) && eligible(t))
    .sort((a, b) => rateOf(b) - rateOf(a));

  // 3. 빈 자리는 자격자로 충원 (히스테리시스 없이 채움)
  while (watched.length < watchCount && candidates.length > 0) {
    watched.push(candidates.shift()!);
  }

  // 4. 교체 판정: 최저 감시 vs 최고 후보 간 히스테리시스 배율 적용
  watched.sort((a, b) => rateOf(a) - rateOf(b));
  for (const challenger of candidates) {
    const lowest = watched[0];
    if (lowest === undefined) break;
    if (rateOf(challenger) > rateOf(lowest) * hysteresisRatio) {
      watched.shift();
      watched.push(challenger);
      watched.sort((a, b) => rateOf(a) - rateOf(b));
    } else {
      break;
    }
  }

  // 최종 틱속도 내림차순 정렬
  const next = watched.sort((a, b) => rateOf(b) - rateOf(a));
  const changed =
    next.length !== currentlyWatched.length ||
    next.some((t, i) => currentlyWatched[i] !== t);

  return { next, changed };
}
