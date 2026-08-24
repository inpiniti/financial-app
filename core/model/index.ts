// 모델 도메인 진입점 — "모델 감지 → 매매 → 그리드"의 감지 쪽 전부.
//
// 이 도메인이 대체하는 것: 추세(분봉 4선 상태기계). 추세 코드는 그대로 남아 있고 `MODEL_MODE=false`면 다시 그쪽이 쓰인다
// (슬롯·매니저·포지션 관리자 모두 모델을 먼저 보고, 모델이 꺼졌을 때만 TREND_MODE를 본다).
// 무엇을 하나:
//   ① 토스 5분봉(원시가)으로 그날 봉을 들고(bars.ts)
//   ② 학습과 같은 계산으로 Feature 33개를 만들고(features.ts + indicators.ts)
//   ③ LightGBM 800트리를 순수 TS로 돌려(gbdt.ts) 확률을 내고
//   ④ 학습·백테스트가 걸어 둔 필터를 통과하면 BUY를 낸다(signal.ts)
//   ⑤ 청산은 백테스트 기하 그대로 — 트레일링(고점 −5%) + 하드 손절(평단 −2%) + 장 마감(exitRule.ts, 2026-08-24)
//
// 검증 이력·남은 리스크는 financial-analyze `docs/analysis/2026-08-21_final-test-결과.md`가 정본이다.

import type { GbdtModel } from './gbdt';

export * from './bars';
export * from './exitRule';
export * from './features';
export * from './gbdt';
export * from './inspect';
export * from './session';
export * from './signal';

/**
 * 번들에 실린 모델(2.8MB JSON, 800트리). 첫 호출에서만 파싱한다 — 앱 시작을 막지 않게 지연 로딩.
 * 교체 절차: financial-analyze에서 `python python/export_model.py --out <이 경로>` 를 다시 돌린다.
 */
let cached: GbdtModel | null = null;
export function loadModel(): GbdtModel {
  if (cached === null) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cached = require('./model.json') as GbdtModel;
  }
  return cached;
}
