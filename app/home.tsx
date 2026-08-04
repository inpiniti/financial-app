// 홈 화면(게이트 통과 후 최초 화면) — 옛 (tabs)/scalper.tsx. 하단 탭 바 제거에 따라 이 화면이 홈이 된다.
// 상단바: 좌측 "조회", 우측 "설정" 진입 버튼. 실행 배너·피드 배지·프리필 배너는 그대로 유지한다.
// 매매 로직·데이터 훅(features/scalper)은 원본 그대로 재사용 — 이 파일은 화면 배치만 담당한다.
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { EmptyState, ErrorNotice, SetupNotice } from '../features/inquiry/components';
import type { AutoPilotManager } from '../features/scalper/autopilotManager';
import { AddCard } from '../features/scalper/ui/AddCard';
import { AutoPilotScreen } from '../features/scalper/ui/AutoPilotScreen';
import { AddInstanceSheet, type AddInstanceInitial } from '../features/scalper/ui/AddInstanceSheet';
import { formatHHMM, isRunningState } from '../features/scalper/ui/format';
import { InstanceCard } from '../features/scalper/ui/InstanceCard';
import { useScalperManager } from '../features/scalper/ui/managerProvider';
import { PrefillBanner, type PrefillAccept } from '../features/scalper/ui/PrefillBanner';
import { RunningBanner } from '../features/scalper/ui/RunningBanner';
import { MAX_INSTANCES, type FeedEvent, type ScalperManager } from '../features/scalper/scalperManager';
import type { ScalperInstance } from '../features/scalper/scalperInstance';
import type { FeedStatus } from '../features/scalper/types';
import type { OverseasExchangeCode } from '../kis/trId';
import type { RealtimeMarketCode } from '../kis/realtimePrice';

const EMPTY_INITIAL: AddInstanceInitial = { ticker: '', qty: 1 };

type ScalperMode = 'manual' | 'auto';

// 탭 전환(언마운트/리마운트)에도 마지막 모드를 유지한다 — 세션 한정, 영속화하지 않는다.
let lastMode: ScalperMode = 'manual';

/** 수동/자동 모드 전환 세그먼트 — 화면당 포인트색 강조는 선택된 쪽 하나만. */
function ModeSwitch({ mode, onChange }: { mode: ScalperMode; onChange: (mode: ScalperMode) => void }) {
  const item = (value: ScalperMode, label: string) => {
    const selected = mode === value;
    return (
      <Pressable
        onPress={() => onChange(value)}
        className="flex-1 items-center justify-center rounded-xl active:opacity-70"
        style={{ minHeight: 36, backgroundColor: selected ? '#ffffff' : 'transparent' }}
        accessibilityRole="button"
        accessibilityState={{ selected }}
      >
        <Text className="text-sm font-semibold" style={{ color: selected ? '#191f28' : '#8b95a1' }}>
          {label}
        </Text>
      </Pressable>
    );
  };
  return (
    <View className="bg-white px-5 pb-3">
      <View className="flex-row rounded-xl bg-[#f2f4f6] p-1" style={{ gap: 4 }}>
        {item('manual', '수동 카드')}
        {item('auto', '자동 단타')}
      </View>
    </View>
  );
}

/** 인스턴스 market(RealtimeMarketCode — 아시아 포함) → 분봉 차트가 지원하는 미국 거래소 코드로 좁힌다. */
function toChartExcd(market: RealtimeMarketCode | undefined): 'NYS' | 'NAS' | 'AMS' | undefined {
  return market === 'NYS' || market === 'NAS' || market === 'AMS' ? market : undefined;
}

/** WS 연결 상태 배지 문구·색 — idle도 "아직 연결 안 됐다"를 알 수 있게 표시한다(숨기지 않는다). */
const FEED_STATUS_BADGE: Record<FeedStatus, { label: string; bg: string; fg: string }> = {
  idle: { label: '연결 전 — Run을 누르면 연결돼요', bg: '#f2f4f6', fg: '#8b95a1' },
  open: { label: '시세 연결됨', bg: '#e6f4ea', fg: '#03b26c' },
  connecting: { label: '시세 연결 중', bg: '#eaf2ff', fg: '#3182f6' },
  reconnecting: { label: '시세 재연결 중', bg: '#fff4e5', fg: '#ff9500' },
  closed: { label: '시세 끊김', bg: '#feeaea', fg: '#f04452' },
};

/** 홈 상단바 — 중앙 타이틀 "단타" + 좌측 조회·우측 설정(아이콘 전용, 라벨 없음). */
function HomeTopBar() {
  const insets = useSafeAreaInsets();

  return (
    <View
      className="flex-row items-center justify-between bg-white px-2"
      style={{ paddingTop: insets.top, minHeight: 44 + insets.top }}
    >
      <Pressable
        onPress={() => router.push('/inquiry')}
        hitSlop={8}
        className="items-center justify-center px-3 active:opacity-60"
        style={{ minHeight: 44, minWidth: 44 }}
        accessibilityRole="button"
        accessibilityLabel="조회 화면으로 이동"
      >
        <Ionicons name="search-outline" size={22} color="#191f28" />
      </Pressable>

      <Text className="text-[17px] font-bold text-[#191f28]">단타</Text>

      <Pressable
        onPress={() => router.push('/settings')}
        hitSlop={8}
        className="items-center justify-center px-3 active:opacity-60"
        style={{ minHeight: 44, minWidth: 44 }}
        accessibilityRole="button"
        accessibilityLabel="설정 화면으로 이동"
      >
        <Ionicons name="settings-outline" size={22} color="#191f28" />
      </Pressable>
    </View>
  );
}

/** 배지 아래 한 줄 — 구독 성공/실패·연결 오류 진단(마지막 이벤트, hh:mm 포함). */
function FeedEventLine({ event }: { event: FeedEvent | null }) {
  if (!event) return null;
  const isWarn =
    event.text.startsWith('구독 실패') ||
    event.text.startsWith('연결 오류') ||
    event.text.startsWith('자동매매 중단');
  return (
    <View className="items-center px-4 pb-2">
      <Text className="text-xs" style={{ color: isWarn ? '#f04452' : '#8b95a1' }}>
        {formatHHMM(event.at)} · {event.text}
      </Text>
    </View>
  );
}

/** 실행 중인 카드가 있는데 feedStatus가 closed면 더 급한 문구("연결이 끊겼어요")로 바꾼다. */
function FeedStatusBadge({ status, instances }: { status: FeedStatus; instances: ScalperInstance[] }) {
  const [anyRunning, setAnyRunning] = useState(() => instances.some((i) => isRunningState(i.state)));

  useEffect(() => {
    const recompute = () => {
      setAnyRunning((prev) => {
        const next = instances.some((i) => isRunningState(i.state));
        return prev === next ? prev : next;
      });
    };
    recompute();
    const unsubs = instances.map((i) => i.subscribe(recompute));
    return () => unsubs.forEach((u) => u());
  }, [instances]);

  const badge = FEED_STATUS_BADGE[status];
  const label = status === 'closed' && anyRunning ? '연결이 끊겼어요' : badge.label;

  return (
    <View className="items-center px-4 pb-2 pt-3">
      <View className="rounded-full px-3 py-1" style={{ backgroundColor: badge.bg }}>
        <Text className="text-xs font-semibold" style={{ color: badge.fg }}>
          {label}
        </Text>
      </View>
    </View>
  );
}

interface ScalperReadyScreenProps {
  manager: ScalperManager;
  autopilot: AutoPilotManager;
  defaultQty: number;
  bufferSize: number;
  chunkSeconds: number;
}

/** 매니저가 준비된 뒤('ready')의 실제 카드 리스트 화면. */
function ScalperReadyScreen({ manager, autopilot, defaultQty, bufferSize, chunkSeconds }: ScalperReadyScreenProps) {
  const [mode, setMode] = useState<ScalperMode>(lastMode);
  const handleModeChange = useCallback((next: ScalperMode) => {
    lastMode = next;
    setMode(next);
  }, []);
  const [instances, setInstances] = useState<ScalperInstance[]>(() => manager.getInstances());
  const [feedStatus, setFeedStatus] = useState<FeedStatus>(() => manager.getFeedStatus());
  const [feedEvent, setFeedEvent] = useState<FeedEvent | null>(() => manager.lastFeedEvent);
  // 구독 성공 ACK를 한 번이라도 받았는지 — 카드 진단 줄에서 "장 시간 문제"와 "구독 자체 실패"를 구분하는 데 쓴다.
  const [hasSubscribeAck, setHasSubscribeAck] = useState(() => manager.lastFeedEvent?.text.startsWith('구독 성공') ?? false);
  const [sheetVisible, setSheetVisible] = useState(false);
  const [sheetInitial, setSheetInitial] = useState<AddInstanceInitial>(EMPTY_INITIAL);
  const [pendingLocation, setPendingLocation] = useState<{
    market?: RealtimeMarketCode;
    exchange?: OverseasExchangeCode;
  }>({});

  // 인스턴스 추가/삭제(목록 변경)만 이 화면을 리렌더한다 — 개별 카드의 틱 갱신은 InstanceCard 자체 구독이 처리.
  useEffect(() => {
    setInstances(manager.getInstances());
    return manager.subscribe(setInstances);
  }, [manager]);

  // WS 연결 상태 배지 — feedStatus 변화 시에만 리렌더.
  useEffect(() => {
    setFeedStatus(manager.getFeedStatus());
    return manager.subscribeFeedStatus(setFeedStatus);
  }, [manager]);

  // 배지 아래 진단 한 줄(구독 ACK 성공/실패, 연결 오류) — 원인을 사용자가 스스로 확인하게.
  useEffect(() => {
    setFeedEvent(manager.lastFeedEvent);
    return manager.subscribeFeedDiagnostic((event) => {
      setFeedEvent(event);
      if (event.text.startsWith('구독 성공')) setHasSubscribeAck(true);
    });
  }, [manager]);

  const handleAddPress = useCallback(() => {
    setPendingLocation({});
    setSheetInitial({ ticker: '', qty: defaultQty });
    setSheetVisible(true);
  }, [defaultQty]);

  const handlePrefillAccept = useCallback(
    (payload: PrefillAccept) => {
      setPendingLocation({ market: payload.market, exchange: payload.exchange });
      setSheetInitial({ ticker: payload.ticker, qty: defaultQty });
      setSheetVisible(true);
    },
    [defaultQty],
  );

  const handleSheetSubmit = useCallback(
    (input: { ticker: string; qty: number }) => {
      try {
        manager.add({ ticker: input.ticker, qty: input.qty, ...pendingLocation });
        setSheetVisible(false);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        Alert.alert('알림', message);
      }
    },
    [manager, pendingLocation],
  );

  const handleRemove = useCallback((id: string) => manager.remove(id), [manager]);
  // Run/Stop은 매니저 경유가 필수 — manager.start(id)가 WS 연결(realtime.connect)까지 수행한다.
  const handleRun = useCallback((id: string) => manager.start(id), [manager]);
  const handleStop = useCallback((id: string) => manager.stop(id), [manager]);
  // updateQty가 실행 중이면 throw — InstanceCard가 그대로 받아 Alert로 노출한다.
  const handleEditQty = useCallback((id: string, qty: number) => manager.updateQty(id, qty), [manager]);
  // 오토런 토글 — 실행 중에도 허용(다음 완료 시 반영). 매니저 경유로 persist·인스턴스 반영.
  const handleToggleAutoRun = useCallback(
    (id: string, enabled: boolean) => manager.setAutoRun(id, enabled),
    [manager],
  );
  // 수량 마틴게일 토글 — 오토런과 직교(오토런이 꺼져 있으면 카드에서 비활성으로 보인다).
  const handleToggleMartingale = useCallback(
    (id: string, enabled: boolean) => manager.setMartingale(id, enabled),
    [manager],
  );

  const renderItem = useCallback(
    ({ item }: { item: ScalperInstance }) => (
      <InstanceCard
        instance={item}
        manager={manager}
        bufferSize={bufferSize}
        chunkSeconds={chunkSeconds}
        onRequestRemove={handleRemove}
        onRun={handleRun}
        onStop={handleStop}
        onEditQty={handleEditQty}
        onToggleAutoRun={handleToggleAutoRun}
        onToggleMartingale={handleToggleMartingale}
        hasSubscribeAck={hasSubscribeAck}
        chartExcd={toChartExcd(manager.getConfig(item.id)?.market)}
      />
    ),
    [
      bufferSize,
      chunkSeconds,
      handleEditQty,
      handleToggleAutoRun,
      handleToggleMartingale,
      handleRemove,
      handleRun,
      handleStop,
      hasSubscribeAck,
      manager,
    ],
  );

  const atLimit = instances.length >= MAX_INSTANCES;

  if (mode === 'auto') {
    return (
      <View className="flex-1 bg-[#f2f4f6]">
        <HomeTopBar />
        <ModeSwitch mode={mode} onChange={handleModeChange} />
        <AutoPilotScreen autopilot={autopilot} />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-[#f2f4f6]">
      <HomeTopBar />
      <ModeSwitch mode={mode} onChange={handleModeChange} />
      <RunningBanner instances={instances} />
      <FeedStatusBadge status={feedStatus} instances={instances} />
      <FeedEventLine event={feedEvent} />
      <FlatList
        data={instances}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={{ paddingTop: 8, paddingBottom: 32, flexGrow: 1 }}
        ListHeaderComponent={<PrefillBanner onAccept={handlePrefillAccept} />}
        ListFooterComponent={<AddCard disabled={atLimit} onPress={handleAddPress} />}
        ListEmptyComponent={
          <EmptyState icon="add-circle-outline" title="아직 단타 카드가 없어요" description="+ 추가로 첫 카드를 만들어 보세요" />
        }
      />
      <AddInstanceSheet
        visible={sheetVisible}
        initial={sheetInitial}
        onClose={() => setSheetVisible(false)}
        onSubmit={handleSheetSubmit}
      />
    </View>
  );
}

export default function HomeScreen() {
  const bootstrap = useScalperManager();

  if (bootstrap.kind === 'loading') {
    return (
      <View className="flex-1 items-center justify-center bg-[#f2f4f6]">
        <ActivityIndicator color="#3182f6" />
      </View>
    );
  }
  if (bootstrap.kind === 'needsSetup') {
    return (
      <View className="flex-1 bg-[#f2f4f6]">
        <HomeTopBar />
        <SetupNotice />
      </View>
    );
  }
  if (bootstrap.kind === 'error') {
    return (
      <View className="flex-1 bg-[#f2f4f6]">
        <HomeTopBar />
        <ErrorNotice message={bootstrap.message} />
      </View>
    );
  }

  return (
    <ScalperReadyScreen
      manager={bootstrap.manager}
      autopilot={bootstrap.autopilot}
      defaultQty={bootstrap.defaultQty}
      bufferSize={bootstrap.bufferSize}
      chunkSeconds={bootstrap.chunkSeconds}
    />
  );
}
