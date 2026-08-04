// 조회/설정 화면 공용 상단바 — 좌상단 뒤로가기(←)로 홈 복귀 + 중앙 타이틀.
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';

export interface BackHeaderProps {
  title: string;
}

export function BackHeader({ title }: BackHeaderProps) {
  const insets = useSafeAreaInsets();

  return (
    <View
      className="flex-row items-center bg-white px-2"
      style={{ paddingTop: insets.top, minHeight: 44 + insets.top }}
    >
      <Pressable
        onPress={() => (router.canGoBack() ? router.back() : router.replace('/home'))}
        hitSlop={8}
        className="flex-row items-center px-3 py-3 active:opacity-60"
        style={{ minHeight: 44 }}
        accessibilityRole="button"
        accessibilityLabel="뒤로가기"
      >
        <Ionicons name="chevron-back" size={24} color="#191f28" />
      </Pressable>
      <Text className="flex-1 text-center text-base font-bold text-[#191f28]" style={{ marginRight: 44 }}>
        {title}
      </Text>
    </View>
  );
}
