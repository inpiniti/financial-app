// 조회 화면 — 옛 (tabs)/inquiry.tsx. 좌상단 뒤로가기로 홈 복귀, 하단 고정 메뉴(보유종목|미체결|순위|손익|거래기록).
// 세그먼트별 데이터 취득·UI는 features/inquiry/ 아래 기존 컴포넌트를 그대로 재사용한다.
import { useState } from 'react';
import { View } from 'react-native';
import { BackHeader } from '../components/BackHeader';
import { BottomMenu, type BottomMenuItem } from '../components/BottomMenu';
import { Holdings } from '../features/inquiry/Holdings';
import { PendingOrders } from '../features/inquiry/PendingOrders';
import { ProfitLoss } from '../features/inquiry/ProfitLoss';
import { Ranking } from '../features/inquiry/Ranking';
import { TradeHistory } from '../features/inquiry/TradeHistory';

type InquirySegment = 'holdings' | 'pending' | 'ranking' | 'profitLoss' | 'trades';

const MENU_ITEMS: BottomMenuItem<InquirySegment>[] = [
  { key: 'holdings', label: '보유종목', icon: 'wallet-outline', activeIcon: 'wallet' },
  { key: 'pending', label: '미체결', icon: 'hourglass-outline', activeIcon: 'hourglass' },
  { key: 'ranking', label: '순위', icon: 'podium-outline', activeIcon: 'podium' },
  { key: 'profitLoss', label: '손익', icon: 'cash-outline', activeIcon: 'cash' },
  { key: 'trades', label: '거래기록', icon: 'receipt-outline', activeIcon: 'receipt' },
];

export default function InquiryScreen() {
  const [segment, setSegment] = useState<InquirySegment>('holdings');
  // 손익 일별 상세가 열려 있으면 상단 바·하단 메뉴를 숨긴다 — 뒤로가기가 둘 보이는 UX를 막는다.
  const [detailOpen, setDetailOpen] = useState(false);

  return (
    <View className="flex-1 bg-[#f2f4f6]">
      {!detailOpen && <BackHeader title="조회" />}
      <View className="flex-1">
        {segment === 'holdings' && <Holdings />}
        {segment === 'pending' && <PendingOrders />}
        {segment === 'ranking' && <Ranking />}
        {segment === 'profitLoss' && <ProfitLoss onDetailOpenChange={setDetailOpen} />}
        {segment === 'trades' && <TradeHistory />}
      </View>
      {!detailOpen && <BottomMenu items={MENU_ITEMS} value={segment} onChange={setSegment} />}
    </View>
  );
}
