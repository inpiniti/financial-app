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
- **AI 기업 요약 (Company Brief, 호가 탭 대체)**:
  - 종목 상세 화면 내에서 KIS 현재가 상세 정보(시총, PER, 52주 고저), Yahoo 뉴스 기사 본문 N건을 조합하여 AI가 `종합 / 호재 / 악재 / 지켜볼 점`으로 요약하여 제공합니다.
  - 종목+거래일(ET) 단위 로컬 캐시 적용 및 스트리밍 타이핑 렌더링.
- **커스텀 훅 및 모듈**:
  - `features/stock/companyBrief.ts`: AI 기업 브리프 생성 및 파싱
  - `useWatchlist()`: 현재 감시 목록 및 종목별 실시간 시세 구독
  - `useRanking()`: 토스/한투 통합 랭킹 목록 구독
  - `useQuoteFeed(symbol)`: 특정 종목의 실시간 틱/호가 스트림 수신
