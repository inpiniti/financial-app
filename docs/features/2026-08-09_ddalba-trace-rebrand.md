# 기능: Ddalba Trace 리브랜딩 — 로고(딸기+바나나) 제작 + 앱명 변경

> 2026-08-09 · 분류: **소형** — 에셋 추가 + 설정/문구 변경으로 파일 몇 개로 끝남 (설계 변경 없음)

## 왜

- 사용자가 첨부한 딸기(씨앗)+바나나 실루엣 이미지를 앱 로고로 채택.
- 색상은 앱 포인트 컬러 `#3182f6`(자동 단타 시작하기 버튼 등), 배경은 투명.
- 앱명을 "단타" → **Ddalba Trace**로 변경. 홈 상단바 타이틀은 대문자 "DDALBA TRACE" 표기.

## 작업

| 단계 | 작업 | 사용 스킬 | 에이전트 모델 (effort) | 완료 기준 |
|---|---|---|---|---|
| L-0 | `assets/logo.svg` 제작 — 딸기 실루엣(#3182f6) + 투명 씨앗 + 투명 바나나 크레센트(블루 아웃라인), 투명 배경 | — | **예외: 세션 직접** — 첨부 이미지가 이 세션 컨텍스트에만 존재해 에이전트에 전달 불가 | logo.svg가 투명 배경 + #3182f6 단색 |
| L-1 | logo.svg → PNG 세트 재생성: icon 1024(흰 배경), splash-icon 1024, favicon 48, android foreground 512(66% 세이프존), background 512(흰색), monochrome 432(흰 실루엣) — sharp는 스크래치패드에 설치 | — | Sonnet (medium, thinking O) | assets/*.png 6종이 기존과 동일 해상도로 교체됨 |
| L-2 (L-1과 병렬) | 앱명 변경: `app.json` name → "Ddalba Trace" (slug·scheme·package는 EAS 연결 유지 위해 불변), `app/home.tsx` 상단바 타이틀 "단타" → "DDALBA TRACE" | — | Haiku (low, thinking X) | app.json name과 홈 타이틀이 변경, slug는 financial-app 유지 |

- 순서: `L-0 → (L-1 ∥ L-2)`

## 완료 기준

- 투명 배경 SVG 로고 + expo 아이콘 PNG 세트 전부 새 로고로 교체.
- expo 설정 앱명 = Ddalba Trace, 홈 화면 첫 타이틀 = DDALBA TRACE.
- 주의: 앱 아이콘·설치 앱명은 네이티브 리소스라 **eas update(OTA)로는 반영 안 됨** — 새 빌드 필요. 홈 타이틀 문구는 OTA로 반영 가능.
