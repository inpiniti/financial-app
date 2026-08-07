// 조회 탭 세그먼트 1 — 보유종목 (kis/balance.ts 잔고 API).
// 색 규칙(PRD 명시 — toss-design 기본 색 규칙보다 우선): 한국 관례로 이익=빨강 계열, 손실=파랑 계열.
import { useCallback, useEffect, useState } from 'react';
import { FlatList, RefreshControl, Text, View } from 'react-native';
import { router } from 'expo-router';
import { ListRow } from '../../components/ListRow';
import { Panel } from '../../components/Panel';
import { TickerAvatar } from '../../components/TickerAvatar';
import { inquireOverseasBalance, type OverseasBalancePosition } from '../../kis/balance';
import { toStockMarketCode } from '../stock/marketCodes';
import { formatSignedPercent, formatSignedUsd, pnlColor } from '../../lib/format';
import { EmptyState, ErrorNotice, SetupNotice, SkeletonList } from './components';
import { useKisSession } from './useKisSession';

function formatQty(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  return n.toLocaleString('ko-KR');
}

/** 손익 금액·퍼센트 — "$·천단위 콤마·소수 2자리" + "퍼센트 소수 1자리"로 청킹(토스 라이팅: 8자리 소수 노출 금지). */
function ProfitText({ amount, rate }: { amount: string; rate: string }) {
  const color = pnlColor(amount);
  return (
    <Text style={{ color }} className="text-base font-bold">
      {formatSignedUsd(amount)} ({formatSignedPercent(rate)})
    </Text>
  );
}

function HoldingRow({ item }: { item: OverseasBalancePosition }) {
  // 행 탭 → 종목 상세화면(차트/댓글/호가). market은 잔고 응답 거래소 코드(NASD 등)를 정규화해 전달 —
  // 매핑이 안 되는 값이면 raw를 그대로 넘기고 상세화면이 에러 상태를 표시한다.
  const handlePress = () => {
    const market = toStockMarketCode(item.ovrs_excg_cd);
    router.push({
      pathname: '/stock/[ticker]',
      params: { ticker: item.pdno, market: market ?? item.ovrs_excg_cd, name: item.prdt_name },
    });
  };
  return (
    <ListRow
      onPress={handlePress}
      leading={<TickerAvatar ticker={item.pdno} />}
      title={
        <View className="flex-row items-center">
          <Text className="text-base font-bold text-[#191f28]">{item.pdno}</Text>
          <Text className="ml-2 text-[11px] text-[#8b95a1]">{item.tr_mket_name}</Text>
        </View>
      }
      subtitle={item.prdt_name}
      trailing={
        <>
          <Text className="mb-0.5 text-xs text-[#8b95a1]">{formatQty(item.cblc_qty13)}주</Text>
          <ProfitText amount={item.evlu_pfls_amt2} rate={item.evlu_pfls_rt1} />
        </>
      }
    />
  );
}

export function Holdings() {
  const [reloadKey, setReloadKey] = useState(0);
  const session = useKisSession(reloadKey);
  const [positions, setPositions] = useState<OverseasBalancePosition[] | null>(null);
  const [loadingData, setLoadingData] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchPositions = useCallback(async () => {
    if (session.kind !== 'ready') return;
    setLoadingData(true);
    setDataError(null);
    try {
      const result = await inquireOverseasBalance(session.session.environment, session.session.credentials, session.session.accessToken, {
        account: session.session.account,
      });
      setPositions(result.output1);
    } catch (e) {
      setDataError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingData(false);
      setRefreshing(false);
    }
  }, [session]);

  useEffect(() => {
    if (session.kind === 'ready') fetchPositions();
  }, [session, fetchPositions]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setReloadKey((k) => k + 1);
  }, []);

  if (session.kind === 'needsSetup') return <SetupNotice />;
  if (session.kind === 'error') return <ErrorNotice message={session.message} />;
  if (session.kind === 'loading' || (loadingData && positions === null))
    return (
      <Panel title="보유종목" style={{ flex: 1, marginBottom: 0 }}>
        <SkeletonList />
      </Panel>
    );
  if (dataError && positions === null) return <ErrorNotice message={dataError} />;

  return (
    <Panel title="보유종목" style={{ flex: 1, marginBottom: 0 }}>
      <FlatList
        data={positions ?? []}
        keyExtractor={(item, idx) => `${item.pdno}-${idx}`}
        renderItem={({ item }) => <HoldingRow item={item} />}
        contentContainerStyle={{ flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#3182f6" />}
        ListEmptyComponent={<EmptyState icon="cube-outline" title="보유 중인 종목이 없어요" description="매수하면 여기에 나타나요" />}
      />
    </Panel>
  );
}
