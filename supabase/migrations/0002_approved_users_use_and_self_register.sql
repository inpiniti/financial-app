-- 0002_approved_users_use_and_self_register.sql
--
-- 실행 방법: Supabase 대시보드 → SQL Editor 에 붙여넣고 실행한다 (0001과 동일한 경로).
--
-- 목적 (2026-08-12):
--   1) use 컬럼 도입 — 앱은 use = true 인 계좌만 진입시킨다. 승인은 개발자가 DB에서 직접 켠다.
--      (대시보드에서 이미 add column 한 상태라면 아래 add column if not exists 는 아무 일도 하지 않는다.)
--   2) 미등록 계좌의 앱 내 등록 신청 허용 — anon 이 use=false 행만 insert 할 수 있게 정책을 연다.
--      승인 자체(use=true)는 anon 이 절대 못 만든다: with check 로 막고, update 정책은 만들지 않는다.

alter table approved_users add column if not exists "use" boolean default false;

-- 기존 행(정책 도입 전에 개발자가 직접 넣은 계좌)은 승인된 것으로 본다.
update approved_users set "use" = true where "use" is null;

-- anon 등록 신청: use 는 반드시 false, memo(이름/회사명)는 비어 있으면 안 된다.
-- 이미 있는 계좌번호는 PK 충돌(23505)로 거부되므로 남의 행을 덮어쓸 수 없다.
drop policy if exists "anon can request approval" on approved_users;
create policy "anon can request approval"
  on approved_users
  for insert
  to anon
  with check (
    "use" is not true
    and memo is not null
    and length(btrim(memo)) > 0
  );
