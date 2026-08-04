// 단타 탭 인스턴스 카드 — ScalperInstance 1개를 구독해 그 카드만 리렌더한다(매 틱 전체 리스트 리렌더 금지).
import { memo, useEffect, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { TickerAvatar } from '../../../components/TickerAvatar';
import type { MinuteChartExchangeCode } from '../../../kis/minuteChart';
import type { ScalperInstance } from '../scalperInstance';
import type { ScalperManager } from '../scalperManager';
import type { ScalperInstanceView } from '../types';
import { ChartSheet } from './ChartSheet';
import { CommentsSheet } from './CommentsSheet';
import { EditQtySheet } from './EditQtySheet';
import { QuoteSheet } from './QuoteSheet';
import {
  STATE_BADGE_COLOR,
  STATE_LABEL,
  canRun,
  canStop,
  formatPrice,
  formatRate,
  formatSigned,
  isRunningState,
  pnlColor,
  SIGNAL_LABEL,
} from './format';

/** 이 시간 이상 틱이 없으면 "끊겼어요"로 본다(시세 수신 진단). */
const STALE_TICK_MS = 15000;
/** 분봉 조회 EXCD 기본값 — 부모(scalper.tsx)가 manager.getConfig(id).market을 못 찾은 경우의 폴백. */
const DEFAULT_CHART_EXCD: MinuteChartExchangeCode = 'NAS';
/** 진단 줄 색(경고=주황, 정상 수신=회색) — 기존 BUYING/SELLING 배지 색과 동일 톤. */
const DIAGNOSIS_WARN_COLOR = '#ff9500';
const DIAGNOSIS_NEUTRAL_COLOR = '#8b95a1';

export interface InstanceCardProps {
  instance: ScalperInstance;
  /** 📊 호가 시트(QuoteSheet)가 구독 ACK 상태(trKey별)를 조회하는 데 필요 — 인스턴스 자체엔 없는 매니저 전용 정보. */
  manager: ScalperManager;
  /** 워밍업 진행률 표시용(설정 탭 버퍼 크기) — 실제 진행률은 view.sampleCount(실측)로 표시한다. */
  bufferSize: number;
  chunkSeconds: number;
  onRequestRemove: (id: string) => void;
  /**
   * Run/Stop은 반드시 매니저 경유 — manager.start(id)가 WS 연결(realtime.connect)까지 담당한다.
   * instance.start()를 직접 부르면 카드는 감시 상태가 되지만 웹소켓이 영영 연결되지 않는다(실기기 버그 재발 방지).
   */
  onRun: (id: string) => void;
  onStop: (id: string) => void;
  /**
   * 수량 수정 — 매니저가 IDLE/DONE/FAULT가 아니면 throw한다(실행 중 변경 금지). 이 컴포넌트는 Alert로 노출만 한다.
   * 연필 아이콘 자체를 실행 중엔 숨기므로 정상 흐름에서는 호출되지 않지만, 방어적으로 매니저가 최종 검증한다.
   */
  onEditQty: (id: string, qty: number) => void;
  /** 오토런 토글 — 실행 중에도 켜고 끌 수 있다(다음 사이클 완료 시 반영). 매니저 경유. */
  onToggleAutoRun: (id: string, enabled: boolean) => void;
  /** 구독 성공 ACK를 (전체 피드 기준) 한 번이라도 받았는지 — 틱이 0개여도 "구독 자체는 됐다"를 구분해 보여준다. */
  hasSubscribeAck?: boolean;
  /** 분봉 차트 거래소 코드 — 부모가 manager.getConfig(id)?.market로 전달(NYS/AMS 종목 오조회 방지). */
  chartExcd?: MinuteChartExchangeCode;
}

function InstanceCardBase({
  instance,
  manager,
  bufferSize,
  onRequestRemove,
  onRun,
  onStop,
  onEditQty,
  onToggleAutoRun,
  hasSubscribeAck,
  chartExcd,
}: InstanceCardProps) {
  const [view, setView] = useState<ScalperInstanceView>(() => instance.getView());
  // 시세 진단 줄("마지막 x초 전"/"끊겼어요")의 기준 시각 — 1초 주기로만 갱신(매 프레임 금지).
  const [now, setNow] = useState(() => Date.now());
  // 시트는 열렸을 때만 마운트되므로 이 플래그 자체가 리렌더 비용을 늘리지 않는다(닫힘 상태에서 Modal 트리 없음).
  const [commentsVisible, setCommentsVisible] = useState(false);
  const [chartVisible, setChartVisible] = useState(false);
  const [quoteVisible, setQuoteVisible] = useState(false);
  const [editQtyVisible, setEditQtyVisible] = useState(false);

  useEffect(() => {
    const unsub = instance.subscribe((next) => {
      setView(next);
    });
    return unsub;
  }, [instance]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const handleRun = () => onRun(view.id);

  const handleStop = () => {
    // FAULT는 인터록 해제(추가 주문 없음) — 매도 확인 다이얼로그 없이 바로 멈춘다.
    if (view.state === 'FAULT') {
      onStop(view.id);
      return;
    }
    if (isRunningState(view.state)) {
      Alert.alert('정지할까요?', '보유 중이면 전량 매도한 뒤 종료해요.', [
        { text: '닫기', style: 'cancel' },
        { text: '정지하기', style: 'destructive', onPress: () => onStop(view.id) },
      ]);
      return;
    }
    onStop(view.id);
  };

  // 연필 아이콘은 !isRunningState(state)일 때만 노출(IDLE/DONE/FAULT) — 실행 중엔 아예 숨긴다.
  const canEditQty = !isRunningState(view.state);

  const handleEditQtySubmit = (qty: number) => {
    try {
      onEditQty(view.id, qty);
      setEditQtyVisible(false);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      Alert.alert('알림', message);
    }
  };

  const handleRemove = () => {
    if (isRunningState(view.state)) {
      Alert.alert('카드를 지울까요?', '실행 중인 카드예요. 지우면 정지 후 삭제돼요.', [
        { text: '닫기', style: 'cancel' },
        { text: '지우기', style: 'destructive', onPress: () => onRequestRemove(view.id) },
      ]);
      return;
    }
    onRequestRemove(view.id);
  };

  // WATCH_BUY 중 매수 모멘텀 확인 대기이면 배지만 "모멘텀 확인 중"(주황)으로, BUY 게이트(거래량/체결강도)만
  // 막고 있으면 "수급 확인 중"(주황)으로, HOLDING 중 매도 확인 대기이면 "매도 확인 중"(주황)으로
  // 오버라이드한다 — 상태기계(WATCH_BUY/HOLDING)는 그대로다.
  const gateBlocked = view.state === 'WATCH_BUY' && view.buyGateBlocked;
  const confirmingMomentum = view.state === 'WATCH_BUY' && view.momentumConfirming && !gateBlocked;
  const confirmingSell = view.state === 'HOLDING' && view.sellConfirming;
  const badge =
    gateBlocked || confirmingMomentum || confirmingSell ? { bg: '#fff4e5', fg: '#ff9500' } : STATE_BADGE_COLOR[view.state];
  const isDoneBadge = !gateBlocked && !confirmingMomentum && !confirmingSell && view.state === 'DONE';
  const badgeLabel = gateBlocked
    ? '수급 확인 중'
    : confirmingMomentum
      ? '모멘텀 확인 중'
      : confirmingSell
        ? '매도 확인 중'
        : STATE_LABEL[view.state];

  // 실측 워밍업 진행률 — 리샘플러에 실제로 쌓인 개수(sampleCount)를 그대로 쓴다(시간 근사치 아님).
  const warmupCount = view.warmedUp ? bufferSize : view.sampleCount;

  // 시세 수신 진단 — 틱 0개 / 15초 이상 정체 / 정상 수신 3단계.
  const secondsSinceLastTick = view.lastTickAt !== null ? Math.max(0, Math.floor((now - view.lastTickAt) / 1000)) : null;
  const isStale =
    isRunningState(view.state) && view.lastTickAt !== null && now - view.lastTickAt >= STALE_TICK_MS;
  const diagnosis: { text: string; color: string } =
    view.tickCount === 0
      ? hasSubscribeAck
        ? {
            text: '구독은 됐어요 — 장 시간(한국 22:30~05:00)이 아니면 시세가 없어요',
            color: DIAGNOSIS_NEUTRAL_COLOR,
          }
        : {
            text: '시세가 안 들어와요 — 미국 장 시간(한국 22:30~05:00)인지 확인해 주세요',
            color: DIAGNOSIS_WARN_COLOR,
          }
      : isStale
        ? { text: '시세가 끊겼어요(재연결 대기)', color: DIAGNOSIS_WARN_COLOR }
        : {
            text: `시세 수신 중 · ${view.tickCount}틱 · 마지막 ${secondsSinceLastTick ?? 0}초 전`,
            color: DIAGNOSIS_NEUTRAL_COLOR,
          };

  return (
    <View className="mb-2 bg-white px-5 pb-5 pt-4">
      <View className="flex-row items-start justify-between">
        <View className="flex-row items-center">
          <TickerAvatar ticker={view.ticker} />
          <View className="ml-3">
            <Text className="text-base font-bold text-[#191f28]">
              {view.ticker} <Text className="text-sm font-normal text-[#8b95a1]">· {view.qty}주</Text>
              {canEditQty && (
                <Text onPress={() => setEditQtyVisible(true)} suppressHighlighting>
                  {'  '}
                  <Ionicons name="pencil-outline" size={13} color="#8b95a1" />
                </Text>
              )}
            </Text>
            <View className="mt-2 flex-row items-center">
              {/* 배지 문구가 길어져도(예: "매수 변곡점 감지 중") 줄바꿈 없이 한 줄로 — 11pt + numberOfLines=1. */}
              <View
                className="flex-row items-center rounded-full px-3 py-1"
                style={{ backgroundColor: badge.bg }}
              >
                {isDoneBadge && (
                  <Ionicons name="checkmark-circle" size={12} color={badge.fg} style={{ marginRight: 3 }} />
                )}
                <Text
                  className="font-semibold"
                  numberOfLines={1}
                  style={{ color: badge.fg, fontSize: 11 }}
                >
                  {badgeLabel}
                </Text>
              </View>
            </View>
          </View>
        </View>
        <Pressable onPress={handleRemove} hitSlop={8} className="p-1">
          <Text className="text-lg text-[#8b95a1]">×</Text>
        </Pressable>
      </View>

      {view.lastFault && (
        <View className="mt-3 rounded-2xl bg-[#feeaea] px-3 py-2">
          <Text className="text-sm font-semibold text-[#f04452]">{view.lastFault.text}</Text>
        </View>
      )}

      {view.lastAutoRun && (
        <View
          className="mt-3 flex-row items-center rounded-2xl px-3 py-2"
          style={{ backgroundColor: '#eaf2ff', gap: 4 }}
        >
          <Ionicons name="repeat-outline" size={14} color="#3182f6" />
          <Text className="text-sm font-semibold" style={{ color: '#3182f6' }}>
            {view.lastAutoRun.text}
          </Text>
        </View>
      )}

      {!view.warmedUp ? (
        <View className="mt-4 rounded-2xl bg-[#f7f9fc] px-3 py-2">
          <Text className="text-sm text-[#4e5968]">
            데이터 모으는 중이에요 {warmupCount}/{bufferSize}
          </Text>
        </View>
      ) : (
        <View className="mt-4">
          <Text className="text-[11px] text-[#8b95a1]">현재가</Text>
          <Text className="text-[22px] font-bold text-[#191f28]">{formatPrice(view.price)}</Text>

          <View className="mt-3 flex-row flex-wrap">
            <View className="mr-6 mb-2 w-[28%]">
              <Text className="text-[11px] text-[#8b95a1]">기울기</Text>
              <Text className="text-base font-semibold text-[#191f28]">{formatSigned(view.slope)}</Text>
            </View>
            <View className="mr-6 mb-2 w-[28%]">
              <Text className="text-[11px] text-[#8b95a1]">가속도</Text>
              <Text className="text-base font-semibold text-[#191f28]">{formatSigned(view.accel)}</Text>
            </View>
            <View className="mb-2 w-[28%]">
              <Text className="text-[11px] text-[#8b95a1]">수익률</Text>
              <Text className="text-base font-semibold" style={{ color: pnlColor(view.pnlRate) }}>
                {formatRate(view.pnlRate)}
              </Text>
            </View>
          </View>
        </View>
      )}

      {view.lastSignal && (
        <Text className="mt-1 text-xs text-[#8b95a1]">최근 신호 · {SIGNAL_LABEL[view.lastSignal]}</Text>
      )}

      <Text className="mt-1 text-xs" style={{ color: diagnosis.color }}>
        {diagnosis.text}
      </Text>

      {/* 호가 수신 여부(선택 진단) — quoteCount(실측 수신 건수) 기준으로 판정한다. 공격적 지정가는 최신 호가를 쓴다. */}
      {isRunningState(view.state) &&
        view.quoteCount > 0 &&
        view.lastQuoteAt !== null &&
        now - view.lastQuoteAt < STALE_TICK_MS && (
          <Text className="mt-0.5 text-xs" style={{ color: DIAGNOSIS_NEUTRAL_COLOR }}>
            호가 수신 중 — 매수는 매도1호가, 매도는 매수1호가로 발주해요
          </Text>
        )}

      <View className="mt-2 flex-row items-center" style={{ gap: 16 }}>
        <Pressable
          onPress={() => setCommentsVisible(true)}
          hitSlop={8}
          className="flex-row items-center self-start py-1"
          style={{ gap: 4 }}
        >
          <Ionicons name="chatbubble-outline" size={14} color="#3182f6" />
          <Text className="text-xs font-semibold text-[#3182f6]">토스 댓글</Text>
        </Pressable>
        <Pressable
          onPress={() => setChartVisible(true)}
          hitSlop={8}
          className="flex-row items-center self-start py-1"
          style={{ gap: 4 }}
        >
          <Ionicons name="stats-chart-outline" size={14} color="#3182f6" />
          <Text className="text-xs font-semibold text-[#3182f6]">차트</Text>
        </Pressable>
        <Pressable
          onPress={() => setQuoteVisible(true)}
          hitSlop={8}
          className="flex-row items-center self-start py-1"
          style={{ gap: 4 }}
        >
          <Ionicons name="list-outline" size={14} color="#3182f6" />
          <Text className="text-xs font-semibold text-[#3182f6]">호가</Text>
        </Pressable>
      </View>

      {/* 오토런 토글 — 사이클이 완료되면 손익에 따라 수량을 조정해 자동으로 다시 시작해요(실행 중에도 켜고 끌 수 있어요). */}
      <Pressable
        onPress={() => onToggleAutoRun(view.id, !view.autoRun)}
        hitSlop={8}
        className="mt-4 flex-row items-center justify-between rounded-2xl bg-[#f7f9fc] px-3 py-2 active:opacity-80"
      >
        <View>
          <Text className="text-sm font-semibold text-[#191f28]">오토런</Text>
          <Text className="text-[11px] text-[#8b95a1]">완료되면 수량을 조정해 자동으로 다시 시작해요</Text>
        </View>
        <View
          className="rounded-full px-3 py-1"
          style={{ backgroundColor: view.autoRun ? '#eaf2ff' : '#e5e8eb' }}
        >
          <Text
            className="text-xs font-semibold"
            style={{ color: view.autoRun ? '#3182f6' : '#8b95a1' }}
          >
            {view.autoRun ? '켜짐' : '꺼짐'}
          </Text>
        </View>
      </Pressable>

      <View className="mt-3 flex-row" style={{ gap: 8 }}>
        <Pressable
          onPress={handleRun}
          disabled={!canRun(view.state)}
          className={`flex-1 items-center rounded-2xl py-3 active:opacity-80 ${
            canRun(view.state) ? 'bg-[#3182f6]' : 'bg-[#e5e8eb]'
          }`}
          style={{ minHeight: 44 }}
        >
          <Text className={`text-sm font-semibold ${canRun(view.state) ? 'text-white' : 'text-[#8b95a1]'}`}>
            Run
          </Text>
        </Pressable>
        <Pressable
          onPress={handleStop}
          disabled={!canStop(view.state)}
          className={`flex-1 items-center rounded-2xl py-3 active:opacity-80 ${
            canStop(view.state) ? 'bg-[#191f28]' : 'bg-[#e5e8eb]'
          }`}
          style={{ minHeight: 44 }}
        >
          <Text className={`text-sm font-semibold ${canStop(view.state) ? 'text-white' : 'text-[#8b95a1]'}`}>
            Stop
          </Text>
        </Pressable>
      </View>

      <CommentsSheet visible={commentsVisible} ticker={view.ticker} onClose={() => setCommentsVisible(false)} />
      <ChartSheet
        visible={chartVisible}
        ticker={view.ticker}
        excd={chartExcd ?? DEFAULT_CHART_EXCD}
        onClose={() => setChartVisible(false)}
      />
      <QuoteSheet
        visible={quoteVisible}
        instance={instance}
        manager={manager}
        onClose={() => setQuoteVisible(false)}
      />
      <EditQtySheet
        visible={editQtyVisible}
        ticker={view.ticker}
        initialQty={view.qty}
        onClose={() => setEditQtyVisible(false)}
        onSubmit={handleEditQtySubmit}
      />
    </View>
  );
}

/** instance identity가 같으면(같은 카드) props 얕은 비교로 충분 — 실제 리렌더는 내부 subscribe가 유발한다. */
export const InstanceCard = memo(InstanceCardBase);
