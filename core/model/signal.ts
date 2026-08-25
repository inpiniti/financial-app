// 모델 진입 신호 — 봉 마감 1회당 판정 1회. 순수 함수(모델 객체를 인자로 받는다).
//
// 무엇을 재현하나(financial-analyze docs/analysis/2026-08-21_final-test-결과.md):
//   신호 = LightGBM(+5%/−2%/120분 first-touch 라벨, 5분봉 Feature 33개) 확률 ≥ 임계값(학습 구간 상위 1%).
//   백테스트가 신호에 붙여 놓은 조건까지 같이 재현해야 숫자가 의미를 갖는다:
//     · 표본 필터(학습): 정규장(session=='main') · 그날 누적 거래대금 ≥ $2M ("그 시각에 봇이 볼 수 있던 종목")
//     · 기하 필터(백테스트): 진입가 > $1 (MINPRICE — 페니주 왕복 비용에 잡아먹히는 구간 배제)
//     · 봉당 1신호, 보유 중 재진입 없음(busy 판정은 호출부 몫)
//   ⚠ 백테스트는 "신호 봉의 **다음 봉 시가**"에 샀다. 앱은 신호 즉시 현재가 지정가로 산다 —
//     이 차이(최대 5분)는 실거래로만 잴 수 있는 괴리다. 페이퍼 단계에서 이 값을 먼저 본다.
//
// SELL은 여기서 나오지 않는다 — 모델은 진입 전용 분류기다. 청산은 exitRule.ts(+5%/−2%/120분).

import { computeFeatures, MIN_BARS_FOR_SIGNAL, type DayContext, type OhlcvBar } from './features';
import { predictProb, type GbdtModel } from './gbdt';
import { isMainSessionBar } from './session';

/** 감지 가능 시점 필터 — 그날 누적 거래대금 문턱(USD). 학습 표본 필터(convert_parquet.DETECT_DOLLAR)와 같은 값. */
export const DETECT_DOLLAR_VOLUME = 2_000_000;

/** 최소 진입가(USD) — 백테스트 MINPRICE. 이 값 **이하**면 신호를 버린다. */
export const MIN_ENTRY_PRICE = 1;

export interface ModelEvalInput {
  /** 그날 04:00 ET부터 마지막 닫힌 봉까지 오름차순 전부. */
  bars: readonly OhlcvBar[];
  ctx: DayContext;
  /** 그날 누적 거래대금(USD). */
  cumDollarVolume: number;
  /** 봉 주기(분) — 정규장 판정에 쓴다(집계봉의 마지막 구성 분봉 기준). */
  barMinutes: number;
}

/** 판정 결과 — 왜 신호가 아닌지까지 남긴다(실거래 일지·화면 진단용). */
export interface ModelEval {
  signal: 'BUY' | null;
  /**
   * 상단 장벽(+5%) 선터치 확률. 봉이 모자랄 때(reject 'bars')만 null.
   * 정규장·거래대금·가격 게이트에 걸려도 확률은 계산한다(2026-08-25) — 화면·챗봇이 "모델이 지금
   * 뭐라고 보는지"를 항상 보여주기 위해서다. 단 그 확률은 **학습 분포 밖일 수 있는 참고값**이고
   * (프리·애프터 봉은 학습에 없었다), 매수는 여전히 게이트를 전부 통과해야만 나간다.
   */
  prob: number | null;
  threshold: number;
  /** 신호가 아닌 이유 — 'bars'(봉 부족) 'session'(정규장 아님) 'liquidity'(누적 거래대금 미달) 'price'(≤$1) 'prob'(확률 미달). */
  reject: 'bars' | 'session' | 'liquidity' | 'price' | 'prob' | null;
  bars: number;
}

/**
 * 마지막 닫힌 봉 시점의 진입 판정.
 * 확률은 봉만 있으면 항상 계산한다(30종목 × 800트리 × 5분당 1회 — 부담 없는 양이다).
 * 게이트(정규장·거래대금·가격)는 확률과 무관하게 신호를 막는다 — reject 우선순위는 게이트가 먼저다.
 */
export function evaluateModel(model: GbdtModel, input: ModelEvalInput): ModelEval {
  const { bars, ctx, cumDollarVolume, barMinutes } = input;
  const n = bars.length;
  const base = { signal: null, threshold: model.threshold, bars: n } as const;
  if (n < MIN_BARS_FOR_SIGNAL) return { ...base, prob: null, reject: 'bars' };
  const last = bars[n - 1];

  const prob = predictProb(model, computeFeatures(bars, ctx));
  if (!isMainSessionBar(last.minuteKey, barMinutes)) return { ...base, prob, reject: 'session' };
  if (!(cumDollarVolume >= DETECT_DOLLAR_VOLUME)) return { ...base, prob, reject: 'liquidity' };
  if (!(last.close > MIN_ENTRY_PRICE)) return { ...base, prob, reject: 'price' };
  if (!(prob >= model.threshold)) return { ...base, prob, reject: 'prob' };
  return { signal: 'BUY', prob, threshold: model.threshold, reject: null, bars: n };
}
