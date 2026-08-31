// 오늘 거래 기록 화면(2026-08-29 데스크탑에서 이식) — 트레이딩의 "오늘 성과" 행을 누르면 들어온다.
// 앱이 기록한 오늘의 매수→매도 사이클을 시간순으로. 뒤로가기 상단바 + 스크롤.
// 데이터는 features/inquiry/TradeHistory(useTodayTrades)를 그대로 쓴다.
import { ScrollView, View } from 'react-native';
import { BackHeader } from '../components/BackHeader';
import { TradeHistoryPanel, useTodayTrades } from '../features/inquiry/TradeHistory';
import { useUsdKrwRate } from '../lib/useUsdKrwRate';

export default function TradesScreen() {
  const trades = useTodayTrades(0);
  const usdKrw = useUsdKrwRate();
  return (
    <View className="flex-1 bg-[#f2f4f6]">
      <BackHeader title="오늘 거래 기록" />
      <ScrollView className="flex-1" contentContainerStyle={{ paddingTop: 8, paddingBottom: 32 }}>
        <TradeHistoryPanel trades={trades} usdKrw={usdKrw} />
      </ScrollView>
    </View>
  );
}
