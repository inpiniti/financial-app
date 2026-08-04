// 조회 탭 세그먼트 4 — 손익 (kis/periodProfit.ts inquireOverseasPeriodProfit, TTTS3039R 기간손익 조회).
// "오늘 거래"(features/inquiry/TodayTrades.tsx)를 대체한다 — 기간 pill(오늘/어제/1주/1달/1년/전체)로
// 기간을 고른 뒤 KIS 기간손익 내역을 보여준다. "오늘" 기간에는 앱이 직접 기록한 단타 사이클(features/scalper/tradeStore)도
// 함께 보여준다 — KIS 조회가 실패해도 이 로컬 섹션은 항상 표시한다(TodayTrades.tsx의 폴백 관례 계승).
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { ListRow } from '../../components/ListRow';
import { Panel } from '../../components/Panel';
import { TickerAvatar } from '../../components/TickerAvatar';
import { inquireOverseasPeriodProfit, type PeriodProfitItem, type PeriodProfitSummary } from '../../kis/periodProfit';
import { formatSignedPercent, formatSignedUsd, formatUsd, pnlColor } from '../../lib/format';
import { readTodayTrades, type StoredTrade } from '../scalper/tradeStore';
import { EmptyState, ErrorNotice, SetupNotice, SkeletonList } from './components';
import { useKisSession } from './useKisSession';

const clock = { now: () => Date.now() };

type PeriodKey = 'today' | 'yesterday' | 'week' | 'month' | 'year' | 'all';

const PERIODS: Array<{ key: PeriodKey; label: string }> = [
  { key: 'today', label: '오늘' },
  { key: 'yesterday', label: '어제' },
  { key: 'week', label: '1주' },
  { key: 'month', label: '1달' },
  { key: 'year', label: '1년' },
  { key: 'all', label: '전체' },
];

const DAY_MS = 24 * 60 * 60 * 1000;
/** 한국시간(UTC+9) 오프셋 — INQR_STRT_DT/END_DT는 문서상 YYYYMMDD, 이 앱은 한국시간 기준으로 날짜를 끊는다. */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** epoch ms → 한국시간 기준 'YYYYMMDD'. UTC 게터로 로컬 기기 시간대 영향을 받지 않게 한다. */
function toKstYyyymmdd(epochMs: number): string {
  const kst = new Date(epochMs + KST_OFFSET_MS);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(kst.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/** 기간 pill → { startDt, endDt }(YYYYMMDD, 한국시간 기준). 전체는 2020-01-01부터. */
function dateRangeFor(period: PeriodKey, nowMs: number): { startDt: string; endDt: string } {
  const today = toKstYyyymmdd(nowMs);
  switch (period) {
    case 'today':
      return { startDt: today, endDt: today };
    case 'yesterday': {
      const y = toKstYyyymmdd(nowMs - DAY_MS);
      return { startDt: y, endDt: y };
    }
    case 'week':
      return { startDt: toKstYyyymmdd(nowMs - 7 * DAY_MS), endDt: today };
    case 'month':
      return { startDt: toKstYyyymmdd(nowMs - 30 * DAY_MS), endDt: today };
    case 'year':
      return { startDt: toKstYyyymmdd(nowMs - 365 * DAY_MS), endDt: today };
    case 'all':
      return { startDt: '20200101', endDt: today };
  }
}

function ProfitRow({ item }: { item: PeriodProfitItem }) {
  return (
    <ListRow
      leading={<TickerAvatar ticker={item.pdno} />}
      title={item.pdno}
      subtitle={`${item.tradeDt.slice(0, 4)}.${item.tradeDt.slice(4, 6)}.${item.tradeDt.slice(6, 8)} · ${item.name}`}
      trailing={
        <>
          <Text style={{ color: pnlColor(item.realizedPnl) }} className="text-sm font-bold">
            {formatSignedUsd(item.realizedPnl)}
          </Text>
          <Text style={{ color: pnlColor(item.pnlRate) }} className="mt-0.5 text-xs font-semibold">
            {formatSignedPercent(item.pnlRate)}
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
  const [period, setPeriod] = useState<PeriodKey>('today');

  const [items, setItems] = useState<PeriodProfitItem[] | null>(null);
  const [summary, setSummary] = useState<PeriodProfitSummary | null>(null);
  const [loadingData, setLoadingData] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [localTrades, setLocalTrades] = useState<StoredTrade[] | null>(null);

  const { startDt, endDt } = useMemo(() => dateRangeFor(period, clock.now()), [period]);

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

  // "오늘" 기간에는 KIS 조회 성패와 무관하게 앱 자체 사이클 기록을 함께(또는 대신) 보여준다.
  useEffect(() => {
    if (period !== 'today') {
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
  }, [period]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setReloadKey((k) => k + 1);
    fetchProfit();
  }, [fetchProfit]);

  if (session.kind === 'needsSetup') return <SetupNotice />;
  if (session.kind === 'error') return <ErrorNotice message={session.message} />;

  const showLocalSection = period === 'today' && localTrades !== null;
  const kisFailed = dataError !== null && items === null;

  return (
    <View className="flex-1 bg-[#f2f4f6]">
      <View className="mb-2 bg-white px-2 py-2">
        <View className="flex-row flex-wrap px-3" style={{ gap: 8 }}>
          {PERIODS.map((p) => {
            const active = p.key === period;
            return (
              <Pressable
                key={p.key}
                onPress={() => setPeriod(p.key)}
                className={`items-center justify-center rounded-2xl px-4 py-2 ${active ? 'bg-[#3182f6]' : 'bg-[#f2f4f6]'}`}
                style={{ minHeight: 44 }}
              >
                <Text className={`text-sm font-semibold ${active ? 'text-white' : 'text-[#4e5968]'}`}>{p.label}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {session.kind === 'loading' || (loadingData && items === null && summary === null && !kisFailed) ? (
        <Panel title="손익" style={{ flex: 1, marginBottom: 0 }}>
          <SkeletonList />
        </Panel>
      ) : (
        <Panel title="기간손익 내역" style={{ flex: 1, marginBottom: 0 }}>
          <FlatList
            data={kisFailed ? [] : (items ?? [])}
            keyExtractor={(item, idx) => `${item.pdno}-${item.tradeDt}-${idx}`}
            renderItem={({ item }) => <ProfitRow item={item} />}
            contentContainerStyle={{ flexGrow: 1 }}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#3182f6" />}
            ListHeaderComponent={
              <>
                {!kisFailed && summary && (
                  <View className="border-b border-[#e5e8eb] px-5 pb-4 pt-2">
                    <Text className="text-xs text-[#8b95a1]">기간 실현손익</Text>
                    <Text className="mt-1 text-[22px] font-bold" style={{ color: pnlColor(summary.totalRealizedPnl) }}>
                      {formatSignedUsd(summary.totalRealizedPnl)}
                    </Text>
                    <Text className="mt-1 text-sm font-semibold" style={{ color: pnlColor(summary.totalPnlRate) }}>
                      {formatSignedPercent(summary.totalPnlRate)}
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
                <EmptyState icon="trending-down-outline" title="이 기간엔 손익이 없어요" description="다른 기간을 선택해 보세요" />
              )
            }
          />
        </Panel>
      )}
    </View>
  );
}
