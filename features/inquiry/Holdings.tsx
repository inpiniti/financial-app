// 보유종목 (kis/balance.ts 잔고 API) — 홈 보유종목 섹션(HoldingsAndPending)의 상단 패널.
// 섹션이 ScrollView 하나로 미체결 패널과 함께 스크롤하므로 자체 스크롤 없이 map 렌더만 한다.
// 색 규칙(PRD 명시 — toss-design 기본 색 규칙보다 우선): 한국 관례로 이익=빨강 계열, 손실=파랑 계열.
import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { router } from 'expo-router';
import { ListRow } from '../../components/ListRow';
import { Panel } from '../../components/Panel';
import { TickerAvatar } from '../../components/TickerAvatar';
import { inquireOverseasBalance, type OverseasBalancePosition } from '../../kis/balance';
import { toStockMarketCode } from '../stock/marketCodes';
import { formatSignedPercent, formatSignedUsd, pnlColor } from '../../lib/format';
import { EmptyState, SkeletonList } from './components';
import type { KisSessionState } from './useKisSession';

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
          <Text className="mb-0.5 text-xs text-[#8b95a1]">{formatQty(item.ccld_qty_smtl1)}주</Text>
          <ProfitText amount={item.evlu_pfls_amt2} rate={item.evlu_pfls_rt1} />
        </>
      }
    />
  );
}

export interface HoldingsData {
  positions: OverseasBalancePosition[] | null;
  loading: boolean;
  error: string | null;
}

/** 세션이 ready가 될 때마다(당겨서 새로고침 → 세션 재로드 포함) 잔고를 다시 조회한다. */
export function useHoldings(session: KisSessionState): HoldingsData {
  const [positions, setPositions] = useState<OverseasBalancePosition[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPositions = useCallback(async () => {
    if (session.kind !== 'ready') return;
    setLoading(true);
    setError(null);
    try {
      const result = await inquireOverseasBalance(session.session.environment, session.session.credentials, session.session.accessToken, {
        account: session.session.account,
      });
      setPositions(result.output1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    if (session.kind === 'ready') fetchPositions();
  }, [session, fetchPositions]);

  return { positions, loading, error };
}

/** 보유종목 패널 — 스크롤 없는 순수 패널(HoldingsAndPending의 ScrollView 안에서 렌더). */
export function HoldingsPanel({ data }: { data: HoldingsData }) {
  const { positions, loading, error } = data;
  return (
    <Panel title="보유종목">
      {positions === null && (loading || !error) ? (
        <SkeletonList />
      ) : positions === null && error ? (
        <EmptyState icon="alert-circle-outline" title="잠시 연결이 어려워요" description={`조금 뒤에 다시 시도해 주세요. (${error})`} />
      ) : positions !== null && positions.length === 0 ? (
        <EmptyState icon="cube-outline" title="보유 중인 종목이 없어요" description="매수하면 여기에 나타나요" />
      ) : (
        (positions ?? []).map((item, idx) => <HoldingRow key={`${item.pdno}-${idx}`} item={item} />)
      )}
      <View style={{ height: 8 }} />
    </Panel>
  );
}
