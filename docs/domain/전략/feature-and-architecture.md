# 전략 — 기능 및 아키텍처 (Feature & Architecture)

## 1. 핵심 비즈니스 규칙 명세

### A. 실시간 MA5 및 실시간 볼린저 밴드(Realtime BB) 계산식
- 확정된 최근 19개 1분봉 종가: $C_{-1}, C_{-2}, \dots, C_{-19}$
- 현재 시각 틱 가격: $P_{current}$
- **실시간 MA5**:
$$MA5_{realtime} = \frac{C_{-1} + C_{-2} + C_{-3} + C_{-4} + P_{current}}{5}$$
- **실시간 볼린저 밴드 (20분봉, 2σ)**:
  - 20개 합성 표본: $X = [C_{-19}, C_{-18}, \dots, C_{-1}, P_{current}]$
  - 중심선: $MA20_{realtime} = \frac{1}{20}\sum_{i=1}^{20} X_i$
  - 분산: $\sigma^2 = \frac{1}{20}\sum_{i=1}^{20} (X_i - MA20_{realtime})^2$
  - 표준편차: $\sigma = \sqrt{\sigma^2}$
  - **실시간 볼린저 하단선**: $lowerBb = MA20_{realtime} - 2\sigma$
  - **실시간 볼린저 상단선**: $upperBb = MA20_{realtime} + 2\sigma$

### B. 기울기 상승(Slope Rising) 및 모멘텀 판정
- 실시간 가격 모멘텀: $P_{current} \ge P_{prev}$ (틱 단위 상승) 또는 $P_{current} \ge C_{-1}$ (직전 1분봉 종가 대비 상승)
- *(주의: 과거 $P_{current} > C_{-5}$는 5분 전 고점 종가와의 비교로 인해 바닥 반등 시 1~2분의 심각한 지연 및 고점 매수 버그를 유발하므로 돌파 필터로 사용하지 않음)*

### C. 볼린저 하단선 상향 돌파 — 잔파동 방지(1초 디바운스) 양방향 3초 체류 상태 머신
- **목적**: 급락 후 바닥을 충분히 다진 뒤 볼린저 하단선을 뚫고 올라오는 강한 반등 추세를 포착하고, 1호가 단위의 잔파동(tick noise / flutter)으로 인한 성급한 취소 방지.
- **1단계: 하단 3초 체류 (`belowDwellOk = true`)**:
  - $P_{current} \le lowerBb$: 하단 체류 시작 기록 (`belowStartMs`). 연속 3초(3,000ms) 이상 체류 시 `belowDwellOk = true` 확정.
  - $P_{current} > lowerBb$ (일시적 상단 튐):
    - 즉시 취소하지 않고 상단 이탈 타이머(`aboveEscapeStartMs`)를 가동.
    - **1초(1,000ms) 이상 연속 머물러야** 비로소 이탈로 보고 하단 체류 리셋.
    - 1초 미만의 일시적 튐은 **잔파동(Noise)으로 무시**하고 하단 체류 타이머를 보존.
- **2단계: 상단 3초 체류 (`isArmed = true`)**:
  - 하단 3초 체류 충족(`belowDwellOk === true`) 후 $P_{current} > lowerBb$로 올라오면 상단 체류 시작(`aboveStartMs`).
  - 상단에서 연속 3초(3,000ms) 이상 체류 시 `isArmed = true` (돌파 완료 / 진입 준비 완료).
  - $P_{current} \le lowerBb$ (일시적 하단 눌림):
    - 즉시 취소하지 않고 하단 침범 타이머(`belowDipStartMs`)를 가동.
    - **1초(1,000ms) 이상 연속 머물러야** 비로소 이탈로 보고 상단 체류 리셋.
    - 1초 미만의 일시적 눌림은 **잔파동(Noise)으로 무시**하고 상단 체류 타이머를 보존.
- **3단계: 돌파 발화**:
  - `isArmed === true` 도달 시 해당 틱에서 상향 돌파(`breakout = true`) 신호를 1회 발행하고 `isArmed`, `belowDwellOk` 상태를 즉시 소진(`false`).
  - 재돌파를 위해서는 다시 하단 3초 체류부터 시작해야 함.

### D. 신호 발생 조건표

| 구분 | 조건 | 실행 결정 |
|---|---|---|
| **신규 진입** | 보유수량 = 0 ∧ 실시간 BB 하단선 돌파 (`breakout = true`) ∧ 해당 분봉 미진입 | BUY 신호 발행, 평단×1.03 매도선 선등록 |
| **물타기** | 보유수량 > 0 ∧ `gapRate` $\le -3\%$ ∧ 실시간 BB 하단선 돌파 (`breakout = true`) | BUY 추가 매수 신호 (수량 = 보유량 $\times (\vert gap \vert - 1)$) — 5분 지연 없이 돌파 즉시 실행 |
| **홀딩** | 위 조건 미충족 | HOLD |

---

## 2. 데이터 흐름 다이어그램

```mermaid
flowchart LR
    Tick[실시간 체결 틱<br/>가격 / 체결량 / 시각] --> Builder[RealtimeCandleBuilder]
    Builder -->|현재틱 반영| MA5[MA5_realtime 계산]
    Builder -->|분 경계 확정| Ring[130개 봉 링버퍼]
    
    MA5 --> Evaluator[RealtimeMa5Evaluator]
    Ring --> Evaluator
    
    Evaluator -->|규칙 검증| Signal[SignalDecision: BUY / HOLD / SELL]
    Signal --> PositionManager[포지션 도메인]
```
