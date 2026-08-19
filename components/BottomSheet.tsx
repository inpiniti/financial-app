// 공용 바텀시트 껍데기(입력 폼 시트 — AdoptSheet 등 — 공용).
// 종목 정보성 뷰(차트/댓글/기업)는 시트가 아니라 종목 상세화면(app/stock/[ticker])으로 통일됐다.
// 올바른 UX: 딤(반투명 배경)은 제자리에서 페이드 인/아웃, 패널만 아래에서 위로 슬라이드된다.
// RN Modal의 animationType="slide"는 딤까지 함께 슬라이드시켜 어색하므로 쓰지 않는다 — 여기서는
// transparent + animationType="none"으로 Modal 자체 애니메이션을 끄고, 내부 Animated 값 2개로 직접 제어한다.
// 새 패키지 금지(react-native-reanimated 미설치) — RN 내장 Animated만 사용.
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Keyboard, Modal, Pressable, View, useWindowDimensions } from 'react-native';

export interface BottomSheetProps {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
  /** 패널 높이 비율(0~1, 화면 높이 기준). 생략 시 내용 높이만큼(하단에서부터) 자동으로 늘어난다. */
  heightRatio?: number;
}

const DIM_MS = 200;
const PANEL_MS = 260;

export function BottomSheet({ visible, onClose, children, heightRatio }: BottomSheetProps) {
  const { height: windowHeight } = useWindowDimensions();
  // 부모가 visible=false로 바꿔도 닫힘 애니메이션이 끝날 때까지는 Modal을 화면에 남겨야 한다(지연 unmount).
  // 그래서 실제 Modal 마운트 여부는 이 내부 상태로 제어하고, 부모의 visible은 애니메이션 방향만 결정한다.
  const [mounted, setMounted] = useState(visible);
  const dim = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(windowHeight)).current;
  // 키패드가 떠 있는 동안의 "닫기" 제스처(딤 탭·안드로이드 뒤로가기)는 시트가 아니라 키패드만 닫아야 한다.
  // (실기기 제보 2026-08-01: 숫자 키패드를 닫으려다 투입 금액 시트까지 닫혀 설정 버튼을 누를 수 없었음.)
  const keyboardVisible = useRef(false);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => {
      keyboardVisible.current = true;
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      keyboardVisible.current = false;
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const handleCloseGesture = () => {
    if (keyboardVisible.current) {
      Keyboard.dismiss(); // 키패드만 닫고 시트는 유지 — 다음 탭부터 정상 닫기.
      return;
    }
    onClose();
  };

  useEffect(() => {
    if (visible) {
      setMounted(true);
      // 열림/닫힘이 빠르게 반복돼도 애니메이션이 꼬이지 않도록, 진행 중이던 애니메이션을 멈추고
      // 현재 값에서 이어서 시작한다(처음부터 다시 튀지 않음).
      dim.stopAnimation();
      translateY.stopAnimation();
      Animated.parallel([
        Animated.timing(dim, {
          toValue: 1,
          duration: DIM_MS,
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(translateY, {
          toValue: 0,
          duration: PANEL_MS,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start();
    } else if (mounted) {
      dim.stopAnimation();
      translateY.stopAnimation();
      Animated.parallel([
        Animated.timing(dim, {
          toValue: 0,
          duration: DIM_MS,
          easing: Easing.in(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(translateY, {
          toValue: windowHeight,
          duration: PANEL_MS,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start(({ finished }) => {
        // 도중에 다시 열려 visible이 true로 바뀐 뒤라면(finished=false 또는 재오픈) unmount하지 않는다.
        if (finished) setMounted(false);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, windowHeight]);

  if (!mounted) return null;

  return (
    <Modal visible transparent animationType="none" onRequestClose={handleCloseGesture} statusBarTranslucent>
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Animated.View
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.45)',
            opacity: dim,
          }}
        >
          <Pressable style={{ flex: 1 }} onPress={handleCloseGesture} accessibilityRole="button" accessibilityLabel="닫기" />
        </Animated.View>

        <Animated.View
          className="rounded-t-3xl bg-white"
          style={{
            height: heightRatio ? windowHeight * heightRatio : undefined,
            transform: [{ translateY }],
          }}
        >
          <View className="items-center pb-1 pt-2">
            <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: '#d1d5db' }} />
          </View>
          {children}
        </Animated.View>
      </View>
    </Modal>
  );
}
