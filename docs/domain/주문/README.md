# 주문 (Order) 도메인

> **주문 도메인**은 매수 및 매도 주문의 발주(Place), 호가 추종 정정(Reprice Loop), 미체결 시간 취소(Cancel), 그리고 **실시간 체결통보(Execution/Fill Event) 수신 및 상태 전이**를 총괄하는 핵심 인프라·비즈니스 브리지 도메인입니다.

---

## 1. DDD 모델

### 엔티티 (Entity)
- **`Order`**: 주문의 전체 라이프사이클을 추적하는 핵심 엔티티.
  - 고유 식별자: `orderRef`(내부 식별자), `odno`(KIS 원주문번호)
  - 속성: `symbol`, `side` (`buy` / `sell`), `orderQty`, `orderPrice`, `filledQty`, `avgFilledPrice`
  - 상태 머신 (`OrderStatus`):
    - `SUBMITTED` (발주 요청 전송)
    - `PENDING` (브로커 접수 완료, 체결 대기)
    - `AMENDING` (호가 변동에 따른 정정 요청 중)
    - `PARTIALLY_FILLED` (일부 체결)
    - `FILLED` (전량 체결 완료)
    - `CANCELLED` (미체결 전량 취소)
    - `REJECTED` / `FAULT` (주문 거부 또는 비정상 예외)

### 값 객체 (Value Object)
- **`OrderRequest`**: 신규 발주 규격 (`symbol`, `side`, `qty`, `price`, `strategy`: quote/lastChase/lastCancel).
- **`FillEvent` (Domain Event)**: 체결 수신 이벤트 (`odno`, `symbol`, `side`, `fillQty`, `fillPrice`, `isFullFill`, `filledAt`).
- **`CancelResult`**: 취소 확정 상태 (`confirmed` 미체결 취소 성공, `rejected` 이미 체결되어 취소 불가).

### 애그리게잇 (Aggregate)
- **`OrderExecutionAggregate` (Root: `OrderPortAdapter`)**:
  - 발주된 주문과 브로커(KIS) 간의 일관성을 유지합니다.
  - **취소-체결 레이스 컨디션 방어**: 취소가 거절(`rejected`)된 경우 "이미 체결" 가능성을 염두에 두고 즉시 실패로 단정하지 않으며, 실시간 체결통보 및 체결내역 폴링 결과로 최종 상태를 확정합니다.
  - **정정 한도 보호**: 연속 정정 실패 횟수가 상한(`AMEND_FAIL_LIMIT = 8`)에 도달하면 무한 루프를 방지하기 위해 정정을 자진 중단하고 지정가 대기로 복귀합니다.

### 도메인 서비스 (Domain Service)
- **`OrderRepriceService`**: 호가(매도 1호가/매수 1호가) 또는 현재가가 변동될 때 최유리 호가로 추격 정정 주문을 발행.
- **`FillStreamRouter`**: KIS 웹소켓 실시간 체결통보 또는 REST 체결 폴링 스트림을 파싱하여 해당 `Order` 엔티티로 라우팅하고 `OrderFilledEvent`를 발행.

---

## 2. 주문 전략 3종 (`OrderPricing`, ADR 0013 정본)

사용자는 매수와 매도 각각 독립적으로 3가지 주문 전략 중 하나를 선택할 수 있으며 실행 중 즉시 반영됩니다:

| 전략 (`OrderPricing`) | 발주가 결정 | 미체결 시 정정 루프 | 자동 취소 조건 |
|---|---|---|---|
| **`quote` (1호가 크로스, 기본값)** | 반대편 1호가 (매수: ask1, 매도: bid1) | 1호가가 바뀔 때마다 해당 호가로 추격 정정 | 취소 없음 (체결까지 유지) |
| **`lastChase` (현재가 추종)** | 현재가 (마지막 체결 틱가) | 틱마다 현재가가 변동되면 정정 | 취소 없음 (체결까지 추격) |
| **`lastCancel` (현재가 + 시간 취소)** | 현재가 (마지막 체결 틱가) | 정정 없음 (지정가 유지) | `cancelAfterMs` 초과 시 미체결 잔량 즉시 취소 |

---

## 3. 도메인 불변식 및 핵심 원칙 (Invariants)

1. **리프라이스 시간 양보 금지 (ADR 0003)**:
   - 매도 리프라이스는 매수 1호가(bid1)만 추종하며, 시간이 지나 체결되지 않더라도 가격을 하향 양보(시간 에스컬레이션)하지 않습니다. 하락장에서 지속적인 양보는 원치 않는 시장가 손절과 다름없기 때문입니다.
   - `decideReprice` 함수는 경과 시간을 입력받지 않아 타입 수준에서 가격 양보 로직 구현이 원천 차단됩니다.
   - 호가 절사(`roundOverseasOrderPrice`) 후의 가격끼리만 비교하여 불필요한 주문 정정 폭주를 방어합니다.
2. **자기 완결성 및 부분 체결 보호**:
   - 발주 후 주문 객체 스스로 정정 요건, 취소 타임아웃, 체결 수량 누적을 추적합니다.
   - 부분 체결(`PARTIALLY_FILLED`) 상태인 주문은 자동 포기 취소 대상에서 제외하여 잔여 수량 누수를 방지합니다.
3. **정정 한도 보호 (Anti-thrashing)**:
   - 연속 정정 실패 횟수가 상한(`AMEND_FAIL_LIMIT = 8`)에 도달하면 무한 루프 방지를 위해 정정을 중단하고 지정가 대기로 전환합니다.
4. **취소-체결 경합 방어**:
   - 브로커 취소 요청 거절 시 "이미 체결 완료" 여부를 실시간 통보 및 체결내역 폴링을 통해 최종 확정합니다.
