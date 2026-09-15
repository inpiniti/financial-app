import { memo, useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, Text, View } from 'react-native';
import Svg, { Circle, Path, Polygon, Rect } from 'react-native-svg';

interface GoalCelebrationOverlayProps {
  ticker: string | null;
  onDismiss: () => void;
}

export const GoalCelebrationOverlay = memo(function GoalCelebrationOverlay({
  ticker,
  onDismiss,
}: GoalCelebrationOverlayProps) {
  const opacityAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.7)).current;
  const bounceAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!ticker) return;

    // 등장 애니메이션 (Zoom + Fade In)
    Animated.parallel([
      Animated.timing(opacityAnim, {
        toValue: 1,
        duration: 250,
        easing: Easing.out(Easing.back(1.5)),
        useNativeDriver: true,
      }),
      Animated.timing(scaleAnim, {
        toValue: 1,
        duration: 350,
        easing: Easing.out(Easing.back(2)),
        useNativeDriver: true,
      }),
      Animated.loop(
        Animated.sequence([
          Animated.timing(bounceAnim, {
            toValue: -8,
            duration: 250,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(bounceAnim, {
            toValue: 0,
            duration: 250,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
        ]),
      ),
    ]).start();

    // 2.8초 후 자동 퇴장
    const timer = setTimeout(() => {
      Animated.timing(opacityAnim, {
        toValue: 0,
        duration: 350,
        easing: Easing.in(Easing.quad),
        useNativeDriver: true,
      }).start(() => onDismiss());
    }, 2800);

    return () => clearTimeout(timer);
  }, [ticker, opacityAnim, scaleAnim, bounceAnim, onDismiss]);

  if (!ticker) return null;

  return (
    <Pressable
      onPress={onDismiss}
      className="absolute inset-0 z-50 items-center justify-center p-5"
      style={{ backgroundColor: 'rgba(15, 23, 42, 0.75)' }}
    >
      <Animated.View
        style={{
          opacity: opacityAnim,
          transform: [{ scale: scaleAnim }, { translateY: bounceAnim }],
          alignItems: 'center',
        }}
        className="w-full max-w-sm rounded-3xl border-2 border-[#fcd34d] bg-[#1e293b] p-6 shadow-2xl"
      >
        {/* 황금 트로피 & 코인 파티클 SVG */}
        <View className="mb-4">
          <Svg width={80} height={80} viewBox="0 0 80 80">
            {/* 후광 광채 */}
            <Circle cx={40} cy={40} r={36} fill="rgba(251, 191, 36, 0.2)" />
            {/* 트로피 컵 */}
            <Path
              d="M26 22 L54 22 L50 44 C48 52 32 52 30 44 Z"
              fill="#fbbf24"
              stroke="#f59e0b"
              strokeWidth={2}
            />
            {/* 손잡이 좌우 */}
            <Path
              d="M26 26 C16 26 16 38 26 40"
              stroke="#f59e0b"
              strokeWidth={3}
              fill="none"
              strokeLinecap="round"
            />
            <Path
              d="M54 26 C64 26 64 38 54 40"
              stroke="#f59e0b"
              strokeWidth={3}
              fill="none"
              strokeLinecap="round"
            />
            {/* 트로피 기둥 및 받침 */}
            <Rect x={37} y={48} width={6} height={12} fill="#d97706" />
            <Rect x={28} y={60} width={24} height={6} fill="#f59e0b" rx={2} />
            {/* 황금 별 */}
            <Polygon points="40,26 42,32 48,32 43,36 45,42 40,38 35,42 37,36 32,32 38,32" fill="#ffffff" />
          </Svg>
        </View>

        {/* 잭팟 타이틀 & 축하 문구 */}
        <View className="mb-2 rounded-full bg-[#f59e0b] px-3 py-1">
          <Text className="text-xs font-black tracking-widest text-[#78350f]">
            FEVER JACKPOT GOAL!
          </Text>
        </View>

        <Text className="mb-1 text-2xl font-black text-white">{ticker} 목표가 돌파!</Text>
        <Text className="mb-4 text-sm font-semibold text-[#fde68a]">
          +3.0% 익절 결승선을 통과했습니다 🏁
        </Text>

        <View className="rounded-xl bg-[#0f172a] px-4 py-2">
          <Text className="text-xs text-[#94a3b8]">화면을 터치하면 바로 닫혀요</Text>
        </View>
      </Animated.View>
    </Pressable>
  );
});
