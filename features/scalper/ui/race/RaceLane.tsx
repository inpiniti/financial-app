import { memo, useEffect, useRef, useState } from 'react';
import { Animated, Easing, Text, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, Line, Path, Polygon, Rect } from 'react-native-svg';
import { formatSignedPercentFromRatio } from '../../../../lib/format';
import { formatPrice } from '../format';
import { HapticFeedback } from '../../../../lib/haptics';
import type { AutoPilotGridView } from '../../autopilot';
import type { GridLiveSample } from '../../autopilotManager';
import {
  calcRaceProgress,
  FINISH_LINE_POS,
  SCALE_IN_POS,
  START_LINE_POS,
  type TensionZone,
} from './raceMath';

const LANE_HEIGHT = 46;
const RACER_WIDTH = 34;

const ZONE_CONFIG: Record<
  TensionZone,
  { label: string; badgeBg: string; badgeFg: string; glow: string }
> = {
  idle: { label: '대기', badgeBg: '#f2f4f6', badgeFg: '#8b95a1', glow: 'transparent' },
  cruise: { label: '순항', badgeBg: '#eaf2ff', badgeFg: '#3182f6', glow: 'rgba(49, 130, 246, 0.15)' },
  nitro: { label: '가속 ⚡', badgeBg: '#fff4e5', badgeFg: '#ff9500', glow: 'rgba(255, 149, 0, 0.25)' },
  reach: { label: '골인 임박 🔥', badgeBg: '#feeaea', badgeFg: '#f04452', glow: 'rgba(240, 68, 82, 0.35)' },
  goal: { label: 'GOAL 🏆', badgeBg: '#ffd700', badgeFg: '#854d0e', glow: 'rgba(255, 215, 0, 0.5)' },
  danger: { label: '물타기 장전 🛡️', badgeBg: '#f3e8ff', badgeFg: '#7e22ce', glow: 'rgba(126, 34, 206, 0.2)' },
};

interface RaceLaneProps {
  laneIndex: number;
  grid: AutoPilotGridView;
  name?: string;
  getLive?: () => GridLiveSample | null;
  onGoal?: (ticker: string) => void;
}

export const RaceLane = memo(function RaceLane({
  laneIndex,
  grid,
  name,
  getLive,
  onGoal,
}: RaceLaneProps) {
  const [trackWidth, setTrackWidth] = useState(0);
  const onTrackLayout = (e: LayoutChangeEvent) => setTrackWidth(e.nativeEvent.layout.width);

  // 라이브 샘플(250ms) 폴링
  const getLiveRef = useRef(getLive);
  getLiveRef.current = getLive;
  const [live, setLive] = useState<GridLiveSample | null>(null);

  useEffect(() => {
    if (!getLiveRef.current) return;
    setLive(getLiveRef.current?.() ?? null);
    const timer = setInterval(() => setLive(getLiveRef.current?.() ?? null), 250);
    return () => clearInterval(timer);
  }, []);

  const currentPrice = live?.currentPrice ?? grid.currentPrice;
  const avgPrice = live?.avgPrice ?? grid.avgPrice;

  // 레이스 진행도 및 구간 계산
  const race = calcRaceProgress(currentPrice, avgPrice);
  const prevZone = useRef<TensionZone>(race.zone);

  // 긴장감 진입 시 햅틱 피드백
  useEffect(() => {
    if (race.zone !== prevZone.current) {
      if (race.zone === 'reach') {
        HapticFeedback.reach();
      } else if (race.zone === 'nitro') {
        HapticFeedback.nitro();
      } else if (race.zone === 'goal') {
        HapticFeedback.goal();
        onGoal?.(grid.ticker);
      }
      prevZone.current = race.zone;
    }
  }, [race.zone, grid.ticker, onGoal]);

  // 주자 위치 애니메이션 (translateX)
  const targetX = trackWidth > 0 ? race.trackPos * (trackWidth - RACER_WIDTH) : 0;
  const racerX = useRef(new Animated.Value(0)).current;
  const initialized = useRef(false);

  useEffect(() => {
    if (trackWidth <= 0) return;
    if (!initialized.current) {
      initialized.current = true;
      racerX.setValue(targetX);
      return;
    }
    Animated.timing(racerX, {
      toValue: targetX,
      duration: 250,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [targetX, trackWidth, racerX]);

  // 리치 구간 심장박동 펄스 애니메이션
  const pulseAnim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (race.zone === 'reach') {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.15,
            duration: 350,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1.0,
            duration: 350,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ]),
      );
      loop.start();
      return () => loop.stop();
    } else {
      pulseAnim.setValue(1);
    }
  }, [race.zone, pulseAnim]);

  const zoneMeta = ZONE_CONFIG[race.zone];
  const startX = trackWidth * START_LINE_POS;
  const finishX = trackWidth * FINISH_LINE_POS;
  const scaleInX = trackWidth * SCALE_IN_POS;

  return (
    <View
      className="mb-3 overflow-hidden rounded-2xl border border-[#e5e8eb] bg-white p-3.5 shadow-sm"
      style={{
        backgroundColor: race.zone === 'reach' ? '#fffaf8' : '#ffffff',
        borderColor: race.zone === 'reach' ? '#fca5a5' : '#e5e8eb',
      }}
    >
      {/* 레인 상단: 종목 정보 + 수익률 + 긴장도 배지 */}
      <View className="mb-2.5 flex-row items-center justify-between">
        <View className="flex-row items-center" style={{ gap: 8 }}>
          <View className="rounded-md bg-[#191f28] px-2 py-0.5">
            <Text className="text-[11px] font-bold text-white">LANE {laneIndex + 1}</Text>
          </View>
          <Text className="text-sm font-bold text-[#191f28]">
            {name ? `${name} (${grid.ticker})` : grid.ticker}
          </Text>
          <Text className="text-xs text-[#8b95a1]">{formatPrice(currentPrice)}</Text>
        </View>

        <View className="flex-row items-center" style={{ gap: 6 }}>
          <Text
            className="text-xs font-bold"
            style={{ color: race.pnlRatio >= 0 ? '#f04452' : '#3182f6' }}
          >
            {formatSignedPercentFromRatio(race.pnlRatio, 2)}
          </Text>
          <View
            className="rounded-full px-2 py-0.5"
            style={{ backgroundColor: zoneMeta.badgeBg }}
          >
            <Text className="text-[10px] font-semibold" style={{ color: zoneMeta.badgeFg }}>
              {zoneMeta.label}
            </Text>
          </View>
        </View>
      </View>

      {/* 레이싱 트랙 영역 */}
      <View
        onLayout={onTrackLayout}
        className="relative justify-center rounded-xl bg-[#f8fafc] px-2"
        style={{ height: LANE_HEIGHT }}
      >
        {trackWidth > 0 && (
          <Svg width={trackWidth} height={LANE_HEIGHT} style={{ position: 'absolute' }}>
            {/* 메인 아스팔트 트랙 레일 */}
            <Line
              x1={0}
              y1={LANE_HEIGHT / 2}
              x2={trackWidth}
              y2={LANE_HEIGHT / 2}
              stroke="#e2e8f0"
              strokeWidth={8}
              strokeLinecap="round"
            />
            {/* 위험/물타기 구간 (-3% ~ 0%) 보라/회색 점선 */}
            <Line
              x1={scaleInX}
              y1={LANE_HEIGHT / 2}
              x2={startX}
              y2={LANE_HEIGHT / 2}
              stroke="#cbd5e1"
              strokeWidth={6}
              strokeDasharray="4 3"
            />
            {/* 득점 질주 구간 (0% ~ +3%) 그린/블루 실선 */}
            <Line
              x1={startX}
              y1={LANE_HEIGHT / 2}
              x2={finishX}
              y2={LANE_HEIGHT / 2}
              stroke="#93c5fd"
              strokeWidth={6}
            />

            {/* 물타기 피트스탑 마커 (0%) */}
            <Rect
              x={scaleInX}
              y={LANE_HEIGHT / 2 - 10}
              width={3}
              height={20}
              fill="#9333ea"
              rx={1.5}
            />

            {/* 출발선 마커 (평단가 25%) */}
            <Line
              x1={startX}
              y1={LANE_HEIGHT / 2 - 12}
              x2={startX}
              y2={LANE_HEIGHT / 2 + 12}
              stroke="#3182f6"
              strokeWidth={3}
            />

            {/* 결승선 체커 플래그 패턴 (100%) */}
            <Rect
              x={trackWidth - 8}
              y={LANE_HEIGHT / 2 - 14}
              width={6}
              height={28}
              fill="#f59e0b"
              rx={2}
            />
            <Rect
              x={trackWidth - 8}
              y={LANE_HEIGHT / 2 - 14}
              width={3}
              height={7}
              fill="#1e293b"
            />
            <Rect
              x={trackWidth - 5}
              y={LANE_HEIGHT / 2 - 7}
              width={3}
              height={7}
              fill="#1e293b"
            />
            <Rect
              x={trackWidth - 8}
              y={LANE_HEIGHT / 2}
              width={3}
              height={7}
              fill="#1e293b"
            />
            <Rect
              x={trackWidth - 5}
              y={LANE_HEIGHT / 2 + 7}
              width={3}
              height={7}
              fill="#1e293b"
            />
          </Svg>
        )}

        {/* 달리는 주자 (레이서 차량 & 부스터 화염) */}
        {trackWidth > 0 && (
          <Animated.View
            style={{
              position: 'absolute',
              left: 0,
              width: RACER_WIDTH,
              height: LANE_HEIGHT,
              justifyContent: 'center',
              alignItems: 'center',
              transform: [{ translateX: racerX }, { scale: pulseAnim }],
            }}
          >
            {/* 니트로/리치 상태일 때 후방 부스터 화염 */}
            {(race.zone === 'nitro' || race.zone === 'reach' || race.zone === 'goal') && (
              <View style={{ position: 'absolute', left: -14, top: LANE_HEIGHT / 2 - 6 }}>
                <Svg width={16} height={12}>
                  <Polygon
                    points="16,6 0,1 4,6 0,11"
                    fill={race.zone === 'reach' ? '#f04452' : '#f59e0b'}
                  />
                  <Polygon points="16,6 4,3 8,6 4,9" fill="#fef08a" />
                </Svg>
              </View>
            )}

            {/* 레이서 비히클 SVG (공기역학 레이싱카) */}
            <Svg width={30} height={20} viewBox="0 0 30 20">
              {/* 차체 글로우 */}
              {race.zone === 'reach' && (
                <Circle cx={15} cy={10} r={9} fill="rgba(240, 68, 82, 0.4)" />
              )}
              {/* 바디 메인 */}
              <Path
                d="M3 13 L8 7 L20 7 L27 10 L28 14 L2 14 Z"
                fill={race.zone === 'reach' ? '#ef4444' : race.zone === 'nitro' ? '#f59e0b' : '#2563eb'}
              />
              {/* 윈드실드 유리창 */}
              <Polygon points="9,8 14,8 16,11 8,11" fill="#e0f2fe" />
              {/* 바퀴 전/후륜 */}
              <Circle cx={8} cy={14} r={3.5} fill="#1e293b" />
              <Circle cx={8} cy={14} r={1.5} fill="#94a3b8" />
              <Circle cx={22} cy={14} r={3.5} fill="#1e293b" />
              <Circle cx={22} cy={14} r={1.5} fill="#94a3b8" />
              {/* 번호판 */}
              <Rect x={11} y={11} width={6} height={3} fill="#ffffff" rx={1} />
            </Svg>
          </Animated.View>
        )}
      </View>

      {/* 트랙 하단 라벨 (물타기 피트스탑 · 출발 평단 · 결승 골인) */}
      <View className="mt-1 flex-row items-center justify-between px-1">
        <Text className="text-[10px] text-[#9333ea]">물타기 (−3%)</Text>
        <Text className="text-[10px] text-[#3182f6]">출발(평단 0%)</Text>
        <Text className="text-[10px] font-bold text-[#f59e0b]">
          {race.remainingPct > 0 ? `골인까지 −${race.remainingPct}%` : '골인 달성! 🏁'}
        </Text>
      </View>
    </View>
  );
});
