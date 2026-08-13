-- 0004_surge_events.sql
--
-- 실행 방법: Supabase 대시보드 → SQL Editor 에 붙여넣고 실행한다 (0001과 동일한 경로 — CLI 미연결).
--
-- 용도 (2026-08-13): 급등주 찾기 신호 기록 (docs/domain/surge-stock-finder).
--   급등(진입) 신호가 행을 열고(open) 같은 종목의 이탈(트레일링 하락 확정) 신호가 행을 닫는다(closed).
--   plunge_* 컬럼명은 초안의 흔적 — 담기는 값은 "이탈(하락 확정) 시점"이다. 단독 하락은 기록하지 않는다.
--   매매 연동 없음 — 감지 품질을 나중에 기록으로 판단하기 위한 관찰 데이터 수집 전용.
--   변동율 3종은 생성 컬럼 — 앱은 원천값(체결가·호가)만 넣고 계산은 DB가 한다(계산 불일치·위조 차단).

create table if not exists surge_events (
  id               uuid primary key default gen_random_uuid(),

  -- 종목
  ticker           text not null,             -- 예: 'AAPL'
  market           text not null,             -- 거래소 (NAS/NYS/AMS)

  -- 급등 스냅샷 (단독 급락 행이면 null)
  surge_at         timestamptz,               -- 급등 확정 시각 (기기 시계, UTC)
  surge_price      numeric,                   -- 급등 시점 체결가
  surge_ask1       numeric,                   -- 급등 시점 매도1호가 (PASK1)
  surge_ask2       numeric,                   -- 급등 시점 매도2호가 (PASK2)

  -- 이탈(하락 확정) 스냅샷 (에피소드 미종결이면 null)
  plunge_at        timestamptz,               -- 이탈 확정 시각
  plunge_price     numeric,                   -- 이탈 시점 체결가
  plunge_bid1      numeric,                   -- 이탈 시점 매수1호가 (PBID1)
  plunge_bid2      numeric,                   -- 이탈 시점 매수2호가 (PBID2)

  -- 변동율 (%) — "급등 시점 매도호가에 사서 급락 시점 매수호가에 판다" 정의.
  price_change_pct numeric generated always as
    (case when surge_price > 0 and plunge_price is not null
          then (plunge_price - surge_price) / surge_price * 100 end) stored,
  l1_change_pct    numeric generated always as
    (case when surge_ask1 > 0 and plunge_bid1 is not null
          then (plunge_bid1 - surge_ask1) / surge_ask1 * 100 end) stored,
  l2_change_pct    numeric generated always as
    (case when surge_ask2 > 0 and plunge_bid2 is not null
          then (plunge_bid2 - surge_ask2) / surge_ask2 * 100 end) stored,

  -- 에피소드 상태: open(이탈 대기) · closed(이탈 확정 종결) · expired(타임아웃/재시작 정리)
  -- · plunge_only(초안의 단독 급락 — 이탈 재정의로 미사용, enum만 잔류)
  status           text not null default 'open'
                   check (status in ('open', 'closed', 'expired', 'plunge_only')),
  created_at       timestamptz not null default now()
);

create index if not exists surge_events_ticker_created_idx on surge_events (ticker, created_at desc);
create index if not exists surge_events_status_idx on surge_events (status) where status = 'open';

alter table surge_events enable row level security;
grant select, insert, update on table surge_events to anon, authenticated;

-- 조회: 앱 내 기록 열람용.
drop policy if exists "anon can read surge_events" on surge_events;
create policy "anon can read surge_events"
  on surge_events for select to anon, authenticated
  using (true);

-- 기록 생성: open(급등) 또는 plunge_only(단독 급락)만 만들 수 있다.
drop policy if exists "anon can insert signals" on surge_events;
create policy "anon can insert signals"
  on surge_events for insert to anon, authenticated
  with check (status in ('open', 'plunge_only'));

-- 에피소드 종결: 아직 열린 행만 고칠 수 있고(using), 고친 결과는 closed/expired여야 한다(with check).
-- ⚠ with check를 생략하면 Postgres가 using 식을 갱신 후 행에도 적용한다 — 새 행은 status='closed'라
--    using(status='open')에 걸려 종결 update가 전부 거부된다. 반드시 둘 다 명시할 것.
drop policy if exists "anon can close open episodes" on surge_events;
create policy "anon can close open episodes"
  on surge_events for update to anon, authenticated
  using (status = 'open')
  with check (status in ('closed', 'expired'));

-- delete 정책 없음 — RLS 기본 거부. 정리는 대시보드에서만.

-- 확인용 — 아래를 실행하면 정책이 제대로 붙었는지 볼 수 있다.
--   select policyname, cmd, qual, with_check from pg_policies where tablename = 'surge_events';
