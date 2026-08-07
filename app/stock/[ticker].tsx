// 종목 상세화면 — 2026-08-07 종목상세화면 plan. 어느 리스트(수동 카드·자동 단타·보유·미체결·순위)에서
// 종목을 탭하든 이 화면 하나로 온다(바텀시트 난립 제거). 탭: 차트(기본)/댓글/호가.
// 실시간 구독은 화면 진입 시 획득, 이탈 시 해제 — useQuoteFeed(acquireFeed/releaseFeed refcount) 참고.
import { useCallback, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SegmentedControl } from '../../features/inquiry/SegmentedControl';
import { AddInstanceSheet } from '../../features/scalper/ui/AddInstanceSheet';
import { useScalperManager } from '../../features/scalper/ui/managerProvider';
import { ChartPanel } from '../../features/stock/ui/ChartPanel';
import { CommentsPanel } from '../../features/stock/ui/CommentsPanel';
import { QuotePanel } from '../../features/stock/ui/QuotePanel';
import { MARKET_TO_EXCHANGE, toStockMarketCode } from '../../features/stock/marketCodes';
import { useQuoteFeed } from '../../features/stock/useQuoteFeed';

type DetailTab = 'chart' | 'comments' | 'quote';

const TAB_ITEMS: Array<{ key: DetailTab; label: string }> = [
  { key: 'chart', label: '차트' },
  { key: 'comments', label: '댓글' },
  { key: 'quote', label: '호가' },
];

/** 상단바 — 좌측 뒤로가기 + 타이틀(종목명·티커) + 우측 수동 카드 추가(+). */
function DetailHeader({
  title,
  subtitle,
  onAddPress,
}: {
  title: string;
  subtitle?: string;
  onAddPress: () => void;
}) {
  const insets = useSafeAreaInsets();

  return (
    <View
      className="flex-row items-center bg-white px-2"
      style={{ paddingTop: insets.top, minHeight: 44 + insets.top }}
    >
      <Pressable
        onPress={() => (router.canGoBack() ? router.back() : router.replace('/home'))}
        hitSlop={8}
        className="items-center justify-center px-3 py-3 active:opacity-60"
        style={{ minHeight: 44, minWidth: 44 }}
        accessibilityRole="button"
        accessibilityLabel="뒤로가기"
      >
        <Ionicons name="chevron-back" size={24} color="#191f28" />
      </Pressable>
      <View className="flex-1 items-center">
        <Text className="text-base font-bold text-[#191f28]" numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? <Text className="text-[11px] text-[#8b95a1]">{subtitle}</Text> : null}
      </View>
      <Pressable
        onPress={onAddPress}
        hitSlop={8}
        className="items-center justify-center px-3 active:opacity-60"
        style={{ minHeight: 44, minWidth: 44 }}
        accessibilityRole="button"
        accessibilityLabel="수동 카드에 추가"
      >
        <Ionicons name="add" size={26} color="#191f28" />
      </Pressable>
    </View>
  );
}

export default function StockDetailScreen() {
  const params = useLocalSearchParams<{ ticker: string; market?: string; name?: string }>();
  const ticker = (params.ticker ?? '').toUpperCase();
  const market = toStockMarketCode(params.market);
  const name = params.name?.trim() || undefined;

  const bootstrap = useScalperManager();
  const manager = bootstrap.kind === 'ready' ? bootstrap.manager : null;
  const defaultQty = bootstrap.kind === 'ready' ? bootstrap.defaultQty : 1;

  const [tab, setTab] = useState<DetailTab>('chart');
  const [addSheetVisible, setAddSheetVisible] = useState(false);

  // 진입~이탈 동안 체결가+호가 구독 유지 — market이 없으면(null) 아무것도 구독하지 않는다.
  const { state: quoteState, trKey } = useQuoteFeed(manager, ticker, market);

  const handleAddPress = useCallback(() => {
    if (!manager || !market) {
      Alert.alert('알림', '지금은 수동 카드에 추가할 수 없어요 — 설정 탭에서 KIS 키를 확인해 주세요.');
      return;
    }
    if (manager.getInstances().some((i) => i.ticker === ticker)) {
      Alert.alert('알림', '이미 수동 카드에 있는 종목이에요.');
      return;
    }
    setAddSheetVisible(true);
  }, [manager, market, ticker]);

  const handleAddSubmit = useCallback(
    (input: { ticker: string; qty: number }) => {
      if (!manager || !market) return;
      try {
        manager.add({
          ticker: input.ticker,
          qty: input.qty,
          market,
          exchange: MARKET_TO_EXCHANGE[market],
        });
        setAddSheetVisible(false);
        Alert.alert('알림', '수동 카드에 추가했어요.');
      } catch (e) {
        Alert.alert('알림', e instanceof Error ? e.message : String(e));
      }
    },
    [manager, market],
  );

  const title = name ?? ticker;
  const subtitle = name ? ticker : undefined;

  // market 누락/매핑 불가 — 조용한 오동작 대신 에러 상태를 표시한다(plan §1).
  if (!ticker || !market) {
    return (
      <View className="flex-1 bg-[#f2f4f6]">
        <DetailHeader title={title || '종목 상세'} subtitle={subtitle} onAddPress={handleAddPress} />
        <View className="flex-1 items-center justify-center px-8">
          <Ionicons name="alert-circle-outline" size={40} color="#8b95a1" style={{ marginBottom: 12 }} />
          <Text className="text-center text-base font-semibold text-[#191f28]">
            종목 정보를 불러올 수 없어요
          </Text>
          <Text className="mt-1 text-center text-sm text-[#8b95a1]">
            거래소 정보가 없는 종목이에요 — 목록에서 다시 선택해 주세요
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-[#f2f4f6]">
      <DetailHeader title={title} subtitle={subtitle} onAddPress={handleAddPress} />
      <SegmentedControl items={TAB_ITEMS} value={tab} onChange={setTab} />
      <View className="flex-1">
        {tab === 'chart' ? (
          <ChartPanel ticker={ticker} excd={market} />
        ) : tab === 'comments' ? (
          <CommentsPanel ticker={ticker} />
        ) : (
          <QuotePanel manager={manager} state={quoteState} trKey={trKey} />
        )}
      </View>

      <AddInstanceSheet
        visible={addSheetVisible}
        initial={{ ticker, qty: defaultQty }}
        onClose={() => setAddSheetVisible(false)}
        onSubmit={handleAddSubmit}
      />
    </View>
  );
}
