import { memo, useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { AutoPilotView } from '../../autopilot';
import type { AutoPilotSlotRow, GridLiveSample } from '../../autopilotManager';
import { GoalCelebrationOverlay } from './GoalCelebrationOverlay';
import { RaceLane } from './RaceLane';
import { StartingGate } from './StartingGate';

interface LiveRaceTrackCardProps {
  view: AutoPilotView;
  slotRows: readonly AutoPilotSlotRow[];
  getLiveByTicker?: (ticker: string) => GridLiveSample | null;
}

export const LiveRaceTrackCard = memo(function LiveRaceTrackCard({
  view,
  slotRows,
  getLiveByTicker,
}: LiveRaceTrackCardProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [celebrationTicker, setCelebrationTicker] = useState<string | null>(null);

  const activeGrids = view.grids.filter((g) => view.activeTickers.includes(g.ticker));
  const hasActiveStocks = activeGrids.length > 0;

  const handleGoal = useCallback((ticker: string) => {
    setCelebrationTicker(ticker);
  }, []);

  const handleDismissCelebration = useCallback(() => {
    setCelebrationTicker(null);
  }, []);

  return (
    <View className="bg-white" style={{ marginBottom: 8 }}>
      {/* 카드 상단 헤더: 스타디움 타이틀 + 실시간 중계 상태 + 접기/펼치기 토글 */}
      <Pressable
        onPress={() => setIsExpanded((prev) => !prev)}
        className="flex-row items-center justify-between px-5 py-3.5 active:bg-[#f8fafc]"
      >
        <View className="flex-row items-center" style={{ gap: 8 }}>
          <View className="h-8 w-8 items-center justify-center rounded-xl bg-[#1e293b]">
            <Text style={{ fontSize: 16 }}>🏁</Text>
          </View>
          <View>
            <View className="flex-row items-center" style={{ gap: 6 }}>
              <Text className="text-sm font-bold text-[#191f28]">라이브 레이스 스타디움</Text>
              <View
                className="rounded-full px-2 py-0.5"
                style={{
                  backgroundColor: hasActiveStocks ? '#eaf2ff' : '#f2f4f6',
                }}
              >
                <Text
                  className="text-[10px] font-bold"
                  style={{ color: hasActiveStocks ? '#3182f6' : '#8b95a1' }}
                >
                  {hasActiveStocks ? `${activeGrids.length}마 질주 중 🏇` : '출발선 대기 중'}
                </Text>
              </View>
            </View>
            <Text className="text-[11px] text-[#8b95a1]">
              {hasActiveStocks
                ? '목표가(+3%) 결승선을 향해 실시간 주행 중'
                : '5선 돌파 후보 종목들이 출발 게이트에 대기하고 있어요'}
            </Text>
          </View>
        </View>

        <View className="flex-row items-center" style={{ gap: 4 }}>
          <Text className="text-xs font-semibold text-[#8b95a1]">
            {isExpanded ? '접기' : '펼치기'}
          </Text>
          <Ionicons
            name={isExpanded ? 'chevron-up' : 'chevron-down'}
            size={16}
            color="#8b95a1"
          />
        </View>
      </Pressable>

      {/* 펼쳐진 본문 영역 */}
      {isExpanded && (
        <View className="px-4 pb-4 pt-1">
          {hasActiveStocks ? (
            <View>
              {activeGrids.map((grid, idx) => {
                const row = slotRows.find((r) => r.entry.ticker === grid.ticker);
                const name = row?.entry.name;
                const getLive = getLiveByTicker ? () => getLiveByTicker(grid.ticker) : undefined;
                return (
                  <RaceLane
                    key={grid.ticker}
                    laneIndex={idx}
                    grid={grid}
                    name={name}
                    getLive={getLive}
                    onGoal={handleGoal}
                  />
                );
              })}
            </View>
          ) : (
            <StartingGate candidates={slotRows} />
          )}
        </View>
      )}

      {/* 잭팟 축포 오버레이 */}
      <GoalCelebrationOverlay
        ticker={celebrationTicker}
        onDismiss={handleDismissCelebration}
      />
    </View>
  );
});
