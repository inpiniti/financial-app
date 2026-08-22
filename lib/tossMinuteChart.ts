// 토스증권 미국주식 1분봉 — 비공식 API(페이로드 원문: docs/toss/분봉.txt). 로그인·쿠키 없이 호출된다(2026-08-18 curl 실호출 확인).
//
// 왜 토스인가(2026-08-18): 한투 분봉조회(HHDFS76950200)는 "정규장만" 준다 — 프리·애프터·주간거래(오버나이트)에
// 앱을 켜면 시드가 몇 시간 전 정규장 꼬리라 4선(5·20·60·120)이 전부 꼬였다. 토스 c-chart는 세션 구분 없이
// 이어진 봉(sessionType 필드로 세션만 표시)을 주고 오버나이트 구간(ET 20시~04시)까지 1분 공백 없이 들어온다
// (docs/toss/분봉.txt: US20200609002, ET 20:32~01:33 302봉 연속). 지연은 닫힌 봉 기준 사실상 0.
//
// 종목 식별자는 토스 productCode(US20100629001 등)라 티커→코드 해석이 한 번 필요하다 — 자동완성 검색의
// symbol 정확 일치로 푼다(resolveTossProductCode). 호출부가 캐시한다(코드는 바뀌지 않는다).
import type { MinuteBar } from '../core/trend/bars';
import type { OhlcvBar as ModelOhlcvBar } from '../core/model/bars';
import { TOSS_MARKET_TO_APP, type TossAppMarket } from './tossSearch';

type FetchLike = typeof fetch;

export interface TossMinuteChartDeps {
  fetchImpl?: FetchLike;
}

export const TOSS_CHART_URL = 'https://wts-info-api.tossinvest.com/api/v1/c-chart/us-s';
const TOSS_SEARCH_URL = 'https://wts-info-api.tossinvest.com/api/v2/search-all/wts-auto-complete';

/** 요청 봉 수 상한 — 원문은 302도 받았다. 링(130)보다 넉넉한 안전 상한만 둔다. */
export const TOSS_CHART_MAX_COUNT = 300;

/** 분봉.txt candles[] 원소 — 스키마 드리프트에 대비해 전부 옵셔널. */
interface RawTossCandle {
  /** ISO 8601 + 오프셋(ex. 2026-08-18T01:33:00-04:00) — 봉 시작 분. */
  dt?: string;
  sessionType?: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
}

/** 봉 하나 — dt는 원문 그대로(오프셋 붙은 ISO, 미국 종목은 ET). 차트 화면용 OHLCV. */
export interface TossMinuteCandle {
  dt: string;
  /** dt의 epoch 분 키. */
  minuteKey: number;
  sessionType?: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * 차트 URL 조립 — min:{interval}, count는 1..TOSS_CHART_MAX_COUNT로 자른다. (min:3·5·15도 실호출 확인)
 * adjusted=false면 **원시가**(분할·병합 조정 없는 당시 실제 가격) — 모델 경로가 쓴다. 학습 데이터가
 * `useAdjustedRate=false`로 모였고(financial-analyze src/tossChart.ts), 실시간 체결가(한투)도 원시가라
 * 그쪽과 눈금을 맞춘다. 추세 경로는 기존대로 조정가(true).
 */
export function buildTossChartUrl(productCode: string, count: number, intervalMin = 1, adjusted = true): string {
  const n = Math.max(1, Math.min(TOSS_CHART_MAX_COUNT, Math.floor(count)));
  const iv = Math.max(1, Math.floor(intervalMin));
  return `${TOSS_CHART_URL}/${encodeURIComponent(productCode)}/min:${iv}?count=${n}&useAdjustedRate=${adjusted}`;
}

/** 일봉 URL — day:1. 모델 경로의 전일 종가(원시가)용. */
export function buildTossDayChartUrl(productCode: string, count: number, adjusted = false): string {
  const n = Math.max(1, Math.min(TOSS_CHART_MAX_COUNT, Math.floor(count)));
  return `${TOSS_CHART_URL}/${encodeURIComponent(productCode)}/day:1?count=${n}&useAdjustedRate=${adjusted}`;
}

/** 응답 → OHLCV 봉(원문 순서 그대로 = 최신순). dt 파싱 불가·종가 0 이하는 버린다. */
export function parseTossMinuteCandles(body: unknown): TossMinuteCandle[] {
  const candles = (body as { result?: { candles?: unknown } } | null)?.result?.candles;
  if (!Array.isArray(candles)) return [];
  const out: TossMinuteCandle[] = [];
  for (const raw of candles as RawTossCandle[]) {
    if (typeof raw?.dt !== 'string') continue;
    const ms = Date.parse(raw.dt);
    const close = Number(raw.close);
    if (!Number.isFinite(ms) || !Number.isFinite(close) || close <= 0) continue;
    const open = Number(raw.open);
    const high = Number(raw.high);
    const low = Number(raw.low);
    out.push({
      dt: raw.dt,
      minuteKey: Math.floor(ms / 60_000),
      sessionType: raw.sessionType,
      open: Number.isFinite(open) && open > 0 ? open : close,
      high: Number.isFinite(high) && high > 0 ? high : close,
      low: Number.isFinite(low) && low > 0 ? low : close,
      close,
      volume: Number.isFinite(Number(raw.volume)) ? Number(raw.volume) : 0,
    });
  }
  return out;
}

/** 차트 화면용 — N분봉 count개(최신순). */
export async function fetchTossMinuteCandles(
  productCode: string,
  intervalMin: number,
  count: number,
  deps: TossMinuteChartDeps = {},
): Promise<TossMinuteCandle[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const res = await fetchImpl(buildTossChartUrl(productCode, count, intervalMin), {
    method: 'GET',
    headers: { accept: 'application/json' },
  });
  return parseTossMinuteCandles(await res.json());
}

/**
 * 응답 → MinuteBar[](분 키·종가). dt는 오프셋이 붙은 ISO라 Date.parse로 epoch가 정확히 나온다(DST 무관).
 * 파싱 불가·비유한·0 이하 종가는 버린다. 정렬·중복은 호출부(MinuteBarBuilder.seed)가 흡수하므로 손대지 않는다.
 * beforeMinuteKey를 주면 그 키 **이상**은 버린다 — 토스는 현재 분의 진행 중 봉도 내려주는데(min:5 실호출에서 확인)
 * 그걸 seed하면 MinuteBarBuilder가 그 분의 뒤이은 WS 틱을 "seed 마지막 키 이하"로 버려 봉이 미완성값으로 굳는다.
 */
export function parseTossMinuteBars(body: unknown, beforeMinuteKey?: number): MinuteBar[] {
  const out: MinuteBar[] = [];
  for (const c of parseTossMinuteCandles(body)) {
    if (beforeMinuteKey !== undefined && c.minuteKey >= beforeMinuteKey) continue;
    out.push({ minuteKey: c.minuteKey, close: c.close });
  }
  return out;
}

export interface FetchTossMinuteBarsOptions extends TossMinuteChartDeps {
  /** 지금(epoch ms) — 진행 중 봉 컷오프 기준. 기본 Date.now(). */
  nowMs?: number;
  /** 봉 주기(분, min:N). 기본 1. 컷오프도 이 주기의 진행 중 봉(봉 시작 키 ≥ 지금의 봉 시작 키)을 뺀다. */
  intervalMin?: number;
}

/** 토스 productCode의 최근 1분봉 count개 — 현재 분(진행 중) 봉은 뺀다. 응답이 비면 [] — throw는 네트워크·JSON 실패뿐. */
export async function fetchTossMinuteBars(
  productCode: string,
  count: number,
  deps: FetchTossMinuteBarsOptions = {},
): Promise<MinuteBar[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const iv = Math.max(1, Math.floor(deps.intervalMin ?? 1));
  const res = await fetchImpl(buildTossChartUrl(productCode, count, iv), {
    method: 'GET',
    headers: { accept: 'application/json' },
  });
  const nowKey = Math.floor((deps.nowMs ?? Date.now()) / (60_000 * iv)) * iv;
  return parseTossMinuteBars(await res.json(), nowKey);
}

interface RawSearchItem {
  symbol?: string;
  market?: string;
  productCode?: string;
  code?: string;
}

/**
 * 티커·거래소 → 토스 productCode. 자동완성 검색에서 symbol 정확 일치 + 거래소 일치 항목의 productCode.
 * 못 찾으면 null(호출부가 시드 실패로 처리 — WS 봉만으로 서서히 채운다).
 */
export async function resolveTossProductCode(
  ticker: string,
  market: TossAppMarket,
  deps: TossMinuteChartDeps = {},
): Promise<string | null> {
  const symbol = ticker.trim().toUpperCase();
  if (!symbol) return null;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const res = await fetchImpl(TOSS_SEARCH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query: symbol, sections: [{ type: 'PRODUCT' }] }),
  });
  const body = (await res.json()) as { result?: Array<{ data?: { items?: RawSearchItem[] } }> };
  const items = body.result?.[0]?.data?.items ?? [];
  // 거래소까지 맞는 것 우선, 없으면 심볼만 맞는 미국 종목(토스 거래소 코드가 우리 채용값과 어긋난 경우 대비).
  let fallback: string | null = null;
  for (const item of items) {
    if (item.symbol?.trim().toUpperCase() !== symbol) continue;
    const code = (item.productCode ?? item.code)?.trim();
    if (!code) continue;
    const m = item.market ? TOSS_MARKET_TO_APP[item.market] : undefined;
    if (m === market) return code;
    if (m && fallback === null) fallback = code;
  }
  return fallback;
}

// ── 모델 경로(2026-08-22) ───────────────────────────────────────────────────
// 왜 여기 따로 있나: 모델 Feature는 종가만이 아니라 OHLCV 전부와 **원시가**가 필요하다(core/model/bars.ts 주석).
// 추세용 fetchTossMinuteBars(종가·조정가)는 그대로 두고 모델용 조회를 나란히 둔다.

/** 응답 → 모델용 OHLCV 봉(오름차순). 진행 중(미완성) 봉은 뺀다 — beforeMinuteKey 이상은 버린다. */
export function parseTossOhlcvBars(body: unknown, beforeMinuteKey?: number): ModelOhlcvBar[] {
  const out: ModelOhlcvBar[] = [];
  for (const c of parseTossMinuteCandles(body)) {
    if (beforeMinuteKey !== undefined && c.minuteKey >= beforeMinuteKey) continue;
    out.push({
      minuteKey: c.minuteKey,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    });
  }
  return out.sort((a, b) => a.minuteKey - b.minuteKey);
}

export interface FetchTossOhlcvOptions extends TossMinuteChartDeps {
  /** 지금(epoch ms) — 진행 중 봉 컷오프 기준. 기본 Date.now(). */
  nowMs?: number;
  /** 봉 주기(분, min:N). 기본 5(모델 채택값). */
  intervalMin?: number;
}

/** 모델용 N분봉 count개(오름차순, 원시가, 진행 중 봉 제외). */
export async function fetchTossOhlcvBars(
  productCode: string,
  count: number,
  deps: FetchTossOhlcvOptions = {},
): Promise<ModelOhlcvBar[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const iv = Math.max(1, Math.floor(deps.intervalMin ?? 5));
  const res = await fetchImpl(buildTossChartUrl(productCode, count, iv, false), {
    method: 'GET',
    headers: { accept: 'application/json' },
  });
  const nowKey = Math.floor((deps.nowMs ?? Date.now()) / (60_000 * iv)) * iv;
  return parseTossOhlcvBars(await res.json(), nowKey);
}

/** 일봉 종가 하나 — 거래일(ET, 원문 dt의 날짜 부분)과 원시 종가. */
export interface TossDailyClose {
  date: string;
  close: number;
}

/** 응답 → 일봉 종가(날짜 오름차순). 종가 0 이하·날짜 파싱 불가는 버린다. */
export function parseTossDailyCloses(body: unknown): TossDailyClose[] {
  const candles = (body as { result?: { candles?: unknown } } | null)?.result?.candles;
  if (!Array.isArray(candles)) return [];
  const byDate = new Map<string, number>();
  for (const raw of candles as Array<{ dt?: string; close?: number }>) {
    if (typeof raw?.dt !== 'string' || raw.dt.length < 10) continue;
    const close = Number(raw.close);
    if (!Number.isFinite(close) || close <= 0) continue;
    byDate.set(raw.dt.slice(0, 10), close);
  }
  return [...byDate.entries()]
    .map(([date, close]) => ({ date, close }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** 최근 일봉 종가 count개(날짜 오름차순, 원시가). 오늘(진행 중) 일봉도 섞여 오므로 호출부가 날짜로 거른다. */
export async function fetchTossDailyCloses(
  productCode: string,
  count = 5,
  deps: TossMinuteChartDeps = {},
): Promise<TossDailyClose[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const res = await fetchImpl(buildTossDayChartUrl(productCode, count), {
    method: 'GET',
    headers: { accept: 'application/json' },
  });
  return parseTossDailyCloses(await res.json());
}
