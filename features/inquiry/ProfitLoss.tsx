// 조회 탭 세그먼트 4 — 손익 (kis/periodProfit.ts inquireOverseasPeriodProfit, TTTS3039R 기간손익 조회).
// 상단 MonthNavigator("< 2026년 8월 >")로 년·월을 고르면, 그 달의 기간손익을 "일별 합계" 리스트로 보여준다
// (일별 접기/월 범위 계산은 features/inquiry/dailyProfit.ts). 금액은 WCRC_FRCR_DVSN_CD 기본값 02(원화)로
// 받으므로 원화(formatSignedKrw)로 표시한다.
// KIS가 당일 손익을 제공하지 않아, 현재 달에서는 앱 자체 기록(features/scalper/tradeStore)을 합산한
// "오늘예상" 행을 일별 리스트와 같은 형식으로 맨 위에 얹는다(응답 환율로 원화 환산, 환율 없으면 USD).
// 개별 사이클 상세는 조회 탭 "거래기록" 세그먼트(TradeHistory.tsx)로 분리했다.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, RefreshControl, Text, View } from 'react-native';
import { ListRow } from '../../components/ListRow';
import { MonthNavigator } from '../../components/MonthNavigator';
import { Panel } from '../../components/Panel';
import { inquireOverseasPeriodProfit, type PeriodProfitItem, type PeriodProfitSummary } from '../../kis/periodProfit';
import { formatSignedKrw, formatSignedPercent, formatSignedUsd, pnlColor } from '../../lib/format';
import { readTodayTrades, type StoredTrade } from '../scalper/tradeStore';
import { EmptyState, ErrorNotice, SetupNotice, SkeletonList } from './components';
import { useKisSession } from './useKisSession';
import {
  aggregateDaily,
  currentYearMonthKst,
  estimateToday,
  formatDayLabel,
  monthRange,
  todayKstDt,
  type DailyProfit,
  type TodayEstimate,
  type YearMonth,
} from './dailyProfit';

const clock = { now: () => Date.now() };

function DailyRow({ day }: { day: DailyProfit }) {
  return (
    <ListRow
      title={formatDayLabel(day.tradeDt)}
      trailing={
        <>
          <Text style={{ color: pnlColor(day.totalPnl) }} className="text-sm font-bold">
            {formatSignedKrw(day.totalPnl)}
          </Text>
          <Text style={{ color: pnlColor(day.pnlRate) }} className="mt-0.5 text-xs font-semibold">
            {day.pnlRate === null ? '—' : formatSignedPercent(day.pnlRate, 2)}
          </Text>
        </>
      }
    />
  );
}

/** 오늘예상 행 — 일별 행(DailyRow)과 같은 시각 형식, 환율이 없을 때만 USD로 표시한다. */
function TodayEstimateRow({ tradeDt, estimate }: { tradeDt: string; estimate: TodayEstimate }) {
  return (
    <ListRow
      title={`${formatDayLabel(tradeDt)} · 오늘예상`}
      trailing={
        <>
          <Text style={{ color: pnlColor(estimate.pnlUsd) }} className="text-sm font-bold">
            {estimate.pnlKrw !== null ? formatSignedKrw(estimate.pnlKrw) : formatSignedUsd(estimate.pnlUsd)}
          </Text>
          <Text style={{ color: pnlColor(estimate.pnlRate) }} className="mt-0.5 text-xs font-semibold">
            {estimate.pnlRate === null ? '—' : formatSignedPercent(estimate.pnlRate, 2)}
          </Text>
        </>
      }
    />
  );
}

export function ProfitLoss() {
  const [reloadKey, setReloadKey] = useState(0);
  const session = useKisSession(reloadKey);
  const [ym, setYm] = useState<YearMonth>(() => currentYearMonthKst(clock.now()));

  const [items, setItems] = useState<PeriodProfitItem[] | null>(null);
  const [summary, setSummary] = useState<PeriodProfitSummary | null>(null);
  const [loadingData, setLoadingData] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [localTrades, setLocalTrades] = useState<StoredTrade[] | null>(null);

  const nowYm = currentYearMonthKst(clock.now());
  const isCurrentMonth = ym.year === nowYm.year && ym.month === nowYm.month;
  const { startDt, endDt } = useMemo(() => monthRange(ym, clock.now()), [ym]);
  const dailyList = useMemo(() => aggregateDaily(items ?? []), [items]);

  const fetchProfit = useCallback(async () => {
    if (session.kind !== 'ready') return;
    setLoadingData(true);
    setDataError(null);
    try {
      const result = await inquireOverseasPeriodProfit(session.session.credentials, session.session.accessToken, {
        account: session.session.account,
        startDt,
        endDt,
      });
      setItems(result.items);
      setSummary(result.summary);
    } catch (e) {
      setDataError(e instanceof Error ? e.message : String(e));
      setItems(null);
      setSummary(null);
    } finally {
      setLoadingData(false);
      setRefreshing(false);
    }
  }, [session, startDt, endDt]);

  useEffect(() => {
    if (session.kind === 'ready') fetchProfit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, startDt, endDt]);

  // 현재 달을 보는 동안에는 KIS 조회 성패와 무관하게 앱 자체 사이클 기록으로 "오늘예상"을 만든다.
  useEffect(() => {
    if (!isCurrentMonth) {
      setLocalTrades(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const local = await readTodayTrades(AsyncStorage, clock);
      if (!cancelled) setLocalTrades(local);
    })();
    return () => {
      cancelled = true;
    };
  }, [isCurrentMonth, reloadKey]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setReloadKey((k) => k + 1);
    fetchProfit();
  }, [fetchProfit]);

  // 원화 환산용 환율 — 응답 summary의 exrt를 우선, 없으면 종목 행에서 찾는다(둘 다 없으면 USD 표시).
  const exchangeRate = useMemo(() => {
    if (summary && summary.exchangeRate > 0) return summary.exchangeRate;
    const fromItem = (items ?? []).find((i) => i.exchangeRate > 0);
    return fromItem ? fromItem.exchangeRate : null;
  }, [summary, items]);

  const todayDt = todayKstDt(clock.now());
  // KIS가 당일 행을 이미 내려주면(제공 시작 등) 예상 행을 겹쳐 그리지 않는다.
  const kisHasToday = dailyList.some((d) => d.tradeDt === todayDt);
  const todayEstimate = useMemo(
    () => estimateToday(localTrades ?? [], exchangeRate),
    [localTrades, exchangeRate],
  );
  const showTodayRow = isCurrentMonth && !kisHasToday && todayEstimate !== null;

  if (session.kind === 'needsSetup') return <SetupNotice />;
  if (session.kind === 'error') return <ErrorNotice message={session.message} />;

  const kisFailed = dataError !== null && items === null;

  return (
    <View className="flex-1 bg-[#f2f4f6]">
      <MonthNavigator
        year={ym.year}
        month={ym.month}
        maxYear={nowYm.year}
        maxMonth={nowYm.month}
        onChange={(year, month) => setYm({ year, month })}
      />

      {session.kind === 'loading' || (loadingData && items === null && summary === null && !kisFailed) ? (
        <Panel title="손익" style={{ flex: 1, marginBottom: 0 }}>
          <SkeletonList />
        </Panel>
      ) : (
        <Panel title="일별 손익" style={{ flex: 1, marginBottom: 0 }}>
          <FlatList
            data={kisFailed ? [] : dailyList}
            keyExtractor={(day) => day.tradeDt}
            renderItem={({ item: day }) => <DailyRow day={day} />}
            contentContainerStyle={{ flexGrow: 1 }}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#3182f6" />}
            ListHeaderComponent={
              <>
                {!kisFailed && summary && (
                  <View className="border-b border-[#e5e8eb] px-5 pb-4 pt-2">
                    <Text className="text-xs text-[#8b95a1]">{`${ym.month}월 실현손익`}</Text>
                    <Text className="mt-1 text-[22px] font-bold" style={{ color: pnlColor(summary.totalRealizedPnl) }}>
                      {formatSignedKrw(summary.totalRealizedPnl)}
                    </Text>
                    <Text className="mt-1 text-sm font-semibold" style={{ color: pnlColor(summary.totalPnlRate) }}>
                      {formatSignedPercent(summary.totalPnlRate, 2)}
                    </Text>
                  </View>
                )}

                {kisFailed && (
                  <View className="bg-[#fff9db] px-5 py-3">
                    <Text className="text-xs text-[#8b6f00]">잠시 연결이 어려워 KIS 손익 내역을 불러오지 못했어요</Text>
                  </View>
                )}

                {showTodayRow && todayEstimate && <TodayEstimateRow tradeDt={todayDt} estimate={todayEstimate} />}
              </>
            }
            ListEmptyComponent={
              kisFailed || showTodayRow ? null : (
                <EmptyState
                  icon="trending-down-outline"
                  title="이 달엔 손익이 없어요"
                  description="다른 달을 선택해 보세요"
                />
              )
            }
          />
        </Panel>
      )}
    </View>
  );
}
