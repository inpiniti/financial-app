import { ScrollView, View } from 'react-native';
import { BackHeader } from '../components/BackHeader';
import { TradeHistoryPanel, useTodayTradeActions } from '../features/inquiry/TradeHistory';
import { useUsdKrwRate } from '../lib/useUsdKrwRate';

export default function TradesScreen() {
  const actions = useTodayTradeActions(0);
  const usdKrw = useUsdKrwRate();
  return (
    <View className="flex-1 bg-[#f2f4f6]">
      <BackHeader title="오늘 거래 기록" />
      <ScrollView className="flex-1" contentContainerStyle={{ paddingTop: 8, paddingBottom: 32 }}>
        <TradeHistoryPanel actions={actions} usdKrw={usdKrw} />
      </ScrollView>
    </View>
  );
}
