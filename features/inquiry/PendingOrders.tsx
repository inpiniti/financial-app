// 미체결 (kis/nccs.ts inquireOverseasUnfilled + kis/orderCancel.ts 취소) — 홈 보유종목 섹션의 하단 패널.
// 주문체결내역(TTTS3035R)이 일부 계좌에서 APTR0058로 거절되어 미체결 전용 TR(TTTS3018R)로 전환 (README.md 참조).
// 섹션이 ScrollView 하나로 보유종목 패널과 함께 스크롤하므로 자체 스크롤 없이 map 렌더만 한다.
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { ListRow } from '../../components/ListRow';
import { Panel } from '../../components/Panel';
import { TickerAvatar } from '../../components/TickerAvatar';
import { inquireOverseasUnfilled, type OverseasUnfilledItem } from '../../kis/nccs';
import { cancelOverseasOrder } from '../../kis/orderCancel';
import type { OverseasExchangeCode } from '../../kis/trId';
import { toStockMarketCode } from '../stock/marketCodes';
import { formatUsd } from '../../lib/format';
import { EmptyState, SkeletonList } from './components';
import type { KisSessionState } from './useKisSession';

function PendingRow({ item, onCancel, cancelling }: { item: OverseasUnfilledItem; onCancel: () => void; cancelling: boolean }) {
  const isBuy = item.sll_buy_dvsn_cd === '02';
  // 행 탭 → 종목 상세화면. market은 미체결 응답 거래소 코드(NASD 등)를 정규화 — 실패 시 raw 전달(상세가 에러 표시).
  const handlePress = () => {
    const market = toStockMarketCode(item.ovrs_excg_cd);
    router.push({
      pathname: '/stock/[ticker]',
      params: { ticker: item.pdno, market: market ?? item.ovrs_excg_cd, name: item.prdt_name },
    });
  };
  return (
    <View className="border-b border-[#f2f4f6]">
      <ListRow
        onPress={handlePress}
        leading={<TickerAvatar ticker={item.pdno} />}
        title={
          <View className="flex-row items-center">
            <Text className="text-base font-bold text-[#191f28]">{item.pdno}</Text>
            <Text className={`ml-2 text-xs font-semibold ${isBuy ? 'text-[#f04452]' : 'text-[#3182f6]'}`}>
              {isBuy ? '매수' : '매도'}
            </Text>
          </View>
        }
        subtitle={
          <>
            <Text className="mt-0.5 text-sm text-[#8b95a1]" numberOfLines={1}>
              {item.prdt_name}
            </Text>
            <Text className="mt-1 text-xs text-[#8b95a1]">
              주문 {item.ft_ord_qty}주 · 미체결 {item.nccs_qty}주 · 단가 {formatUsd(item.ft_ord_unpr3)}
            </Text>
          </>
        }
      />
      <Pressable
        onPress={onCancel}
        disabled={cancelling}
        className="mx-5 mb-3 items-center rounded-2xl bg-[#fdecee] py-2 active:opacity-80"
        style={{ minHeight: 44, justifyContent: 'center' }}
      >
        <Text className="text-sm font-semibold text-[#f04452]">{cancelling ? '취소하는 중이에요…' : '취소하기'}</Text>
      </Pressable>
    </View>
  );
}

export interface PendingOrdersData {
  orders: OverseasUnfilledItem[] | null;
  loading: boolean;
  error: string | null;
  cancellingOdno: string | null;
  cancelOrder: (item: OverseasUnfilledItem) => void;
}

/** 세션이 ready가 될 때마다 미체결을 다시 조회한다. 취소 성공 시 미체결만 재조회(잔고는 건드리지 않음). */
export function usePendingOrders(session: KisSessionState): PendingOrdersData {
  const [orders, setOrders] = useState<OverseasUnfilledItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancellingOdno, setCancellingOdno] = useState<string | null>(null);

  const fetchOrders = useCallback(async () => {
    if (session.kind !== 'ready') return;
    setLoading(true);
    setError(null);
    try {
      // OVRS_EXCG_CD=NASD면 미국 전체(나스닥/뉴욕/아멕스)가 함께 조회된다 (미체결내역.md).
      const result = await inquireOverseasUnfilled(session.session.environment, session.session.credentials, session.session.accessToken, {
        account: session.session.account,
        ovrsExcgCd: 'NASD',
      });
      setOrders(result.output);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    if (session.kind === 'ready') fetchOrders();
  }, [session, fetchOrders]);

  const cancelOrder = useCallback(
    async (item: OverseasUnfilledItem) => {
      if (session.kind !== 'ready') return;
      setCancellingOdno(item.odno);
      try {
        // ORGN_ODNO(취소 대상 원주문번호)는 정정취소주문.md 정의상 "주문 API 또는 미체결내역 API의 ODNO" —
        // 미체결내역 응답의 orgn_odno(정정 이력 추적용)가 아니라 이 건 자체의 odno를 넣는다.
        await cancelOverseasOrder(session.session.environment, session.session.credentials, session.session.accessToken, {
          account: session.session.account,
          ovrsExcgCd: item.ovrs_excg_cd as OverseasExchangeCode,
          pdno: item.pdno,
          orgnOdno: item.odno,
          orderQty: Number(item.nccs_qty) || Number(item.ft_ord_qty),
        });
        Alert.alert('알림', '주문을 취소했어요.');
        fetchOrders();
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        Alert.alert('알림', `취소하지 못했어요: ${reason}`);
      } finally {
        setCancellingOdno(null);
      }
    },
    [session, fetchOrders],
  );

  return { orders, loading, error, cancellingOdno, cancelOrder };
}

/** 미체결 패널 — 스크롤 없는 순수 패널(HoldingsAndPending의 ScrollView 안에서 렌더). */
export function PendingOrdersPanel({ data }: { data: PendingOrdersData }) {
  const { orders, loading, error, cancellingOdno, cancelOrder } = data;
  return (
    <Panel title="미체결">
      {orders === null && (loading || !error) ? (
        <SkeletonList count={2} />
      ) : orders === null && error ? (
        <EmptyState icon="alert-circle-outline" title="잠시 연결이 어려워요" description={`조금 뒤에 다시 시도해 주세요. (${error})`} />
      ) : orders !== null && orders.length === 0 ? (
        <EmptyState icon="hourglass-outline" title="미체결 주문이 없어요" description="주문을 넣으면 여기에 나타나요" />
      ) : (
        (orders ?? []).map((item) => (
          <PendingRow key={item.odno} item={item} onCancel={() => cancelOrder(item)} cancelling={cancellingOdno === item.odno} />
        ))
      )}
      <View style={{ height: 8 }} />
    </Panel>
  );
}
