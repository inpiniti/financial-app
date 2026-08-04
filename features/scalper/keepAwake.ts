// expo-keep-awake 얇은 래퍼 — 인스턴스 1개 이상 실행 중이면 화면을 켠 채로 둔다(PRD §9-5).
// expo 의존은 이 파일에만 격리한다(vitest node에서 import하지 않도록). 매니저는 KeepAwakeControl 인터페이스로만 의존.
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import type { KeepAwakeControl } from './types';

const KEEP_AWAKE_TAG = 'scalper';

export const expoKeepAwake: KeepAwakeControl = {
  activate() {
    void activateKeepAwakeAsync(KEEP_AWAKE_TAG);
  },
  deactivate() {
    void deactivateKeepAwake(KEEP_AWAKE_TAG);
  },
};
