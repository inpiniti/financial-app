import { memo, useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { formatPrice } from '../format';
import { getTickDirection } from './animatedPriceMath';

interface AnimatedPriceProps {
  value: number | null;
  className?: string;
  style?: StyleProp<TextStyle>;
  containerStyle?: StyleProp<ViewStyle>;
  /** 플래시 지속 시간 (ms, 기본값 350ms) */
  duration?: number;
  /** 화면 가시 여부 — false이면 애니메이션 실행을 생략하여 CPU/배터리 0% 유지 */
  isVisible?: boolean;
}

const UP_FLASH = 'rgba(240, 68, 82, 0.22)'; // 상승 틱 은은한 빨강
const DOWN_FLASH = 'rgba(49, 130, 246, 0.22)'; // 하강 틱 은은한 파랑

export const AnimatedPrice = memo(function AnimatedPrice({
  value,
  className = 'text-base font-bold text-[#191f28]',
  style,
  containerStyle,
  duration = 350,
  isVisible = true,
}: AnimatedPriceProps) {
  const prevPriceRef = useRef<number | null>(value);

  // 틱 플래시 배경 페이드아웃 애니메이션 (opacity만 변경하여 100% GPU 네이티브 가속)
  const flashAnim = useRef(new Animated.Value(0)).current;
  const [flashColor, setFlashColor] = useState<string>('transparent');

  useEffect(() => {
    const prev = prevPriceRef.current;
    prevPriceRef.current = value;

    if (value === null || prev === null || prev === value) {
      return;
    }

    // 화면 밖이거나 비가시 상태이면 애니메이션 생략 (배터리 보호)
    if (!isVisible) {
      return;
    }

    // 1. 틱 방향에 따른 플래시 색상 설정
    const dir = getTickDirection(prev, value);
    if (dir === 'up') {
      setFlashColor(UP_FLASH);
    } else if (dir === 'down') {
      setFlashColor(DOWN_FLASH);
    } else {
      return;
    }

    // 2. 100% Native Driver 가속 페이드아웃 (JS 스레드 0% 점유)
    flashAnim.setValue(1);
    Animated.timing(flashAnim, {
      toValue: 0,
      duration: Math.max(250, duration),
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [value, duration, flashAnim, isVisible]);

  return (
    <View
      style={[
        {
          borderRadius: 4,
          paddingHorizontal: 3,
          paddingVertical: 1,
          overflow: 'hidden',
          position: 'relative',
        },
        containerStyle,
      ]}
    >
      {/* 100% GPU 가속 네이티브 페이드아웃 오버레이 (opacity 애니메이션) */}
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFillObject,
          {
            backgroundColor: flashColor,
            opacity: flashAnim,
            borderRadius: 4,
          },
        ]}
      />
      <Text className={className} style={[{ fontVariant: ['tabular-nums'] }, style]}>
        {formatPrice(value)}
      </Text>
    </View>
  );
});
