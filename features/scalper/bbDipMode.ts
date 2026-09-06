// features/scalper/bbDipMode.ts — 볼린저 하단 투매 반등(BB Dip Snapback) 단타 모드 단일 스위치
//
// 세 층이 같은 상수 하나를 읽는다 —
//   · autopilotManager: 슬롯을 이 모드로 만든다.
//   · feedSlot: 틱마다 볼린저 밴드와 s10 기울기, 틱속도, 체결강도를 재서 바닥 반등에서 BUY를 낸다.
//   · autopilot/positionManager: 미보유 BUY → 진입, 보유 중 MA20 중심선 도달 / +1.2% 익절 / 트레일링 / -0.8% 손절.
// 실제 활성화는 이 상수 AND 매니저의 `bbDip` 주입(설정 engineMode='bbDip').
// false로 두면 설정과 무관하게 이 모드는 주입되지 않는다(엔진 모드 킬스위치 규약).
export const BBDIP_MODE = true;
