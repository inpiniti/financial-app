// 종목 상세화면 — 2026-08-07 종목상세화면 plan. 어느 리스트(자동 단타·보유·미체결·순위)에서
// 종목을 탭하든 이 화면 하나로 온다(바텀시트 난립 제거). 탭: 차트(기본)/커뮤니티/기업(2026-08-19 호가 탭 대체 — AI 기업요약).
// 실시간 구독은 화면 진입 시 획득, 이탈 시 해제 — useQuoteFeed(acquireFeed/releaseFeed refcount) 참고.
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useScalperManager } from '../../features/scalper/ui/managerProvider';
import { ChartPanel } from '../../features/stock/ui/ChartPanel';
import { CommentsPanel } from '../../features/stock/ui/CommentsPanel';
import { PriceHeader } from '../../features/stock/ui/PriceHeader';
import { CompanyPanel } from '../../features/stock/ui/CompanyPanel';
import { toStockMarketCode } from '../../features/stock/marketCodes';
import { useQuoteFeed } from '../../features/stock/useQuoteFeed';

type DetailTab = 'chart' | 'comments' | 'company';

const TAB_ITEMS: Array<{ key: DetailTab; label: string }> = [
  { key: 'chart', label: '차트' },
  { key: 'comments', label: '커뮤니티' },
  { key: 'company', label: '기업' },
];

/** 차트/커뮤니티/기업 밑줄 탭 — 선택된 탭은 진한 글자 + 하단 2px 바(토스식). */
function DetailTabs({ value, onChange }: { value: DetailTab; onChange: (next: DetailTab) => void }) {
  return (
    <View className="mb-2 flex-row bg-white px-2">
      {TAB_ITEMS.map((item) => {
        const active = item.key === value;
        return (
          <Pressable
            key={item.key}
            onPress={() => onChange(item.key)}
            className="flex-1 items-center justify-center"
            style={{
              minHeight: 44,
              borderBottomWidth: 2,
              borderBottomColor: active ? '#191f28' : 'transparent',
            }}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
          >
            <Text className={`text-[15px] ${active ? 'font-bold text-[#191f28]' : 'font-medium text-[#8b95a1]'}`}>
              {item.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** 상단바 — 좌측 뒤로가기 + 타이틀(종목명·티커). */
function DetailHeader({ title, subtitle }: { title: string; subtitle?: string }) {
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
      {/* 좌측 뒤로가기와 같은 폭의 자리 채움 — 타이틀 중앙 정렬 유지(옛 + 버튼 자리). */}
      <View style={{ minHeight: 44, minWidth: 44 }} />
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

  const [tab, setTab] = useState<DetailTab>('chart');

  // 진입~이탈 동안 체결가 구독 유지(PriceHeader 실시간가·기업 탭 하단 구독 진단) — market이 없으면(null) 아무것도 구독하지 않는다.
  const { state: quoteState, trKey } = useQuoteFeed(manager, ticker, market);

  const title = name ?? ticker;
  const subtitle = name ? ticker : undefined;

  // market 누락/매핑 불가 — 조용한 오동작 대신 에러 상태를 표시한다(plan §1).
  if (!ticker || !market) {
    return (
      <View className="flex-1 bg-[#f2f4f6]">
        <DetailHeader title={title || '종목 상세'} subtitle={subtitle} />
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
      <DetailHeader title={title} subtitle={subtitle} />
      <PriceHeader ticker={ticker} excd={market} livePrice={quoteState.price} />
      <DetailTabs value={tab} onChange={setTab} />
      <View className="flex-1">
        {tab === 'chart' ? (
          <ChartPanel ticker={ticker} excd={market} />
        ) : tab === 'comments' ? (
          <CommentsPanel ticker={ticker} />
        ) : (
          <CompanyPanel
            ticker={ticker}
            excd={market}
            name={name}
            manager={manager}
            quoteState={quoteState}
            trKey={trKey}
          />
        )}
      </View>
    </View>
  );
}
