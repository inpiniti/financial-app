import { memo, useEffect, useRef, useState } from 'react';
import { Animated, Easing, Text, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { formatPrice } from '../format';
import { getTickDirection, interpolatePrice } from './animatedPriceMath';

interface AnimatedPriceProps {
  value: number | null;
  className?: string;
  style?: StyleProp<TextStyle>;
  containerStyle?: StyleProp<ViewStyle>;
  /** 보간 지속 시간 (ms, 기본값 250ms) */
  duration?: number;
}

const UP_FLASH = 'rgba(240, 68, 82, 0.18)'; // 상승 틱 은은한 빨강
const DOWN_FLASH = 'rgba(49, 130, 246, 0.18)'; // 하강 틱 은은한 파랑

export const AnimatedPrice = memo(function AnimatedPrice({
  value,
  className = 'text-base font-bold text-[#191f28]',
  style,
  containerStyle,
  duration = 250,
}: AnimatedPriceProps) {
  const [displayPrice, setDisplayPrice] = useState<number | null>(value);
  const prevPriceRef = useRef<number | null>(value);

  // 틱 플래시 배경 페이드아웃 애니메이션
  const flashAnim = useRef(new Animated.Value(0)).current;
  const [flashColor, setFlashColor] = useState<string>('transparent');

  useEffect(() => {
    const prev = prevPriceRef.current;
    prevPriceRef.current = value;

    if (value === null || prev === null || prev === value) {
      setDisplayPrice(value);
      return;
    }

    // 1. 틱 방향에 따른 플래시 색상 설정 및 페이드아웃
    const dir = getTickDirection(prev, value);
    if (dir === 'up') {
      setFlashColor(UP_FLASH);
    } else if (dir === 'down') {
      setFlashColor(DOWN_FLASH);
    }

    flashAnim.setValue(1);
    Animated.timing(flashAnim, {
      toValue: 0,
      duration: Math.max(350, duration),
      easing: Easing.out(Easing.quad),
      useNativeDriver: false, // backgroundColor 애니메이션
    }).start();

    // 2. 가격 카운트업/다운 부드러운 보간 (requestAnimationFrame)
    const startTime = Date.now();
    let animFrame: number;

    const tick = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(1, elapsed / duration);
      const currentVal = interpolatePrice(prev, value, progress);
      setDisplayPrice(currentVal);

      if (progress < 1) {
        animFrame = requestAnimationFrame(tick);
      } else {
        setDisplayPrice(value);
      }
    };

    animFrame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animFrame);
  }, [value, duration, flashAnim]);

  const flashBg = flashAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['rgba(255, 255, 255, 0)', flashColor],
  });

  return (
    <Animated.View
      style={[
        {
          backgroundColor: flashBg,
          borderRadius: 4,
          paddingHorizontal: 3,
          paddingVertical: 1,
        },
        containerStyle,
      ]}
    >
      <Text className={className} style={[{ fontVariant: ['tabular-nums'] }, style]}>
        {formatPrice(displayPrice)}
      </Text>
    </Animated.View>
  );
});
