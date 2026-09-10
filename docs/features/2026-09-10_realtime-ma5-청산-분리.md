# 기능: realtimeMa5 청산 전략 분리 — 진입 전략 강제 전환 방지
> 작성일 · 분류: **소형** — 설정 정규화 버그로 청산 전략만 `realtimeMa5`여도 진입 전략까지 바뀌어 의도한 조합이 깨진다.

## 왜
- 사용자는 `5선 돌파`로 진입하면서 `실시간 MA5 익절·물타기`로 보유 포지션만 관리하려고 한다.
- 현재 저장/로드 정규화가 `realtimeMa5`를 양쪽 전략에 강제로 복사해 실제 진입 엔진이 바뀐다.

## 작업
| 단계 | 작업 | 사용 스킬 | 에이전트 모델 (effort) | 완료 기준 |
|---|---|---|---|---|
| 1 | 설정 저장/로드 정규화를 `진입=realtimeMa5`일 때만 일방향으로 적용 | diagnosing-bugs | Sonnet (medium, thinking O) | `exitStrategy='realtimeMa5'` 단독 저장 시 `entryStrategy`가 유지된다 |
| 2 | 설정 화면도 같은 규칙으로 저장하도록 맞춘다 | diagnosing-bugs | Sonnet (medium, thinking O) | 화면 저장 후 재실행해도 `5선 돌파 진입 + realtimeMa5 청산` 조합이 유지된다 |
| 3 | 회귀 테스트 추가 | diagnosing-bugs | Sonnet (medium, thinking O) | 관련 단위 테스트가 red→green으로 통과한다 |

## 완료 기준
- `realtimeMa5`를 청산 전략에만 둬도 진입 전략은 유지된다.
- `entryStrategy='realtimeMa5'`일 때만 청산 전략이 함께 `realtimeMa5`로 맞춰진다.