import { ScrollView, View } from 'react-native';
import { BackHeader } from '../components/BackHeader';
import { TradeHistoryPanel, useTodayTradeSummary } from '../features/inquiry/TradeHistory';
import { useUsdKrwRate } from '../lib/useUsdKrwRate';

export default function TradesScreen() {
  const summary = useTodayTradeSummary(0);
  const usdKrw = useUsdKrwRate();
  return (
    <View className="flex-1 bg-[#f2f4f6]">
      <BackHeader title="오늘 거래 기록" />
      <ScrollView className="flex-1" contentContainerStyle={{ paddingTop: 8, paddingBottom: 32 }}>
        <TradeHistoryPanel summary={summary} usdKrw={usdKrw} />
      </ScrollView>
    </View>
  );
}
