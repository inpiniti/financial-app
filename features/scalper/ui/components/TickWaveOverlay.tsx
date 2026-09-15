import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Animated, Easing, View, type LayoutChangeEvent } from 'react-native';
import type { ScalperManager } from '../../scalperManager';
import { getTickDirection, type TickDirection } from './animatedPriceMath';
import {
  calculateWaveTranslateRange,
  DEFAULT_THROTTLE_MS,
  DEFAULT_WAVE_DURATION_MS,
  DEFAULT_WAVE_WIDTH,
  getNextPoolIndex,
  getWaveColors,
  shouldThrottleTick,
  WAVE_COLORS,
  WAVE_POOL_SIZE,
  type WaveColorScheme,
} from './tickWaveMath';

interface WaveSlotHandle {
  trigger: (direction: TickDirection, rowWidth: number) => void;
}

/**
 * 재사용 가능한 단일 웨이브 슬롯 컴포넌트.
 * 고정된 Animated.View 안에서 GPU 가속(Native Driver)으로만 위치/투명도를 이동시킨다.
 */
const WaveSlot = memo(
  forwardRef<WaveSlotHandle, object>(function WaveSlot(_props, ref) {
    const [colors, setColors] = useState<WaveColorScheme>(WAVE_COLORS.same);
    const animX = useRef(new Animated.Value(-DEFAULT_WAVE_WIDTH)).current;
    const opacity = useRef(new Animated.Value(0)).current;
    const activeAnimRef = useRef<Animated.CompositeAnimation | null>(null);

    useImperativeHandle(
      ref,
      () => ({
        trigger(direction: TickDirection, rowWidth: number) {
          const nextColors = getWaveColors(direction);
          setColors(nextColors);

          const { fromX, toX } = calculateWaveTranslateRange(rowWidth, DEFAULT_WAVE_WIDTH);

          // 진행 중인 애니메이션이 있다면 즉시 정지하고 리셋
          if (activeAnimRef.current) {
            activeAnimRef.current.stop();
          }

          animX.setValue(fromX);
          opacity.setValue(1);

          const anim = Animated.parallel([
            Animated.timing(animX, {
              toValue: toX,
              duration: DEFAULT_WAVE_DURATION_MS,
              easing: Easing.out(Easing.cubic),
              useNativeDriver: true,
            }),
            Animated.timing(opacity, {
              toValue: 0,
              duration: DEFAULT_WAVE_DURATION_MS,
              easing: Easing.in(Easing.quad),
              useNativeDriver: true,
            }),
          ]);

          activeAnimRef.current = anim;
          anim.start(() => {
            activeAnimRef.current = null;
          });
        },
      }),
      [animX, opacity],
    );

    return (
      <Animated.View
        pointerEvents="none"
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 0,
          width: DEFAULT_WAVE_WIDTH,
          opacity,
          transform: [{ translateX: animX }],
        }}
      >
        {/* 웨이브 바디: 왼쪽 투명 → 오른쪽으로 은은하게 퍼지는 그라데이션 광채 + 앞머리 크레스트 라인 */}
        <View style={{ flex: 1, flexDirection: 'row' }}>
          <View style={{ flex: 1, backgroundColor: 'transparent' }} />
          <View
            style={{
              width: 90,
              backgroundColor: colors.primary,
              borderTopRightRadius: 6,
              borderBottomRightRadius: 6,
            }}
          />
          {/* 웨이브 선두 빛줄기 (Leading Edge) */}
          <View
            style={{
              width: 2.5,
              backgroundColor: colors.accent,
            }}
          />
        </View>
      </Animated.View>
    );
  }),
);

export interface TickWaveOverlayProps {
  ticker: string;
  manager: ScalperManager;
  isVisible: boolean;
  enabled?: boolean;
}

/**
 * 트레이딩 리스트 행 배경에 배치되는 0-GC 수신 틱 웨이브 오버레이.
 *
 * 1. 고정 인스턴스 풀(3개) 순환 재사용으로 메모리 생성/해제 0%
 * 2. 화면에 보이는 아이템(isVisible=true)만 웹소켓 틱을 구독하여 O(1) 격리
 * 3. 80ms 스로틀링으로 초당 수십 건 폭주 시 JS 스레드 완전 보호
 */
export const TickWaveOverlay = memo(function TickWaveOverlay({
  ticker,
  manager,
  isVisible,
  enabled = true,
}: TickWaveOverlayProps) {
  const [rowWidth, setRowWidth] = useState(0);
  const rowWidthRef = useRef(0);
  rowWidthRef.current = rowWidth;

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    setRowWidth(w);
    rowWidthRef.current = w;
  }, []);

  const slot0Ref = useRef<WaveSlotHandle>(null);
  const slot1Ref = useRef<WaveSlotHandle>(null);
  const slot2Ref = useRef<WaveSlotHandle>(null);

  const prevPriceRef = useRef<number | null>(null);
  const lastTriggerTsRef = useRef<number>(0);
  const poolIndexRef = useRef<number>(0);

  useEffect(() => {
    // 비활성화 상태이거나 화면 밖(Off-screen)이면 구독 자체를 걸지 않아 CPU 점유 0%
    if (!enabled || !isVisible) {
      return;
    }

    const unsubscribe = manager.subscribeFeedData(ticker, {
      onTick: (price: number) => {
        const now = Date.now();
        if (shouldThrottleTick(now, lastTriggerTsRef.current, DEFAULT_THROTTLE_MS)) {
          return;
        }
        lastTriggerTsRef.current = now;

        const currentWidth = rowWidthRef.current;
        if (currentWidth <= 0) return;

        const dir = getTickDirection(prevPriceRef.current, price);
        prevPriceRef.current = price;

        const currentSlotIdx = poolIndexRef.current;
        poolIndexRef.current = getNextPoolIndex(currentSlotIdx, WAVE_POOL_SIZE);

        if (currentSlotIdx === 0) {
          slot0Ref.current?.trigger(dir, currentWidth);
        } else if (currentSlotIdx === 1) {
          slot1Ref.current?.trigger(dir, currentWidth);
        } else {
          slot2Ref.current?.trigger(dir, currentWidth);
        }
      },
    });

    return () => {
      unsubscribe();
    };
  }, [ticker, manager, isVisible, enabled]);

  return (
    <View
      onLayout={onLayout}
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
        overflow: 'hidden',
      }}
    >
      <WaveSlot ref={slot0Ref} />
      <WaveSlot ref={slot1Ref} />
      <WaveSlot ref={slot2Ref} />
    </View>
  );
});
