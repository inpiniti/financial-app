// 홈 화면(게이트 통과 후 최초 화면) — 옛 (tabs)/scalper.tsx. 하단 탭 바 제거에 따라 이 화면이 홈이 된다.
// 상단바: 좌측 "조회", 우측 "설정" 진입 버튼. 수동 카드 모드 제거(2026-08-08) — 자동 단타 단독 화면.
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ErrorNotice, SetupNotice } from '../features/inquiry/components';
import { AutoPilotScreen } from '../features/scalper/ui/AutoPilotScreen';
import { useScalperManager } from '../features/scalper/ui/managerProvider';

/** 홈 상단바 — 중앙 타이틀 "DDALBA TRACE" + 좌측 조회·우측 설정(아이콘 전용, 라벨 없음). */
function HomeTopBar() {
  const insets = useSafeAreaInsets();

  return (
    <View
      className="flex-row items-center justify-between bg-white px-2"
      style={{ paddingTop: insets.top, minHeight: 44 + insets.top }}
    >
      <Pressable
        onPress={() => router.push('/inquiry')}
        hitSlop={8}
        className="items-center justify-center px-3 active:opacity-60"
        style={{ minHeight: 44, minWidth: 44 }}
        accessibilityRole="button"
        accessibilityLabel="조회 화면으로 이동"
      >
        <Ionicons name="search-outline" size={22} color="#191f28" />
      </Pressable>

      <Text className="text-[17px] font-bold text-[#191f28]">DDALBA TRACE</Text>

      <Pressable
        onPress={() => router.push('/settings')}
        hitSlop={8}
        className="items-center justify-center px-3 active:opacity-60"
        style={{ minHeight: 44, minWidth: 44 }}
        accessibilityRole="button"
        accessibilityLabel="설정 화면으로 이동"
      >
        <Ionicons name="settings-outline" size={22} color="#191f28" />
      </Pressable>
    </View>
  );
}

export default function HomeScreen() {
  const bootstrap = useScalperManager();

  if (bootstrap.kind === 'loading') {
    return (
      <View className="flex-1 items-center justify-center bg-[#f2f4f6]">
        <ActivityIndicator color="#3182f6" />
      </View>
    );
  }
  if (bootstrap.kind === 'needsSetup') {
    return (
      <View className="flex-1 bg-[#f2f4f6]">
        <HomeTopBar />
        <SetupNotice />
      </View>
    );
  }
  if (bootstrap.kind === 'error') {
    return (
      <View className="flex-1 bg-[#f2f4f6]">
        <HomeTopBar />
        <ErrorNotice message={bootstrap.message} />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-[#f2f4f6]">
      <HomeTopBar />
      <AutoPilotScreen autopilot={bootstrap.autopilot} />
    </View>
  );
}
