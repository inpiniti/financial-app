// 상단 고정 배너 — 인스턴스 1개 이상 실행 중이면 "화면을 켠 채로 두세요" 안내 (keep-awake 자체는 5단계 매니저가 처리).
// 카드별 numeric 값(가격 등) 변화에는 반응하지 않는다 — state 변화(전이)로만 표시 여부를 갱신해 리렌더를 최소화한다.
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import type { ScalperInstance } from '../scalperInstance';
import { isRunningState } from './format';

export interface RunningBannerProps {
  instances: ScalperInstance[];
}

export function RunningBanner({ instances }: RunningBannerProps) {
  const [anyRunning, setAnyRunning] = useState(() => instances.some((i) => isRunningState(i.state)));

  useEffect(() => {
    const recompute = () => {
      setAnyRunning((prev) => {
        const next = instances.some((i) => isRunningState(i.state));
        return prev === next ? prev : next;
      });
    };
    recompute();
    const unsubs = instances.map((i) => i.subscribe(recompute));
    return () => unsubs.forEach((u) => u());
  }, [instances]);

  if (!anyRunning) return null;

  return (
    <View className="bg-[#191f28] px-4 py-2">
      <Text className="text-center text-xs font-semibold text-white">매매 중이에요 — 화면을 켠 채로 두세요</Text>
    </View>
  );
}
