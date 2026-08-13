// 자동 트레이딩(오토파일럿) 화면.
// 상태 패널(오늘 성과·Run/Stop·PAUSED 복구) + 트레이딩 리스트 패널 + 오늘 거래 기록 + 기록 패널.
// 운용 설정(진입금액·동시 그리드·최소 속도)은 상단바 > 설정 > "트레이딩 설정"으로 옮겼다(2026-08-12) —
// 매매파라미터와 흩어져 있던 설정을 한 화면에 모았다. 값 반영은 managerProvider가 트레이딩 포커스마다 한다.
// app-ui-style: 풀폭 Panel + 촘촘한 ListRow, 이모지 금지(Ionicons), 손익 색은 pnlColor()만.
import { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { ListRow } from '../../../components/ListRow';
import { Panel } from '../../../components/Panel';
import { TickerAvatar } from '../../../components/TickerAvatar';
import { EmptyState } from '../../inquiry/components';
import { TradeHistoryPanel, useTodayTrades } from '../../inquiry/TradeHistory';
import { formatSignedKrw, formatSignedUsd, formatUsd, pnlColor } from '../../../lib/format';
import { useUsdKrwRate } from '../../../lib/useUsdKrwRate';
import type { AutoPilotEvent, AutoPilotState, AutoPilotView } from '../autopilot';
import type { AutoPilotManager, AutoPilotSlotRow } from '../autopilotManager';
import type { FeedEvent, ScalperManager } from '../scalperManager';
import type { SurgeEpisodeView } from '../surgeRecorder';
import { useSurgeEvents } from './useSurgeEvents';
import type { FeedStatus } from '../types';
import { isDaytimeSessionOpen } from '../daySession';
import { WATCH_SOURCE_LABEL } from '../watchlist';
import { AdoptSheet } from './AdoptSheet';
import { formatHHMM, formatPrice } from './format';
import { GridGauge } from './GridGauge';

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

/**
 * 주간거래 세션 배지(2026-08-10 실거래 재개) — KST 10~16시엔 주간거래 API(주문·시세)로 실거래가 나간다.
 * 일부 종목은 주간거래 미지원으로 주문이 거절될 수 있어 사용자가 세션을 인지하게 표시한다.
 */
function DaytimeBadge() {
  return (
    <View className="rounded-full px-3 py-1" style={{ backgroundColor: '#eaf2ff' }}>
      <Text className="text-xs font-semibold" style={{ color: '#3182f6' }}>
        주간거래
      </Text>
    </View>
  );
}

/**
 * 시세(WS) 연결 상태 배지 — 정상(open)·시작 전(idle)에는 아무것도 그리지 않고,
 * 문제 상태(연결 중·재연결 중·끊김)만 보여준다. 2026-08-10 갤럭시 실사고(안드로이드 평문 ws 차단으로
 * 실시간만 조용히 무한 재연결 — 화면에는 '감지중'만 표시) 재발 방지: 문제를 화면에서 바로 알 수 있게.
 */
const FEED_BADGE: Partial<Record<FeedStatus, { label: string; bg: string; fg: string }>> = {
  connecting: { label: '시세 연결 중', bg: '#f2f4f6', fg: '#8b95a1' },
  reconnecting: { label: '시세 재연결 중', bg: '#fff4e5', fg: '#ff9500' },
  closed: { label: '시세 끊김', bg: '#feeaea', fg: '#f04452' },
};

function FeedBadge({ status }: { status: FeedStatus }) {
  const badge = FEED_BADGE[status];
  if (!badge) return null;
  return (
    <View className="rounded-full px-3 py-1" style={{ backgroundColor: badge.bg }}>
      <Text className="text-xs font-semibold" style={{ color: badge.fg }}>
        {badge.label}
      </Text>
    </View>
  );
}

/** 피드 진단 이벤트 중 화면에 띄울 실패류('연결 오류 · …', '구독 실패 · …')인지 — 성공 ACK는 조용히 지나간다. */
function isFeedFailureEvent(event: FeedEvent | null): event is FeedEvent {
  return event !== null && (event.text.startsWith('연결 오류') || event.text.startsWith('구독 실패'));
}

/**
 * 급등(진입)·이탈 세트 행의 우측 상태 — 급등(open)은 상승색, 종결(closed)은 왕복 변동율을 pnlColor로.
 * 감지 중(alerting)·만료(expired)는 회색(docs/domain/surge-stock-finder). 단독 하락 행은 없다(세트만 기록).
 */
function SurgeTrailing({ ep }: { ep: SurgeEpisodeView }) {
  if (ep.status === 'alerting') {
    return <Text className="text-xs font-semibold text-[#8b95a1]">감지 중</Text>;
  }
  if (ep.status === 'open') {
    return (
      <View className="items-end">
        <Text className="text-sm font-bold text-[#f04452]">급등 {formatPrice(ep.surgePrice ?? null)}</Text>
        <Text className="mt-0.5 text-xs text-[#8b95a1]">이탈 대기</Text>
      </View>
    );
  }
  if (ep.status === 'expired') {
    // 트레일링 이탈이 조용한 하락까지 잡으므로, 만료는 거래가 끊긴 극단 케이스에서만 남는다.
    return <Text className="text-xs font-semibold text-[#8b95a1]">거래 끊김 — 만료</Text>;
  }
  // closed — 1호가 왕복(매도1호가에 사서 매수1호가에 판) 변동율이 핵심 지표, 없으면 체결가 변동율.
  const pct = ep.l1ChangePct ?? ep.priceChangePct;
  return (
    <View className="items-end">
      {pct != null ? (
        <Text className="text-sm font-bold" style={{ color: pnlColor(pct) }}>
          {pct >= 0 ? '+' : ''}
          {pct.toFixed(2)}%
        </Text>
      ) : (
        <Text className="text-xs font-semibold text-[#8b95a1]">호가 없음</Text>
      )}
      <Text className="mt-0.5 text-xs text-[#8b95a1]">
        {ep.l1ChangePct != null ? '1호가 왕복' : '체결가 기준'}
      </Text>
    </View>
  );
}

/** 급등(진입)·이탈 세트 패널 — 관찰 데이터 수집 전용(매매 연동 없음). 미기록(logged=false)은 경고 아이콘. */
function SurgePanel({ episodes }: { episodes: readonly SurgeEpisodeView[] }) {
  return (
    <Panel title="급등·이탈 기록" headerRight={episodes.length > 0 ? `최근 ${episodes.length}건` : undefined}>
      {episodes.length === 0 ? (
        <View className="px-5 pb-4">
          <Text className="text-sm text-[#8b95a1]">시작하면 급등 진입과 이탈 시점이 세트로 쌓여요</Text>
        </View>
      ) : (
        episodes.slice(0, 20).map((ep) => (
          <View key={ep.id} className="flex-row items-center px-5 py-2">
            <Text className="mr-2 text-xs text-[#8b95a1]">{formatHHMM(ep.plungeAt ?? ep.surgeAt ?? 0)}</Text>
            <View className="flex-1 flex-row items-center" style={{ gap: 4 }}>
              <Text className="text-sm font-semibold text-[#191f28]">{ep.ticker}</Text>
              {!ep.logged && ep.status !== 'alerting' && (
                // 기록 실패(네트워크·env 미설정) — 감지는 계속되지만 이 행은 DB에 없다.
                <Ionicons name="cloud-offline-outline" size={12} color="#ff9500" />
              )}
            </View>
            <SurgeTrailing ep={ep} />
          </View>
        ))
      )}
      <View style={{ height: 8 }} />
    </Panel>
  );
}

/** 리스트 행의 우측 상태 표시 — 보유 > 감시 > 핀(정리 대기) 순으로 하나만. */
function SlotBadge({ row, activeTickers }: { row: AutoPilotSlotRow; activeTickers: readonly string[] }) {
  if (activeTickers.includes(row.entry.ticker)) {
    return (
      <View className="mt-0.5 flex-row items-center" style={{ gap: 3 }}>
        <Ionicons name="ellipse" size={8} color="#03b26c" />
        <Text className="text-xs font-semibold text-[#03b26c]">보유 중</Text>
      </View>
    );
  }
  if (row.view.watched) {
    // 사다리 감시(2026-08-07 plan) — 홀 카운트가 쌓이는 중이면 몇 칸째인지 보여준다(0칸이면 "감시 중"만).
    const ladder = row.view.ladder;
    const counting = ladder !== null && ladder.count > 0;
    return (
      <View className="mt-0.5 flex-row items-center" style={{ gap: 3 }}>
        <Ionicons name={counting ? 'trending-down-outline' : 'pulse-outline'} size={12} color="#3182f6" />
        <Text className="text-xs font-semibold text-[#3182f6]">
          {counting ? `하락 ${ladder.count}/${ladder.triggerCount}칸` : '감시 중'}
        </Text>
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

/** 리스트 행 — "트레이딩 리스트" 패널의 연속이므로(FlatList 아이템) 직접 흰 배경을 입힌다.
 * 탭하면 부모가 액션시트(댓글/차트/호가)를 띄운다 — onPress는 표시용 UI 상태만 바꾼다(매매 로직 무관). */
function SlotRow({
  item,
  activeTickers,
  onPress,
}: {
  item: AutoPilotSlotRow;
  activeTickers: readonly string[];
  onPress: (ticker: string, market: string, name?: string) => void;
}) {
  // 종목명이 있으면 이름을 제목으로, 티커는 부제 맨 앞으로 — 이름 없이 티커만 보이면 무슨 종목인지
  // 알 수 없어 조회 탭 리스트(종목명 · 티커)와 읽는 방식이 달랐다.
  const { ticker, name } = item.entry;
  return (
    <Pressable
      className="bg-white"
      onPress={() => onPress(ticker, item.entry.market, name)}
      android_ripple={{ color: '#f2f4f6' }}
    >
      <ListRow
        leading={<TickerAvatar ticker={ticker} />}
        title={name || ticker}
        subtitle={`${name ? `${ticker} · ` : ''}${WATCH_SOURCE_LABEL[item.entry.source]} · ${item.view.tickRate.toFixed(1)}틱/초`}
        trailing={
          <View className="items-end">
            <Text className="text-base font-bold text-[#191f28]">{formatPrice(item.view.price)}</Text>
            <SlotBadge row={item} activeTickers={activeTickers} />
          </View>
        }
      />
    </Pressable>
  );
}

export interface AutoPilotScreenProps {
  autopilot: AutoPilotManager;
  /** 피드 허브 — WS 연결 상태 배지·구독 실패 진단 한 줄 표시용(ScalperManager가 이미 보존하는 값을 그리기만). */
  manager: ScalperManager;
}

export function AutoPilotScreen({ autopilot, manager }: AutoPilotScreenProps) {
  const [view, setView] = useState<AutoPilotView>(() => autopilot.pilot.getView());
  const [rows, setRows] = useState<readonly AutoPilotSlotRow[]>(() => autopilot.getRows());
  const [events, setEvents] = useState<readonly AutoPilotEvent[]>(() => autopilot.recentEvents);
  // 계좌 잔고 보유분을 그리드에 다시 태우는 시트(FAULT 이후 복구 경로).
  const [adoptVisible, setAdoptVisible] = useState(false);
  // 오늘 거래 기록(푸터 패널) — 사이클이 완료될 때마다(view.cycles 증가) 다시 읽는다.
  const trades = useTodayTrades(view.cycles);
  // 시세 피드 진단 — 매니저가 이미 보존 중인 연결 상태·마지막 진단 이벤트를 구독해 그린다.
  const [feedStatus, setFeedStatus] = useState<FeedStatus>(() => manager.getFeedStatus());
  const [feedEvent, setFeedEvent] = useState<FeedEvent | null>(() => manager.lastFeedEvent);
  // 오늘 성과 원화 병기용 환율(잔고 기준·30분 캐시) — 못 구하면 null이라 USD만 보여준다.
  const usdKrw = useUsdKrwRate();
  // 급등/급락 신호 에피소드(기록 전용) — 매니저 구독, 탭 전환 후 재마운트 시 스냅샷 재수화.
  const surgeEpisodes = useSurgeEvents(autopilot);

  useEffect(() => autopilot.subscribeView(setView), [autopilot]);
  useEffect(() => autopilot.subscribeList(setRows), [autopilot]);
  useEffect(() => manager.subscribeFeedStatus(setFeedStatus), [manager]);
  useEffect(() => manager.subscribeFeedDiagnostic(setFeedEvent), [manager]);
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

  const handleRun = useCallback(() => {
    if (!view.config) {
      Alert.alert('알림', '진입금액을 먼저 정해 주세요. 상단바 설정 > 트레이딩 설정에서 바꿀 수 있어요.');
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

  // 행 탭 → 종목 상세화면(차트/댓글/호가) — 3거래소 병합 리스트라 행마다 채용 거래소를 넘긴다.
  // 종목명도 함께 넘겨 상세 상단바가 티커만 덩그러니 뜨지 않게 한다(리스트와 같은 제목).
  const handleRowPress = useCallback((ticker: string, market: string, name?: string) => {
    router.push({ pathname: '/stock/[ticker]', params: name ? { ticker, market, name } : { ticker, market } });
  }, []);

  const renderRow = useCallback(
    ({ item }: { item: AutoPilotSlotRow }) => (
      <SlotRow item={item} activeTickers={view.activeTickers} onPress={handleRowPress} />
    ),
    [view.activeTickers, handleRowPress],
  );

  const config = view.config;
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
            <Panel
              title="자동 트레이딩"
              headerRight={
                <View className="flex-row items-center" style={{ gap: 6 }}>
                  <FeedBadge status={feedStatus} />
                  {isDaytimeSessionOpen(Date.now()) && <DaytimeBadge />}
                  <StateBadge state={view.state} />
                </View>
              }
            >
              <ListRow
                title="오늘 성과 · 오늘예상"
                subtitle={`사이클 ${view.cycles}회 · 그리드 ${view.activeTickers.length}/${view.maxGrids}개 관리 중`}
                trailing={
                  // 누적 손익은 USD로 쌓이지만 체감은 원화라 둘 다 보여준다 —
                  // 환율(잔고 기준)을 못 구했을 때만 예전처럼 USD 한 줄.
                  usdKrw !== null ? (
                    <>
                      <Text className="text-base font-bold" style={{ color: pnlColor(view.cumPnl) }}>
                        {formatSignedKrw(view.cumPnl * usdKrw)}
                      </Text>
                      <Text className="mt-0.5 text-xs font-semibold" style={{ color: pnlColor(view.cumPnl) }}>
                        {formatSignedUsd(view.cumPnl)}
                      </Text>
                    </>
                  ) : (
                    <Text className="text-base font-bold" style={{ color: pnlColor(view.cumPnl) }}>
                      {formatSignedUsd(view.cumPnl)}
                    </Text>
                  )
                }
              />
              {/* 실계좌로 나가는 금액이라 지금 걸린 값은 화면에 늘 보여야 한다 — 편집은 설정 화면에서만 한다. */}
              <View className="px-5 pb-2">
                <Text className="text-xs leading-5 text-[#8b95a1]">
                  {config
                    ? `종목당 ${formatUsd(config.startAmountUsd)} · 그리드 최대 ${view.maxGrids}개 · 최소 속도 ${config.minTickRate}틱/초`
                    : '진입금액이 아직 없어요 — 설정 > 트레이딩 설정에서 정해 주세요'}
                </Text>
              </View>
              {view.lastFault && (
                <View className="px-5 pb-2">
                  <Text className="text-xs leading-5 text-[#f04452]">{view.lastFault.text}</Text>
                  <Text className="mt-1 text-xs leading-5 text-[#8b95a1]">
                    해제하면 계좌에 남은 물량은 앱이 더 이상 관리하지 않아요. 다시 시작한 뒤 &quot;보유 종목
                    등록&quot;으로 그리드에 태울 수 있어요.
                  </Text>
                </View>
              )}
              {(isFeedFailureEvent(feedEvent) || feedStatus === 'reconnecting' || feedStatus === 'closed') && (
                <View className="px-5 pb-2">
                  {isFeedFailureEvent(feedEvent) && (
                    <Text className="text-xs leading-5 text-[#f04452]">
                      {formatHHMM(feedEvent.at)} · {feedEvent.text}
                    </Text>
                  )}
                  {(feedStatus === 'reconnecting' || feedStatus === 'closed') && (
                    <Text className="text-xs leading-5 text-[#8b95a1]">
                      실시간 시세 연결이 원활하지 않아요 — 가격이 계속 안 들어오면 네트워크 상태를 확인해
                      주세요
                    </Text>
                  )}
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
                  <Pressable
                    onPress={handleResume}
                    className="items-center rounded-2xl bg-[#3182f6] py-4 active:opacity-80"
                    style={{ minHeight: 48 }}
                  >
                    <Text className="text-base font-semibold text-white">입금했어요 — 재개하기</Text>
                  </Pressable>
                )}
                {running && (
                  <>
                    {/* 그리드 자리가 남아 있을 때만 — 만석이면 등록해도 거절되므로 버튼을 감춘다. */}
                    {view.activeTickers.length < view.maxGrids && (
                      <Pressable
                        onPress={() => setAdoptVisible(true)}
                        className="flex-row items-center justify-center rounded-2xl bg-[#eaf2ff] py-4 active:opacity-80"
                        style={{ minHeight: 48, gap: 6 }}
                      >
                        <Ionicons name="wallet-outline" size={16} color="#3182f6" />
                        <Text className="text-base font-semibold text-[#3182f6]">보유 종목 등록</Text>
                      </Pressable>
                    )}
                    <Pressable
                      onPress={handleStop}
                      className="items-center rounded-2xl bg-[#f7f9fc] py-4 active:opacity-80"
                      style={{ minHeight: 48 }}
                    >
                      <Text className="text-base font-semibold text-[#4e5968]">정지하기</Text>
                    </Pressable>
                  </>
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
                      {view.state === 'FAULT' ? '확인하고 해제하기' : '자동 트레이딩 시작하기'}
                    </Text>
                  </Pressable>
                )}
              </View>
            </Panel>
            {view.grids.length > 0 && (
              <Panel
                title="그리드 관리"
                headerRight={`${view.grids.length}/${view.maxGrids}개`}
              >
                {view.grids.map((grid, i) => (
                  <View key={grid.ticker}>
                    {/* 그리드 사이 구분선 — 게이지가 연달아 붙으면 어느 종목 것인지 읽기 어렵다. */}
                    {i > 0 && <View className="mx-5 h-px bg-[#f2f4f6]" />}
                    <GridGauge grid={grid} />
                  </View>
                ))}
              </Panel>
            )}
            {/* "트레이딩 리스트" 패널 헤더 — 행들은 FlatList 아이템으로 이어진다. */}
            <View className="bg-white">
              <View className="flex-row items-center justify-between px-5 pb-2 pt-4">
                <Text className="text-[15px] font-bold text-[#191f28]">트레이딩 리스트</Text>
                <Text className="text-xs text-[#8b95a1]">토스 거래량 실시간 순위 상위 {rows.length}종목</Text>
              </View>
            </View>
          </>
        }
        ListEmptyComponent={
          <View className="bg-white pb-4">
            <EmptyState
              icon="list-outline"
              title="아직 트레이딩 리스트가 비어 있어요"
              description="자동 트레이딩을 시작하면 순위에서 종목을 골라 채워요"
            />
          </View>
        }
        ListFooterComponent={
          <>
            {/* 리스트 패널 마감 여백 + 패널 간 갭. */}
            <View className="bg-white" style={{ height: 8, marginBottom: 8 }} />
            {/* 급등/급락 신호(관찰 기록) — 감지 품질을 데이터로 판단하기 위한 수집 전용 패널. */}
            <SurgePanel episodes={surgeEpisodes} />
            {/* 완료된 사이클(오늘 거래 기록)이 먼저 — 운영 이벤트 로그(기록)보다 자주 본다. */}
            <TradeHistoryPanel trades={trades} usdKrw={usdKrw} />
            <Panel title="기록" headerRight={events.length > 0 ? `최근 ${events.length}건` : undefined}>
              {events.length === 0 ? (
                <View className="px-5 pb-4">
                  <Text className="text-sm text-[#8b95a1]">시작하면 진입·청산 내역이 여기에 쌓여요</Text>
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
      <AdoptSheet visible={adoptVisible} autopilot={autopilot} onClose={() => setAdoptVisible(false)} />
    </View>
  );
}
