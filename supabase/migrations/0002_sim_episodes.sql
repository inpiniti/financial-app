-- sim_episodes — 가상 전략 에피소드 기록 (시뮬레이션 plan 2026-08-06 §B-3).
-- 오토파일럿 진입 1건마다 폭×배율 매트릭스(~20조합) 전략 각각이 한 행씩 남긴다.
-- 시각 컬럼(entered_at/exited_at/trade_date)은 전부 **한국시간(KST) 문자열** — 사용자 확정 §5-7.
-- 실행: Supabase 대시보드 → SQL Editor에서 이 파일 전체를 붙여넣어 실행 (0001과 동일 방식).

create table if not exists public.sim_episodes (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),

  -- 어느 모드에서 수집됐나: 'sim'(주문 가상) | 'live'(실거래 병행 관찰)
  mode text not null check (mode in ('sim', 'live')),

  ticker text not null,
  trade_date text not null,          -- 진입일 KST 'YYYY-MM-DD'
  entered_at text not null,          -- KST 'YYYY-MM-DD HH:mm:ss'
  exited_at text not null,
  duration_s integer not null,

  entry_price double precision not null,
  exit_price double precision not null,
  min_price double precision not null,
  mae_pct double precision not null,          -- 최대 역행률(양수 %)

  max_qty integer not null,
  max_invested_usd double precision not null, -- 무한 현금 기준 최대 투입 = 최소 필요 자금
  rebuy_count integer not null,

  width_pct double precision not null,
  buy_multiplier double precision not null,
  is_primary boolean not null default false,  -- 사용자 실제 설정 조합

  escaped boolean not null,
  exit_reason text not null check (exit_reason in ('escaped', 'data_lost', 'stopped', 'evicted')),

  tick_rate_at_entry double precision,
  entry_session text not null check (entry_session in ('pre', 'regular', 'after', 'off'))
);

-- 분석 편의 인덱스 — 설정 조합·날짜·세션별 집계가 주 쿼리.
create index if not exists sim_episodes_strategy_idx on public.sim_episodes (width_pct, buy_multiplier);
create index if not exists sim_episodes_date_idx on public.sim_episodes (trade_date);
create index if not exists sim_episodes_ticker_idx on public.sim_episodes (ticker);

-- RLS: anon은 insert만 — 조회는 대시보드(service role)에서 한다 (approved_users 패턴과 동일 철학).
alter table public.sim_episodes enable row level security;

drop policy if exists sim_episodes_insert_anon on public.sim_episodes;
create policy sim_episodes_insert_anon
  on public.sim_episodes for insert
  to anon
  with check (true);
