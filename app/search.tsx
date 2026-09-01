// 검색 화면 — 티커·종목명(한글/영문)으로 미국 종목을 찾아 종목상세로 진입한다(옛 조회 화면 대체).
// 데이터 소스는 토스 자동완성(lib/tossSearch.ts, 비공식·로그인 불필요). 뒤로가기 시 홈 복귀.
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { BackHeader } from '../components/BackHeader';
import { ListRow } from '../components/ListRow';
import { Panel } from '../components/Panel';
import { TickerAvatar } from '../components/TickerAvatar';
import { EmptyState, SkeletonList } from '../features/inquiry/components';
import { searchStocks, type TossSearchResult } from '../lib/tossSearch';

const MARKET_LABEL: Record<TossSearchResult['market'], string> = {
  NAS: '나스닥',
  NYS: '뉴욕',
  AMS: '아멕스',
};

// memo — 검색 중 화면 리렌더(로딩 토스트 등)에서 결과 행(item 참조 동일)을 다시 그리지 않는다.
const ResultRow = memo(function ResultRow({ item }: { item: TossSearchResult }) {
  const handlePress = () => {
    router.push({
      pathname: '/stock/[ticker]',
      params: { ticker: item.symbol, market: item.market, name: item.name },
    });
  };
  return (
    <ListRow
      onPress={handlePress}
      leading={<TickerAvatar ticker={item.symbol} />}
      title={item.name}
      subtitle={`${item.symbol} · ${MARKET_LABEL[item.market]}`}
      trailing={<Ionicons name="chevron-forward" size={16} color="#8b95a1" />}
    />
  );
});

export default function SearchScreen() {
  const [query, setQuery] = useState('');
  // null = 아직 검색 전(대기 상태) — 빈 배열(결과 없음)과 구분한다.
  const [results, setResults] = useState<TossSearchResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  // 연타 시 이전 응답 잔상 차단 — 마지막 요청만 반영(latest-wins, ProfitLoss.tsx 관례).
  const requestSeqRef = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      requestSeqRef.current += 1;
      setResults(null);
      setLoading(false);
      setError(false);
      return;
    }

    const timer = setTimeout(async () => {
      const seq = ++requestSeqRef.current;
      setLoading(true);
      setError(false);
      try {
        const found = await searchStocks(trimmed);
        if (seq !== requestSeqRef.current) return;
        setResults(found);
      } catch {
        if (seq !== requestSeqRef.current) return;
        setResults(null);
        setError(true);
      } finally {
        if (seq === requestSeqRef.current) setLoading(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  // renderItem을 렌더마다 새로 만들지 않는다 — FlatList가 행 재렌더 여부를 안정적으로 판단하게.
  const renderResult = useCallback(({ item }: { item: TossSearchResult }) => <ResultRow item={item} />, []);

  return (
    <View className="flex-1 bg-[#f2f4f6]">
      <BackHeader title="검색" />
      <View className="bg-white px-5 pb-3 pt-2" style={{ marginBottom: 8 }}>
        <View className="flex-row items-center rounded-2xl bg-[#f2f4f6] px-4" style={{ minHeight: 48, gap: 8 }}>
          <Ionicons name="search-outline" size={18} color="#8b95a1" />
          <TextInput
            value={query}
            onChangeText={setQuery}
            autoFocus
            autoCorrect={false}
            autoCapitalize="none"
            placeholder="티커나 종목명을 입력해 주세요"
            placeholderTextColor="#8b95a1"
            className="flex-1 text-base text-[#191f28]"
            style={{ paddingVertical: 12 }}
          />
        </View>
      </View>
      <Panel style={{ flex: 1, marginBottom: 0 }}>
        {loading && results === null ? (
          <SkeletonList />
        ) : error ? (
          <EmptyState
            icon="alert-circle-outline"
            title="검색하지 못했어요"
            description="잠시 후 다시 시도해 주세요"
          />
        ) : results === null ? (
          <EmptyState
            icon="search-outline"
            title="티커나 종목명으로 검색해 보세요"
            description="예: TSLA, 테슬라, 애플"
          />
        ) : (
          <FlatList
            data={results}
            keyExtractor={(item) => `${item.market}-${item.symbol}`}
            renderItem={renderResult}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ flexGrow: 1 }}
            ListEmptyComponent={
              <EmptyState
                icon="help-circle-outline"
                title="검색 결과가 없어요"
                description="티커나 종목명을 다시 확인해 주세요"
              />
            }
          />
        )}
      </Panel>
      {loading && results !== null && (
        <View className="absolute bottom-4 self-center rounded-full bg-[#191f28]/70 px-4 py-2">
          <Text className="text-xs font-semibold text-white">검색하는 중…</Text>
        </View>
      )}
    </View>
  );
}
