// Feature 이식 대조 — 학습 파이프라인(financial-analyze)이 낸 정답과 앱 계산이 같은지 본다.
//
// fixture 생성: financial-analyze에서
//   python python/export_feature_fixture.py --date 2026-08-18 --symbol AAPL --out ../financial-app/core/model/features.fixtures.json
// 담긴 것: 그 종목-일의 5분봉 192개 + 전일/전전일 종가 + dataset5에서 뽑은 정답 Feature 벡터 12시점.
// 이 테스트가 깨지면 지표·결측 규칙·반올림 중 하나가 학습과 어긋난 것이다 — 모델이 딴 값을 먹고 있다는 뜻.

import { describe, expect, it } from 'vitest';
import fixtures from './features.fixtures.json';
import model from './model.json';
import { computeFeatures, FEATURE_NAMES, quantize, type OhlcvBar } from './features';

const bars = fixtures.bars as OhlcvBar[];
const ctx = fixtures.dayContext as { dayOpen: number; prevClose: number | null; prevPrevClose: number | null };

describe('모델 Feature 이식', () => {
  it('입력 순서가 모델 파일의 features와 정확히 같다', () => {
    expect([...FEATURE_NAMES]).toEqual(model.features);
    expect([...FEATURE_NAMES]).toEqual(fixtures.features);
  });

  it('학습 파이프라인이 낸 정답과 33개 값이 전부 일치한다(12시점)', () => {
    expect(fixtures.cases.length).toBeGreaterThan(0);
    // −0 정규화 — 파이썬 fixture는 −0.0을, 앱 계산은 +0을 낼 수 있다(수치로는 동일, toEqual은 ±0을 구분).
    const norm = (v: number | null) => (v === 0 ? 0 : v);
    for (const c of fixtures.cases) {
      const got = computeFeatures(bars.slice(0, c.index + 1), ctx).map(norm);
      const want = (c.expected as (number | null)[]).map(quantize).map(norm);
      // 어느 열이 어긋났는지 바로 보이게 이름을 붙여 비교한다.
      const label = (v: (number | null)[]) => Object.fromEntries(FEATURE_NAMES.map((n, i) => [n, v[i]]));
      expect({ dt: c.dt, ...label(got) }).toEqual({ dt: c.dt, ...label(want) });
    }
  });

  it('봉이 모자라면 워밍업 열은 null이다 — 0으로 채우지 않는다(모델이 결측을 따로 배웠다)', () => {
    const early = computeFeatures(bars.slice(0, 3), ctx);
    const at = (name: (typeof FEATURE_NAMES)[number]) => early[FEATURE_NAMES.indexOf(name)];
    expect(at('return_1bar')).not.toBeNull(); // 2봉이면 나온다
    expect(at('return_20m')).toBeNull();
    expect(at('ma120_slope')).toBeNull();
    expect(at('rsi14')).toBeNull();
  });

  it('전일 종가가 없으면 전일 계열 3개만 null이고 나머지는 그대로 나온다', () => {
    const idx = fixtures.cases[fixtures.cases.length - 1].index;
    const withPrev = computeFeatures(bars.slice(0, idx + 1), ctx);
    const noPrev = computeFeatures(bars.slice(0, idx + 1), { ...ctx, prevClose: null, prevPrevClose: null });
    for (const name of FEATURE_NAMES) {
      const i = FEATURE_NAMES.indexOf(name);
      if (name === 'change_from_prev_close' || name === 'prev_day_return') expect(noPrev[i]).toBeNull();
      else expect(noPrev[i]).toEqual(withPrev[i]);
    }
  });

  it('전일 종가가 당일 시가와 3배 이상 어긋나면 정합 가드가 전일 계열을 버린다', () => {
    const idx = fixtures.cases[fixtures.cases.length - 1].index;
    const distorted = computeFeatures(bars.slice(0, idx + 1), {
      ...ctx,
      prevClose: ctx.dayOpen * 80, // 병합 얽힌 종목의 EOD 왜곡(FFAI ×80) 재현
      prevPrevClose: ctx.dayOpen * 80,
    });
    expect(distorted[FEATURE_NAMES.indexOf('change_from_prev_close')]).toBeNull();
    expect(distorted[FEATURE_NAMES.indexOf('prev_day_return')]).toBeNull();
  });
});
