# 계좌 (Account) 도메인

> **계좌 도메인**은 KIS(한국투자증권) API 인증 세션, 토큰 발급 및 자동 갱신, 예수금/가용 자본 조회, 실현 손익 및 거래 내역 조회를 총괄합니다.

---

## 1. DDD 모델

### 엔티티 (Entity)
- **`KisSession`**: 현재 활성화된 KIS 인증 세션 (`cano`: 계좌번호 앞8자리, `acntPrdtCd`: 상품코드 2자리, `accessToken`, `tokenExpiredAt`).
- **`TradeHistoryRecord`**: 체결 완료된 개별 거래 내역 엔티티 (`tradeId`, `symbol`, `side`, `price`, `qty`, `executedAt`, `realizedPnl`).

### 값 객체 (Value Object)
- **`KisCredentials`**: AppKey, AppSecret 암호화 저장 정보.
- **`AccountBalance`**: 총 자산, 외화 예수금(USD), 원화 예수금(KRW), 매수 가능 금액.
- **`DailyProfitStats`**: 당일 실현 손익, 승률, 총 거래 횟수 불변 통계.
- **`UsdKrwRate`**: 현재 환율 정보 (USD/KRW).

### 애그리게잇 (Aggregate)
- **`AccountAggregate` (Root: `AccountManager`)**:
  - 계좌 자산과 가용 자본의 무결성을 유지합니다.
  - 가용 자본 한도(`capitalLimit`) 내에서만 개별 포지션 진입을 승인하여 계좌 잔고 마이너스 및 주문 거부를 방지합니다.

### 도메인 서비스 (Domain Service)
- **`TokenRefreshService`**: 토큰 만료 시간 1시간 전 또는 API 인증 오류(401) 감지 시 자동으로 재발급을 수행하여 트레이딩 중단을 차단.
- **`DailyProfitCalculator`**: 당일 체결 내역들을 집계하여 총 매매대금, 수수료 차감 순손익, 켈리 기준 권장 투자 비율 계산.

---

## 2. 도메인 책임의 핵심 3원칙

1. **자기 완결성**: 인증 토큰의 만료 시간을 객체 스스로 추적하여 유효한 토큰만을 반환하며, 잔고 변경 시 가용 주문 금액을 자체 계산합니다.
2. **비즈니스 규칙 보호**:
   - 가용 예수금을 초과하는 주문 요청을 도메인 레벨에서 사전에 차단합니다.
   - 보안 인증 정보(AppSecret)가 평문으로 외부 로그에 노출되지 않도록 마스킹 및 보안 스토리지(`secureTokenStorage`) 격리를 보장합니다.
3. **응집도 유지**: 계좌 자산, KIS 세션 라이프사이클, 환율 변환 및 손익 통계가 단일 도메인 안에서 조화롭게 동작합니다.
