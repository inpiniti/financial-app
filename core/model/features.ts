// 모델 입력 Feature 33개 — financial-analyze `src/build-dataset.ts`(+ `python/convert_parquet.py`의 FEATURES)의 이식본.
// 학습 파이프라인과 **한 자리라도 어긋나면 모델이 딴 값을 먹는다**. 바꾸지 말고, 정본이 바뀌면 통째로 다시 이식한다.
//
// 학습 규약 중 여기서 반드시 재현해야 하는 것들:
//  · 지표는 **그날 04:00 ET부터의 봉 전부**(프리·정규·애프터)로 잇는다 — 전일 연속성 없음. 워밍업은 null.
//  · CSV가 `toFixed(6)`으로 저장됐고 parquet에서 float32로 캐스팅됐다 → 여기서도 **6자리 반올림 + fround**.
//    (반올림을 빼면 트리 분기 문턱 근처에서 학습 때와 다른 가지를 탄다.)
//  · 전일 종가 정합 가드: 전일 종가와 당일 첫 봉 시가가 3배 이상 어긋나면 전일 계열 Feature 전부 null.
//  · null(결측)은 그대로 null로 넘긴다 — LightGBM이 결측 분기를 따로 배웠다. 0으로 채우면 안 된다.

import {
  atrWilder,
  bollingerPercentB,
  macdPct,
  rsiWilder,
  sma,
  stochastic,
  type Series,
} from './indicators';

/** 봉 하나(집계된 5분봉). 시간 오름차순으로 넘긴다. */
export interface OhlcvBar {
  /** 봉 시작 epoch 분. */
  minuteKey: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** 그날·그 종목의 봉 밖 맥락 — 전일 EOD와 당일 첫 봉 시가. 시드 때 한 번 만든다. */
export interface DayContext {
  /** 당일 첫 봉(04:00 ET 이후 첫 봉)의 시가. change_from_day_open의 분모. */
  dayOpen: number;
  /** 전일 EOD 종가(원시가). 모르면 null → 전일 계열 Feature 전부 null. */
  prevClose: number | null;
  /** 전전일 EOD 종가(원시가). prev_day_return 계산용. */
  prevPrevClose: number | null;
}

/** 모델 입력 순서 — python/convert_parquet.py의 FEATURES와 **같은 순서**여야 한다(테스트가 model.json과 대조). */
export const FEATURE_NAMES = [
  'return_1bar', 'return_3m', 'return_5m', 'return_10m', 'return_20m',
  'body_ratio', 'upper_wick_ratio', 'lower_wick_ratio',
  'volume_change_1bar', 'volume_ratio_20', 'volume_ratio_60',
  'ma5_slope', 'ma20_slope', 'ma60_slope', 'ma120_slope',
  'price_vs_ma5', 'price_vs_ma20', 'price_vs_ma60', 'price_vs_ma120',
  'rsi14', 'rsi_change', 'macd_pct', 'macd_pct_change', 'macd_hist_pct', 'macd_hist_pct_change',
  'stoch_k', 'stoch_d', 'bb_percent_b', 'atr_pct', 'atr_pct_change',
  'change_from_day_open', 'change_from_prev_close', 'prev_day_return',
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];

/**
 * 판정에 필요한 최소 봉 수 — 2봉(return_1bar이 생기는 시점).
 * ⚠ 여기서 121봉(ma120 완성)을 요구하면 안 된다: 5분봉으로 120봉은 04:00부터 10시간이라 **ET 14:00 이후**다.
 * 학습 표본은 09:31부터 있었고 그 구간의 ma120 계열은 전부 null이었다 — LightGBM이 그 결측을 그대로 배웠다.
 * 오전 신호를 살리려면 여기서 거르지 말고 null을 그대로 모델에 넘겨야 한다.
 */
export const MIN_BARS_FOR_SIGNAL = 2;

/**
 * CSV `toFixed(6)` → parquet float32 왕복 재현. null·비유한값은 null.
 * ⚠ toFixed는 반올림 규칙이 Math.round와 다른 자리가 있어 문자열 경유 그대로를 쓴다(학습 파이프라인과 동일 경로).
 */
export function quantize(v: number | null): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  return Math.fround(Number(v.toFixed(6)));
}

const pctDiv = (a: number | null, b: number | null): number | null =>
  a !== null && b !== null && b !== 0 ? (a - b) / b : null;

const slopeAt = (s: Series, i: number): number | null => (i > 0 ? pctDiv(s[i], s[i - 1]) : null);

const deltaAt = (s: Series, i: number): number | null =>
  i > 0 && s[i] !== null && s[i - 1] !== null ? s[i]! - s[i - 1]! : null;

/**
 * 마지막 봉 시점의 Feature 벡터(FEATURE_NAMES 순서, 길이 33). 결측은 null.
 * bars는 **그날 04:00 ET부터 마지막 봉까지 오름차순 전부**(거래량 0 봉도 포함 — 학습이 그랬다).
 */
export function computeFeatures(bars: readonly OhlcvBar[], ctx: DayContext): (number | null)[] {
  const n = bars.length;
  if (n === 0) return new Array(FEATURE_NAMES.length).fill(null);
  const i = n - 1;
  const b = bars[i];

  const closes = bars.map((x) => x.close);
  const highs = bars.map((x) => x.high);
  const lows = bars.map((x) => x.low);
  const vols = bars.map((x) => x.volume);

  const ma5 = sma(closes, 5);
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  const ma120 = sma(closes, 120);
  const rsi = rsiWilder(closes, 14);
  const { macd, hist } = macdPct(closes, 12, 26, 9);
  const { k: stochK, d: stochD } = stochastic(highs, lows, closes, 14, 3, 3);
  const bbB = bollingerPercentB(closes, 20, 2);
  const atr = atrWilder(highs, lows, closes, 14);
  const volSma20 = sma(vols, 20);
  const volSma60 = sma(vols, 60);

  // 전일 종가 정합 가드 — 병합·티커 변경이 얽힌 종목의 EOD 왜곡(FFAI ×80) 방어.
  const dayOpen = ctx.dayOpen;
  const prev = ctx.prevClose;
  const prevClose =
    prev !== null && prev > 0 && dayOpen > 0 && prev / dayOpen < 3 && dayOpen / prev < 3 ? prev : null;
  const prevDayReturn =
    prevClose !== null && ctx.prevPrevClose !== null && ctx.prevPrevClose > 0
      ? (prevClose - ctx.prevPrevClose) / ctx.prevPrevClose
      : null;

  const range = b.high - b.low;
  const atrPct = atr[i] !== null ? atr[i]! / b.close : null;
  const atrPctPrev = i > 0 && atr[i - 1] !== null ? atr[i - 1]! / closes[i - 1] : null;
  const backReturn = (k: number): number | null =>
    i >= k && closes[i - k] !== 0 ? (b.close - closes[i - k]) / closes[i - k] : null;

  const raw: (number | null)[] = [
    backReturn(1), backReturn(3), backReturn(5), backReturn(10), backReturn(20),
    range > 0 ? Math.abs(b.close - b.open) / range : null,
    range > 0 ? (b.high - Math.max(b.open, b.close)) / range : null,
    range > 0 ? (Math.min(b.open, b.close) - b.low) / range : null,
    i > 0 && vols[i - 1] > 0 ? (b.volume - vols[i - 1]) / vols[i - 1] : null,
    volSma20[i] !== null && volSma20[i]! > 0 ? b.volume / volSma20[i]! : null,
    volSma60[i] !== null && volSma60[i]! > 0 ? b.volume / volSma60[i]! : null,
    slopeAt(ma5, i), slopeAt(ma20, i), slopeAt(ma60, i), slopeAt(ma120, i),
    pctDiv(b.close, ma5[i]), pctDiv(b.close, ma20[i]), pctDiv(b.close, ma60[i]), pctDiv(b.close, ma120[i]),
    rsi[i], deltaAt(rsi, i),
    macd[i], deltaAt(macd, i), hist[i], deltaAt(hist, i),
    stochK[i], stochD[i], bbB[i],
    atrPct, atrPct !== null && atrPctPrev !== null ? atrPct - atrPctPrev : null,
    dayOpen > 0 ? (b.close - dayOpen) / dayOpen : null,
    prevClose !== null ? (b.close - prevClose) / prevClose : null,
    prevDayReturn,
  ];
  return raw.map(quantize);
}
