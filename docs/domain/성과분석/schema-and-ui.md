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
// 키: `trade_actions.YYYY-MM-DD` (미국 동부시간 America/New_York, ET 기준 일자)
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

/** 추가진입(물타기) 체결 이벤트 도메인 값 객체 (ScaleInExecution VO) */
interface ScaleInExecution {
  ticker: string;
  price: number;                               // 실제 체결 단가 (USD)
  qty: number;                                 // 체결 수량
  prevAvgPrice: number;                        // 직전 평단가
  newAvgPrice: number;                         // 체결 후 새 평단가
  totalQty: number;                            // 체결 후 총 보유 수량
  ts: number;                                  // 체결 시각 (epoch ms)
}
```

> **[불변식 1] 미국 동부시간(America/New_York, ET) 기준 거래일 일원화**:  
> 오토파일럿의 일일 성과(`cumPnl`)와 `tradeStore`의 체결 기록(`trade_actions.*`, `trades.*`)은 동일하게 미국 동부시간(ET) 기준일(`YYYY-MM-DD`)을 단일 정본으로 사용합니다. 한국 시각 오전(새벽 정규장 종료 후)에도 직전 미국장 세션의 체결 기록과 오늘 성과가 정확히 1:1로 일치하여 보존됩니다.
>
> **[불변식 2] 당일 체결 기록 무손실 보장 (Lossless Migration)**:  
> 당일 신규 체결 액션(`trade_actions.*`)이 기록된 상태라도, 아직 변환되지 않은 당일 구버전 사이클 기록(`trades.*`)이 존재하면 ID 기반 중복 방지를 거쳐 무손실로 합성·병합하여 사용자에게 온전한 거래 이력을 제공합니다.

---

## 3. 화면 및 커스텀 훅 (`screens.md`, `custom-hook.md`)

- **화면**:
  - `app/trades.tsx` (오늘 거래 기록 세부 화면 — `TradeHistory.tsx` 탑재):
    - 상단 필터 칩: `전체` | `진입` | `추가진입` | `청산`
    - 당일 체결 요약: 실현 손익 및 체결 건수 통계
    - 체결 타임라인: 액션별 뱃지, 체결시각, 체결단가·수량·대금(USD/원화), 평단 변화 또는 실현손익
  - `app/index.tsx` / `app/home.tsx` (손익 탭: `ProfitLoss.tsx`, `KellySection.tsx`):
    - **페이지 단위 패널화 (통일된 드래그 체감)**: `MonthNavigator`와 당월 요약 카드, "일별 손익" 리스트, 하단 `KellySection`이 단일 `FlatList`로 통합 구성되어, 화면 전체를 아래로 당겨 새로고침(Pull-to-Refresh)할 수 있습니다.
- **커스텀 훅**:
  - `useTodayTradeActions()`: 당일 로컬 체결 액션(`ENTRY`, `SCALE_IN`, `EXIT`) 실시간 조회 및 정렬
  - `useTodayTrades()`: 당일 완료된 매수→매도 사이클 기록 조회 (기존 호환)
  - `useKellyStats()`: 최근 거래 이력 기반 켈리 계산 결과 및 권장 배율 구독
  - `useTradeHistory()`: 로컬 및 Supabase 동기화된 거래 내역 페이징 조회

