# financial-app — 에이전트 안내

KIS Open API로 미국주식 단타를 자동 매매하는 Expo(React Native) 단독 앱. 실계좌·소액 전제.

## 용어와 지도 (코드 읽기·설계·문서 쓰기 전에)
- 용어 정본: `CONTEXT.md` — 추세·그리드·매매·오토파일럿·서킷 등 이 repo의 말은 이 표의 정의로 쓴다.
- 도메인 지도: `docs/domain/README.md` — 도메인별 상태·코드 위치. 도메인 규칙을 고치면 해당 `docs/domain/<이름>/` 문서도 같이 고친다.
- 되돌리기 어려운 결정: `docs/adr/` — 여기 적힌 결정을 뒤집는 변경은 새 ADR부터.
- 화면 단위는 `docs/features/`, 배선 plan은 `docs/development/`, 실거래 분석 일지는 `docs/분석/README.md`.

## 스펙
- KIS 엔드포인트·TR ID·필드는 `docs/koreainvestment/`가 정본. 연동 코드는 `kis-openapi` 스킬 절차대로.
- 화면·컴포넌트는 `app-ui-style` 스킬(토스 풀폭 패널 문법).

## 관례
- 커밋은 `main` 직행, 메시지는 `✨ Feat:` / `📝 Docs:` / `🐛 Fix:` 접두 + 한 줄 요약(한국어). 작업이 끝난 뒤 한 번에.
- 시각 표기: 거래일은 ET, 문서 날짜는 `YYYY-MM-DD` 파일명 접두.
- 테스트: `npm test`(vitest). 도메인 규칙 변경은 `core/<module>` 테스트를 함께 바꾼다.

## Agent skills

### Issue tracker

이슈·스펙·티켓은 GitHub Issues(`inpiniti/financial-app`)에 `gh` CLI로 기록한다. See `docs/agents/issue-tracker.md`.

### Triage labels

기본 5개 라벨(`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`)을 그대로 쓴다. See `docs/agents/triage-labels.md`.

### Domain docs

단일 컨텍스트 — 루트 `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.
