import { Platform, Vibration } from 'react-native';

/**
 * 레이스 트랙 기믹 및 체결 피드백용 햅틱 진동 유틸리티.
 * 무음 모드에서도 시각 효과와 결합되어 묵직한 손맛을 제공합니다.
 */

export const HapticFeedback = {
  /** 골인/익절 잭팟 달성 시 축하 세레머니 진동 (강렬한 리듬 버스트) */
  goal: () => {
    try {
      if (Platform.OS === 'android') {
        Vibration.vibrate([0, 100, 60, 150, 60, 250]);
      } else {
        Vibration.vibrate();
      }
    } catch {
      // 무시
    }
  },

  /** 매수 체결 및 출발대(Starting Gate) 로켓 스타트 발진 진동 */
  start: () => {
    try {
      if (Platform.OS === 'android') {
        Vibration.vibrate([0, 60, 40, 120]);
      } else {
        Vibration.vibrate();
      }
    } catch {
      // 무시
    }
  },

  /** 리치(Reach / 골인 임박 +2% 이상) 진입 시 긴장감 심장박동 진동 */
  reach: () => {
    try {
      if (Platform.OS === 'android') {
        Vibration.vibrate([0, 35, 70, 45]);
      } else {
        Vibration.vibrate();
      }
    } catch {
      // 무시
    }
  },

  /** 니트로 가속 및 미세 틱 상승 시 가벼운 펄스 */
  nitro: () => {
    try {
      if (Platform.OS === 'android') {
        Vibration.vibrate(30);
      } else {
        Vibration.vibrate();
      }
    } catch {
      // 무시
    }
  },
};
