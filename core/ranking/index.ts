// 순위(Ranking) 도메인 — 트레이딩 리스트(감시 후보)를 어느 순위에서 몇 개씩 뽑을지 정하는 규칙.
// 도메인 문서: docs/domain/순위/2026-08-18_순위-도메인-plan.md
//
// 개념
//   · 원천(Source): 순위 하나. 토스는 (종류 × 기간 × 위험포함) 조합이 곧 원천 하나이고(8개),
//     한투(KIS)는 종류 하나가 원천 하나(7개)이며 기간창은 원천의 옵션(사용자 선택)이다.
//   · 선택(Selection): 원천별 {켬, 개수, (한투) 기간창}. 설정 화면이 저장하고 폴링이 읽는다.
//   · 계획(Plan): 선택에서 켜져 있고 개수>0인 원천만 카탈로그 순서(=우선권)로 나열한 것.
//     겹치는 티커는 앞 원천이 가져가고 뒤 원천은 차순위로 충원한다(watchlist.computeDesired).
//
// 플랫폼 무관 순수 TS — 실제 조회(lib/tossRanking·kis/ranking)는 호출부(managerProvider)가 한다.

// ── 토스 원천 ─────────────────────────────────────────────────────────────

export type TossMetric = 'volume' | 'amount';
export type TossDuration = 'realtime' | '1d';

export const TOSS_METRIC_LABEL: Record<TossMetric, string> = { volume: '거래량', amount: '거래대금' };
export const TOSS_DURATION_LABEL: Record<TossDuration, string> = { realtime: '실시간', '1d': '1일' };

// ── 한투(KIS) 원천 ────────────────────────────────────────────────────────

/** kis/ranking.ts의 RankingKind와 같은 이름 — 도메인이 kis 모듈을 import하지 않도록 여기서 다시 선언한다. */
export type KisMetric =
  | 'tradeVolume'
  | 'volumeSurge'
  | 'priceFluct'
  | 'tradeGrowth'
  | 'tradeTurnover'
  | 'volumePower'
  | 'upDownRate';

export const KIS_METRIC_LABEL: Record<KisMetric, string> = {
  tradeVolume: '거래량',
  volumeSurge: '거래량급증',
  priceFluct: '가격급등',
  tradeGrowth: '거래증가율',
  tradeTurnover: '거래회전율',
  volumePower: '매수체결강도',
  upDownRate: '상승율',
};

/** 기간창 단위 — 종류별로 일(NDAY) 또는 분(MINX/분 단위 NDAY). kis/ranking.ts RANKING_TIME_UNIT과 같다. */
export type KisWindowUnit = 'day' | 'minute';
export const KIS_METRIC_WINDOW_UNIT: Record<KisMetric, KisWindowUnit> = {
  tradeVolume: 'day',
  volumeSurge: 'minute',
  priceFluct: 'minute',
  tradeGrowth: 'day',
  tradeTurnover: 'day',
  volumePower: 'minute',
  upDownRate: 'day',
};

/** 기간창 값('0'~'9') — 문서 코드 그대로. 일 단위와 분 단위가 같은 코드 공간을 쓴다. */
export type KisWindow = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';
export const KIS_WINDOWS: readonly KisWindow[] = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** 일 단위 창 라벨(거래량순위.md NDAY 설명 그대로). */
export const KIS_DAY_WINDOW_LABEL: Record<KisWindow, string> = {
  '0': '당일',
  '1': '2일',
  '2': '3일',
  '3': '5일',
  '4': '10일',
  '5': '20일',
  '6': '30일',
  '7': '60일',
  '8': '120일',
  '9': '1년',
};

/** 분 단위 창 라벨(거래량급증.md MINX 설명 그대로). */
export const KIS_MINUTE_WINDOW_LABEL: Record<KisWindow, string> = {
  '0': '1분전',
  '1': '2분전',
  '2': '3분전',
  '3': '5분전',
  '4': '10분전',
  '5': '15분전',
  '6': '20분전',
  '7': '30분전',
  '8': '60분전',
  '9': '120분전',
};

export function kisWindowLabel(metric: KisMetric, window: KisWindow): string {
  return KIS_METRIC_WINDOW_UNIT[metric] === 'day' ? KIS_DAY_WINDOW_LABEL[window] : KIS_MINUTE_WINDOW_LABEL[window];
}

/** 기간창 기본값 — 일 단위는 당일, 분 단위는 5분전(리스트 폴링 주기 3분보다 살짝 넓게). */
export function defaultKisWindow(metric: KisMetric): KisWindow {
  return KIS_METRIC_WINDOW_UNIT[metric] === 'day' ? '0' : '3';
}

// ── 원천 카탈로그 ─────────────────────────────────────────────────────────

export interface TossRankingSource {
  readonly provider: 'toss';
  readonly id: string;
  readonly metric: TossMetric;
  readonly duration: TossDuration;
  /** true = 관리종목(투자위험·경고 계열) 포함(필터 없음), false = KRX_MANAGEMENT_STOCK 필터로 제외. */
  readonly includeRisk: boolean;
}

export interface KisRankingSource {
  readonly provider: 'kis';
  readonly id: string;
  readonly metric: KisMetric;
}

export type RankingSource = TossRankingSource | KisRankingSource;
export type RankingSourceId = string;

export function tossSourceId(metric: TossMetric, duration: TossDuration, includeRisk: boolean): RankingSourceId {
  return `toss:${metric}:${duration}:${includeRisk ? 'risk' : 'norisk'}`;
}

export function kisSourceId(metric: KisMetric): RankingSourceId {
  return `kis:${metric}`;
}

const TOSS_METRICS: readonly TossMetric[] = ['amount', 'volume'];
const TOSS_DURATIONS: readonly TossDuration[] = ['realtime', '1d'];
const KIS_METRICS: readonly KisMetric[] = [
  'tradeVolume',
  'tradeGrowth',
  'tradeTurnover',
  'volumeSurge',
  'priceFluct',
  'volumePower',
  'upDownRate',
];

/**
 * 원천 카탈로그 — **배열 순서가 곧 우선권**이다(앞 원천이 겹치는 티커를 가져간다).
 * 토스 8개(거래대금 → 거래량, 실시간 → 1일, 위험미포함 → 위험포함) 다음 한투 7개.
 * 기본 선택(거래대금 실시간 위험미포함 15 + 거래량 실시간 위험미포함 15)이 카탈로그 앞쪽에 오도록 배치했다.
 */
export const RANKING_SOURCES: readonly RankingSource[] = [
  ...TOSS_METRICS.flatMap((metric) =>
    TOSS_DURATIONS.flatMap((duration) =>
      [false, true].map(
        (includeRisk): TossRankingSource => ({
          provider: 'toss',
          id: tossSourceId(metric, duration, includeRisk),
          metric,
          duration,
          includeRisk,
        }),
      ),
    ),
  ),
  ...KIS_METRICS.map((metric): KisRankingSource => ({ provider: 'kis', id: kisSourceId(metric), metric })),
];

const SOURCE_BY_ID = new Map(RANKING_SOURCES.map((s) => [s.id, s]));

export function findRankingSource(id: RankingSourceId): RankingSource | undefined {
  return SOURCE_BY_ID.get(id);
}

/** 원천 표시명 — 예: "토스 거래대금 실시간 위험미포함", "한투 거래증가율". 한투 기간창은 선택값이라 라벨에 넣지 않는다. */
export function rankingSourceLabel(source: RankingSource): string {
  if (source.provider === 'toss') {
    return `토스 ${TOSS_METRIC_LABEL[source.metric]} ${TOSS_DURATION_LABEL[source.duration]} ${
      source.includeRisk ? '위험포함' : '위험미포함'
    }`;
  }
  return `한투 ${KIS_METRIC_LABEL[source.metric]}`;
}

/** 원천 id → 표시명. 모르는 id(옛 저장값 등)는 id 그대로 — 화면이 깨지지 않게. */
export function rankingSourceLabelOf(id: RankingSourceId): string {
  const source = findRankingSource(id);
  return source ? rankingSourceLabel(source) : id;
}

// ── 선택(Selection) ───────────────────────────────────────────────────────

export interface RankingSourceSelection {
  readonly enabled: boolean;
  /** 이 원천에서 채용할 최대 종목 수(0 이상 정수). 0이면 켜져 있어도 채용하지 않는다. */
  readonly count: number;
  /** 한투 원천의 기간창. 토스 원천은 무시된다. */
  readonly window?: KisWindow;
}

export type RankingSelection = Readonly<Record<RankingSourceId, RankingSourceSelection>>;

/**
 * 리스트 총 상한 — 모든 원천 개수의 합이 이 값을 넘지 못한다.
 * 근거: KIS WS 구독 예산 41건 = 체결가 30 + 호가(감시·진입·보유·급등) + 상세화면 (features/scalper/watchlist.ts).
 */
export const RANKING_TOTAL_MAX = 30;

/** 기본 선택 — 2026-08-14~18 실사용 구성 그대로: 토스 거래대금·거래량 실시간, 관리종목 제외, 각 15. */
export const DEFAULT_RANKING_SELECTION: RankingSelection = {
  [tossSourceId('amount', 'realtime', false)]: { enabled: true, count: 15 },
  [tossSourceId('volume', 'realtime', false)]: { enabled: true, count: 15 },
};

function toCount(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw ?? ''));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function toWindow(raw: unknown, metric: KisMetric): KisWindow {
  return typeof raw === 'string' && (KIS_WINDOWS as readonly string[]).includes(raw) ? (raw as KisWindow) : defaultKisWindow(metric);
}

/**
 * 저장값(부분·파손 가능) → 카탈로그 전 원천에 대해 정리된 선택.
 * 모르는 id는 버리고, 없는 원천은 {꺼짐, 0}(한투는 기본 기간창)으로 채운다. 개수는 0 이상 정수로 절사.
 * ⚠ 총합 상한은 여기서 자르지 않는다 — 어느 원천을 줄일지는 사용자 몫이라 저장 시 검증(validateRankingSelection)한다.
 */
export function normalizeRankingSelection(raw: unknown): RankingSelection {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, Partial<RankingSourceSelection> | undefined>;
  const out: Record<RankingSourceId, RankingSourceSelection> = {};
  for (const source of RANKING_SOURCES) {
    const item = input[source.id];
    const enabled = item?.enabled === true;
    const count = toCount(item?.count);
    out[source.id] =
      source.provider === 'kis'
        ? { enabled, count, window: toWindow(item?.window, source.metric) }
        : { enabled, count };
  }
  return out;
}

/** 켜진 원천의 개수 합(계획에 실제로 반영되는 양). */
export function totalSelectedCount(selection: RankingSelection): number {
  let total = 0;
  for (const source of RANKING_SOURCES) {
    const item = selection[source.id];
    if (item?.enabled) total += toCount(item.count);
  }
  return total;
}

/** 저장 전 검증 — 문제가 없으면 null, 있으면 사용자에게 보여줄 문구. */
export function validateRankingSelection(selection: RankingSelection): string | null {
  const total = totalSelectedCount(selection);
  if (total <= 0) return '순위 원천을 하나 이상 켜고 개수를 1 이상으로 입력해 주세요.';
  if (total > RANKING_TOTAL_MAX) return `켜진 원천의 개수 합이 ${RANKING_TOTAL_MAX}를 넘을 수 없어요. (지금 ${total})`;
  return null;
}

// ── 계획(Plan) ────────────────────────────────────────────────────────────

export interface RankingPlanItem {
  readonly source: RankingSource;
  /** 이 원천에서 채용할 최대 종목 수(1 이상). */
  readonly count: number;
  /** 한투 원천의 기간창(토스는 undefined). */
  readonly window?: KisWindow;
}

export type RankingPlan = readonly RankingPlanItem[];

/**
 * 선택 → 계획: 켜져 있고 개수>0인 원천만 카탈로그 순서(우선권)로. 총합이 상한을 넘으면 뒤 원천부터
 * 잘라 넘지 않게 한다(저장 검증을 우회한 옛 저장값 방어 — 정상 경로에선 자르지 않는다).
 */
export function planFromSelection(selection: RankingSelection): RankingPlan {
  const plan: RankingPlanItem[] = [];
  let remaining = RANKING_TOTAL_MAX;
  for (const source of RANKING_SOURCES) {
    const item = selection[source.id];
    if (!item?.enabled) continue;
    const count = Math.min(toCount(item.count), remaining);
    if (count <= 0) continue;
    remaining -= count;
    plan.push(
      source.provider === 'kis'
        ? { source, count, window: toWindow(item.window, source.metric) }
        : { source, count },
    );
    if (remaining <= 0) break;
  }
  return plan;
}

/** 계획의 동일성 비교 키 — 설정 재반영 시 "바뀌었나"를 싸게 판정한다. */
export function rankingPlanKey(plan: RankingPlan): string {
  return plan.map((p) => `${p.source.id}#${p.count}#${p.window ?? ''}`).join('|');
}
