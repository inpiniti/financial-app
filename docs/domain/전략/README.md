# 전략 (Strategy) 도메인

> **전략 도메인**은 실시간으로 유입되는 틱 데이터와 캔들(Candle)을 분석하여 매수(진입), 매도(청산), 물타기 시그널을 판정하는 핵심 비즈니스 로직 영역입니다.
> 현재 프로젝트는 **`realtime-ma5` (실시간 1분봉 볼린저 하단선 돌파 단일 전략)**을 정본으로 삼고 있습니다.

---

## 1. DDD 모델

### 엔티티 (Entity)
- **`StrategyInstance`**: 특정 종목(`symbol`)에 바인딩되어 실시간 캔들 빌더와 상태 판정기를 유지하는 객체.
  - 필드: `symbol`, `liveTickCount`(라이브 틱 카운트), `prevLiveTick`, `currentLiveTick`, `lastBreakoutMinute`

### 값 객체 (Value Object)
- **`RealtimeCandle`**: 1분봉 데이터 (`minuteKey`, `open`, `high`, `low`, `close`).
  - 시가(open): 분 시작 시점 첫 라이브 틱으로 고정
  - 고가/저가(high/low): 매 틱 갱신
  - 종가(close): 현재 수신된 최신 라이브 틱 가격
- **`SignalDecision`**: 전략의 판단 결과 (`type`: BUY / SELL / HOLD / NONE, `reason`, `suggestedQty`, `targetPrice`).
- **`Slope`**: 실시간 기울기 방향 (`'up'` | `'down'` | `null`).
- **`Ma5Value`**: 실시간 5선 값 = `(직전 확정 4개 분봉 종가합 + 현재틱) / 5`.
- **`RealtimeMa60` / `RealtimeMa120`**: 실시간 60선 / 120선 값 및 상승 플래그 (`ma60Up`, `ma120Up`).
- **`RealtimeBb`**: 실시간 볼린저 밴드 (직전 확정 19개 분봉 종가 + 현재틱 = 20개 표본).
  - `lowerBb`: 20선 - 2σ (하단선)
  - `ma20`: 20선 (중심선)
  - `upperBb`: 20선 + 2σ (상단선)

### 애그리게잇 (Aggregate)
- **`RealtimeCandleBuilder` (Root)**:
  - 최근 130개 확정 봉 링버퍼(RingBuffer)와 1개의 미완성 봉을 포함하여 시계열 데이터 무결성을 보장합니다.
  - 00초 분 경계 시점에 현재 봉을 링버퍼에 안전하게 확정(commit)하고 새 봉을 개시합니다.
  - **시드 오염 방지**: REST 분봉 시드(`seed`) 시점의 `probe` 계산은 순수 스냅샷 계산으로만 격리하고, 실시간 틱 계산기의 `prevLiveTick` 및 라이브 틱 카운트를 오염시키지 않습니다.

### 도메인 서비스 (Domain Service)
- **`RealtimeMa5Calculator`**: 무지연 MA5, 실시간 볼린저 밴드(Realtime BB), 실시간 MA60·MA120 및 상태 연산
  $$\text{MA5}_{\text{realtime}} = \frac{\sum_{i=1}^4 \text{Close}_{n-i} + \text{Tick}_{\text{current}}}{5}$$
  $$\text{MA60}_{\text{realtime}} = \frac{\sum_{i=1}^{59} \text{Close}_{n-i} + \text{Tick}_{\text{current}}}{60}, \quad \text{MA120}_{\text{realtime}} = \frac{\sum_{i=1}^{119} \text{Close}_{n-i} + \text{Tick}_{\text{current}}}{120}$$
  $$\text{LowerBB}_{\text{realtime}} = \text{MA20}_{\text{realtime}} - 2\sigma, \quad \text{UpperBB}_{\text{realtime}} = \text{MA20}_{\text{realtime}} + 2\sigma$$
- **`BreakoutDetector`**: 무지연 볼린저 하단선 상향 돌파 판정 (신규 진입 신호)
  - 하단 3초 체류(`belowDwellOk`) + 상단 3초 체류(`isArmed`) 충족 시 돌파 발화.
  - 반대편 영역 이탈 취소는 **1초(1,000ms) 이상 연속 머물러야 취소**되며 1초 미만 잔파동(Noise)은 무시.
  - **라이브 틱 관측 요건**: 최소 2회 이상의 라이브 틱(`liveTickCount >= 2`)이 연속 관측된 상태에서만 돌파 판정 가능.
- **`MiddleCrossDetector`**: 실시간 볼린저 중심선(MA20) 상향 돌파 판정 (반익절 신호)
  - $P_{prev} < MA20 \land P_{current} \ge MA20$ 교차 시 1회 발화(`middleCross = true`).
  - 보유 포지션의 50%(수량 1이면 전량)를 1차 익절.
- **`UpperBreakoutDetector`**: 실시간 볼린저 상단선(UpperBB) 상향 돌파 판정 (전량 익절 신호)
  - $P_{prev} < UpperBB \land P_{current} \ge UpperBB$ 교차 시 1회 발화(`upperBreakout = true`).
  - 남은 잔여 수량 전량 익절 청산.

---

## 2. 도메인 책임의 핵심 원칙 및 불변식 (Invariants)

1. **중심선 반익절 및 상단선 전량익절 불변식**:
   - 진입은 **실시간 BB 하단 상향 돌파** 시 설정 수량/금액 단위로 진입합니다.
   - 청산은 **실시간 BB 중심선(MA20) 상향 돌파 시 반익절**(1회), **실시간 BB 상단선 상향 돌파 시 전량 익절**을 수행합니다.
2. **진입봉 저점 손절 불변식**:
   - 진입 체결 시점의 1분봉 최저점($Low_{entry}$)을 메모리에 기록합니다.
   - 현재가가 이 저점을 하향 이탈($P_{current} < Low_{entry}$)하면 지체 없이 전량 손절(`STOP_LOSS`)합니다.
3. **물타기(추가진입) 완전 봉인 불변식**:
   - 포지션 보유 중 발생하는 모든 BUY 신호는 무시하며, 추가진입(물타기)을 전면 금지합니다.
4. **60선·120선 동시 상승 전제 불변식**:
   - 신규 진입은 반드시 **실시간 60선과 120선이 동시에 상승 중(`ma60Up === true && ma120Up === true`)**일 때만 허용됩니다. 둘 중 하나라도 하락/보합이거나 120봉 미만 워밍업 상태이면 진입이 원천 차단됩니다.
5. **한국시간 새벽 02:00 KST 진입 차단 불변식**:
   - 미국 정규장 운영 중 **한국시간 새벽 02:00 KST 이후에는 신규 진입이 전면 금지**됩니다.
   - 02:00 KST 이후에는 오직 기존 보유 포지션의 **익절 및 손절 청산**만 수행됩니다.
6. **돌파 순수성 및 1회 발화 불변식**:
   - 모든 상향 돌파 및 교차는 동일 세션 내에서 최소 2개 이상의 라이브 틱이 교차한 경우에만 인정되며, 시드 프로브는 판정에 영향을 미치지 않습니다.
   - 중심선 반익절은 포지션 사이클당 최대 1회만 실행됩니다.
