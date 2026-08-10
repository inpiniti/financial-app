// 홈 보유종목 섹션 — 보유종목 패널 + 미체결 패널을 ScrollView 하나에 위아래로 쌓는다(옛 조회 화면의 두 세그먼트 병합).
// KIS 세션은 섹션 레벨에서 1회 공유하고, 당겨서 새로고침은 reloadKey 하나로 세션·잔고·미체결을 함께 갱신한다.
import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView } from 'react-native';
import { ErrorNotice, SetupNotice } from './components';
import { HoldingsPanel, useHoldings } from './Holdings';
import { PendingOrdersPanel, usePendingOrders } from './PendingOrders';
import { useKisSession } from './useKisSession';

export function HoldingsAndPending() {
  const [reloadKey, setReloadKey] = useState(0);
  const session = useKisSession(reloadKey);
  const holdings = useHoldings(session);
  const pending = usePendingOrders(session);
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setReloadKey((k) => k + 1);
  }, []);

  // 새로고침 스피너는 세션 재로드 + 두 조회가 모두 끝나면 내린다.
  useEffect(() => {
    if (refreshing && session.kind !== 'loading' && !holdings.loading && !pending.loading) setRefreshing(false);
  }, [refreshing, session.kind, holdings.loading, pending.loading]);

  if (session.kind === 'needsSetup') return <SetupNotice />;
  if (session.kind === 'error') return <ErrorNotice message={session.message} />;

  return (
    <ScrollView
      className="flex-1"
      contentContainerStyle={{ paddingBottom: 24 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#3182f6" />}
    >
      <HoldingsPanel data={holdings} />
      <PendingOrdersPanel data={pending} />
    </ScrollView>
  );
}
