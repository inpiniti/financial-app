# 순위 (Ranking) 도메인

> **순위 도메인**은 트레이딩 후보 종목을 어느 원천(토스 8종, 한투 7종)에서 몇 개씩 선정할 것인지 규칙을 정하고, 3분 주기로 폴링하여 최대 30개의 트레이딩 리스트(Watchlist)를 관리하는 영역입니다.

---

## 1. DDD 모델

### 엔티티 (Entity)
- **`Watchlist`**: 현재 활성 감시 중인 종목들의 목록과 우선순위를 유지하는 최상위 엔티티.
- **`RankingPlanItem`**: 실행 계획에 포함된 개별 원천과 배정 개수 (`sourceId`, `count`, `window`).

### 값 객체 (Value Object)
- **`RankingSourceId`**: 원천 식별자 (예: `toss:amount:realtime:norisk`, `kis:tradeVolume`).
- **`RankingSelection`**: 사용자가 설정한 원천별 `{ enabled, count, window }` 설정 맵.
- **`CandidateRow`**: 순위 API로부터 수신한 개별 종목 데이터 (`symb`, `rate`, `name`, `lastPrice`, `ordAvailable`).

### 애그리게잇 (Aggregate)
- **`RankingSelectionAggregate` (Root: `core/ranking`)**:
  - 원천별 선택 개수의 합이 **최대 30개(`RANKING_TOTAL_MAX = 30`)**를 초과하지 않도록 보장합니다.
  - 선택(Selection)을 카탈로그 우선순위 순서대로 정렬하여 결정론적인 실행 계획(`RankingPlan`)을 도출합니다.

### 도메인 서비스 (Domain Service)
- **`WatchlistAggregator` (`features/scalper/watchlist.ts`)**:
  - **중복 제거 및 차순위 충원**: 앞선 원천이 이미 채택한 티커는 뒤 원천에서 건너뛰고 차순위 종목으로 채웁니다.
  - **진입금액 게이트**: 현재가 > 1회 진입금액(`startAmountUsd`)인 종목은 1주도 살 수 없으므로 리스트 단계에서 걸러냅니다.
  - **핀(Pinning) 유예**: 순위에서 밀려났더라도 현재 매매 사이클이 진행 중인 종목은 즉시 제거하지 않고 사이클 종료 시점까지 리스트에 유예합니다.

---

## 2. 도메인 책임의 핵심 3원칙

1. **자기 완결성**: 외부 호출부가 원천 목록만 주입해주면, 도메인 내부에서 우선순위 플랜 수립, 중복 제거, 차순위 충원, 핀 유예 판정을 자체적으로 완결합니다.
2. **비즈니스 규칙 보호**:
   - 웹소켓 구독 한도 보호를 위해 **최대 30개 상한선**을 엄격히 방어합니다.
   - 매매 진행 중인 종목이 리스트에서 갑자기 증발하여 체결 관리가 유실되는 현상을 핀 고정 규칙으로 방어합니다.
3. **응집도 유지**: 원천 카탈로그, 선택 정규화/검증 로직(`core/ranking`), 워치리스트 폴링 및 슬롯 관리(`watchlist.ts`)가 하나의 도메인 경계로 묶여 있습니다.
