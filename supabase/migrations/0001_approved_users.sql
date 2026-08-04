-- 0001_approved_users.sql
--
-- 실행 방법: Supabase 대시보드 → 해당 프로젝트 → SQL Editor 에서 이 파일 내용을 그대로 붙여넣고 실행한다.
-- (이 프로젝트는 supabase CLI로 로컬 연결되어 있지 않으므로 CLI migration up이 아니라 대시보드 실행이 기본 경로다.)
--
-- 용도: 변곡점 단타 앱의 게이트 화면이 계좌번호 화이트리스트를 조회하는 테이블 (PRD §4-A).
-- 앱은 이 테이블에 대해 읽기 전용(anon select만)이며, 행 추가/수정/삭제는 이 SQL Editor에서 개발자가 직접 한다.
--   예) insert into approved_users (account_no, memo) values ('12345678-01', '본인 계좌');
--       update approved_users set is_active = false where account_no = '12345678-01';

create table if not exists approved_users (
  account_no text primary key,
  is_active boolean not null default true,
  memo text,
  created_at timestamptz not null default now()
);

alter table approved_users enable row level security;

-- anon 키(앱)는 select만 허용한다. insert/update/delete 정책은 의도적으로 만들지 않는다 —
-- 정책이 없는 작업은 RLS 기본값(거부)으로 막힌다. 쓰기는 대시보드(관리자 권한)에서만 수행한다.
create policy "anon can read approved_users"
  on approved_users
  for select
  to anon
  using (true);
