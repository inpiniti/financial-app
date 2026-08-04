// 자동 단타(오토파일럿) 화면 — plan §3-6단계 + 세션 확장(2026-08-01) §2-5.
// 상태 패널(설정·세션·오늘 성과·Run/Stop·PAUSED 복구) + 단타 리스트 패널 + 기록 패널.
// app-ui-style: 풀폭 Panel + 촘촘한 ListRow, 이모지 금지(Ionicons), 손익 색은 pnlColor()만.
import { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ActionSheet } from '../../../components/ActionSheet';
import { ListRow } from '../../../components/ListRow';
import { Panel } from '../../../components/Panel';
import { TickerAvatar } from '../../../components/TickerAvatar';
import { EmptyState } from '../../inquiry/components';
import { formatSignedUsd, formatUsd, pnlColor } from '../../../lib/format';
import { isMartingaleOn } from '../autopilot';
import type { AutoPilotEvent, AutoPilotState, AutoPilotView } from '../autopilot';
import type { AutoPilotManager, AutoPilotSlotRow } from '../autopilotManager';
import { WATCH_SOURCE_LABEL } from '../watchlist';
import type { MinuteChartExchangeCode } from '../../../kis/minuteChart';
import { AmountSheet } from './AmountSheet';
import { ChartSheet } from './ChartSheet';
import { CommentsSheet } from './CommentsSheet';
import { formatHHMM, formatPrice } from './format';
import { GridGauge } from './GridGauge';
import { WatchQuoteSheet } from './WatchQuoteSheet';

/** 리스트 분봉 조회 EXCD — 리스트가 NAS 전용(autopilotManager.ts MARKET 상수)이므로 고정. */
const AUTOPILOT_CHART_EXCD: MinuteChartExchangeCode = 'NAS';

const STATE_BADGE: Record<AutoPilotState, { label: string; bg: string; fg: string }> = {
  IDLE: { label: '대기 중', bg: '#f2f4f6', fg: '#8b95a1' },
  SCANNING: { label: '변곡점 감시 중', bg: '#eaf2ff', fg: '#3182f6' },
  ENTERING: { label: '매수 중', bg: '#fff4e5', fg: '#ff9500' },
  HOLDING: { label: '보유 중', bg: '#e6f4ea', fg: '#03b26c' },
  EXITING: { label: '매도 중', bg: '#fff4e5', fg: '#ff9500' },
  PAUSED: { label: '일시정지 — 현금 부족', bg: '#fff4e5', fg: '#ff9500' },
  FAULT: { label: '멈춤 — 확인 필요', bg: '#feeaea', fg: '#f04452' },
};

function StateBadge({ state }: { state: AutoPilotState }) {
  const badge = STATE_BADGE[state];
  return (
    <View className="rounded-full px-3 py-1" style={{ backgroundColor: badge.bg }}>
      <Text className="text-xs font-semibold" style={{ color: badge.fg }}>
        {badge.label}
      </Text>
    </View>
  );
}

/** 리스트 행의 우측 상태 표시 — 보유 > 감시 > 핀(정리 대기) 순으로 하나만. */
function SlotBadge({ row, activeTicker }: { row: AutoPilotSlotRow; activeTicker: string | null }) {
  if (activeTicker === row.entry.ticker) {
    return (
      <View className="mt-0.5 flex-row items-center" style={{ gap: 3 }}>
        <Ionicons name="ellipse" size={8} color="#03b26c" />
        <Text className="text-xs font-semibold text-[#03b26c]">보유 중</Text>
      </View>
    );
  }
  if (row.view.watched) {
    return (
      <View className="mt-0.5 flex-row items-center" style={{ gap: 3 }}>
        <Ionicons name="pulse-outline" size={12} color="#3182f6" />
        <Text className="text-xs font-semibold text-[#3182f6]">감시 중</Text>
      </View>
    );
  }
  if (row.entry.pinned) {
    return (
      <View className="mt-0.5 flex-row items-center" style={{ gap: 3 }}>
        <Ionicons name="lock-closed-outline" size={11} color="#ff9500" />
        <Text className="text-xs font-semibold text-[#ff9500]">정리 대기</Text>
      </View>
    );
  }
  return null;
}

/** 리스트 행 — "단타 리스트" 패널의 연속이므로(FlatList 아이템) 직접 흰 배경을 입힌다.
 * 탭하면 부모가 액션시트(댓글/차트/호가)를 띄운다 — onPress는 표시용 UI 상태만 바꾼다(매매 로직 무관). */
function SlotRow({
  item,
  activeTicker,
  onPress,
}: {
  item: AutoPilotSlotRow;
  activeTicker: string | null;
  onPress: (ticker: string) => void;
}) {
  return (
    <Pressable className="bg-white" onPress={() => onPress(item.entry.ticker)} android_ripple={{ color: '#f2f4f6' }}>
      <ListRow
        leading={<TickerAvatar ticker={item.entry.ticker} />}
        title={item.entry.ticker}
        subtitle={`${WATCH_SOURCE_LABEL[item.entry.source]} · ${item.view.tickRate.toFixed(1)}틱/초`}
        trailing={
          <View className="items-end">
            <Text className="text-base font-bold text-[#191f28]">{formatPrice(item.view.price)}</Text>
            <SlotBadge row={item} activeTicker={activeTicker} />
          </View>
        }
      />
    </Pressable>
  );
}

export interface AutoPilotScreenProps {
  autopilot: AutoPilotManager;
}

export function AutoPilotScreen({ autopilot }: AutoPilotScreenProps) {
  const [view, setView] = useState<AutoPilotView>(() => autopilot.pilot.getView());
  const [rows, setRows] = useState<readonly AutoPilotSlotRow[]>(() => autopilot.getRows());
  const [events, setEvents] = useState<readonly AutoPilotEvent[]>(() => autopilot.recentEvents);
  const [sheetVisible, setSheetVisible] = useState(false);
  // 리스트 행 탭 → 액션시트(댓글/차트/호가) → 셋 중 하나의 조회 전용 시트. InstanceCard.tsx의 3버튼과 동일 대상.
  const [actionSheetTicker, setActionSheetTicker] = useState<string | null>(null);
  const [commentsTicker, setCommentsTicker] = useState<string | null>(null);
  const [chartTicker, setChartTicker] = useState<string | null>(null);
  const [quoteTicker, setQuoteTicker] = useState<string | null>(null);

  useEffect(() => autopilot.subscribeView(setView), [autopilot]);
  useEffect(() => autopilot.subscribeList(setRows), [autopilot]);
  useEffect(
    () => autopilot.subscribeEvents(() => setEvents([...autopilot.recentEvents])),
    [autopilot],
  );

  // 틱/초·현재가는 이벤트 없이도 계속 변한다 — 구동 중에만 2초 주기로 행을 다시 읽는다(매 틱 리렌더 금지).
  const engaged = view.state !== 'IDLE' && view.state !== 'FAULT';
  const running = engaged && view.state !== 'PAUSED';
  useEffect(() => {
    if (!engaged) return;
    const timer = setInterval(() => setRows(autopilot.getRows()), 2000);
    return () => clearInterval(timer);
  }, [autopilot, engaged]);

  const handleConfigPress = useCallback(() => {
    if (view.state !== 'IDLE') {
      Alert.alert('알림', '설정은 정지 상태에서 바꿀 수 있어요. 먼저 Stop을 눌러 주세요.');
      return;
    }
    setSheetVisible(true);
  }, [view.state]);

  const handleConfigSubmit = useCallback(
    (config: Parameters<typeof autopilot.pilot.setConfig>[0]) => {
      const error = autopilot.pilot.setConfig(config);
      if (!error) setSheetVisible(false);
      return error;
    },
    [autopilot],
  );

  const handleRun = useCallback(() => {
    if (!view.config) {
      setSheetVisible(true);
      return;
    }
    try {
      autopilot.start();
    } catch (e) {
      Alert.alert('알림', e instanceof Error ? e.message : String(e));
    }
  }, [autopilot, view.config]);

  const handleStop = useCallback(() => autopilot.stop(), [autopilot]);
  const handleResume = useCallback(() => autopilot.pilot.resume(), [autopilot]);
  const handleResetSession = useCallback(() => {
    Alert.alert('세션 초기화', '현재 세션을 버리고 시작금액부터 새로 시작할까요?', [
      { text: '닫기', style: 'cancel' },
      { text: '초기화하고 재개하기', onPress: () => autopilot.pilot.resetSession() },
    ]);
  }, [autopilot]);

  const handleRowPress = useCallback((ticker: string) => setActionSheetTicker(ticker), []);

  const renderRow = useCallback(
    ({ item }: { item: AutoPilotSlotRow }) => (
      <SlotRow item={item} activeTicker={view.activeTicker} onPress={handleRowPress} />
    ),
    [view.activeTicker, handleRowPress],
  );

  // 액션시트(Modal)가 닫히는 애니메이션 중에 대상 시트(또 다른 Modal)를 동시에 띄우면 iOS에서 프리즈가 난다
  // (RN Modal 스택킹). 그래서 티커를 클로저에 잡아두고, 액션시트가 완전히 사라진 뒤(280ms > 닫힘 260ms)에 연다.
  const openAfterActionSheet = useCallback((open: (t: string) => void, ticker: string) => {
    setTimeout(() => open(ticker), 280);
  }, []);

  const actionSheetOptions = actionSheetTicker
    ? [
        {
          icon: 'chatbubble-outline' as const,
          label: '토스 댓글',
          onPress: () => openAfterActionSheet(setCommentsTicker, actionSheetTicker),
        },
        {
          icon: 'stats-chart-outline' as const,
          label: '차트',
          onPress: () => openAfterActionSheet(setChartTicker, actionSheetTicker),
        },
        {
          icon: 'list-outline' as const,
          label: '호가',
          onPress: () => openAfterActionSheet(setQuoteTicker, actionSheetTicker),
        },
      ]
    : [];

  const config = view.config;
  const session = view.session;
  const idleWatch = view.state === 'SCANNING' && view.watched.length === 0 && rows.length > 0;

  return (
    <View className="flex-1 bg-[#f2f4f6]">
      <FlatList
        data={rows as AutoPilotSlotRow[]}
        keyExtractor={(item) => item.entry.ticker}
        renderItem={renderRow}
        contentContainerStyle={{ paddingBottom: 32 }}
        ListHeaderComponent={
          <>
            <Panel title="자동 단타" headerRight={<StateBadge state={view.state} />}>
              <ListRow
                title="설정"
                subtitle={
                  config
                    ? `${isMartingaleOn(config) ? '마틴게일' : '금액 고정'} · 최소 속도 ${config.minTickRate}틱/초`
                    : '탭해서 설정해 주세요'
                }
                trailing={
                  <View className="flex-row items-center" style={{ gap: 6 }}>
                    <Text className="text-base font-bold text-[#191f28]">
                      {config
                        ? isMartingaleOn(config)
                          ? `${formatUsd(config.startAmountUsd)} ~ ${formatUsd(config.maxAmountUsd)}`
                          : formatUsd(config.startAmountUsd)
                        : '설정 전'}
                    </Text>
                    <Ionicons name="chevron-forward" size={16} color="#8b95a1" />
                  </View>
                }
                onPress={handleConfigPress}
              />
              {session && (
                <ListRow
                  title={`세션 #${view.sessionCount}`}
                  subtitle={`이번 세션 ${session.cycles}사이클 · 투입 ${formatUsd(session.amountUsd)}`}
                  trailing={
                    <Text className="text-base font-bold" style={{ color: pnlColor(session.pnl) }}>
                      {formatSignedUsd(session.pnl)}
                    </Text>
                  }
                />
              )}
              <ListRow
                title="오늘 성과"
                subtitle={`사이클 ${view.cycles}회 · 세션 ${view.sessionCount}개`}
                trailing={
                  <Text className="text-base font-bold" style={{ color: pnlColor(view.cumPnl) }}>
                    {formatSignedUsd(view.cumPnl)}
                  </Text>
                }
              />
              {view.lastFault && (
                <View className="px-5 pb-2">
                  <Text className="text-xs leading-5 text-[#f04452]">{view.lastFault.text}</Text>
                </View>
              )}
              {idleWatch && config && (
                <View className="px-5 pb-2">
                  <Text className="text-xs leading-5 text-[#8b95a1]">
                    모든 종목이 {config.minTickRate}틱/초 미만이라 기다리고 있어요 — 거래가 살아나면 자동으로 감시를
                    시작해요
                  </Text>
                </View>
              )}
              <View className="px-5 pb-4 pt-2" style={{ gap: 8 }}>
                {view.state === 'PAUSED' && (
                  <>
                    <Pressable
                      onPress={handleResume}
                      className="items-center rounded-2xl bg-[#3182f6] py-4 active:opacity-80"
                      style={{ minHeight: 48 }}
                    >
                      <Text className="text-base font-semibold text-white">입금했어요 — 이어서 재개하기</Text>
                    </Pressable>
                    <Pressable
                      onPress={handleResetSession}
                      className="items-center rounded-2xl bg-[#f7f9fc] py-4 active:opacity-80"
                      style={{ minHeight: 48 }}
                    >
                      <Text className="text-base font-semibold text-[#4e5968]">세션 초기화하고 재개하기</Text>
                    </Pressable>
                  </>
                )}
                {running && (
                  <Pressable
                    onPress={handleStop}
                    className="items-center rounded-2xl bg-[#f7f9fc] py-4 active:opacity-80"
                    style={{ minHeight: 48 }}
                  >
                    <Text className="text-base font-semibold text-[#4e5968]">정지하기</Text>
                  </Pressable>
                )}
                {view.state === 'PAUSED' && (
                  <Pressable onPress={handleStop} className="items-center py-2 active:opacity-60">
                    <Text className="text-sm font-semibold text-[#8b95a1]">정지하기</Text>
                  </Pressable>
                )}
                {(view.state === 'IDLE' || view.state === 'FAULT') && (
                  <Pressable
                    onPress={view.state === 'FAULT' ? handleStop : handleRun}
                    className="items-center rounded-2xl py-4 active:opacity-80"
                    style={{ minHeight: 48, backgroundColor: view.state === 'FAULT' ? '#f04452' : '#3182f6' }}
                  >
                    <Text className="text-base font-semibold text-white">
                      {view.state === 'FAULT' ? '확인하고 해제하기' : '자동 단타 시작하기'}
                    </Text>
                  </Pressable>
                )}
              </View>
            </Panel>
            {view.grid && (
              <Panel title="그리드 관리">
                <GridGauge grid={view.grid} />
              </Panel>
            )}
            {/* "단타 리스트" 패널 헤더 — 행들은 FlatList 아이템으로 이어진다. */}
            <View className="bg-white">
              <View className="flex-row items-center justify-between px-5 pb-2 pt-4">
                <Text className="text-[15px] font-bold text-[#191f28]">단타 리스트</Text>
                <Text className="text-xs text-[#8b95a1]">거래량·증가율·회전율·상승률 상위 {rows.length}종목</Text>
              </View>
            </View>
          </>
        }
        ListEmptyComponent={
          <View className="bg-white pb-4">
            <EmptyState
              icon="list-outline"
              title="아직 단타 리스트가 비어 있어요"
              description="자동 단타를 시작하면 순위에서 종목을 골라 채워요"
            />
          </View>
        }
        ListFooterComponent={
          <>
            {/* 리스트 패널 마감 여백 + 패널 간 갭. */}
            <View className="bg-white" style={{ height: 8, marginBottom: 8 }} />
            <Panel title="기록" headerRight={events.length > 0 ? `최근 ${events.length}건` : undefined}>
              {events.length === 0 ? (
                <View className="px-5 pb-4">
                  <Text className="text-sm text-[#8b95a1]">시작하면 진입·청산·세션 내역이 여기에 쌓여요</Text>
                </View>
              ) : (
                events.slice(0, 20).map((e, i) => (
                  <View key={`${e.at}-${i}`} className="flex-row px-5 py-2">
                    <Text className="mr-2 text-xs text-[#8b95a1]">{formatHHMM(e.at)}</Text>
                    <Text className="flex-1 text-xs leading-5 text-[#4e5968]">{e.text}</Text>
                  </View>
                ))
              )}
              <View style={{ height: 8 }} />
            </Panel>
          </>
        }
      />
      <AmountSheet
        visible={sheetVisible}
        initial={view.config}
        onClose={() => setSheetVisible(false)}
        onSubmit={handleConfigSubmit}
      />
      <ActionSheet
        visible={actionSheetTicker !== null}
        onClose={() => setActionSheetTicker(null)}
        title={actionSheetTicker ?? undefined}
        options={actionSheetOptions}
      />
      <CommentsSheet
        visible={commentsTicker !== null}
        ticker={commentsTicker ?? ''}
        onClose={() => setCommentsTicker(null)}
      />
      <ChartSheet
        visible={chartTicker !== null}
        ticker={chartTicker ?? ''}
        excd={AUTOPILOT_CHART_EXCD}
        onClose={() => setChartTicker(null)}
      />
      <WatchQuoteSheet
        visible={quoteTicker !== null}
        ticker={quoteTicker ?? ''}
        getRow={() => autopilot.getRows().find((r) => r.entry.ticker === quoteTicker)}
        onClose={() => setQuoteTicker(null)}
      />
    </View>
  );
}
