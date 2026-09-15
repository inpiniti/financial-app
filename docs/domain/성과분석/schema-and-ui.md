# 성과분석 — 스키마, 수식 및 UI 명세 (Schema & Formulas & UI)

## 1. Supabase 테이블 스키마 (`schema.md`)

```sql
create table trade_results (
  id                uuid primary key default gen_random_uuid(),
  account_no        text not null,             -- 계좌번호
  strategy          text not null,             -- 매매 전략 태그
  exit_reason       text not null,             -- 청산 사유 (TP, SL, TIMEOUT 등)
  ticker            text not null,
  market            text,                      -- NAS/NYS/AMS
  name              text,
  qty               numeric not null,
  entry_price       numeric not null,
  entry_at          timestamptz not null,
  exit_price        numeric not null,
  exit_at           timestamptz not null,
  gross_pnl         numeric not null,
  fees              numeric not null default 0,
  pnl               numeric not null,          -- 순손익 (USD)
  entry_amount_usd  numeric generated always as (entry_price * qty) stored,
  return_pct        numeric generated always as (pnl / (entry_price * qty) * 100) stored,
  sizing_mode       text not null default 'fixed',
  kelly_fraction    numeric,
  entry_snapshot    jsonb,
  exit_snapshot     jsonb,
  created_at        timestamptz not null default now()
);
```

---

## 2. 로컬 저장소 스키마 (`AsyncStorage`)

```typescript
// 키: `trade_actions.YYYY-MM-DD` (UTC 기준 일자)
interface StoredTradeAction {
  id: string;                                  // 고유 식별자 (ticker-action-ts)
  cycleId?: string;                            // 매매 사이클 식별자
  action: 'ENTRY' | 'SCALE_IN' | 'EXIT';       // 체결 유형 (진입, 추가진입, 청산)
  ticker: string;
  market?: 'NAS' | 'NYS' | 'AMS';
  name?: string;
  price: number;                               // 체결가 (USD)
  qty: number;                                 // 체결 수량
  amountUsd: number;                           // 체결 대금 (price * qty)
  ts: number;                                  // 체결 시각 (epoch ms)
  // 진입 정보
  targetPrice?: number;                        // 익절 목표가
  // 추가진입(물타기) 정보
  prevAvgPrice?: number;                       // 추가진입 전 평단
  newAvgPrice?: number;                        // 추가진입 후 새 평단
  totalQty?: number;                           // 추가진입 후 총 보유수량
  // 청산 정보
  exitReason?: ExitReason;                     // 청산 사유 (TAKE_PROFIT, STOP_LOSS, MANUAL 등)
  entryAvgPrice?: number;                      // 청산 시점의 진입 평단
  pnl?: number;                                // 실현 순손익 (USD)
  grossPnl?: number;
  fees?: number;
  returnRatio?: number;                        // 수익률
}
```

---

## 3. 화면 및 커스텀 훅 (`screens.md`, `custom-hook.md`)

- **화면**:
  - `app/trades.tsx` (오늘 거래 기록 세부 화면):
    - 상단 필터 칩: `전체` | `진입` | `추가진입` | `청산`
    - 당일 체결 요약: 실현 손익 및 체결 건수 통계
    - 체결 타임라인: 액션별 뱃지, 체결시각, 체결단가·수량·대금(USD/원화), 평단 변화 또는 실현손익
  - `app/index.tsx` (손익 탭: `ProfitLoss.tsx`, `KellySection.tsx`, 거래기록: `TradeHistory.tsx`)
- **커스텀 훅**:
  - `useTodayTradeActions()`: 당일 로컬 체결 액션(`ENTRY`, `SCALE_IN`, `EXIT`) 실시간 조회 및 정렬
  - `useTodayTrades()`: 당일 완료된 매수→매도 사이클 기록 조회 (기존 호환)
  - `useKellyStats()`: 최근 거래 이력 기반 켈리 계산 결과 및 권장 배율 구독
  - `useTradeHistory()`: 로컬 및 Supabase 동기화된 거래 내역 페이징 조회
