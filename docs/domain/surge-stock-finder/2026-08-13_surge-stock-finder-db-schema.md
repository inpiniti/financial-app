# 급등주 찾기 — DB 스키마 (surge_events)

> 작성일 2026-08-13 · 분류: **소형** (Supabase 테이블 1개 + RLS 정책)
> 기준: `supabase/migrations/0001~0003` (기존 마이그레이션 관례), `lib/supabase.ts` (anon 클라이언트 싱글턴)
> 상위 기획: [2026-08-13_surge-stock-finder-plan.md](./2026-08-13_surge-stock-finder-plan.md)

## 1. 설계 원칙

- **1행 = 1에피소드**: 급등 신호가 행을 열고(insert), 같은 종목의 후속 급락 신호가 행을 닫는다(update). 열린 에피소드 없이 온 단독 급락도 행으로 남긴다(급등 컬럼 null).
- **변동율은 DB가 계산**: `generated always as ... stored` 생성 컬럼. 앱 쪽 계산과 어긋날 여지를 없애고, 앱은 원천값(체결가·호가)만 넣는다.
- **행 열고 바로 저장**: 에피소드를 앱 메모리에만 들고 있다가 닫힐 때 한 번에 insert하는 방식은 앱 강제종료 시 급등 기록이 통째로 유실된다 → 급등 시점에 insert, 급락 시점에 update. 대신 anon update 정책이 필요해지는데, `open` 상태 행만 갱신 가능하게 좁힌다(§4).
- 마이그레이션 실행 경로는 기존 관례대로 **Supabase 대시보드 SQL Editor** (CLI 미연결 — `0001` 머리말 참조).

## 2. DDL — `supabase/migrations/0004_surge_events.sql`

```sql
-- 0004_surge_events.sql
-- 급등주 찾기 신호 기록 (docs/domain/surge-stock-finder). 매매 연동 없음 — 관찰 데이터 수집 전용.

create table if not exists surge_events (
  id               uuid primary key default gen_random_uuid(),

  -- 종목
  ticker           text not null,             -- 예: 'AAPL'
  market           text not null,             -- 거래소 (NAS/NYS/AMS — kis/trId의 OverseasExchangeCode 축약)

  -- 급등 스냅샷 (단독 급락 행이면 null)
  surge_at         timestamptz,               -- 급등 확정 시각 (기기 시계, UTC)
  surge_price      numeric,                   -- 급등 시점 체결가
  surge_ask1       numeric,                   -- 급등 시점 매도1호가 (PASK1)
  surge_ask2       numeric,                   -- 급등 시점 매도2호가 (PASK2)

  -- 급락 스냅샷 (에피소드 미종결이면 null)
  plunge_at        timestamptz,               -- 급락 확정 시각
  plunge_price     numeric,                   -- 급락 시점 체결가
  plunge_bid1      numeric,                   -- 급락 시점 매수1호가 (PBID1)
  plunge_bid2      numeric,                   -- 급락 시점 매수2호가 (PBID2)

  -- 변동율 (%) — DB 생성 컬럼. "급등 시점 매도호가에 사서 급락 시점 매수호가에 판다" 정의.
  price_change_pct numeric generated always as
    (case when surge_price > 0 and plunge_price is not null
          then (plunge_price - surge_price) / surge_price * 100 end) stored,
  l1_change_pct    numeric generated always as
    (case when surge_ask1 > 0 and plunge_bid1 is not null
          then (plunge_bid1 - surge_ask1) / surge_ask1 * 100 end) stored,
  l2_change_pct    numeric generated always as
    (case when surge_ask2 > 0 and plunge_bid2 is not null
          then (plunge_bid2 - surge_ask2) / surge_ask2 * 100 end) stored,

  -- 에피소드 상태
  status           text not null default 'open'
                   check (status in ('open', 'closed', 'expired', 'plunge_only')),
  created_at       timestamptz not null default now()
);

create index if not exists surge_events_ticker_created_idx on surge_events (ticker, created_at desc);
create index if not exists surge_events_status_idx on surge_events (status) where status = 'open';
```

### 상태 전이

| status | 의미 | 전이 |
|---|---|---|
| `open` | 급등 기록됨, 급락 대기 중 | insert 시 기본값 |
| `closed` | 후속 급락으로 정상 종결 — 변동율 3종 채워짐 | 급락 update |
| `expired` | 타임아웃(기본 30분)까지 급락 없음 — 급락 컬럼 null 유지 | 타임아웃 update |
| `plunge_only` | 열린 에피소드 없이 온 단독 급락 — 급등 컬럼 null | insert 시 지정 |

### 에피소드 운영 규칙 (앱 쪽 SurgeRecorder 책임)

- **재시작 고아 행 정리**: 앱이 죽으면 메모리 에피소드는 사라지지만 DB엔 `open` 행이 남는다. SurgeRecorder는 **부팅(배선) 시 1회**, 자신이 모르는 `open` 행을 전부 `expired`로 update한다(재시작 이후의 급락과 이어붙이지 않는다 — 공백 구간의 가격 흐름을 모르므로 페어링 무효).
- **열린 에피소드 중 재급등**: 같은 종목에 `open` 에피소드가 있는 동안 새 급등 신호는 **무시**한다(행 추가·갱신 없음). 쿨다운(60초)과 별개의 규칙 — 에피소드는 급락 또는 타임아웃으로만 끝난다.
- **단독 급락의 호가는 대부분 null**: `plunge_only` 종목은 호가 구독이 붙어 있던 적이 없어 매수1/2호가가 거의 항상 null이다 — **허용 사양**이다. 호가가 채워진 급락은 에피소드 종결(`closed`) 쪽에서만 기대할 것.
- **기록 실패는 감지를 멈추지 않는다**: Supabase env 미설정·네트워크 실패 시에도 감지는 계속 돌고, 해당 에피소드만 미기록(`logged: false`, 훅 문서 §3)으로 표시한다.

## 3. 컬럼 ↔ 데이터 소스 대응

| 컬럼 | 소스 | 비고 |
|---|---|---|
| `surge_price` / `plunge_price` | WS `HDFSCNT0` LAST | ⚠ 미국 무료 시세는 **지연체결가** — 시각 해석 시 감안 |
| `surge_ask1/2`, `plunge_bid1/2` | WS `HDFSASP0` — 구현 인덱스(공식 샘플 레이아웃): PBID1=10/PASK1=11, **PBID2=16/PASK2=17** (RSYM 포함 레이아웃이면 자동 +1, `kis/realtimePrice.ts` QUOTE_INDEX) | 0분지연. 호가 레벨은 6필드 세트 반복. 실데이터가 1호가까지만 오면 2호가는 undefined → null 기록(허용 사양). 3호가 이상은 원문 중복 표기로 불확정 — 소비 안 함. 실계좌 RAW 덤프 재검증 필요 |
| `surge_at` / `plunge_at` | 감지기 확정 시점의 기기 시계 | KIS 페이로드 체결시각이 아님 (지연시세라 페이로드 시각도 어차피 소스 지연 포함) |
| `market` | 리스트 편입 시 채용 거래소 | `watchlist` 후보의 `excd` |

호가 미수신 상태에서 확정이 먼저 오면(동적 구독 지연·슬롯 고갈) 호가 컬럼 **null로 기록**하고 버리지 않는다 — 생성 컬럼도 자동으로 null이 된다.

## 4. RLS 정책

`approved_users`(읽기 전용)와 달리 이 테이블은 **앱이 직접 쓴다**. anon에 insert·update를 열되 범위를 좁힌다:

```sql
alter table surge_events enable row level security;
grant select, insert, update on table surge_events to anon, authenticated;

-- 조회: 앱 내 기록 열람용
create policy "anon can read surge_events"
  on surge_events for select to anon, authenticated
  using (true);

-- 기록 생성: open(급등) 또는 plunge_only(단독 급락)만 만들 수 있다
create policy "anon can insert signals"
  on surge_events for insert to anon, authenticated
  with check (status in ('open', 'plunge_only'));

-- 에피소드 종결: 아직 열린 행만 고칠 수 있고(using), 고친 결과는 closed/expired여야 한다(with check).
-- ⚠ with check를 생략하면 Postgres가 using 식을 갱신 후 행에도 적용한다 — 새 행은 status='closed'라
--    using(status='open')에 걸려 종결 update가 전부 거부된다. 반드시 둘 다 명시할 것.
create policy "anon can close open episodes"
  on surge_events for update to anon, authenticated
  using (status = 'open')
  with check (status in ('closed', 'expired'));

-- delete 정책 없음 — RLS 기본 거부. 정리는 대시보드에서만.
```

- 개인용 단일 사용자 앱 전제의 최소 방어다. anon 키가 유출되면 쓰레기 행 insert는 가능하지만, 종결된 기록의 변조·삭제는 정책상 불가.
- 생성 컬럼은 클라이언트가 값을 보낼 수 없으므로(DB가 거부) 변동율 위조 걱정은 없다.

## 5. 분석용 쿼리 예시 (기록 리뷰 단계에서 사용)

```sql
-- 변동율 분포 — "매도1호가에 사서 매수1호가에 팔았으면" 얼마였나
select count(*)                             as episodes,
       round(avg(l1_change_pct), 2)         as avg_l1,
       round((percentile_cont(0.5) within group (order by l1_change_pct))::numeric, 2) as median_l1,
       count(*) filter (where l1_change_pct > 0) as wins
from surge_events where status = 'closed';

-- 급등 → 급락까지 걸린 시간 분포 (신호 선행성 평가)
select ticker, surge_at, plunge_at,
       extract(epoch from plunge_at - surge_at) as hold_sec,
       price_change_pct, l1_change_pct
from surge_events where status = 'closed'
order by surge_at desc;

-- 오탐 후보 — 급등 후 급락이 끝내 안 온 비율
select status, count(*) from surge_events group by status;
```

## 6. 확장 후보 (v1에는 넣지 않음, 필요 확인 후 add column)

| 컬럼 | 용도 |
|---|---|
| `surge_strn` | 급등 시점 체결강도 — 추후 필터 후보 분석 |
| `surge_tick_rate` / `baseline_tick_rate` | 조기경보 배수의 실측 기록 — 문턱 튜닝 근거 |
| `session` | 정규장/주간거래 구분 — 세션별 품질 비교 |

## 완료 기준

- [x] `0004_surge_events.sql` 작성 (2026-08-13 — `supabase/migrations/0004_surge_events.sql`)
- [ ] **대시보드 SQL Editor에서 실행** ← 수동 단계, 앱에서 기록이 붙기 전에 반드시 먼저
- [x] `lib/surgeLog.ts` — insertOpen/insertPlungeOnly/close/expire/sweepOrphans, `getSupabaseClient()` 재사용
- [ ] 정책 검증: anon으로 closed 행 update 시도가 거부되는지, **open→closed 종결 update는 통과하는지** 둘 다 확인
- [x] 부팅 고아 행 정리(open→expired sweep) — SurgeRecorder.enable()에서 실행 (`features/scalper/surgeRecorder.ts`, vitest 검증)
