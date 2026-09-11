# 전략 (Strategy) 도메인

> **전략 도메인**은 실시간으로 유입되는 틱 데이터와 캔들(Candle)을 분석하여 매수(진입), 매도(청산), 물타기 시그널을 판정하는 핵심 비즈니스 로직 영역입니다.
> 현재 프로젝트는 **`realtime-ma5` (실시간 5선 돌파 단일 전략)**을 정본으로 삼고 있습니다.

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

### 애그리게잇 (Aggregate)
- **`RealtimeCandleBuilder` (Root)**:
  - 최근 130개 확정 봉 링버퍼(RingBuffer)와 1개의 미완성 봉을 포함하여 시계열 데이터 무결성을 보장합니다.
  - 00초 분 경계 시점에 현재 봉을 링버퍼에 안전하게 확정(commit)하고 새 봉을 개시합니다.
  - **시드 오염 방지**: REST 분봉 시드(`seed`) 시점의 `probe` 계산은 순수 스냅샷 계산으로만 격리하고, 실시간 틱 계산기의 `prevLiveTick` 및 라이브 틱 카운트를 오염시키지 않습니다.

### 도메인 서비스 (Domain Service)
- **`RealtimeMa5Calculator`**: 무지연 MA5 및 기울기 연산
  $$\text{MA5}_{\text{realtime}} = \frac{\text{Close}_{n-4} + \text{Close}_{n-3} + \text{Close}_{n-2} + \text{Close}_{n-1} + \text{Tick}_{\text{current}}}{5}$$
  $$\text{Slope} = \begin{cases} \text{'up'} & \text{if } \text{Tick}_{\text{current}} > \text{Close}_{n-5} \\ \text{'down'} & \text{if } \text{Tick}_{\text{current}} < \text{Close}_{n-5} \\ \text{null} & \text{otherwise} \end{cases}$$
- **`BreakoutDetector`**: 상향 돌파 판정
  $$\text{PrevLiveTick} < \text{MA5}_{\text{realtime}} \quad \land \quad \text{CurrentLiveTick} > \text{MA5}_{\text{realtime}}$$
  - **라이브 틱 관측 요건**: 최소 2회 이상의 라이브 틱(`liveTickCount >= 2`)이 연속 관측된 상태에서만 돌파 판정 가능 (시작 첫 틱 또는 과거 데이터 비교 돌파 원천 방지).

---

## 2. 도메인 책임의 핵심 3원칙 및 불변식 (Invariants)

1. **단일 전략 불변식**: 시스템은 다른 복합 전략 없이 오직 `realtimeMa5` 단일 전략으로만 작동합니다.
2. **돌파 순수성 불변식**:
   - 모든 상향 돌파는 동일 세션 내에서 최소 2개 이상의 라이브 틱이 교차한 경우에만 인정되며, 시드 프로브는 돌파 판정에 영향을 미치지 않습니다.
   - 동일한 분봉 내에서 여러 번의 상향 돌파가 발생하더라도 `봉당 1회` 신호만 발생하도록 엄격히 방어합니다.
3. **신호 라우팅 책임**:
   - 미보유 종목 돌파 $\to$ **[포지션 도메인: 신규 진입 게이트]**로 라우팅
   - 보유 중 종목 돌파 $\to$ **[포지션 도메인: 추가진입(물타기) 게이트]**로 라우팅
