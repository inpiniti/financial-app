---
name: handle-issue
description: 버그, 이상 현상, 기능 개선 요청이 인입되었을 때 이슈 유형(단순 UI / 작은 버그 / 복합 이슈)을 에이전트가 자체 판단하여 최소한의 절차만 수행하는 차등 워크플로우
---

# handle-issue 워크플로우

운영 중 발견된 버그, 예외 상황, 기능 개선 요구사항을 **이슈 유형에 따라 차등 절차**로 해결합니다. 에이전트는 단계 1에서 유형을 판단하고, 필요한 절차만 수행합니다.

---

## 이슈 유형별 절차 요약

| 유형 | 에이전트 판단 기준 | 수행 절차 |
| :--- | :--- | :--- |
| **A. 단순 UI 수정** | 레이아웃·스타일·텍스트 등 비즈니스 로직 무관 변경 | 직접 수정 → 커밋 |
| **B. 작은 버그** | 단일 에러, 로직 버그, 컴포넌트/훅 단순 수정 | TDD → 커밋 |
| **C. 복합 이슈** | 아키텍처·정책·기능·동시성·설계 변경 등 | 인터뷰 → 도메인 명세 → 모바일 점검(UI 포함 시) → TDD → 코드리뷰 → 커밋 |

> **판단 원칙**: 유지보수성 우선. 경계가 모호하면 더 간단한 유형으로 판단합니다.

---

## 참조 외부 스킬 (복합 이슈 시 해당 단계에서 로드)

- **인터뷰**: [`grilling`](file:///C:/Users/user/.gemini/config/skills/grilling/SKILL.md)
- **모바일 성능**: [`vercel-react-native-skills`](file:///C:/Users/user/.gemini/config/skills/vercel-react-native-skills/SKILL.md)
- **TDD**: [`tdd`](file:///C:/Users/user/.gemini/config/skills/tdd/SKILL.md)
- **코드 리뷰**: [`code-review`](file:///C:/Users/user/.gemini/config/skills/code-review/SKILL.md)

---

## 단계 1: 이슈 분석 및 유형 판단

이슈를 분해하고 유형(A/B/C)을 결정합니다:

- **증상 (Symptom)**: 사용자가 보고한 현상
- **근본 원인 후보 (Root Cause)**: 브로커 폴링 누락, 상태 불일치, 로직 오류 등
- **비즈니스 위험도**: 슬롯 낭비, 이중 발주, 잔고 왜곡 여부

판단 결과에 따라 아래 해당 유형의 절차를 수행합니다.

---

## 유형 A: 단순 UI 수정

> 레이아웃, 스타일, 텍스트, 여백, 아이콘 등 비즈니스 로직과 무관한 변경.

1. 수정 사항을 직접 구현합니다.
2. **커밋** (한글 커밋 메시지 필수. 예: `fix(ui): 진입 버튼 여백 조정`)

---

## 유형 B: 작은 버그

> 단일 에러 로그, 조건 누락, 계산 차이, 단순 로직 버그. 컴포넌트/훅 변경이 단순할 때 포함.
> 비-UI 영역(순수 비즈니스 로직, 유틸리티, 브로커 통신)의 단순 버그도 이 유형으로 판단 가능.

1. **TDD** ([`tdd`](file:///C:/Users/user/.gemini/config/skills/tdd/SKILL.md) 지침 로드):
   - **Red**: 버그를 재현하는 단위 테스트 먼저 작성, `npx vitest run <테스트파일>`로 실패 확인
   - **Green**: 최소 구현으로 테스트 통과
   - `npx tsc --noEmit`으로 타입 오류 점검
   - 전체 테스트 슈트 1회 실행 (`npx vitest run`)
2. **커밋** (한글 커밋 메시지 필수. 예: `fix(order): 체결 조건 누락 보정`)

---

## 유형 C: 복합 이슈

> 아키텍처 변경, 정책 결정, 기능 추가, 동시성·경합 문제, 리팩토링 등.

### C-1: 도메인 매핑 및 인터뷰 (grilling)

1. `docs/domain/` 하위에서 책임 도메인 식별
   - 기존 도메인 없으면 `add-domain` 워크플로우로 먼저 등록
   - 예) 주문 누락/체결 응답 → `docs/domain/주문/`
   - 예) 보유 포지션 잔고 동기화 → `docs/domain/포지션/`
2. [`grilling`](file:///C:/Users/user/.gemini/config/skills/grilling/SKILL.md) 지침 로드 후, 숨은 엣지 케이스·정책 결정을 번호 매김 질문 라운드로 사용자와 합의:
   ```markdown
   ❓ **Q1** - **<질문 제목>**: <상세 질문 및 옵션 설명>
   ➡️ <에이전트 추천 방안 및 근거>
   ```

### C-2: 도메인 명세 업데이트

합의된 요구사항을 도메인 문서에 기록합니다:
- **`feature.md`**: 신규 유스케이스 및 예외 복구 흐름 추가
- **`README.md`**: 도메인 불변식(Invariants) 명문화
- **`architecture.md`** (필요 시): 이벤트 흐름 및 예외 복구 시퀀스 갱신

### C-3: 모바일 성능 점검 (UI 포함 시만)

수정 범위에 **React Native UI, 컴포넌트, 훅, 화면 상태 구독**이 포함되는 경우만 수행:

1. [`vercel-react-native-skills/SKILL.md`](file:///C:/Users/user/.gemini/config/skills/vercel-react-native-skills/SKILL.md) 로드 후 해당 카테고리 룰 확인
2. 아래 체크리스트 출력:

| 카테고리 | 핵심 점검 항목 | 점검 및 적용 내용 |
| :--- | :--- | :--- |
| **List Performance** | `FlashList` 가상화, `React.memo`, 인라인 객체/익명 함수 지양 | *(해당/미해당 및 조치 내용)* |
| **State Management** | 전역 스토어 구독 최소화, 안정적 콜백 참조 유지 | *(해당/미해당 및 조치 내용)* |
| **Rendering** | Falsy `&&` 방지 (`count > 0 ? <View> : null`), `<Text>` 감싸기 | *(해당/미해당 및 조치 내용)* |
| **Animation / UI** | GPU 가속 속성만 애니메이션, `expo-image`, `Pressable` 사용 | *(해당/미해당 및 조치 내용)* |

> *(비-UI 영역만 수정 시 사유를 밝히고 스킵)*

### C-4: TDD 구현

[`tdd`](file:///C:/Users/user/.gemini/config/skills/tdd/SKILL.md) 지침 로드:
- **Red**: 버그/요구사항을 재현하는 테스트 먼저 작성, 실패 확인
- **Green**: 최소 구현으로 통과
- `npx tsc --noEmit` 타입 점검
- 전체 테스트 슈트 1회 실행 (`npx vitest run`)

### C-5: 코드 리뷰 (code-review)

[`code-review`](file:///C:/Users/user/.gemini/config/skills/code-review/SKILL.md) 지침 로드 후 2축 자체 점검:
- **Standards 축**: 코딩 컨벤션, Fowler 코드 스멜(Mysterious Name, Duplicated Code 등) 준수 여부
- **Spec 축**: 도메인 문서 및 이슈 요구사항과 실제 diff 일치 여부 (누락/과도한 범위 변경)

### C-6: 커밋

변경된 도메인 문서와 코드를 논리적 단위로 커밋합니다.
- **한글 커밋 메시지 필수** (예: `feat(order): 실시간 잔고 동기화 방어 로직 추가`)

---

## 완료 보고

- 판단한 이슈 유형(A/B/C)과 수행한 절차 명시
- (유형 C) 업데이트된 도메인 문서 및 추가된 불변식/규칙 요약
- (유형 C, UI 포함) 모바일 성능 체크리스트 결과 요약
- TDD 테스트 통과 결과 및 커밋 해시 보고

