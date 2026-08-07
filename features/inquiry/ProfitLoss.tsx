// 조회 탭 세그먼트 4 — 손익 (kis/periodProfit.ts inquireOverseasPeriodProfit, TTTS3039R 기간손익 조회).
// 상단 MonthNavigator("< 2026년 8월 >")로 년·월을 고르면, 그 달의 기간손익을 "일별 합계" 리스트로 보여준다
// (일별 접기/월 범위 계산은 features/inquiry/dailyProfit.ts). 금액은 WCRC_FRCR_DVSN_CD 기본값 02(원화)로
// 받으므로 원화(formatSignedKrw)로 표시한다.
// 현재 달을 보고 있을 때는 앱이 직접 기록한 오늘의 단타 사이클(features/scalper/tradeStore)도 함께 보여준다
// — KIS 조회가 실패해도 이 로컬 섹션은 항상 표시한다(TodayTrades.tsx 폴백 관례 계승).
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, RefreshControl, Text, View } from 'react-native';
import { ListRow } from '../../components/ListRow';
import { MonthNavigator } from '../../components/MonthNavigator';
import { Panel } from '../../components/Panel';
import { TickerAvatar } from '../../components/TickerAvatar';
import { inquireOverseasPeriodProfit, type PeriodProfitItem, type PeriodProfitSummary } from '../../kis/periodProfit';
import { formatSignedKrw, formatSignedPercent, formatSignedUsd, formatUsd, pnlColor } from '../../lib/format';
import { readTodayTrades, type StoredTrade } from '../scalper/tradeStore';
import { EmptyState, ErrorNotice, SetupNotice, SkeletonList } from './components';
import { useKisSession } from './useKisSession';
import { aggregateDaily, currentYearMonthKst, formatDayLabel, monthRange, type DailyProfit, type YearMonth } from './dailyProfit';

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

/**
 * 앱이 직접 기록한 오늘의 매수→매도 사이클 1건 — KIS 기간손익 조회 실패 시에도 표시되는 폴백 섹션의 행.
 * 색 규칙(PRD 관례: 이익=빨강, 손실=파랑)은 lib/format.pnlColor 하나로 통일한다(개별 파일에서 직접 삼항연산 금지).
 */
function LocalCycleRow({ item }: { item: StoredTrade }) {
  const isProfit = item.pnl > 0;
  const label =
    item.pnl === 0 ? formatSignedUsd(item.pnl) : `${formatSignedUsd(item.pnl)} (${isProfit ? '벌었어요' : '잃었어요'})`;
  // 수수료를 켠 뒤 기록에만 fees가 있다(옛 기록은 undefined) — 있을 때만 덧붙인다.
  const feeNote = item.fees && item.fees > 0 ? ` · 수수료 ${formatUsd(item.fees)}` : '';
  return (
    <ListRow
      leading={<TickerAvatar ticker={item.ticker} />}
      title={`${item.ticker} · 진입 ${formatUsd(item.entryPrice)} → 청산 ${formatUsd(item.exitPrice)}${feeNote}`}
      trailing={
        <Text style={{ color: pnlColor(item.pnl) }} className="text-sm font-bold">
          {label}
        </Text>
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

  // 현재 달을 보는 동안에는 KIS 조회 성패와 무관하게 앱 자체 사이클 기록을 함께(또는 대신) 보여준다.
  useEffect(() => {
    if (!isCurrentMonth) {
      setLocalTrades(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const local = await readTodayTrades(AsyncStorage, clock);
      // 시간순(진입 시각 기준) 정렬 — "오늘 매수→매도 사이클을 시간순으로" 요구사항.
      const sorted = [...local].sort((a, b) => a.entryTs - b.entryTs);
      if (!cancelled) setLocalTrades(sorted);
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

  if (session.kind === 'needsSetup') return <SetupNotice />;
  if (session.kind === 'error') return <ErrorNotice message={session.message} />;

  const showLocalSection = isCurrentMonth && localTrades !== null;
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

                {showLocalSection && (
                  <View className="border-b border-[#e5e8eb] pb-2">
                    <Text className="px-5 pb-1 pt-3 text-[15px] font-bold text-[#191f28]">오늘 앱 거래 기록</Text>
                    {(localTrades ?? []).length === 0 ? (
                      <EmptyState icon="receipt-outline" title="오늘 완료한 사이클이 없어요" description="매수→매도가 끝나면 여기에 나타나요" />
                    ) : (
                      (localTrades ?? []).map((t, idx) => (
                        <LocalCycleRow key={`${t.instanceId}-${t.exitTs}-${idx}`} item={t} />
                      ))
                    )}
                  </View>
                )}
              </>
            }
            ListEmptyComponent={
              kisFailed ? null : (
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
