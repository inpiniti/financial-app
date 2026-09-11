# 오토파일럿 — 상태 및 프론트엔드 연동 (State & Hooks)

## 1. 클라이언트 로컬 상태 (`server-state.md` / Zustand)
- **스토어**: `useAutopilotStore` (`features/scalper/tradeStore.ts`)
- **주요 상태**:
  - `isRunning`: boolean (오토파일럿 동작 여부)
  - `slots`: SlotState[] (각 슬롯의 현재 상태, 종목코드, 수익률, 체결 내역)
  - `dailyStats`: { winCount, lossCount, totalPnl, winRate }
- **주요 액션**:
  - `startAutopilot()`, `stopAutopilot()`
  - `resetFault(symbol: string)`

## 2. 커스텀 훅 (`custom-hook.md`)
- **`useAutopilotControl()`**:
  - 오토파일럿 시작/정지 토글 및 현재 실행 상태 구독
- **`useAutopilotSlots()`**:
  - 실시간 슬롯 상태(SCANNING, ENTERING, HOLDING 등) 배열 및 종목별 카드 렌더링용 데이터 제공

## 3. 화면 연동 (`screens.md`)
- **화면 경로**: `app/index.tsx` (메인 트레이딩 탭)
- **UI 진입점**:
  - 상단 `AutopilotToggleBar`: 전원 버튼, 동시 운용 슬롯 수 표기
  - 중앙 `ActiveSlotList`: 현재 활성화된 슬롯의 실시간 진행 상황 표시
