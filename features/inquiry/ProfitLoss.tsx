// 홈 손익 섹션 — (kis/periodProfit.ts inquireOverseasPeriodProfit, TTTS3039R 기간손익 조회).
// 상단 MonthNavigator("< 2026년 8월 >")로 년·월을 고르면, 그 달의 기간손익을 "일별 합계" 리스트로 보여준다
// (일별 접기/월 범위 계산은 features/inquiry/dailyProfit.ts). 금액은 WCRC_FRCR_DVSN_CD 기본값 02(원화)로
// 받으므로 원화(formatSignedKrw)로 표시한다.
// KIS가 당일 손익을 제공하지 않아, 현재 달에서는 앱 자체 기록(features/scalper/tradeStore)을 합산한
// "오늘예상" 행을 일별 리스트와 같은 형식으로 맨 위에 얹는다(응답 환율 → 잔고 환율 순으로 원화 환산,
// 둘 다 없을 때만 USD).
// 개별 사이클 상세는 홈 트레이딩 섹션 하단 "오늘 거래 기록" 패널(TradeHistory.tsx)로 분리했다.
// 일별 행을 누르면 그 날의 종목별 합계(실현손익·평균매수가→평균매도가·수량) 상세로 들어간다.
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ListRow } from '../../components/ListRow';
import { MonthNavigator } from '../../components/MonthNavigator';
import { Panel } from '../../components/Panel';
import { TickerAvatar } from '../../components/TickerAvatar';
import { inquireOverseasPeriodProfitAll, type PeriodProfitItem, type PeriodProfitSummary } from '../../kis/periodProfit';
import { formatKrw, formatSignedKrw, formatSignedPercent, formatSignedUsd, pnlColor } from '../../lib/format';
import { useUsdKrwRate } from '../../lib/useUsdKrwRate';
import { readTodayTrades, type StoredTrade } from '../scalper/tradeStore';
import { toStockMarketCode } from '../stock/marketCodes';
import { EmptyState, ErrorNotice, SetupNotice, SkeletonList } from './components';
import { KellySection } from './KellySection';
import { useKisSession } from './useKisSession';
import {
  aggregateDaily,
  aggregateDayByTicker,
  currentYearMonthKst,
  estimateToday,
  formatDayLabel,
  monthRange,
  todayKstDt,
  type DailyProfit,
  type DayTickerProfit,
  type TodayEstimate,
  type YearMonth,
} from './dailyProfit';

const clock = { now: () => Date.now() };

// memo — onSelect(안정 참조)와 day(월 데이터가 그대로면 참조 유지)만 비교해, 목록 리렌더에서 바뀐 행만 다시 그린다.
const DailyRow = memo(function DailyRow({
  day,
  onSelect,
}: {
  day: DailyProfit;
  onSelect: (tradeDt: string) => void;
}) {
  return (
    <ListRow
      title={formatDayLabel(day.tradeDt)}
      onPress={() => onSelect(day.tradeDt)}
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
});

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

/** 일별 상세의 종목 행 — "테슬라 · TSLA · 672원 → 692원 · 729주" + 우측 실현손익/수익률. 탭하면 종목상세. */
const DayTickerRow = memo(function DayTickerRow({ row }: { row: DayTickerProfit }) {
  const priceNote =
    row.avgBuyPrice !== null && row.avgSellPrice !== null
      ? ` · ${formatKrw(row.avgBuyPrice)} → ${formatKrw(row.avgSellPrice)}`
      : '';
  const handlePress = () => {
    const market = toStockMarketCode(row.exchangeCode);
    router.push({
      pathname: '/stock/[ticker]',
      params: { ticker: row.pdno, market: market ?? row.exchangeCode, name: row.name },
    });
  };
  return (
    <ListRow
      onPress={handlePress}
      leading={<TickerAvatar ticker={row.pdno} />}
      title={row.name || row.pdno}
      subtitle={`${row.pdno}${priceNote} · ${row.sellQty.toLocaleString('en-US')}주`}
      trailing={
        <>
          <Text style={{ color: pnlColor(row.totalPnl) }} className="text-sm font-bold">
            {formatSignedKrw(row.totalPnl)}
          </Text>
          <Text style={{ color: pnlColor(row.pnlRate) }} className="mt-0.5 text-xs font-semibold">
            {row.pnlRate === null ? '—' : formatSignedPercent(row.pnlRate, 2)}
          </Text>
        </>
      }
    />
  );
});

/**
 * 일별 상세 — 상단 "< 2026년 07월 31일 (금)" 바 + 그 날의 종목별 합계 리스트.
 * 상세로 들어가면 조회 화면의 상단 바·하단 메뉴가 숨어(뒤로가기가 둘이 되는 걸 막는다 — inquiry.tsx)
 * 이 바가 화면 최상단이 되므로 safe-area 상단 여백을 직접 채운다.
 */
function DayDetail({ day, onBack }: { day: DailyProfit; onBack: () => void }) {
  const rows = useMemo(() => aggregateDayByTicker(day.items), [day]);
  const insets = useSafeAreaInsets();
  // renderItem을 렌더마다 새로 만들지 않는다 — FlatList가 행 재렌더 여부를 안정적으로 판단하게.
  const renderRow = useCallback(({ item: row }: { item: DayTickerProfit }) => <DayTickerRow row={row} />, []);
  return (
    <View className="flex-1 bg-[#f2f4f6]">
      <View className="mb-2 flex-row items-center bg-white px-2 py-1" style={{ paddingTop: insets.top + 4 }}>
        <Pressable
          onPress={onBack}
          className="items-center justify-center active:opacity-60"
          style={{ width: 44, height: 44 }}
          accessibilityRole="button"
          accessibilityLabel="일별 목록으로"
        >
          <Ionicons name="chevron-back" size={20} color="#4e5968" />
        </Pressable>
        <Text className="text-lg font-bold text-[#191f28]">{`${day.tradeDt.slice(0, 4)}년 ${formatDayLabel(day.tradeDt)}`}</Text>
      </View>
      <Panel title="종목별 손익" style={{ flex: 1, marginBottom: 0 }}>
        <FlatList
          data={rows}
          keyExtractor={(row) => row.pdno}
          renderItem={renderRow}
          ListHeaderComponent={
            <View className="border-b border-[#e5e8eb] px-5 pb-4 pt-2">
              <Text className="text-xs text-[#8b95a1]">이 날 실현손익</Text>
              <Text className="mt-1 text-[22px] font-bold" style={{ color: pnlColor(day.totalPnl) }}>
                {formatSignedKrw(day.totalPnl)}
              </Text>
              <Text className="mt-1 text-sm font-semibold" style={{ color: pnlColor(day.pnlRate) }}>
                {day.pnlRate === null ? '—' : formatSignedPercent(day.pnlRate, 2)}
              </Text>
            </View>
          }
        />
      </Panel>
    </View>
  );
}

export interface ProfitLossProps {
  /** 일별 상세 진입/이탈 알림 — 조회 화면이 상단 바·하단 메뉴를 숨기고 되살리는 데 쓴다. */
  onDetailOpenChange?: (open: boolean) => void;
}

export function ProfitLoss({ onDetailOpenChange }: ProfitLossProps = {}) {
  const [reloadKey, setReloadKey] = useState(0);
  const session = useKisSession(reloadKey);
  const [ym, setYm] = useState<YearMonth>(() => currentYearMonthKst(clock.now()));

  const [items, setItems] = useState<PeriodProfitItem[] | null>(null);
  const [summary, setSummary] = useState<PeriodProfitSummary | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [localTrades, setLocalTrades] = useState<StoredTrade[] | null>(null);
  /** 일별 상세로 들어간 날(YYYYMMDD) — null이면 일별 목록. */
  const [selectedDt, setSelectedDt] = useState<string | null>(null);

  const nowYm = currentYearMonthKst(clock.now());
  const isCurrentMonth = ym.year === nowYm.year && ym.month === nowYm.month;
  const { startDt, endDt } = useMemo(() => monthRange(ym, clock.now()), [ym]);
  const dailyList = useMemo(() => aggregateDaily(items ?? []), [items]);

  // 월을 연타하면 이전 달 요청들이 아직 날아가는 중 — 마지막 요청만 화면에 반영한다(latest-wins).
  // 응답이 돌아온 시점에 순번이 밀렸으면(=그 사이 새 요청이 나감) 결과·에러 모두 버린다.
  const requestSeqRef = useRef(0);

  const fetchProfit = useCallback(async () => {
    if (session.kind !== 'ready') return;
    const seq = ++requestSeqRef.current;
    setDataError(null);
    try {
      const result = await inquireOverseasPeriodProfitAll(session.session.credentials, session.session.accessToken, {
        account: session.session.account,
        startDt,
        endDt,
      });
      if (seq !== requestSeqRef.current) return;
      setItems(result.items);
      setSummary(result.summary);
    } catch (e) {
      if (seq !== requestSeqRef.current) return;
      setDataError(e instanceof Error ? e.message : String(e));
      setItems(null);
      setSummary(null);
    } finally {
      if (seq === requestSeqRef.current) setRefreshing(false);
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

  // 일별 행 탭 — 안정 참조로 내려 DailyRow memo가 살아 있게 한다.
  const openDay = useCallback((tradeDt: string) => setSelectedDt(tradeDt), []);
  // renderItem을 렌더마다 새로 만들지 않는다 — FlatList가 행 재렌더 여부를 안정적으로 판단하게.
  const renderDaily = useCallback(
    ({ item: day }: { item: DailyProfit }) => <DailyRow day={day} onSelect={openDay} />,
    [openDay],
  );

  // 원화 환산용 환율 — 응답 summary의 exrt → 종목 행 exrt → 잔고 환율(lib/usdKrw) 순.
  // ⚠ 이 달에 청산 내역이 아직 없으면 기간손익 응답이 통째로 비어 exrt도 0이라, 정작 "오늘예상"이
  //   필요한 날에 환율이 없었다(= 달러 표시). 잔고 기준 환율 폴백이 그 구멍을 메운다.
  const balanceRate = useUsdKrwRate(reloadKey);
  const exchangeRate = useMemo(() => {
    if (summary && summary.exchangeRate > 0) return summary.exchangeRate;
    const fromItem = (items ?? []).find((i) => i.exchangeRate > 0);
    if (fromItem) return fromItem.exchangeRate;
    return balanceRate;
  }, [summary, items, balanceRate]);

  const todayDt = todayKstDt(clock.now());
  // KIS가 당일 행을 이미 내려주면(제공 시작 등) 예상 행을 겹쳐 그리지 않는다.
  const kisHasToday = dailyList.some((d) => d.tradeDt === todayDt);
  const todayEstimate = useMemo(
    () => estimateToday(localTrades ?? [], exchangeRate),
    [localTrades, exchangeRate],
  );
  const showTodayRow = isCurrentMonth && !kisHasToday && todayEstimate !== null;

  const selectedDay = selectedDt !== null ? dailyList.find((d) => d.tradeDt === selectedDt) : undefined;
  const detailOpen = selectedDay !== undefined;

  // 상세 진입/이탈을 조회 화면에 알린다 — 훅이므로 아래 조기 return(설정/에러 안내)보다 먼저 온다.
  // 세그먼트 전환 등으로 언마운트되면 cleanup으로 원상 복구.
  useEffect(() => {
    onDetailOpenChange?.(detailOpen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailOpen]);
  useEffect(() => {
    return () => onDetailOpenChange?.(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (session.kind === 'needsSetup') return <SetupNotice />;
  if (session.kind === 'error') return <ErrorNotice message={session.message} />;

  const kisFailed = dataError !== null && items === null;

  if (selectedDay) {
    return <DayDetail day={selectedDay} onBack={() => setSelectedDt(null)} />;
  }

  return (
    <View className="flex-1 bg-[#f2f4f6]">
      <MonthNavigator
        year={ym.year}
        month={ym.month}
        maxYear={nowYm.year}
        maxMonth={nowYm.month}
        onChange={(year, month) => {
          setSelectedDt(null);
          // 이전 달 데이터를 즉시 비워 스켈레톤을 띄운다 — 어느 달 데이터인지 헷갈리는 잔상을 막는다.
          // (당겨서 새로고침은 여기를 거치지 않으므로 기존 데이터 위에 스피너만 돈다.)
          setItems(null);
          setSummary(null);
          setDataError(null);
          setYm({ year, month });
        }}
      />

      {/* 데이터가 아직 없고 에러도 아니면 스켈레톤 — 로딩 플래그가 아니라 데이터 유무로 판단해, 월 전환 직후 fetch 시작 전 한 프레임에 빈 상태가 번쩍이지 않게 한다. */}
      {session.kind === 'loading' || (items === null && summary === null && !kisFailed) ? (
        <Panel title="손익" style={{ flex: 1, marginBottom: 0 }}>
          <SkeletonList />
        </Panel>
      ) : (
        <Panel title="일별 손익" style={{ flex: 1, marginBottom: 0 }}>
          <FlatList
            data={kisFailed ? [] : dailyList}
            keyExtractor={(day) => day.tradeDt}
            renderItem={renderDaily}
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
            // 켈리 배율 조회(docs/domain/켈리) — 기록된 거래 결과로 계산해 보여주기만 한다. 매매와 무관.
            ListFooterComponent={<KellySection />}
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
