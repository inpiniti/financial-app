# 포지션 (Position) 도메인

> **포지션 도메인**은 신규 진입 게이트, (k-1)배수 물타기 추가진입 판정, 1호가 매수 추종 주문 실행, 익절선 선등록(+0.5%~+3%), 정산 및 피드 유지를 총괄하는 핵심 거래 집행 영역입니다.

---

## 1. DDD 모델

### 엔티티 (Entity)
- **`Position`**: 특정 종목의 현재 보유 상태를 식별하고 변경을 추적하는 객체.
  - 상태: `NONE` $\to$ `ENTERING` $\to$ `HOLDING` $\to$ `AVERAGING_DOWN` $\to$ `EXITING`
  - 필드: `symbol`, `qty`, `avgPrice`, `currentPrice`, `pnl`, `pnlRate`
- **`ActiveOrder`**: 접수되어 활성화된 개별 주문 엔티티 (`orderNo`, `side`: BUY/SELL, `qty`, `price`, `status`).

### 값 객체 (Value Object)
- **`ProfitLoss`**: 손익 금액 및 수익률 VO (`pnlColor()` 내장).
- **`BracketLines`**: 익절선(Take Profit Line = $P_{avg} \times (1 + TP)$) 및 물타기 감시선($P_{avg} \times (1 - 0.03)$). 익절률($TP$)은 계좌 투입 비중에 따라 0.5%~3% 동적으로 결정됩니다.
- **`OrderStrategyConfig`**: 매수/매도 호가 정책 (`quote` 1호가 크로스, `lastChase` 현재가 추종, `lastCancel` 시간 취소).
- **`ScaleInExecution`**: 추가진입(물타기) 체결 이벤트 VO (`ticker`, `price`, `qty`, `prevAvgPrice`, `newAvgPrice`, `totalQty`, `ts`).

### 애그리게잇 (Aggregate)
- **`PositionAggregate` (Root: `RealtimeMa5PositionManager`)**:
  - 종목별 포지션 수량과 평단가를 총괄 관리합니다.
  - **불변식 1**: **포지션 수량 `qty`와 [주문 도메인]에 등록된 미체결 매도 주문 수량은 항상 일치해야 합니다.**
  - **불변식 2 (잔고 정합성 보장 / Reconciliation)**: 브로커 통신 지연이나 체결 응답 유실로 인해 앱 내 보유 상태(`HOLDING`)가 지속되는 유령 포지션을 방지하기 위해, 주기적(`manualExitCheckMs = 15초`)으로 KIS 실계좌 잔고를 대조하여 2회 연속 계좌에 수량이 없으면 외부 체결/정리로 인정하고 포지션을 정상 청산(`MANUAL`) 종결합니다.
  - **불변식 3 (유효 보유 포지션 필터링 / Valid Holding Filter)**: 한투 KIS 계좌 잔고(`inquireOverseasBalance`) 응답 중 체결기준 보유수량이 없거나(`ccld_qty_smtl1 <= 0`, 당일 청산 완료 후 T+1 결제 대기 잔여 행) 현재가가 없는(`ovrs_now_pric1 <= 0`, CVR 등 거래 불능 잔여 권리 및 오류 행) 종목은 유효한 포지션이 아니므로 보유종목 화면(`HoldingsPanel`) 및 오토파일럿 보유 등록(`AdoptSheet`) 대상에서 제외한다.
  - [주문 도메인]으로부터 매수 체결 통보(`OrderFilledEvent`)를 수신하면 즉시 새 평단가를 계산하고, 계좌 총평가자산 대비 투입 비중을 반영한 평단가 $\times (1 + TP)$ (+0.5% ~ +3%) 지정가 매도 주문을 [주문 도메인]에 요청합니다.

---

## 2. 3대 핵심 게이트 및 세션 운영 규칙

### A. 신규 진입 게이트 (Initial Entry Gate)
1. **프리마켓 및 정규장 세션 허용**: 미국 프리마켓 개장부터 정규장 마감(ET 04:00 ~ 16:00, 월~금) 내에서 신규 진입 허용.
2. **애프터마켓 신규 진입 차단**: ET 16:00 ~ 20:00(애프터마켓) 및 주간거래(ATS), 주말/휴일에는 신규 진입 차단.
3. **속도 필터 (`minTickRate`)**: 설정된 최소 틱속도(기본 1.0~2.0틱/초) 이상인 활성 종목만 진입.
4. **감시 후보 필터 (`watchedTickers`)**: 리스트 내 틱속도 상위 N개(`watchCount`) 종목군에 포함되어야 함.
5. **수량 산정**: 설정 도메인에서 제공하는 1배수 수량.

### B. 추가진입(물타기) 게이트 (Averaging Down Gate)
1. **낙폭 조건**: 현재가 기준 평단가 대비 -3% 이하 (`gapRate <= -3%`) 충족 필수.
2. **동시 조건**: 실시간 5선 기울기 상승(`slope === 'up'`) ∧ 실시간 5선 상향 돌파(`breakout === true`).
3. **세션 허용 범위**: **프리마켓, 정규장, 애프터마켓(ET 04:00 ~ 19:55) 내내 허용** (19:55 ET 마감 일괄 청산 전까지 언제든 물타기 허용).
4. **중복 방지 (Invariants)**: 동일 평단에서는 추가진입 이벤트를 1회만 처리하며, 추가진입 매수 체결로 새 평단이 확정되기 전까지 재진입 잠금.
5. **수량 산정**: 희망수량 `(|gapRate| - 1) × 보유수량`과 가용자본 한도 내 최대 가능 수량의 `min`값 적용.

### C. 주문 실행 및 체결 정산 (Execution & Settlement)
1. **호가 추종**: 1호가 매수 틱이 변경되면 기존 매수 주문을 정정하거나 취소 후 재주문.
2. **미체결 자동 취소**: 지정 시간(`buyCancelAfterMs`) 동안 체결되지 않은 주문은 취소(단, 부분 체결 시 취소 금지).
3. **매도 체결(익절 완료)**: 관리 중이던 티커를 `actives`에서 해제하고 사이클 정산 완료.
4. **피드 유지 보장 (Feed Retention)**: 보유 중인 종목은 워치리스트 순위 탈락 여부와 무관하게 `pinned` 및 `tickHolds`로 웹소켓 구독을 강제 유지.
