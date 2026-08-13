// useSurgeEvents — 급등/급락 신호 에피소드 구독 훅 (docs/domain/surge-stock-finder 훅 문서).
//
// 훅은 "창문"이다 — 감지·Supabase 기록은 매니저(SurgeRecorder, 모듈 싱글턴)가 화면과 무관하게
// 계속 하고, 이 훅은 그 결과를 비추기만 한다. 여기서 Supabase를 부르거나 감지 상태를 바꾸지 않는다.
// 마운트 시 recentSurgeEpisodes 스냅샷으로 시작하므로 탭 전환으로 놓친 신호도 재수화된다.
import { useEffect, useState } from 'react';
import type { AutoPilotManager } from '../autopilotManager';
import type { SurgeEpisodeView } from '../surgeRecorder';

export function useSurgeEvents(autopilot: AutoPilotManager): readonly SurgeEpisodeView[] {
  const [episodes, setEpisodes] = useState<readonly SurgeEpisodeView[]>(() => autopilot.recentSurgeEpisodes);
  useEffect(() => autopilot.subscribeSurge(setEpisodes), [autopilot]);
  return episodes;
}
