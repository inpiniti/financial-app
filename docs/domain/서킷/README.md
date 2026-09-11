# 서킷 (Circuit) 도메인

> **서킷 도메인**은 미국 증시의 LULD(Limit Up-Limit Down) 변동성 완화 장치에 의한 **거래 정지(Halt) 및 거래 재개(Resume)를 실시간으로 감지**하고, 정지 수열을 분석하여 단일가 경매 재개 시 안전하게 청산하는 위험 관리 도메인입니다.

---

## 1. DDD 모델

### 엔티티 (Entity)
- **`HaltSequence`**: 특정 종목의 연속적인 정지 수열을 추적하고 서킷 상태를 판정하는 객체.
  - 필드: $p_k$ (정지 직전가 수열), $d_k$ (방향: 상킷 UP / 하킷 DOWN), $w_k$ (재개 창 시간 초)
  - 상태: `NORMAL` $\to$ `HALT_SUSPECT` $\to$ `CIRCUIT_ACTIVE` $\to$ `RELEASED`

### 값 객체 (Value Object)
- **`HaltEvent`**: 정지 의심(`HALT_SUSPECT`) 또는 재개(`RESUME`) 발생 이벤트.
  - `kind`, `price`, `lastTradeAt`, `gapPct`(재개 갭 %), `haltedMs`(정지 지속 시간)
- **`CircuitDecision`**: 서킷 발동 시의 매매 결정 (`side`: SELL, `limitPrice`: 정지 직전가 $\times (1 - \text{할인율})$, `chaseAfterTradeAt`).

### 애그리게잇 (Aggregate)
- **`HaltDetector` (Root)**:
  - 무체결 지속 시간($\ge 45$초)과 직전 활발도 창(3분 내 체결 $\ge 30$건)을 대조하여 저유동 종목의 자연 공백과 실제 LULD 정지를 엄격히 구별합니다.
  - 첫 정지 이후 15분(`relaxAfterHaltMs`) 동안은 문턱을 완화하여 초단기 연속 서킷(재개 후 수초 만에 재정지)을 빠짐없이 포착합니다.

### 도메인 서비스 (Domain Service)
- **`CircuitExitRule`**:
  - 일반 지표(MA5 돌파/SELL)를 감싸는 데코레이터로 작동.
  - 서킷 상태(`CIRCUIT_ACTIVE`)에 진입하거나 하킷 2연속 발생 시, 일반 시그널을 차단하고 **정지 직전가 기준 지정가 매도**를 발주하여 재개 시점의 단일가 경매에서 전량 매도 체결을 유도합니다.

---

## 2. 도메인 책임의 핵심 3원칙

1. **자기 완결성**: 외부 뉴스나 브로커 알림 없이, 틱 체결 시각과 가격 데이터의 시계열 패턴만으로 객체 스스로 정지와 재개를 판정합니다.
2. **비즈니스 규칙 보호**: 서킷 정지로 인해 왜곡된 시간축 캔들/이평선 지표가 잘못된 매수/매도 시그널을 발생시키지 않도록 원천 격리합니다.
3. **응집도 유지**: 정지 감지 알고리즘, 정지 수열 상태 머신, 재개 매도 규칙이 `core/circuit` 내에 순수 TS 함수와 도메인 모델로 응집되어 있습니다.
