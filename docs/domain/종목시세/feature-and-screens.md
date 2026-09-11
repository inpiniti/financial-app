# 종목시세 — 기능, 원천 데이터 및 화면 (Feature & Source Data & Screens)

## 1. 데이터 소스 및 API 연동 (`source-data.md`, `api.md`)

### A. 실시간 체결 웹소켓
- **엔드포인트**: KIS 해외주식 실시간 체결가/호가 WebSocket (`/tryitout/HDFSASP0`)
- **구독 방식**: `createRealtimeFeed.ts`
- **관리**: 슬롯 기반 동적 등록/해제 (`feedSlot.ts`)

### B. 랭킹 원천 소스
- **토스증권**: `lib/tossRanking.ts` (거래대금 상위, 실시간 급등락)
- **한국투자증권**: 해외주식 조건검색/거래량 랭킹 API

---

## 2. 화면 및 커스텀 훅 (`screens.md`, `custom-hook.md`)

- **화면**:
  - `app/index.tsx` (순위 탭 `Ranking.tsx`)
  - `app/search.tsx` (종목 검색 화면)
  - `app/stock/[symbol].tsx` (종목 상세 및 차트 화면)
- **커스텀 훅**:
  - `useWatchlist()`: 현재 감시 목록 및 종목별 실시간 시세 구독
  - `useRanking()`: 토스/한투 통합 랭킹 목록 구독
  - `useQuoteFeed(symbol)`: 특정 종목의 실시간 틱/호가 스트림 수신
