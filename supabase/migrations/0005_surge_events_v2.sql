-- 0005_surge_events_v2.sql
--
-- 실행 방법: Supabase 대시보드 → SQL Editor 에 붙여넣고 실행한다 (0004와 동일한 경로).
--
-- 용도 (2026-08-13): 급등주 찾기 v2 (docs/domain/surge-stock-finder/2026-08-13_surge-stock-finder-v2-plan.md §5).
--   v1 데이터 리뷰 결과 감지 정의를 σ 기반으로 교체하면서, 세트당 반사실 분석(MFE)이 가능하도록
--   컬럼 4개를 추가한다. add column만이라 v1 데이터와 공존한다 — 기존 행은 새 컬럼이 null.
--
--   anchor_price : 급등 출발가(60초 수익률의 시작점) — "어디서 출발한 급등을 언제 인지했나"
--   peak_price   : 이탈 시점 트레일링 고점 — MFE = peak_price / surge_price
--   surge_sigma  : 급등 확정 시점 σ(60초 수익률 표준편차, 소수) — 문턱(4σ/1.5σ/3σ) 튜닝 근거
--   exit_reason  : 이탈 경로 — breakout_fail(돌파 실패)/soft(둔화)/hard(급락). 사유 분포가 곧 진단이다.

alter table surge_events
  add column if not exists anchor_price numeric,
  add column if not exists peak_price   numeric,
  add column if not exists surge_sigma  numeric,
  add column if not exists exit_reason  text
    check (exit_reason in ('breakout_fail', 'soft', 'hard') or exit_reason is null);

-- 확인용:
--   select column_name from information_schema.columns where table_name = 'surge_events' order by ordinal_position;
--
-- v2 리뷰 쿼리 예:
--   -- MFE 분포 — 확정 후 실제로 얼마나 더 갔나 (일관되게 ~0이면 추격류 전면 폐기 근거)
--   select round(avg((peak_price / surge_price - 1) * 100), 2) as avg_mfe_pct,
--          count(*) filter (where peak_price / surge_price - 1 > surge_sigma * 2) as ran_2sigma
--   from surge_events where status = 'closed' and peak_price is not null;
--   -- 이탈 사유 분포 — breakout_fail 과다 → 진입 강화 / soft 과다 → 지속력 부족 / hard 과다 → 변동성 장세
--   select exit_reason, count(*), round(avg(l1_change_pct), 2) as avg_l1
--   from surge_events where status = 'closed' group by exit_reason;
