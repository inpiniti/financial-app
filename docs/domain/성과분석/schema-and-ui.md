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

## 2. 화면 및 커스텀 훅 (`screens.md`, `custom-hook.md`)

- **화면**:
  - `app/index.tsx` (손익 탭: `ProfitLoss.tsx`, `KellySection.tsx`, 거래기록: `TradeHistory.tsx`)
- **커스텀 훅**:
  - `useKellyStats()`: 최근 거래 이력 기반 켈리 계산 결과 및 권장 배율 구독
  - `useTradeHistory()`: 로컬 및 Supabase 동기화된 거래 내역 페이징 조회
