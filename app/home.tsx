// 홈 화면(게이트 통과 후 최초 화면) — 하단 고정 메뉴로 트레이딩/보유종목/순위/손익 섹션을 화면 안에서 전환한다.
// 상단바: 좌측 "검색", 우측 "설정" 진입 버튼. 트레이딩 섹션만 스캘퍼 매니저 부트스트랩에 게이팅되고,
// 나머지 섹션은 각자 useKisSession으로 독립 동작한다(키 미설정이어도 섹션 이동 가능).
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomMenu, type BottomMenuItem } from '../components/BottomMenu';
import { ErrorNotice, SetupNotice } from '../features/inquiry/components';
import { HoldingsAndPending } from '../features/inquiry/HoldingsAndPending';
import { ProfitLoss } from '../features/inquiry/ProfitLoss';
import { Ranking } from '../features/inquiry/Ranking';
import { AutoPilotScreen } from '../features/scalper/ui/AutoPilotScreen';
import { useScalperManager } from '../features/scalper/ui/managerProvider';

type HomeSegment = 'trading' | 'holdings' | 'ranking' | 'profitLoss';

const MENU_ITEMS: BottomMenuItem<HomeSegment>[] = [
  { key: 'trading', label: '트레이딩', icon: 'flash-outline', activeIcon: 'flash' },
  { key: 'holdings', label: '보유종목', icon: 'wallet-outline', activeIcon: 'wallet' },
  { key: 'ranking', label: '순위', icon: 'podium-outline', activeIcon: 'podium' },
  { key: 'profitLoss', label: '손익', icon: 'cash-outline', activeIcon: 'cash' },
];

/** 홈 상단바 — 중앙 타이틀 "DDALBA TRACE" + 좌측 검색·우측 설정(아이콘 전용, 라벨 없음). */
function HomeTopBar() {
  const insets = useSafeAreaInsets();

  return (
    <View
      className="flex-row items-center justify-between bg-white px-2"
      style={{ paddingTop: insets.top, minHeight: 44 + insets.top }}
    >
      <Pressable
        onPress={() => router.push('/search')}
        hitSlop={8}
        className="items-center justify-center px-3 active:opacity-60"
        style={{ minHeight: 44, minWidth: 44 }}
        accessibilityRole="button"
        accessibilityLabel="검색 화면으로 이동"
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

/** 트레이딩 섹션 — 스캘퍼 매니저 부트스트랩 상태에 따라 섹션 내용만 게이팅한다(화면 전체가 아니라). */
function TradingSection() {
  const bootstrap = useScalperManager();

  if (bootstrap.kind === 'loading') {
    return (
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator color="#3182f6" />
      </View>
    );
  }
  if (bootstrap.kind === 'needsSetup') return <SetupNotice />;
  if (bootstrap.kind === 'error') return <ErrorNotice message={bootstrap.message} />;
  return <AutoPilotScreen autopilot={bootstrap.autopilot} />;
}

export default function HomeScreen() {
  const [segment, setSegment] = useState<HomeSegment>('trading');
  // 손익 일별 상세가 열려 있으면 상단 바·하단 메뉴를 숨긴다 — 뒤로가기가 둘 보이는 UX를 막는다.
  const [detailOpen, setDetailOpen] = useState(false);

  const handleSegmentChange = useCallback((next: HomeSegment) => {
    setSegment(next);
    // 상세가 열린 채 세그먼트가 바뀔 일은 없지만(메뉴가 숨음), 방어적으로 리셋한다.
    setDetailOpen(false);
  }, []);

  return (
    <View className="flex-1 bg-[#f2f4f6]">
      {!detailOpen && <HomeTopBar />}
      <View className="flex-1">
        {segment === 'trading' && <TradingSection />}
        {segment === 'holdings' && <HoldingsAndPending />}
        {segment === 'ranking' && <Ranking />}
        {segment === 'profitLoss' && <ProfitLoss onDetailOpenChange={setDetailOpen} />}
      </View>
      {!detailOpen && <BottomMenu items={MENU_ITEMS} value={segment} onChange={handleSegmentChange} />}
    </View>
  );
}
