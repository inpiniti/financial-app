# 종목시세 (Market) 도메인

> **종목시세 도메인**은 트레이딩 후보 종목을 발굴하는 급등락 랭킹 소스(토스증권 및 한국투자증권), 종목 감시 목록(Watchlist), 실시간 체결/호가 웹소켓 피드 및 피드 슬롯 라우팅을 총괄합니다.

---

## 1. DDD 모델

### 엔티티 (Entity)
- **`WatchItem`**: 감시 대상 개별 종목 엔티티.
  - 필드: `symbol`(티커), `koreanName`, `currentPrice`, `changeRate`, `volume`, `slotIndex`(할당된 웹소켓 슬롯 번호)
- **`FeedSlot`**: 실시간 틱/호가 웹소켓 수신 슬롯 (`slotId`, `assignedSymbol`, `connectionStatus`, `tickRatePerSec`).

### 값 객체 (Value Object)
- **`MarketTick`**: 단일 체결 틱 데이터 (`symbol`, `price`, `volume`, `timestamp`, `isBuy`).
- **`OrderBook`**: 매수/매도 10단계 호가 데이터.
- **`RankingItem`**: 랭킹 원천 소스에서 추출된 순위 정보 (`rank`, `symbol`, `rate`, `source`: TOSS / KIS).

### 애그리게잇 (Aggregate)
- **`WatchlistAggregate` (Root: `Watchlist`)**:
  - 토스 상위 종목(최대 8개)과 한투 상위 종목(최대 7개)을 병합/중복 제거하여 **합계 최대 30개 종목**의 감시 리스트 일관성을 유지합니다.
  - 불변식: **전체 감시 종목 수는 30개를 초과할 수 없습니다.**
  - 웹소켓 피드 슬롯 자원이 제한되어 있으므로 우선순위가 높은 종목에 우선적으로 슬롯을 할당합니다.

### 도메인 서비스 (Domain Service)
- **`FeedSlotRouter`**: 신규 종목 진입 시 사용 가능한 웹소켓 슬롯을 동적으로 연결하고, 진입 해제 시 연결을 즉시 회수하여 슬롯 누수를 방지.
- **`RankingAggregator`**: 토스 OpenAPI 및 한투 랭킹 API를 주기적으로 폴링하여 통합 급등/거래대금 랭킹 산출.

---

## 2. 도메인 책임의 핵심 3원칙

1. **자기 완결성**: 웹소켓 끊김 감지 시 내부 재연결 정책(Exponential Backoff)에 따라 스스로 세션을 복구합니다.
2. **비즈니스 규칙 보호**:
   - 감시 종목 30개 상한 규칙을 도메인 내부에서 검증하여 불필요한 네트워크 트래픽 과부하를 방지합니다.
   - 비정상 급변 틱(이상치/Spike)을 감지하여 전략 판정으로 전달되기 전에 필터링합니다.
3. **응집도 유지**: 종목 랭킹 집계, 감시 리스트 관리, 실시간 웹소켓 라우팅이 단일 도메인 영역으로 캡슐화되어 있습니다.
