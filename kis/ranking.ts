// 해외주식 순위 7종 — docs/koreainvestment/{거래량순위,거래량급증,가격급등락,거래증가율순위,거래회전율순위,매수체결강도상위,상승율하락율}.md 그대로.
// 공통 함정 1: 7종 전부 "모의 Domain: 미지원" — priceDetail.ts와 동일 판단으로 environment 파라미터 없이 항상 실전 도메인 고정.
// 공통 함정 2(⚠ 중요): 매수체결강도상위.md의 Query Parameter 이름은 다른 5종과 똑같이 "NDAY"이지만,
//   그 설명(Description)은 "N분전 : 0(1분전), 1(2분전), ... 9(120분전)"으로 분(分) 단위다.
//   나머지 5종(거래량순위·거래증가율순위·거래회전율순위는 NDAY=일 단위, 거래량급증·가격급등락은 MINX=분 단위)과
//   달리 필드명만 보고 "NDAY=일"이라 오해하면 안 된다 — 문서 원문 그대로 옮기고 타입/주석/테스트로 고정한다.
import { REST_DOMAIN } from './domain';
import { appendQuery, assertRtCdOk, buildAuthHeaders, type KisRtCdResponse } from './http';
import type { FetchLike, KisCredentials } from './types';

/** EXCD — 순위 7종 공통 거래소코드(각 .md Query Parameter 표 그대로). PRD §4-E: 미국 3종(NYS/NAS/AMS) 기본. */
export type RankingExchangeCode =
  | 'NYS' // 뉴욕
  | 'NAS' // 나스닥
  | 'AMS' // 아멕스
  | 'HKS' // 홍콩
  | 'SHS' // 상해
  | 'SZS' // 심천
  | 'HSX' // 호치민
  | 'HNX' // 하노이
  | 'TSE'; // 도쿄

/** VOL_RANG — 순위 6종 공통 거래량조건. 기본값 '0'(전체). */
export type VolumeRange = '0' | '1' | '2' | '3' | '4' | '5' | '6';

/** NDAY(일 단위) — 거래량순위·거래증가율순위·거래회전율순위 공통. 0(당일) ~ 9(1년전). */
export type DayWindow = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';

/** MINX(분 단위) / 매수체결강도상위의 NDAY(마찬가지로 분 단위) — 0(1분전) ~ 9(120분전). */
export type MinuteWindow = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';

/** GUBN — 가격급등락.md 전용. 0(급락), 1(급등). */
export type PriceFluctDirection = '0' | '1';

/** GUBN — 상승율하락율.md 전용. 0(하락율), 1(상승율). */
export type UpDownRateDirection = '0' | '1';

export interface RankingDeps {
  fetchImpl?: FetchLike;
}

interface RankingRowBase {
  rsym: string;
  excd: string;
  symb: string;
  last: string;
  sign: string;
  diff: string;
  rate: string;
  [key: string]: unknown;
}

async function callRanking<T extends RankingRowBase>(
  path: string,
  trId: string,
  credentials: KisCredentials,
  accessToken: string,
  query: Record<string, string | undefined>,
  deps: RankingDeps,
): Promise<{ output1: Record<string, unknown>; output2: T[] }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  // 6종 전부 모의투자 미지원 — 항상 실전 도메인(REST_DOMAIN.live)으로 호출한다.
  const url = appendQuery(`${REST_DOMAIN.live}/uapi/overseas-stock/v1/ranking/${path}`, {
    KEYB: '',
    AUTH: '',
    ...query,
  });

  const res = await fetchImpl(url, {
    method: 'GET',
    headers: buildAuthHeaders(accessToken, credentials, trId),
  });
  const body = (await res.json()) as KisRtCdResponse & { output1: Record<string, unknown>; output2: T[] };
  assertRtCdOk(body);
  return { output1: body.output1, output2: body.output2 };
}

// ── 1. 거래량순위 [해외주식-043] — HHDFS76310010 ──────────────────────────
export interface TradeVolumeRankingRow extends RankingRowBase {
  name: string;
  pask: string;
  pbid: string;
  tvol: string;
  tamt: string;
  a_tvol: string;
  rank: string;
  ename: string;
  e_ordyn: string;
}

export interface TradeVolumeRankingParams {
  excd: RankingExchangeCode;
  /** NDAY(일 단위) — 0(당일) ~ 9(1년전). */
  nday: DayWindow;
  /** PRC1 — 현재가 필터범위 시작. 기본 '0'. */
  prc1?: string;
  /** PRC2 — 현재가 필터범위 끝. 기본 '999999'. */
  prc2?: string;
  volRang?: VolumeRange;
}

export function inquireTradeVolumeRanking(
  credentials: KisCredentials,
  accessToken: string,
  params: TradeVolumeRankingParams,
  deps: RankingDeps = {},
) {
  return callRanking<TradeVolumeRankingRow>(
    'trade-vol',
    'HHDFS76310010',
    credentials,
    accessToken,
    {
      EXCD: params.excd,
      NDAY: params.nday,
      PRC1: params.prc1 ?? '0',
      PRC2: params.prc2 ?? '999999',
      VOL_RANG: params.volRang ?? '0',
    },
    deps,
  );
}

// ── 2. 거래량급증 [해외주식-039] — HHDFS76270000 ──────────────────────────
export interface VolumeSurgeRankingRow extends RankingRowBase {
  knam: string;
  tvol: string;
  pask: string;
  pbid: string;
  n_tvol: string;
  n_diff: string;
  n_rate: string;
  enam: string;
  e_ordyn: string;
}

export interface VolumeSurgeRankingParams {
  excd: RankingExchangeCode;
  /** MINX(분 단위) — 0(1분전) ~ 9(120분전). */
  minx: MinuteWindow;
  volRang?: VolumeRange;
}

export function inquireVolumeSurgeRanking(
  credentials: KisCredentials,
  accessToken: string,
  params: VolumeSurgeRankingParams,
  deps: RankingDeps = {},
) {
  return callRanking<VolumeSurgeRankingRow>(
    'volume-surge',
    'HHDFS76270000',
    credentials,
    accessToken,
    {
      EXCD: params.excd,
      MINX: params.minx,
      VOL_RANG: params.volRang ?? '0',
    },
    deps,
  );
}

// ── 3. 가격급등락 [해외주식-038] — HHDFS76260000 ──────────────────────────
export interface PriceFluctRankingRow extends RankingRowBase {
  knam: string;
  tvol: string;
  pask: string;
  pbid: string;
  n_base: string;
  n_diff: string;
  n_rate: string;
  enam: string;
  e_ordyn: string;
}

export interface PriceFluctRankingParams {
  excd: RankingExchangeCode;
  /** GUBN — 0(급락), 1(급등). */
  gubn: PriceFluctDirection;
  /** MINX(분 단위) — 0(1분전) ~ 9(120분전). */
  minx: MinuteWindow;
  volRang?: VolumeRange;
}

export function inquirePriceFluctRanking(
  credentials: KisCredentials,
  accessToken: string,
  params: PriceFluctRankingParams,
  deps: RankingDeps = {},
) {
  return callRanking<PriceFluctRankingRow>(
    'price-fluct',
    'HHDFS76260000',
    credentials,
    accessToken,
    {
      EXCD: params.excd,
      GUBN: params.gubn,
      MINX: params.minx,
      VOL_RANG: params.volRang ?? '0',
    },
    deps,
  );
}

// ── 4. 거래증가율순위 [해외주식-045] — HHDFS76330000 ───────────────────────
export interface TradeGrowthRankingRow extends RankingRowBase {
  name: string;
  pask: string;
  pbid: string;
  tvol: string;
  n_tvol: string;
  n_rate: string;
  rank: string;
  ename: string;
  e_ordyn: string;
}

export interface TradeGrowthRankingParams {
  excd: RankingExchangeCode;
  /** NDAY(일 단위) — 0(당일) ~ 9(1년전). */
  nday: DayWindow;
  volRang?: VolumeRange;
}

export function inquireTradeGrowthRanking(
  credentials: KisCredentials,
  accessToken: string,
  params: TradeGrowthRankingParams,
  deps: RankingDeps = {},
) {
  return callRanking<TradeGrowthRankingRow>(
    'trade-growth',
    'HHDFS76330000',
    credentials,
    accessToken,
    {
      EXCD: params.excd,
      NDAY: params.nday,
      VOL_RANG: params.volRang ?? '0',
    },
    deps,
  );
}

// ── 5. 거래회전율순위 [해외주식-046] — HHDFS76340000 ───────────────────────
export interface TradeTurnoverRankingRow extends RankingRowBase {
  name: string;
  tvol: string;
  pask: string;
  pbid: string;
  n_tvol: string;
  shar: string;
  tover: string;
  rank: string;
  ename: string;
  e_ordyn: string;
}

export interface TradeTurnoverRankingParams {
  excd: RankingExchangeCode;
  /** NDAY(일 단위) — 0(당일) ~ 9(1년전). */
  nday: DayWindow;
  volRang?: VolumeRange;
}

export function inquireTradeTurnoverRanking(
  credentials: KisCredentials,
  accessToken: string,
  params: TradeTurnoverRankingParams,
  deps: RankingDeps = {},
) {
  return callRanking<TradeTurnoverRankingRow>(
    'trade-turnover',
    'HHDFS76340000',
    credentials,
    accessToken,
    {
      EXCD: params.excd,
      NDAY: params.nday,
      VOL_RANG: params.volRang ?? '0',
    },
    deps,
  );
}

// ── 6. 매수체결강도상위 [해외주식-040] — HHDFS76280000 ─────────────────────
// ⚠ 이 API만 Query Parameter 이름이 "NDAY"이지만 값 단위는 분(分)이다(문서 Description 원문: "N분전").
export interface VolumePowerRankingRow extends RankingRowBase {
  knam: string;
  tvol: string;
  pask: string;
  pbid: string;
  tpow: string;
  powx: string;
  enam: string;
  e_ordyn: string;
}

export interface VolumePowerRankingParams {
  excd: RankingExchangeCode;
  /** 문서상 파라미터명은 NDAY지만 값은 분 단위(0=1분전 ~ 9=120분전) — MinuteWindow 타입으로 오용을 방지한다. */
  nday: MinuteWindow;
  volRang?: VolumeRange;
}

export function inquireVolumePowerRanking(
  credentials: KisCredentials,
  accessToken: string,
  params: VolumePowerRankingParams,
  deps: RankingDeps = {},
) {
  return callRanking<VolumePowerRankingRow>(
    'volume-power',
    'HHDFS76280000',
    credentials,
    accessToken,
    {
      EXCD: params.excd,
      NDAY: params.nday,
      VOL_RANG: params.volRang ?? '0',
    },
    deps,
  );
}

// ── 7. 상승율/하락율 [해외주식-041] — HHDFS76290000 ────────────────────────
// ⚠ 가격급등락(3번)과 똑같이 GUBN을 쓰지만 시간창 파라미터는 MINX(분)가 아니라 NDAY(일)다.
export interface UpDownRateRankingRow extends RankingRowBase {
  name: string;
  tvol: string;
  pask: string;
  pbid: string;
  n_base: string;
  n_diff: string;
  n_rate: string;
  rank: string;
  ename: string;
  e_ordyn: string;
}

export interface UpDownRateRankingParams {
  excd: RankingExchangeCode;
  /** GUBN — 0(하락율), 1(상승율). */
  gubn: UpDownRateDirection;
  /** NDAY(일 단위) — 0(당일) ~ 9(1년전). */
  nday: DayWindow;
  volRang?: VolumeRange;
}

export function inquireUpDownRateRanking(
  credentials: KisCredentials,
  accessToken: string,
  params: UpDownRateRankingParams,
  deps: RankingDeps = {},
) {
  return callRanking<UpDownRateRankingRow>(
    'updown-rate',
    'HHDFS76290000',
    credentials,
    accessToken,
    {
      EXCD: params.excd,
      GUBN: params.gubn,
      NDAY: params.nday,
      VOL_RANG: params.volRang ?? '0',
    },
    deps,
  );
}

// ── 조회 탭 UI용 메타(종류 선택 드롭다운/칩) ─────────────────────────────
export type RankingKind =
  | 'tradeVolume'
  | 'volumeSurge'
  | 'priceFluct'
  | 'tradeGrowth'
  | 'tradeTurnover'
  | 'volumePower'
  | 'upDownRate';

export const RANKING_KIND_LABEL: Record<RankingKind, string> = {
  tradeVolume: '거래량순위',
  volumeSurge: '거래량급증',
  priceFluct: '가격급등락',
  tradeGrowth: '거래증가율순위',
  tradeTurnover: '거래회전율순위',
  volumePower: '매수체결강도상위',
  upDownRate: '상승율/하락율',
};

/** 종류별 TR ID(실전 전용) — 안전장치: 여기 없는 종류로는 호출하지 않는다. */
export const RANKING_TR_ID: Record<RankingKind, string> = {
  tradeVolume: 'HHDFS76310010',
  volumeSurge: 'HHDFS76270000',
  priceFluct: 'HHDFS76260000',
  tradeGrowth: 'HHDFS76330000',
  tradeTurnover: 'HHDFS76340000',
  volumePower: 'HHDFS76280000',
  upDownRate: 'HHDFS76290000',
};

/** 종류별 시간창 파라미터 단위 — UI가 '일'/'분' 라벨을 고를 때 참고(매수체결강도상위만 분 단위 NDAY). */
export const RANKING_TIME_UNIT: Record<RankingKind, 'day' | 'minute' | 'none'> = {
  tradeVolume: 'day',
  volumeSurge: 'minute',
  priceFluct: 'minute',
  tradeGrowth: 'day',
  tradeTurnover: 'day',
  volumePower: 'minute',
  upDownRate: 'day',
};
