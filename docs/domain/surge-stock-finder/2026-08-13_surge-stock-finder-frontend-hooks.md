# 급등주 찾기 — 프론트 훅 동작 설계

> 작성일 2026-08-13 · 분류: **소형** (UI 구독 훅 — 감지·기록 로직은 범위 밖)
> 기준: `features/scalper/ui/managerProvider.tsx` (`useScalperManager`), `features/scalper/ui/AutoPilotScreen.tsx:179-184` (구독 관례), `features/scalper/autopilotManager.ts:355-378` (subscribe 3종)
> 상위 기획: [2026-08-13_surge-stock-finder-plan.md](./2026-08-13_surge-stock-finder-plan.md) · DB: [2026-08-13_surge-stock-finder-db-schema.md](./2026-08-13_surge-stock-finder-db-schema.md)

## 1. 대원칙 — 훅은 "창문"이고, 감지·기록은 훅 밖에서 돈다

이 앱의 기존 구조가 이미 그렇다:

- 매니저(`ScalperManager`/`AutoPilotManager`)는 **모듈 스코프 싱글턴** — 탭 전환으로 화면이 언마운트돼도 WS 연결·감지·매매는 계속 돈다 (`managerProvider.tsx:46-48`).
- 화면은 `subscribeXxx(listener)`로 **구독만** 한다. 구독 함수는 해제 함수를 반환하고, 화면은 `useEffect`의 cleanup으로 넘긴다 (`AutoPilotScreen.tsx:179-184`).

급등주 찾기도 동일해야 한다. 특히 **Supabase 기록(insert/update)은 절대 훅·화면에서 하지 않는다** — 사용자가 다른 탭을 보고 있어도, 화면이 하나도 안 떠 있어도 신호는 기록돼야 하기 때문. 기록은 매니저 계층(`SurgeRecorder`)의 일이고, 훅은 그 결과를 비추는 창문이다.

```
[로직 계층 — 화면과 무관하게 상시 동작]
WS 틱 → FeedSlot → SurgeDetector(2단계) → SurgeRecorder ── insert/update ──→ Supabase
                                                 │
                                                 │ notify(episode[])
[UI 계층 — 떠 있을 때만]                          ▼
useSurgeEvents() ← subscribeSurge(listener) ← AutoPilotManager
      │
      ▼
급등 배지 / 신호 타임라인 화면
```

## 2. 부트스트랩 — 새 훅을 만들지 않고 기존 경로에 올라탄다

매니저 생성·수명은 이미 `useScalperManager()`가 관리한다 (`managerProvider.tsx:260-291`):

1. 트레이딩 섹션 포커스 → `useFocusEffect` 발화
2. 싱글턴 캐시 있으면 재사용 + `refreshLiveSettings()`로 바뀔 수 있는 설정만 주입, 없으면 `buildManager()` 1회 실행
3. 상태를 `loading | needsSetup | error | ready`로 노출 — `ready`일 때만 `autopilot` 핸들 접근 가능

SurgeRecorder는 `buildManager()` 안에서 AutoPilotManager에 배선되므로(FeedSlot 병렬 부착), **급등 감지의 시작·중단도 기존 오토파일럿 수명과 함께 간다.** 별도 부트스트랩 훅을 만들지 않는다.

⚠ 따라서 현재 구조의 제약도 그대로 물려받는다: 앱 프로세스가 떠 있고 keep-awake로 화면이 살아 있는 동안만 감지·기록이 돈다(백그라운드 실행 미지원, `README.md:8`).

## 3. 매니저 쪽 노출 API (AutoPilotManager 확장)

기존 subscribe 3종(`subscribeView`/`subscribeEvents`/`subscribeList`)과 같은 관례로 하나 추가:

```ts
// autopilotManager.ts — 기존 관례(355-378행)와 동일한 형태
subscribeSurge(listener: SurgeListener): () => void;   // 구독 즉시 현재 스냅샷 1회 통지
get recentSurgeEpisodes(): SurgeEpisodeView[];         // 최신순, 메모리 상한 (기존 EVENT_LIMIT=50 관례)
```

```ts
/** UI에 보여줄 에피소드 뷰 — DB 행의 메모리 미러 (최근 것만) */
interface SurgeEpisodeView {
  id: string;                       // Supabase 행 id (기록 실패 시 로컬 임시 id)
  ticker: string;
  market: string;
  status: 'alerting' | 'open' | 'closed' | 'expired'; // plunge_only는 이탈 재정의(2026-08-13)로 폐기
  //        ↑ UI 전용 상태: 1단계 조기경보(호가 구독 중, 아직 미확정) — DB에는 없다
  surgeAt?: number;   surgePrice?: number;   surgeAsk1?: number;   surgeAsk2?: number;
  plungeAt?: number;  plungePrice?: number;  plungeBid1?: number;  plungeBid2?: number;
  l1ChangePct?: number;             // closed일 때만 — DB 생성 컬럼과 동일 정의로 표시용 계산
  logged: boolean;                  // Supabase 기록 성공 여부 (실패 시 배지에 경고 표시)
}
```

- `alerting`은 화면 전용이다 — "지금 뭔가 붙었다"를 실시간으로 보여주되, DB에는 2단계 확정만 남긴다(상위 기획 §2).
- `logged: false`는 네트워크 실패로 insert가 안 된 에피소드 — v1은 재시도 큐 없이 표시만 한다(상위 기획 리스크 항목).

## 4. 훅 설계 — `useSurgeEvents()`

위치는 기존 관례대로 `features/scalper/ui/`. 구현은 기존 화면의 구독 패턴을 그대로 따른다:

```tsx
// features/scalper/ui/useSurgeEvents.ts
export function useSurgeEvents(autopilot: AutoPilotManager): SurgeEpisodeView[] {
  const [episodes, setEpisodes] = useState<SurgeEpisodeView[]>(() => autopilot.recentSurgeEpisodes);
  useEffect(() => autopilot.subscribeSurge(setEpisodes), [autopilot]);
  return episodes;
}
```

동작 규약:

| 시점 | 동작 |
|---|---|
| 마운트 | `recentSurgeEpisodes` 스냅샷으로 초기화 → 놓친 신호 없이 최신 상태로 시작 |
| 신호 발생/전이 | 매니저가 listener에 새 배열 통지 → setState → 리렌더 (배열은 매번 새 참조 — 기존 `emitList` 관례) |
| 언마운트/탭 전환 | 구독만 해제. **감지·기록은 계속 돈다** |
| 재마운트 | 스냅샷 재수화 — 부재 중 쌓인 에피소드가 그대로 보인다 |

파생 훅 (같은 파일, 필요 시):

```tsx
/** 홈 하단 메뉴 배지용 — 미확인 신호 개수만 필요할 때 리렌더 최소화 */
export function useSurgeBadgeCount(autopilot: AutoPilotManager): number
```

## 5. 화면 연결 (v1 최소)

1. **트레이딩 화면 신호 섹션**: `useScalperManager()`가 `ready`일 때 `useSurgeEvents(autopilot)`로 목록 표시 — 기존 이벤트 타임라인과 같은 자리 문법. `alerting`(조기경보)은 회색/펄스, `open`(급등 확정)은 상승색, `closed`는 변동율과 함께 표시.
2. **배지**: 하단 메뉴에 `useSurgeBadgeCount` — 마지막 열람 시각 이후 신호 수. 열람 시각은 AsyncStorage.
3. 과거 기록 열람(Supabase select 페이지네이션)은 v1 범위 밖 — 수집 데이터 리뷰는 우선 대시보드 SQL로 한다(DB 문서 §5).

UI 작업 시 `app-ui-style` 스킬(풀폭 패널 + 촘촘한 리스트) 적용.

## 6. 하지 말 것 (기존 사고 사례에서 온 규칙)

- **훅에서 Supabase를 직접 부르지 않는다** — 화면 수명에 기록이 묶인다 (§1).
- **훅에서 감지 파라미터를 매니저에 주입하지 않는다** — 설정 주입은 `refreshLiveSettings()` 단일 경로 (`managerProvider.tsx:232-253`, 2026-08-11 "저장해도 반영 안 됨" 사고의 재발 방지 경로). v1은 파라미터가 코드 고정값이라 해당 없음, 노출하게 되면 반드시 이 경로로.
- **listener 안에서 무거운 계산을 하지 않는다** — 통지는 틱 경로에서 온다. 표시용 가공은 useMemo로 화면 쪽에서.
- **구독 해제를 잊지 않는다** — `useEffect(() => autopilot.subscribeSurge(...), [autopilot])` 형태면 cleanup이 자동으로 해제 함수가 된다.

## 완료 기준

- [x] `AutoPilotManager.subscribeSurge` / `recentSurgeEpisodes` 추가 (2026-08-13, 기존 subscribe 관례와 동형)
- [x] `useSurgeEvents` 훅(`features/scalper/ui/useSurgeEvents.ts`) + AutoPilotScreen "급등·이탈 기록" 패널
- [ ] `useSurgeBadgeCount`(하단 메뉴 배지) — **v1에서 보류**: 홈 BottomMenu 개입 범위가 커서 신호 패널만으로 시작, 수집 데이터가 쓸만하다고 판단되면 추가
- [ ] 실기기 확인: 탭 전환·재마운트 후 부재 중 신호가 목록에 남아 있는지 / 화면이 떠 있지 않은 상태의 신호가 Supabase에 기록되는지 (훅 독립성)
