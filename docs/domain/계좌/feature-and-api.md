# 계좌 — 기능, API 및 화면 (Feature & API & Screens)

## 1. 주요 기능 및 API 명세 (`api.md`, `source-data.md`)

### A. KIS 인증 및 토큰 발급
- **원천 API**: KIS OAuth `POST /oauth2/tokenP`
- **보안 관리**: `lib/secureTokenStorage.ts` (OS 키체인/SecureStore 저장)
- **자동 갱신**: `lib/kisTokenRefresher.ts`

### B. 잔고 및 예수금 조회
- **원천 API**: 해외주식 잔고/예수금 `GET /uapi/overseas-stock/v1/trading/inquire-balance`
- **반환 데이터**: 외화 잔고, 매입금액합계, 평가금액합계, 실현손익

### C. 당일 손익 집계 및 켈리 지표
- **로직**: `features/inquiry/dailyProfit.ts` & `core/kelly/index.ts`
- **역할**: 최근 매매 승률과 손익비를 바탕으로 적정 1회 베팅 비율 제안

---

## 2. 화면 및 커스텀 훅 (`screens.md`, `custom-hook.md`)

- **화면**:
  - `app/settings.tsx`: KIS 키 및 계좌번호(CANO) 등록/수정
  - `app/index.tsx`: 손익 섹션 (`ProfitLoss.tsx`), 켈리 섹션 (`KellySection.tsx`)
- **커스텀 훅**:
  - `useKisSession(reloadKey)`: 계좌 세션 준비 상태(`ready`, `needsSetup`, `loading`) 반환
  - `useDailyProfit()`: 당일 실현손익 및 거래 통계 구독
  - `useUsdKrwRate()`: 실시간 USD/KRW 환율 구독
