# 사용자게이트 (AccessGate) 도메인

> **사용자게이트 도메인**은 계좌번호(`account_no`)를 기반으로 Supabase `approved_users` 테이블과 연동하여 **인가된 사용자만 실거래 자동매매에 접근하도록 통제**하고, 신규 등록 신청 및 기기 간 세션 지속성을 보장하는 보안/인가 도메인입니다.

---

## 1. DDD 모델

### 엔티티 (Entity)
- **`ApprovedUser`**: 인가된 사용자 계정 엔티티.
  - 필드: `accountNo`(계좌번호 8자리), `isActive`(승인 플래그: true/false), `registeredAt`

### 값 객체 (Value Object)
- **`GateStatus`**: 게이트 판정 결과 상태 enum.
  - `approved`: 승인 완료 (메인 트레이딩 진입 허용)
  - `pending`: 등록되었으나 승인 대기 중 (진입 차단, 대기 안내 화면 표시)
  - `notFound`: DB에 등록되지 않은 계좌 (등록 신청 화면으로 유도)
  - `error`: 통신 오류 또는 예외
- **`RegisterStatus`**: 등록 신청 결과 (`registered`, `duplicate`, `error`).

### 애그리게잇 (Aggregate)
- **`AccessGateAggregate` (Root: `lib/accessControl.ts`)**:
  - 로컬에 캐시된 계좌번호(`lib/gateStorage.ts`)와 Supabase 원격 테이블의 상태 무결성을 검증합니다.
  - `isActive === true`가 확인되지 않은 모든 상태에서는 트레이딩 및 KIS 세션 발급을 원천 차단합니다.

### 도메인 서비스 (Domain Service)
- **`AccessGateService`**:
  - `checkApprovedAccount(accountNo)`: 원격 승인 플래그 조회 및 로컬 캐시 갱신
  - `registerAccount(accountNo)`: 신규 사용자 셀프 등록 신청

---

## 2. 도메인 책임의 핵심 3원칙

1. **자기 완결성**: 외부 UI의 단순 이동 시도와 무관하게, 도메인 레이어에서 계좌의 유효 상태를 자체 판정하여 허가증을 발급합니다.
2. **비즈니스 규칙 보호**:
   - 미인가 계좌의 임의 진입 및 실거래 발주 사고를 원천 방어합니다.
   - 중복 등록 시도시 기존 상태를 보존하고 중복 에러를 명확히 처리합니다.
3. **응집도 유지**: 로컬 게이트 캐시 스토리지, Supabase DB 통신, 승인 상태 머신이 단일 도메인으로 응집되어 있습니다.
