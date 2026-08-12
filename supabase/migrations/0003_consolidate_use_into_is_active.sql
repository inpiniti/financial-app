-- 0003_consolidate_use_into_is_active.sql
--
-- 실행 방법: Supabase 대시보드 → SQL Editor 에 붙여넣고 실행한다.
-- 0002를 아직 안 돌렸다면 0002는 건너뛰고 이 파일만 실행하면 된다 (0002가 하던 일을 모두 포함한다).
--
-- 목적 (2026-08-12): 승인 플래그를 is_active 하나로 통합한다.
--   잠깐 use 컬럼을 따로 뒀는데 is_active와 역할이 겹쳤다 — 승인 여부는 한 곳에서만 본다.
--   is_active = true  → 진입 가능 (승인은 개발자가 여기서 직접 켠다)
--   is_active = false → 승인 대기 (앱에서 들어온 등록 신청 포함)
--   행 없음           → 미등록 (앱이 등록 신청을 받는다)

-- 1) use에 값이 있으면 그 값이 실제 승인 상태다 — is_active로 옮긴 뒤 컬럼을 없앤다.
--    (use 컬럼이 없는 환경에서도 실행되도록 존재할 때만 옮긴다.)
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'approved_users' and column_name = 'use'
  ) then
    update approved_users set is_active = "use" where "use" is not null;
    alter table approved_users drop column "use";
  end if;
end $$;

-- 2) 앞으로 들어오는 행은 기본이 "승인 대기"다 — 승인은 개발자가 명시적으로 켠다.
alter table approved_users alter column is_active set default false;

-- 3) 앱(anon)의 등록 신청 허용 — is_active=false 인 행만, memo(이름/회사명) 필수.
--    승인(is_active=true)은 anon 이 만들 수 없고, update 정책도 없으므로 남의 행을 고칠 수 없다.
--    이미 있는 계좌번호는 PK 충돌(23505)로 거부된다.
grant insert on table approved_users to anon, authenticated;

drop policy if exists "anon can request approval" on approved_users;
create policy "anon can request approval"
  on approved_users
  for insert
  to anon, authenticated
  with check (
    is_active is not true
    and memo is not null
    and length(btrim(memo)) > 0
  );

-- 확인용 — 컬럼과 정책이 제대로 붙었는지 본다.
--   select column_name, column_default from information_schema.columns where table_name = 'approved_users';
--   select policyname, cmd, with_check from pg_policies where tablename = 'approved_users';
