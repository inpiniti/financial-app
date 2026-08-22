// 모델 → 매매 → 그리드 단일 스위치 (2026-08-22).
//
// 추세(분봉 4선 상태기계)를 대체한다. 세 층이 **같은 상수 하나**를 읽는다 —
//   · autopilotManager: 슬롯을 모델 모드로 만들고 추세 워밍업 대신 ModelScanner를 돌린다
//   · feedSlot: 자체 판정(추세·사다리·SG)을 전부 끄고 외부(스캐너) 신호만 흘린다
//   · positionManager: 청산 규칙을 ModelExitRule(+5%/−2%/120분)로 고른다
// 두 층의 스위치가 갈라져 "모델 신호 + 추세 청산" 같은 불일치 조합이 생기지 않게 한 곳에 둔다.
//
// 실제 활성화는 이 상수 AND 매니저의 `model` 주입.
// false로 두면 추세(TREND_MODE)로 **한 줄 롤백**된다 — 추세 코드는 지우지 않고 그대로 남겨 뒀다.
//
// 검증 근거: financial-analyze `docs/analysis/2026-08-21_final-test-결과.md`
//   봉인 구간(2026-05-01~08-20) 3,116거래 · 순 +0.42%/거래 · PF 1.301 · 4개월 전부 플러스.
//   Feature 시간축은 5분봉 채택(4폴드 PF 1.229~1.246 균일).
export const MODEL_MODE = true;

/** 모델 Feature 봉 주기(분) — 학습 채택값. 바꾸면 학습과 다른 봉을 먹인다(모델도 같이 다시 내보내야 한다). */
export const MODEL_BAR_MINUTES = 5;
