// 켈리(Kelly) — 거래 수익률 배열에서 켈리 배율을 계산하는 순수 통계 함수.
// 도메인 문서: docs/domain/켈리/2026-08-18_켈리-포지션-사이징-개념과-설계.md
//
// ⚠ 이 값은 **조회용 척도**다(2026-08-18 사용자 확정). 진입금액·PAUSED·어떤 매매 판단에도 쓰지 않는다 —
//    AutoPilot/AutoPilotManager는 이 모듈을 import하지 않는다(의존 방향으로 강제).
//
//  이산형  f_disc = p − (1−p)/b        p=승률, b=평균이익/평균손실(양수)
//  연속형  f_cont = μ/σ²               μ=평균 수익률, σ²=분산(표본분산)
//  raw     = min(f_disc, f_cont)      — 둘 다 있으면 보수 선택, 하나만 있으면 그것
//  half    = raw × 0.5                — 반켈리(원형과 나란히 표시)
// 음수 엣지·표본 부족은 플래그로만 알린다 — 동작 없음.

export interface KellyResult {
  n: number;
  winRate: number | null;
  /** 이익 거래 평균 수익률(소수). 이익 거래가 없으면 null. */
  avgWin: number | null;
  /** 손실 거래 평균 손실률(양수, 소수). 손실 거래가 없으면 null. */
  avgLoss: number | null;
  /** b = avgWin / avgLoss. 어느 한쪽이 없으면 null. */
  payoff: number | null;
  mean: number | null;
  /** 표본분산(n−1). n<2면 null. */
  variance: number | null;
  discrete: number | null;
  continuous: number | null;
  raw: number | null;
  half: number | null;
  flags: { insufficientSamples: boolean; negativeEdge: boolean };
}

export interface KellyOptions {
  /** 표본 부족 플래그 문턱(기본 30). 계산은 그대로 하고 플래그만 세운다. */
  minSamples?: number;
}

export const KELLY_DEFAULT_MIN_SAMPLES = 30;

/** 수익률(소수, 순손익÷진입금액) 배열 → 켈리 통계. 비유한값은 버린다. */
export function computeKelly(returns: readonly number[], opts: KellyOptions = {}): KellyResult {
  const minSamples = opts.minSamples ?? KELLY_DEFAULT_MIN_SAMPLES;
  const xs = returns.filter((r) => Number.isFinite(r));
  const n = xs.length;
  if (n === 0) {
    return {
      n,
      winRate: null,
      avgWin: null,
      avgLoss: null,
      payoff: null,
      mean: null,
      variance: null,
      discrete: null,
      continuous: null,
      raw: null,
      half: null,
      flags: { insufficientSamples: n < minSamples, negativeEdge: false },
    };
  }

  const wins = xs.filter((r) => r > 0);
  const losses = xs.filter((r) => r < 0);
  const winRate = wins.length / n;
  const avgWin = wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : null;
  const avgLoss = losses.length > 0 ? -losses.reduce((a, b) => a + b, 0) / losses.length : null;
  const payoff = avgWin !== null && avgLoss !== null && avgLoss > 0 ? avgWin / avgLoss : null;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const variance = n >= 2 ? xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1) : null;

  const discrete = payoff !== null ? winRate - (1 - winRate) / payoff : null;
  const continuous = variance !== null && variance > 0 ? mean / variance : null;
  const candidates = [discrete, continuous].filter((v): v is number => v !== null);
  const raw = candidates.length > 0 ? Math.min(...candidates) : null;
  const half = raw !== null ? raw * 0.5 : null;

  return {
    n,
    winRate,
    avgWin,
    avgLoss,
    payoff,
    mean,
    variance,
    discrete,
    continuous,
    raw,
    half,
    flags: { insufficientSamples: n < minSamples, negativeEdge: raw !== null && raw <= 0 },
  };
}
