import { memo, useEffect, useRef } from 'react';
import { Animated, Easing, Text, View } from 'react-native';
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';
import { formatPrice } from '../format';
import type { AutoPilotSlotRow } from '../../autopilotManager';
import { calcStartingGateRpm } from './raceMath';

interface StartingGateProps {
  candidates: readonly AutoPilotSlotRow[];
}

export const StartingGate = memo(function StartingGate({ candidates }: StartingGateProps) {
  // 상위 3개 후보 종목 슬롯
  const displaySlots = candidates.slice(0, 3);

  // 게이트 진동 애니메이션 (RPM이 높을 때 엔진 떨림)
  const shakeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(shakeAnim, { toValue: 1.5, duration: 60, easing: Easing.linear, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: -1.5, duration: 60, easing: Easing.linear, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: 0, duration: 60, easing: Easing.linear, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [shakeAnim]);

  if (displaySlots.length === 0) {
    return (
      <View className="items-center justify-center rounded-2xl border border-dashed border-[#e5e8eb] bg-[#f8fafc] py-6">
        <Text className="text-xs font-semibold text-[#8b95a1]">
          출발대 대기 중인 후보 종목을 탐색하고 있어요...
        </Text>
      </View>
    );
  }

  return (
    <View className="rounded-2xl border border-[#e5e8eb] bg-[#1e293b] p-3.5 shadow-sm">
      {/* 게이트 헤더 */}
      <View className="mb-3 flex-row items-center justify-between border-b border-[#334155] pb-2">
        <View className="flex-row items-center" style={{ gap: 6 }}>
          <View className="rounded bg-[#ef4444] px-1.5 py-0.5">
            <Text className="text-[10px] font-black text-white">STARTING GATE</Text>
          </View>
          <Text className="text-xs font-bold text-white">출격 대기선 (REV-UP)</Text>
        </View>
        <Text className="text-[11px] text-[#94a3b8]">5선 상향 돌파 시 즉시 발진</Text>
      </View>

      {/* 출발대 마구간 (Stalls) 1열~3열 */}
      <View style={{ gap: 8 }}>
        {displaySlots.map((slot, index) => {
          const { ticker, name } = slot.entry;
          const currentPrice = slot.view.price;
          const ma5 = slot.view.realtimeMa5?.ma5 ?? slot.view.martingaleLive?.ma5 ?? null;
          const tickRate = slot.view.tickRate ?? 0;
          const slopeRate = slot.view.slopeRate ?? null;
          const rpm = calcStartingGateRpm(currentPrice, ma5, tickRate, slopeRate);
          const isHighRpm = rpm >= 70;

          return (
            <Animated.View
              key={ticker}
              style={{
                transform: [{ translateX: isHighRpm ? shakeAnim : 0 }],
              }}
              className="flex-row items-center justify-between rounded-xl bg-[#0f172a] p-2.5"
            >
              {/* 마구간 게이트 번호 및 종목명 */}
              <View className="flex-row items-center" style={{ gap: 8 }}>
                <View
                  className="h-7 w-7 items-center justify-center rounded-lg"
                  style={{ backgroundColor: index === 0 ? '#f59e0b' : '#334155' }}
                >
                  <Text className="text-xs font-black text-white">#{index + 1}</Text>
                </View>
                <View>
                  <View className="flex-row items-center" style={{ gap: 4 }}>
                    <Text className="text-xs font-bold text-white">{name ?? ticker}</Text>
                    {name && <Text className="text-[10px] text-[#64748b]">{ticker}</Text>}
                  </View>
                  <Text className="text-[11px] text-[#94a3b8]">
                    {formatPrice(currentPrice)} {ma5 ? `· 5선 ${formatPrice(ma5)}` : ''}
                  </Text>
                </View>
              </View>

              {/* RPM 타코미터 바 & 상태 */}
              <View className="items-end" style={{ width: 110 }}>
                <View className="mb-1 flex-row items-center" style={{ gap: 4 }}>
                  <Text
                    className="text-[10px] font-black"
                    style={{ color: isHighRpm ? '#ef4444' : '#38bdf8' }}
                  >
                    {isHighRpm ? '돌파 임박 🔥' : '예열 중'}
                  </Text>
                  <Text className="text-[10px] font-bold text-white">{rpm}% RPM</Text>
                </View>

                {/* 게이지 바 */}
                <View className="h-2 w-full overflow-hidden rounded-full bg-[#334155]">
                  <View
                    className="h-full rounded-full"
                    style={{
                      width: `${rpm}%`,
                      backgroundColor: isHighRpm ? '#ef4444' : '#38bdf8',
                    }}
                  />
                </View>
              </View>
            </Animated.View>
          );
        })}
      </View>
    </View>
  );
});
