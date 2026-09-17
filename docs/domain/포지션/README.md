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
  - **불변식 1 (중심선 반익절 및 상단선 전량익절 불변식)**: 실시간 BB 중심선(MA20) 상향 돌파(`middleCross`) 시 보유 수량의 50%(수량 1이면 전량)를 1회 반익절하고, 이후 실시간 BB 상단선 상향 돌파(`upperBreakout`) 시 잔여 수량 전량을 익절 매도하여 정산 종결합니다.
  - **불변식 2 (진입봉 저점 손절 불변식)**: 진입 시점의 1분봉 최저점($Low_{entry}$)을 메모리에 저장하며, 현재가가 이 저점을 하향 이탈 시 미련 없이 전량 손절(`STOP_LOSS`) 매도를 발주합니다.
  - **불변식 3 (물타기 완전 봉인 불변식)**: 포지션 보유 중 유입되는 모든 BUY 신호는 전면 무시하며 추가진입(물타기)을 원천 차단합니다.
  - **불변식 4 (잔고 정합성 보장 / Reconciliation)**: 브로커 통신 지연이나 체결 응답 유실로 인해 앱 내 보유 상태(`HOLDING`)가 지속되는 유령 포지션을 방지하기 위해, 주기적(`manualExitCheckMs = 15초`)으로 KIS 실계좌 잔고를 대조하여 2회 연속 계좌에 수량이 없으면 외부 체결/정리로 인정하고 포지션을 정상 청산(`MANUAL`) 종결합니다.
  - **불변식 5 (유효 보유 포지션 필터링 / Valid Holding Filter)**: 한투 KIS 계좌 잔고(`inquireOverseasBalance`) 응답 중 체결기준 보유수량이 없거나(`ccld_qty_smtl1 <= 0`, 당일 청산 완료 후 T+1 결제 대기 잔여 행) 현재가가 없는(`ovrs_now_pric1 <= 0`, CVR 등 거래 불능 잔여 권리 및 오류 행) 종목은 유효한 포지션이 아니므로 보유종목 화면(`HoldingsPanel`) 및 오토파일럿 보유 등록(`AdoptSheet`) 대상에서 제외한다.

---

## 2. 3대 핵심 게이트 및 세션 운영 규칙

### A. 신규 진입 게이트 (Initial Entry Gate)
1. **세션 및 시간 창 허용**: 미국 프리마켓 개장(ET 04:00)부터 허용하되, **한국시간 새벽 02:00 KST 이후에는 신규 진입이 전면 차단**됩니다.
2. **지표 전제조건**: 실시간 60선 및 120선이 **동시에 상승 중(`ma60Up && ma120Up`)**이어야 진입 가능.
3. **트리거**: 실시간 BB 하단 상향 돌파 (`breakout === true`).
4. **수량 산정**: 설정 도메인에서 제공하는 1배수 수량 (`orderQty` 또는 금액 환산 수량).
5. **저점 기록**: 진입 시점의 진행 중 1분봉 저점($Low_{entry}$)을 기록하여 포지션 손절선으로 바인딩.

### B. 추가진입 (물타기) 게이트 (Averaging Down Gate)
- **전면 봉인**: 추가 매수 기능은 비활성화되어 동작하지 않습니다.

### C. 청산 (익절 및 손절) 게이트 (Exit Gate)
1. **중심선 반익절**: 실시간 BB 중심선(MA20) 상향 돌파 시 보유 수량의 절반(수량 1이면 전량) 즉시 익절.
2. **상단선 전량익절**: 실시간 BB 상단선 상향 돌파 시 남은 전량 즉시 익절.
3. **진입봉 저점 손절**: 현재가가 진입봉 저점 미만으로 하락 시 전량 손절 (`STOP_LOSS`).
4. **마감 청산**: 19:55 ET (한국시간 익일 아침 마감 5분 전) 도달 시 남은 잔여 수량 전량 시장가 청산.
5. **피드 유지 보장 (Feed Retention)**: 보유 중인 종목은 워치리스트 순위 탈락 여부와 무관하게 `pinned` 및 `tickHolds`로 웹소켓 구독을 강제 유지.
