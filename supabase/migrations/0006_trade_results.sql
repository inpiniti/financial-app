-- 0006_trade_results.sql
--
-- 실행 방법: Supabase 대시보드 → SQL Editor 에 붙여넣고 실행한다 (0004·0005와 동일한 경로).
--
-- 용도 (2026-08-18): 거래 결과 기록 (docs/domain/켈리/2026-08-18_켈리-포지션-사이징-개념과-설계.md §4).
--   자동관리 사이클이 청산(정산)될 때마다 1행 insert. 켈리 배율 **조회**(척도)·성과 분석용이며
--   매매 판단·주문 중계는 하지 않는다. 로컬 tradeStore(AsyncStorage)가 정본이고 이 테이블은 추가 기록처 —
--   업로드 실패는 매매를 멈추지 않는다(앱이 미업로드분을 재전송한다).

create table if not exists trade_results (
  id                uuid primary key default gen_random_uuid(),

  -- 누구·어떤 전략
  account_no        text not null,             -- 게이트 계좌번호(approved_users.account_no와 같은 값) — 기기가 바뀌어도 이력이 이어진다
  strategy          text not null,             -- 'trend' | 'inflection' | 'ladder' | 'grid' — 진입·청산 규칙 태그. 켈리는 전략별로 따로 센다
  exit_reason       text not null,             -- core/cycle TradeRecord.exitReason (SELL_SIGNAL·STOP 등)

  -- 종목
  ticker            text not null,
  market            text,                      -- NAS/NYS/AMS
  name              text,

  -- 체결
  qty               numeric not null,
  entry_price       numeric not null,
  entry_at          timestamptz not null,
  exit_price        numeric not null,
  exit_at           timestamptz not null,

  -- 손익 (USD). pnl = 순손익(수수료 차감) — 켈리 수익률의 정본
  gross_pnl         numeric not null,
  fees              numeric not null default 0,
  pnl               numeric not null,

  -- 사이징 맥락 — 그때 얼마를 어떤 근거로 넣었는지. 나중에 "켈리였다면?"을 되돌려 보는 데 필요
  entry_amount_usd  numeric generated always as (entry_price * qty) stored,
  return_pct        numeric generated always as
    (case when entry_price * qty > 0 then pnl / (entry_price * qty) * 100 end) stored,
  equity_usd        numeric,                   -- 기록(정산) 시점 계좌 총평가(USD) — 비율 역산용. 조회 실패면 null
  sizing_mode       text not null default 'fixed' check (sizing_mode in ('fixed', 'kelly')),
  kelly_fraction    numeric,                   -- 켈리 모드였다면 적용한 f. fixed면 null (현재는 항상 fixed)

  -- 진입/청산 시점 신호 스냅샷 — 사후 분석용, 스키마 자유
  entry_snapshot    jsonb,
  exit_snapshot     jsonb,

  app_version       text,
  created_at        timestamptz not null default now()
);

create index if not exists trade_results_account_strategy_exit_idx
  on trade_results (account_no, strategy, exit_at desc);
-- 재전송 중복 방지 — 같은 계좌·종목·청산 시각은 1행.
create unique index if not exists trade_results_dedup_idx
  on trade_results (account_no, ticker, exit_at);

alter table trade_results enable row level security;
grant select, insert on table trade_results to anon, authenticated;

create policy "anon can read trade_results"
  on trade_results for select to anon, authenticated using (true);
create policy "anon can insert trade_results"
  on trade_results for insert to anon, authenticated with check (true);
-- update/delete 정책 없음 — 기록은 불변. 정정은 대시보드에서만.
