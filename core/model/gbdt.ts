// LightGBM(binary) 순수 TS 추론기 — financial-analyze `python/export_model.py`가 내보낸 평탄 트리를 먹는다.
// 학습기와 같은 규약임을 내보내기 시점에 파이썬 쪽에서 대조했고(raw score 최대 오차 0), 앱에서는
// model.fixtures.json 고정 표본으로 다시 대조한다(gbdt.test.ts).
//
// 평탄 표현: 트리마다 내부 노드가 배열에 평탄화돼 있고 자식은
//   ≥0 → 내부 노드 인덱스,  <0 → leaf 인덱스 ~i.
// 결측(null/NaN) 처리는 LightGBM C++와 같다:
//   missing_type None(0) → NaN은 0으로 보고 문턱 비교, Zero(1) → NaN·|v|≤1e-35가 결측,
//   NaN(2) → NaN만 결측. 결측이면 default_left를 따른다.

/** LightGBM의 "0으로 볼 값" 폭 — C++ kZeroThreshold와 같은 값. */
const ZERO_THRESHOLD = 1e-35;

export interface FlatTree {
  /** 내부 노드의 분기 Feature 인덱스. */
  f: number[];
  /** 내부 노드의 분기 문턱(v ≤ t면 왼쪽). */
  t: number[];
  l: number[];
  r: number[];
  /** 결측이 왼쪽으로 가는가(1/0). */
  d: number[];
  /** missing_type(0=None, 1=Zero, 2=NaN). */
  m: number[];
  /** leaf 값(raw score 기여분). */
  v: number[];
  /** 루트 노드 인덱스(분기 없는 트리는 음수 = leaf). */
  root: number;
}

export interface GbdtModel {
  kind: string;
  /** 학습 구간·원천 — 화면·로그 표기용. */
  trained_at?: string;
  source?: string;
  label?: string;
  rounds?: number;
  /** Feature 이름(순서 = 입력 벡터 순서). */
  features: string[];
  /** 확률 변환 계수(binary objective의 sigmoid 파라미터, 보통 1). */
  sigmoid: number;
  /** 신호 임계값 — 학습 구간 예측 확률의 상위 threshold_quantile 분위. */
  threshold: number;
  threshold_quantile?: number;
  trees: FlatTree[];
}

/** 트리 합(raw score). x의 길이는 model.features와 같아야 한다(짧으면 undefined → 결측). */
export function rawScore(model: GbdtModel, x: readonly (number | null)[]): number {
  let total = 0;
  const trees = model.trees;
  for (let ti = 0; ti < trees.length; ti += 1) {
    const tree = trees[ti];
    let i = tree.root;
    while (i >= 0) {
      const raw = x[tree.f[i]];
      const mt = tree.m[i];
      let v = raw === null || raw === undefined ? Number.NaN : raw;
      const nan = Number.isNaN(v);
      let missing: boolean;
      if (mt === 1) missing = nan || Math.abs(v) <= ZERO_THRESHOLD;
      else if (mt === 2) missing = nan;
      else {
        missing = false;
        if (nan) v = 0;
      }
      const goLeft = missing ? tree.d[i] === 1 : v <= tree.t[i];
      i = goLeft ? tree.l[i] : tree.r[i];
    }
    total += tree.v[~i];
  }
  return total;
}

/** 상단 장벽 선터치 확률(0~1). */
export function predictProb(model: GbdtModel, x: readonly (number | null)[]): number {
  return 1 / (1 + Math.exp(-model.sigmoid * rawScore(model, x)));
}
