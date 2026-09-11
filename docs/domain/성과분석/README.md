# 성과분석 (Analytics) 도메인

> **성과분석 도메인**은 자동매매 사이클이 종료(청산)될 때마다 체결 기록을 영구 저장하고, **켈리 공식(Kelly Criterion)에 기반한 통계적 포지션 사이징 척도**를 계산하며, 클라우드(Supabase `trade_results`)로의 신뢰성 있는 비동기 동기화를 책임집니다.

---

## 1. DDD 모델

### 엔티티 (Entity)
- **`TradeResultRecord`**: 청산된 단일 매매 사이클의 결과 엔티티.
  - 필드: `id`(UUID), `accountNo`, `strategy`, `ticker`, `qty`, `entryPrice`, `exitPrice`, `grossPnl`, `fees`, `pnl`, `returnPct`, `exitReason`, `entrySnapshot`, `exitSnapshot`

### 값 객체 (Value Object)
- **`KellyResult`**: 계산된 켈리 통계 지표.
  - $p$ (승률), $b$ (손익비 = 평균이익 / 평균손실)
  - 이산형 켈리: $f_{disc} = p - \frac{1-p}{b}$
  - 연속형 켈리: $f_{cont} = \frac{\mu}{\sigma^2}$ ($\mu$: 평균수익률, $\sigma^2$: 표본분산)
  - 보수적 결합 켈리: $raw = \min(f_{disc}, f_{cont})$, 반켈리: $half = raw \times 0.5$
  - 플래그: `insufficientSamples` ($n < 30$), `negativeEdge` (기댓값 음수)

### 애그리게잇 (Aggregate)
- **`TradeStoreAggregate` (Root: `features/scalper/tradeStore.ts`)**:
  - 로컬 `AsyncStorage`를 **1차 정본(Single Source of Truth)**으로 관리하여 네트워크가 끊겨도 거래 기록이 유실되지 않도록 보장합니다.
  - Supabase 업로드 실패 시 로컬 미전송 큐(`pendingUploadQueue`)에 적재하여 다음 기회에 자동 재전송합니다 (Fail-Open 원칙).

### 도메인 서비스 (Domain Service)
- **`KellyCalculator` (`core/kelly/index.ts`)**:
  - 최근 $N$건의 수익률 배열을 분석하여 켈리 배율 및 표본 통계를 산출하는 순수 연산 서비스.
  - 주의: 켈리 지표는 사용자 참고용 **조회 척도**이며, 오토파일럿 매매 엔진에 강제 결합되지 않습니다.

---

## 2. 도메인 책임의 핵심 3원칙

1. **자기 완결성**: 수익률 데이터 집합만으로 객체 스스로 승률, 분산, 켈리 비율을 정확하게 수학적으로 도출합니다.
2. **비즈니스 규칙 보호**:
   - Supabase 원격 서버 장애나 네트워크 오류가 발생하더라도 로컬 매매 사이클의 정산과 기록을 차단하지 않습니다.
   - 켈리 기댓값이 음수(`negativeEdge`)인 경우 경고 플래그를 세워 위험 투자를 방어합니다.
3. **응집도 유지**: 거래 기록 수집, 수수료 차감 순손익 계산, 통계적 사이징 척도 산출, 클라우드 동기화가 하나의 도메인 안에 유기적으로 통합되어 있습니다.
