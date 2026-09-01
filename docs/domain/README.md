# 도메인 지도 (docs/domain)

> 작성일 2026-08-19 · 이 폴더의 **기준과 목록**. 용어 정의는 `CONTEXT.md`(용어집)가 정본이고, 여기는 "어떤 도메인이 있고 어디에 코드가 있는가"만 적는다.

## 1. 폴더가 생기는 기준

**고유 용어·규칙을 가진 개념 단위 1개 = `docs/domain/<이름>/` 1개 ≈ `core/<module>` 1개.**
화면 단위(기능)는 `docs/features/`, 구현 순서·배선 plan은 `docs/development/`, 되돌리기 어려운 결정은 `docs/adr/`.

- 도메인 문서는 "무엇을 어떻게 판단하는가"(규칙·불변식·용어)를 적는다. 발주 API·화면 배선은 최소한만.
- 폐기된 도메인도 폴더를 지운다 — 대신 폴더 첫 문서 상단에 **폐기 배너**를 붙이고 후속 도메인을 가리킨다(계보 추적용).

## 2. 목록 (2026-08-22 기준)

| 도메인 | 상태 | 코드 | 한 줄 |
|---|---|---|---|
| [모델](./모델/) | **현행 (설정 `engineMode='model'` 선택 시)** | `core/model`, `features/scalper/modelMode.ts`·`modelScanner.ts` | LightGBM(±3%/120분 first-touch 대칭, 1분봉 Feature 33개 — ADR 0008) 확률 ≥ 학습 상위 1%면 진입 · 청산은 ±3% 밴드 + 익절 보류 래칫(확률 ≥ 상위 10%면 앵커 ×1.03, ADR 0009 `MODEL_TP_HOLD`) · 최장 120분(`MODEL_EXIT_SYMMETRIC`). 모드 전환은 앱 재시작 시 반영 |
| [추세](./추세/) | 보존 (롤백 경로) | `core/trend`, `features/scalper/trendMode.ts` | 5분봉 SMA 4선 순수 상태기계(2026-08-21). 2026-08-22 모델로 교체, `MODEL_MODE=false` 시 복귀 |
| ±3% 단타 (문서 없음 — ADR 0006·0007) | **현행 기본 (설정 `engineMode='martingale'`, 기본값)** | `core/martingale`, `features/scalper/martingaleMode.ts` | 1분봉 정배열·5선 돌파 진입(프리·정규·애프터만) — 진행 중 봉 실시간 판정(2026-09-01, `MARTINGALE_LIVE_ENTRY`), 익절 +3% · 손절 −3% · 물타기 없음(2026-09-01), 19:55 ET 마감 청산. 모델 전환은 설정 엔진 모드(ADR 0008, 앱 재시작 반영) |
| [그리드](./그리드/) | **현행 (포지션 규칙)** | `core/grid`(OCO 매도그리드), `core/conditional`(조건부 그리드) | 평단±폭 물타기·익절, 비대칭 폭, 고정 수량 물타기, 급락 방어 앵커 |
| [매매](./매매/) | **현행 (체결 실행)** | `core/execution`, `core/reprice` | 현재가 추격 지정가·정정, 취소선은 판단이 주입, 매도 리프라이스 |
| [오토파일럿](./오토파일럿/) | **현행 (조율자)** | `features/scalper/autopilot*.ts`, `positionManager.ts`, `core/cycle` | SCANNING→ENTERING→HOLDING→EXITING 상태, 모드 스위치, FAULT 격리, 청산 사유 |
| [순위](./순위/) | 현행 | `core/ranking`, `features/scalper/watchlist.ts` | 트레이딩 리스트 원천(토스8·한투7) 선택, 합≤30 |
| [서킷](./서킷/) | 관측 단계 (`CIRCUIT_MODE=false`) | `core/circuit`, `features/scalper/circuitMode.ts` | LULD 정지 감지, 하킷 2연속 재개 단일가 매도(예정) |
| [켈리](./켈리/) | 현행 (참고 지표) | `core/kelly` | 실거래 승률·손익비로 포지션 사이징 제안 |
| [기울기](./기울기/) | 현행 (표시 지표) | `features/scalper/slopeRate.ts`, `tickRate.ts` | 기울기/10초·틱/초 — 매매 판정엔 안 쓰임 |
| [설정](./설정/) | 현행 | `lib/appSettings.ts` | 옵션별 의미와 반영 경로 |
| [사다리](./사다리/) | 보존 (롤백 경로) | `core/ladder` | 홀 카운트 진입 감지기. `TREND_MODE=false` 시 진입 감지 |
| [변곡점](./변곡점/) | 보존 (롤백 경로) | `core/detector`, `core/resample` | SG 기울기 부호 전환, 리샘플 청크, BUY 게이트. 2026-08-18 추세로 교체 |
| [surge-stock-finder](./surge-stock-finder/) | **폐기 (2026-08-14)** | (삭제됨, `bceb9cc`) | 급등주 찾기 — 후속은 순위 도메인 |

## 3. 도메인이 아닌 것 (다른 곳에 있음)

- 기업 탭(AI 요약) → `docs/features/2026-08-19_기업-탭-AI-요약.md`
- 대화(사용 설명서·챗봇, 옛 이름 "도움말") → `docs/features/2026-08-21_대화-챗봇.md` (설명서 본문은 `features/help/appManual.ts`가 정본)
- 로고 조회 → `docs/development/2026-08-01_로고-도메인-plan.md` (이름만 "도메인", 인프라 성격)
- 접근 제어·둘러보기 → `docs/development/2026-08-12_계좌없이-둘러보기-앱심사대비-plan.md`
- 거래 기록·분석 CSV → `docs/분석/`
- KIS/토스 API 자체 → `docs/koreainvestment/`, `docs/toss/`

## 4. 판단 → 포지션 → 실행 계층

```
신호(언제)      : 모델 (롤백: 추세 → 사다리/변곡점)
포지션(얼마·조건): 그리드 (조건부 그리드 = 신호 왔을 때만 문턱 판정)
실행(체결까지)   : 매매 (추격 지정가·정정·리프라이스)
조율(전체)      : 오토파일럿 (상태·동시 종목·모드 스위치·FAULT·청산 사유)
예외            : 서킷 (정지 종목은 시간축 규칙이 안 돎)
```
