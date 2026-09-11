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

## 2. 도메인 책임의 핵심 3원칙

1. **자기 완결성**: 발주 후 주문 객체 스스로 정정 요건(호가 이탈 여부), 취소 타임아웃, 체결 수량 누적을 추적하여 상태를 전이시킵니다.
2. **비즈니스 규칙 보호**:
   - 부분 체결(`PARTIALLY_FILLED`) 상태인 주문은 자동 포기 취소 대상에서 제외하여 잔여 수량 누수를 방지합니다.
   - 해외주식 가격 단위 호가 절사(`roundOverseasOrderPrice`)를 주문 발주 전에 엄격히 강제합니다.
3. **응집도 유지**: 발주, 호가 추종 정정, 취소 상태 머신, 웹소켓 체결 수신이 하나의 주문 도메인 경계 내에 캡슐화되어 있습니다.
