// LightGBM 추론 이식 대조 — 파이썬 booster와 같은 확률이 나오는지.
// fixture 생성: financial-analyze `python python/export_model.py` (내보내기 시점에 raw score 최대 오차 0으로 대조됨).

import { describe, expect, it } from 'vitest';
import fixtures from './model.fixtures.json';
import { loadModel } from './index';
import { predictProb, rawScore, type GbdtModel } from './gbdt';

const model = loadModel();

describe('모델 추론(LightGBM 이식)', () => {
  it('내보낸 모델의 모양이 기대와 같다 — 800트리 · binary · Feature 33개', () => {
    expect(model.kind).toBe('lgbm-binary-flat');
    expect(model.trees.length).toBe(800);
    expect(model.features.length).toBe(33);
    expect(model.sigmoid).toBe(1);
    expect(model.threshold).toBeGreaterThan(0);
    expect(model.threshold).toBeLessThan(1);
  });

  it('고정 표본 20건의 확률이 파이썬 예측과 일치한다', () => {
    expect(fixtures.cases.length).toBe(20);
    for (const c of fixtures.cases) {
      const got = predictProb(model, c.x as (number | null)[]);
      expect(got).toBeCloseTo(c.prob, 12);
    }
  });

  it('결측(null)은 0이 아니라 결측 가지로 간다 — null 벡터와 0 벡터의 점수가 다르다', () => {
    const nulls = new Array(model.features.length).fill(null) as (number | null)[];
    const zeros = new Array(model.features.length).fill(0) as (number | null)[];
    expect(rawScore(model, nulls)).not.toBeCloseTo(rawScore(model, zeros), 6);
  });

  it('트리가 없으면 확률은 0.5(raw 0) — 빈 모델도 터지지 않는다', () => {
    const empty: GbdtModel = { ...model, trees: [] };
    expect(predictProb(empty, [])).toBe(0.5);
  });
});
