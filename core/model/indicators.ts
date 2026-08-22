// 기술 지표 — financial-analyze `src/indicators.ts`의 **1:1 이식본**. 계산식 정본은 그쪽 `docs/FEATURES.md`.
// 이 파일을 고치면 학습 때 쓴 계산과 어긋나 모델이 딴 값을 먹는다 — 고치지 말고, 정본이 바뀌면 통째로 다시 이식한다.
//
// 전부 "해당 인덱스까지의 값만" 쓰는 순차 계산(누수 없음). 입력과 같은 길이의 배열을 돌려주고 워밍업 구간은 null.
// 앱에 이미 있는 core/trend/index.ts의 smaSeries와 **다른 함수**다 — 그쪽은 창 안 비유한값을 null로 접지만
// 여기 sma는 학습 파이프라인 그대로 단순 누적이다. 섞어 쓰지 말 것.

export type Series = (number | null)[];

/** 단순이동평균 — 직전 period개(현재 포함) 평균. */
export function sma(values: readonly number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** 지수이동평균 — 표준 시드: 첫 period개의 SMA, 이후 k=2/(period+1). */
export function ema(values: readonly number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev: number | null = null;
  let seedSum = 0;
  for (let i = 0; i < values.length; i += 1) {
    if (prev === null) {
      seedSum += values[i];
      if (i === period - 1) {
        prev = seedSum / period;
        out[i] = prev;
      }
      continue;
    }
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** RSI(Wilder) — 기간 14 표준. 첫 평균은 단순평균, 이후 Wilder 평활. 손실 0이면 100. */
export function rsiWilder(closes: readonly number[], period = 14): Series {
  const out: Series = new Array(closes.length).fill(null);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < closes.length; i += 1) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    if (i <= period) {
      avgGain += gain / period;
      avgLoss += loss / period;
      if (i === period) out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      continue;
    }
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/** True Range — 첫 봉은 고저폭. */
function trueRange(h: readonly number[], l: readonly number[], c: readonly number[], i: number): number {
  if (i === 0) return h[0] - l[0];
  return Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
}

/** ATR(Wilder) — 기간 14 표준. 첫 값은 TR 단순평균, 이후 Wilder 평활. */
export function atrWilder(
  h: readonly number[],
  l: readonly number[],
  c: readonly number[],
  period = 14,
): Series {
  const out: Series = new Array(c.length).fill(null);
  let atr = 0;
  for (let i = 0; i < c.length; i += 1) {
    const tr = trueRange(h, l, c, i);
    if (i < period) {
      atr += tr / period;
      if (i === period - 1) out[i] = atr;
      continue;
    }
    atr = (atr * (period - 1) + tr) / period;
    out[i] = atr;
  }
  return out;
}

/** 스토캐스틱 슬로우 14/3/3 — fastK=(C−L14)/(H14−L14)×100, K=SMA3(fastK), D=SMA3(K). 고저폭 0이면 null. */
export function stochastic(
  h: readonly number[],
  l: readonly number[],
  c: readonly number[],
  period = 14,
  kSmooth = 3,
  dSmooth = 3,
): { k: Series; d: Series } {
  const fastK: Series = new Array(c.length).fill(null);
  for (let i = period - 1; i < c.length; i += 1) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j += 1) {
      hh = Math.max(hh, h[j]);
      ll = Math.min(ll, l[j]);
    }
    fastK[i] = hh === ll ? null : ((c[i] - ll) / (hh - ll)) * 100;
  }
  const smoothNullable = (src: Series, p: number): Series => {
    const out: Series = new Array(src.length).fill(null);
    for (let i = 0; i < src.length; i += 1) {
      let sum = 0;
      let n = 0;
      for (let j = Math.max(0, i - p + 1); j <= i; j += 1) {
        if (src[j] !== null) {
          sum += src[j]!;
          n += 1;
        }
      }
      if (n === p) out[i] = sum / p; // p개가 전부 있어야 유효
    }
    return out;
  };
  const k = smoothNullable(fastK, kSmooth);
  const d = smoothNullable(k, dSmooth);
  return { k, d };
}

/** 볼린저 %B — 20/2 표준. %B=(C−하단)/(상단−하단). 표준편차 0이면 null. */
export function bollingerPercentB(closes: readonly number[], period = 20, mult = 2): Series {
  const out: Series = new Array(closes.length).fill(null);
  const ma = sma(closes, period);
  for (let i = period - 1; i < closes.length; i += 1) {
    const m = ma[i]!;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j += 1) variance += (closes[j] - m) ** 2;
    const sd = Math.sqrt(variance / period);
    if (sd === 0) continue;
    const upper = m + mult * sd;
    const lower = m - mult * sd;
    out[i] = (closes[i] - lower) / (upper - lower);
  }
  return out;
}

/** MACD 12/26/9 표준 — 전부 종가 대비 %로 정규화(교차 종목 학습용). */
export function macdPct(
  closes: readonly number[],
  fast = 12,
  slow = 26,
  signalP = 9,
): { macd: Series; hist: Series } {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdRaw: number[] = [];
  const macdIdx: number[] = [];
  const macd: Series = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i += 1) {
    if (emaFast[i] !== null && emaSlow[i] !== null) {
      macdRaw.push(emaFast[i]! - emaSlow[i]!);
      macdIdx.push(i);
    }
  }
  const signal = ema(macdRaw, signalP);
  const hist: Series = new Array(closes.length).fill(null);
  for (let j = 0; j < macdRaw.length; j += 1) {
    const i = macdIdx[j];
    macd[i] = macdRaw[j] / closes[i];
    if (signal[j] !== null) hist[i] = (macdRaw[j] - signal[j]!) / closes[i];
  }
  return { macd, hist };
}
