# 급등주 찾기 v2 — 프론트 훅 동작 설계

> 작성일 2026-08-13 · 분류: **소형** (UI 구독 훅 — v2 감지 재설계에 맞춘 뷰·표시 갱신)
> 기준: `features/scalper/ui/useSurgeEvents.ts`(v1 훅 — 골격 유지), `features/scalper/ui/AutoPilotScreen.tsx`(SurgePanel), `features/scalper/surgeRecorder.ts`
> 상위 기획: [v2 plan](./2026-08-13_surge-stock-finder-v2-plan.md) · 대체: [v1 훅 문서](./2026-08-13_surge-stock-finder-frontend-hooks.md)

## 1. 바뀌지 않는 것 — 대원칙과 골격

v1 훅 문서의 원칙은 전부 유효하다. 요약만 남긴다:

- **훅은 창문** — 감지·Supabase 기록은 매니저(SurgeRecorder, 모듈 싱글턴)가 화면과 무관하게 한다. 훅·화면에서 Supabase 호출 금지, 감지 파라미터 주입 금지(노출하게 되면 `refreshLiveSettings()` 단일 경로).
- 부트스트랩은 `useScalperManager()`에 올라탄다(별도 훅 없음). 감지·기록의 수명 = 오토파일럿 start~stop((a)안).
- 구독은 `autopilot.subscribeSurge(listener)` — 기존 subscribe 관례와 동형, cleanup으로 해제.
- `useSurgeEvents(autopilot)` API는 **시그니처 변경 없음** — 마운트 시 `recentSurgeEpisodes` 스냅샷 재수화, 언마운트 후에도 감지·기록 지속.

## 2. 바뀌는 것 — 뷰 모델 (SurgeEpisodeView v2)

v2 감지가 싣는 정보가 늘었다. 뷰 필드 확장:

```ts
interface SurgeEpisodeView {
  id: string;                       // 로컬 id → DB 기록 성공 시 행 id
  ticker: string;
  market: string;
  status: 'alerting' | 'open' | 'closed' | 'expired';

  // 급등(진입시점) — v2: 앵커·σ 추가
  surgeAt?: number;
  surgePrice?: number;
  anchorPrice?: number;             // 급등 출발가 — "출발가→확정가" 폭 표시용
  surgeSigma?: number;              // 확정 시점 σ — 진단 표시용(선택)
  surgeAsk1?: number | null;
  surgeAsk2?: number | null;

  // 이탈(하락 확정) — v2: 고점·사유 추가
  plungeAt?: number;                // DB plunge_* 컬럼과 같은 자리(이탈 시점 값)
  plungePrice?: number;
  peakPrice?: number;               // 트레일링 고점 — MFE = peak/surge 표시용
  exitReason?: 'breakout_fail' | 'soft' | 'hard';
  plungeBid1?: number | null;
  plungeBid2?: number | null;

  priceChangePct?: number | null;   // 표시용 계산(정본은 DB 생성 컬럼)
  l1ChangePct?: number | null;
  logged: boolean;                  // Supabase 기록 성공 여부(false = 미기록 경고)
}
```

`plunge_only` 상태는 v1.1에서 이미 폐기 — v2도 세트만 기록.

## 3. 화면 표시 규약 (SurgePanel v2)

| status | 우측 표시 | 색 |
|---|---|---|
| `alerting` | "감지 중" | tertiary `#8b95a1` |
| `open` | "급등 {확정가}" + 부제 "출발 {앵커가} · 이탈 대기" | 상승 `#f04452` |
| `closed` | "±%" (l1 우선, 없으면 체결가 기준) + 부제 "**이탈 사유** · 고점 {peak}" | `pnlColor(pct)` |
| `expired` | "거래 끊김 — 만료" | tertiary |

이탈 사유 한글 라벨(이벤트 타임라인과 동일 어휘):

| exitReason | 라벨 | 의미 |
|---|---|---|
| `breakout_fail` | 돌파 실패 | 뚫었던 5분 신고가 선을 도로 내줌 — 가짜 돌파 |
| `soft` | 둔화 | 참여 식음 + 고점 −1.5σ |
| `hard` | 급락 | 고점 −3σ (참여 무관) |

- 사유는 v2 데이터 리뷰의 핵심 축이므로 **행에서 바로 보여야** 한다(탭·시트 진입 없이).
- 미기록(`logged=false`, alerting 제외)은 v1과 동일하게 `cloud-offline-outline` 아이콘.
- 스타일은 app-ui-style 그대로 — 풀폭 Panel + 촘촘한 행(px-5 py-2), 이모지 금지, 손익색은 `pnlColor()`.

## 4. 파생 훅 (v2에서도 보류 유지)

`useSurgeBadgeCount`(하단 메뉴 배지)는 v1 결정대로 보류 — 신호 패널로 시작하고, v2 데이터가 쓸만하다고 판정되면 추가.

## 5. 하지 말 것 (v1 계승 + v2 추가)

- 훅에서 Supabase 직접 호출 금지 / 감지 파라미터 주입 금지 / listener 안 무거운 계산 금지 / 구독 해제 누락 금지 (v1 그대로).
- **(v2 추가)** MFE·변동율을 화면에서 재계산해 DB와 다른 정의를 만들지 않는다 — 표시용 계산은 recorder가 뷰에 실어준 값만 쓴다(정본은 DB 생성 컬럼). 화면마다 계산식이 갈리면 리뷰 때 숫자가 안 맞는다.
- **(v2 추가)** `exitReason`을 화면에서 추론하지 않는다(예: 변동율 크기로 급락 여부 짐작) — 감지기가 판정한 사유만 표기.

## 완료 기준

- [x] `SurgeEpisodeView` v2 필드(anchor/peak/sigma/exitReason) — recorder가 채우고 훅은 그대로 통과 (2026-08-13)
- [x] SurgePanel 사유·앵커·고점 표기 (§3 규약)
- [x] `useSurgeEvents` 시그니처 무변경 확인(호출부 수정 없음)
- [ ] 실기기: 탭 전환 재수화 · 화면 없는 상태의 기록(훅 독립성) — v1 항목 재검증
