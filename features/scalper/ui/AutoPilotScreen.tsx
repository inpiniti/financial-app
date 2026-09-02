// 자동 트레이딩(오토파일럿) 화면.
// 상태 패널(오늘 성과·Run/Stop·PAUSED 복구) + 트레이딩 리스트 패널 + 기록 패널.
// 오늘 거래 기록은 /trades 화면으로 분리(2026-08-29) — "오늘 성과" 행을 눌러 들어간다.
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
import { formatSignedKrw, formatSignedUsd, formatUsd, pnlColor } from '../../../lib/format';
import { useUsdKrwRate } from '../../../lib/useUsdKrwRate';
import type { AutoPilotEvent, AutoPilotGridView, AutoPilotState, AutoPilotView } from '../autopilot';
import type { AutoPilotManager, AutoPilotSlotRow, FeedRejection } from '../autopilotManager';
import type { FeedEvent, ScalperManager } from '../scalperManager';
import type { ModelVerdictView } from '../feedSlot';
import type { FeedStatus } from '../types';
import { isDaytimeSessionOpen } from '../daySession';
import { rankingSourceLabelOf } from '../../../core/ranking';
import { MODEL_BAR_MINUTES, MODEL_MODE } from '../modelMode';
import { MARTINGALE_MODE } from '../martingaleMode';
import { getActiveEngineMode } from '../engineMode';
import { MODEL_SYMMETRIC_EXIT_CONFIG } from '../../../core/model/exitRule';
import { loadModel } from '../../../core/model';
import { MARTINGALE_CONFIG, MARTINGALE_MIN_BARS, type MartingaleBarEval } from '../../../core/martingale';
import { etMinuteOfDay, TRADING_DAY_START_MIN } from '../../../core/model/session';
import { TREND_MODE } from '../trendMode';
import type { TrendEval } from '../../../core/trend/signal';
import { AdoptSheet } from './AdoptSheet';
import { refreshLiveSettings } from './managerProvider';
import { formatHHMM, formatPrice, formatSlopeRate } from './format';
import { GridGauge } from './GridGauge';

const STATE_BADGE: Record<AutoPilotState, { label: string; bg: string; fg: string }> = {
  IDLE: { label: '대기 중', bg: '#f2f4f6', fg: '#8b95a1' },
  SCANNING: { label: '감시 중', bg: '#eaf2ff', fg: '#3182f6' },
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

const trendArrows = (up: TrendEval['up']): string =>
  `5${arrowOf(up.ma5)} 20${arrowOf(up.ma20)} 60${arrowOf(up.ma60)} 120${arrowOf(up.ma120)}`;

const arrowOf = (up: boolean | null) => (up === null ? '·' : up ? '↑' : '↓');

/**
 * 추세 스냅샷 한 줄 — "추세 5↑ 20↑ 60↑ 120↓ · 종가>60선 · 봉 87/122". 봉이 없으면 "추세 봉 0/122".
 *
 * 2026-08-22: 진행 중(미완성) 봉 판정이 마감 판정과 다르면 **그 차이를 같이 적는다** — 매도는 진행 중 봉
 * 기준으로 나가므로(차트에 그려진 4선과 같은 것), 화면이 마감 기준만 보여 주면 또 어긋나 보인다.
 */
function formatTrendLine(trend: TrendEval | null, live: TrendEval | null): string {
  if (trend === null) return '추세 봉 0/122';
  const closedArrows = trendArrows(trend.up);
  const liveArrows = live === null ? null : trendArrows(live.up);
  const now = liveArrows !== null && liveArrows !== closedArrows ? ` · 지금 ${liveArrows}` : '';
  const above = trend.aboveMa60 === null ? '' : trend.aboveMa60 ? ' · 종가>60선' : ' · 종가≤60선';
  return `추세 ${closedArrows}${now}${above} · 봉 ${Math.min(trend.bars, 122)}/122`;
}

/**
 * 체결가 구독 거절 한 줄(2026-08-28) — 거절된 키와 KIS 사유. 주간 키(R…) 거절은 종목이 주간거래 미지원이거나
 * 계정의 주간거래 신청 상태 문제(HTS ID 변경·API 재신청 뒤 전 종목 거절 실사고) 둘 중 하나라 단정하지 않고,
 * 16:00 KST 뒤 정규장 키로 회전하면 자연히 풀린다는 것만 확실히 알린다.
 */
export function formatFeedRejectedLine(r: FeedRejection): string {
  return r.daytime
    ? `주간거래 시세 거절 · ${r.trKey}(${r.message || '사유 없음'}) — 미지원 종목이거나 주간거래 신청 상태 확인 · 16:00 KST 뒤 정규장 키로 다시 받아요`
    : `시세 구독 거절 · ${r.trKey} · ${r.message || '사유 없음'}`;
}

/**
 * 시세 구독 ACK 집계 한 줄(2026-08-28) — "시세 구독 21건 · 수락 3 · 거절 18 · 응답 없음 0". 거절이 하나도 없으면 null
 * (정상일 땐 소음). 장이 닫혀 가격이 안 들어올 때도 KIS가 몇 건을 받아줬는지 숫자로 보여 한도 문제를 셀 수 있게.
 */
export function formatFeedAckSummary(rows: readonly AutoPilotSlotRow[]): string | null {
  const rejected = rows.filter((r) => r.feedAck === 'rejected').length;
  if (rejected === 0) return null;
  const ok = rows.filter((r) => r.feedAck === 'ok').length;
  const pending = rows.length - ok - rejected;
  return `시세 구독 ${rows.length}건 · 수락 ${ok} · 거절 ${rejected} · 응답 없음 ${pending}`;
}

/**
 * ±3% 단타 모드 한 줄(2026-08-27, 2026-09-01 물타기 제거) — "정배열인가 · 진입 봉인가 · 봉 수".
 * 입력은 진행 중 봉 포함 실시간 판정을 우선한다(2026-09-01 실시간 진입 — 차트·엔진과 같은 기준).
 * 진입은 정배열 상태에서 종가가 5선을 아래→위로 뚫는 **그 봉**에만 나므로, 정배열이어도 대부분의 봉은 "돌파 대기"다.
 */
function formatMartingaleLine(ev: MartingaleBarEval | null, nowMs: number = Date.now()): string {
  if (ev === null) return '4선 계산 중';
  if (ev.aligned === null) return `4선 계산 중 · 봉 ${Math.min(ev.bars, MARTINGALE_MIN_BARS)}/${MARTINGALE_MIN_BARS}`;
  // "정배열"은 배열(5>20>60>120)과 4선 기울기 모두 상승을 **둘 다** 뜻한다(백테스트 규약). 눈으로는 배열이 맞아
  // 보여도 5선이 꺾여 있으면 진입 조건이 아니다 — 그 차이를 화살표로 보인다(2026-08-27 CHOW 13:19 ET 제보).
  const eventText = { cross: '5선 돌파', allUp: '4선 상승 성립', ordered: '정배열 성립' } as const;
  // 세션 게이트를 화면에도 반영(2026-09-01) — 예전엔 주간거래 시간대(한국 낮)에 전 종목 "진입 가능"이
  // 떴는데 엔진은 절대 사지 않아 화면-엔진이 어긋났다. 진입 창은 04:00~19:55 ET(엔진 isMartingaleEntryBar와 동일).
  const m = etMinuteOfDay(Math.floor(nowMs / 60_000));
  const entryWindow = m > TRADING_DAY_START_MIN && m < MARTINGALE_CONFIG.closeAtMin;
  const state = ev.condition
    ? entryWindow
      ? ev.entryEvent === null
        ? '조건 충족(정배열 · 5선 위) — 후보 상위·미보유면 사요'
        : `조건 충족 · ${eventText[ev.entryEvent]} → 진입 신호`
      : '조건 충족 · 진입 시간대 아님(04:00~19:55 ET만 사요)'
    : ev.aligned
      ? '정배열 · 5선 아래(돌파 대기)'
      : ev.ordered
        ? `배열은 정배열, 기울기 ${trendArrows(ev.up)}`
        : '정배열 아님';
  return state;
}

/**
 * 모델 판정 한 줄 — 마지막 판정의 **상태까지** 말한다(2026-08-25). 확률 숫자만으로는
 * "정규장이 아니라 판정을 안 한 것"과 "판정했는데 낮은 것"이 같은 "판정 대기"로 보였다.
 * 확률이 기준값에 얼마나 못 미치는지가 "왜 안 사요?"의 답이다(대부분의 봉은 한참 아래에 있다).
 */
function formatModelLine(v: ModelVerdictView | null): string {
  if (v === null) return '모델 판정 대기';
  const prob = v.prob === null ? null : `${(v.prob * 100).toFixed(1)}%`;
  // 옛 봉 기준 판정(장 닫힘·거래정지)이면 어느 봉인지 밝힌다 — 지금 시세에 대한 판정처럼 읽히면 안 된다.
  const staleMin = v.barKey === null ? null : Date.now() / 60_000 - (v.barKey + MODEL_BAR_MINUTES);
  const stale = staleMin !== null && staleMin > MODEL_BAR_MINUTES * 2;
  const tag = stale ? ` · ${formatHHMM(v.barKey! * 60_000)} 봉 기준` : '';
  // 기준값·"정규장에서만 매수"는 패널 머리에 한 번만 적는다(2026-08-25) — 30행 반복은 소음이었다.
  // "(참고)" = 정규장 밖 봉 판정(게이트에 걸려 매수 없음). 사유는 종목마다 다른 것만 남긴다.
  switch (v.reject) {
    case null:
      return stale ? `모델 ${prob} · 그때 기준 넘음${tag}` : `모델 ${prob} · 매수 신호`;
    case 'prob':
      return `모델 ${prob} · 아직 낮아요${tag}`;
    case 'session':
      return prob === null ? '모델 판정 대기' : `모델 ${prob}(참고)${tag}`;
    case 'liquidity':
      return prob === null ? '모델 쉼 · 거래대금 미달' : `모델 ${prob}(참고) · 거래대금 미달${tag}`;
    case 'price':
      return prob === null ? '모델 쉼 · 주가 $1 이하' : `모델 ${prob}(참고) · 주가 $1 이하${tag}`;
    case 'bars':
      return `모델 쉼 · 봉 부족(${v.bars}개)`;
  }
}

/**
 * 리스트 행의 우측 상태 표시 — 보유 > 매수 후보 > 핀(정리 대기) 순으로 하나만.
 *
 * ⚠ 2026-08-24: 후보 판정은 `candidates`(오토파일럿의 watchedTickers)로 한다. 예전엔 `row.view.watched`
 *   (= 슬롯에 감지기가 붙었나)를 썼는데, 감지기는 리스트 전 종목에 상시 부착이라 **모든 행에 "감시 중"이 떴다.**
 *   지금은 매수가 실제로 허용되는 종목만 배지가 뜬다.
 */
function SlotBadge({
  row,
  activeTickers,
  candidates,
}: {
  row: AutoPilotSlotRow;
  activeTickers: readonly string[];
  candidates: readonly string[];
}) {
  if (activeTickers.includes(row.entry.ticker)) {
    return (
      <View className="mt-0.5 flex-row items-center" style={{ gap: 3 }}>
        <Ionicons name="ellipse" size={8} color="#03b26c" />
        <Text className="text-xs font-semibold text-[#03b26c]">보유 중</Text>
      </View>
    );
  }
  if (candidates.includes(row.entry.ticker)) {
    // 사다리 감시(2026-08-07 plan) — 홀 카운트가 쌓이는 중이면 몇 칸째인지 보여준다(0칸이면 "매수 후보"만).
    const ladder = row.view.ladder;
    const counting = ladder !== null && ladder.count > 0;
    return (
      <View className="mt-0.5 flex-row items-center" style={{ gap: 3 }}>
        <Ionicons name={counting ? 'trending-down-outline' : 'pulse-outline'} size={12} color="#3182f6" />
        <Text className="text-xs font-semibold text-[#3182f6]">
          {counting ? `하락 ${ladder.count}/${ladder.triggerCount}칸` : '매수 후보'}
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
  candidates,
  onPress,
}: {
  item: AutoPilotSlotRow;
  activeTickers: readonly string[];
  /** 지금 매수가 허용되는 종목들(속도 상위 N) — 배지 표시용. */
  candidates: readonly string[];
  onPress: (ticker: string, market: string, name?: string) => void;
}) {
  // 종목명이 있으면 이름을 제목으로, 티커는 부제 맨 앞으로 — 이름 없이 티커만 보이면 무슨 종목인지
  // 알 수 없어 조회 탭 리스트(종목명 · 티커)와 읽는 방식이 달랐다.
  const { ticker, name } = item.entry;
  // 분속 = 틱/초 × 60(최근 10초 창의 순간값을 분당으로) — 사용자가 읽기 쉬운 단위(2026-08-29 데스크탑에서 이식).
  const perMinute = Math.round(item.view.tickRate * 60);
  return (
    <Pressable
      className="bg-white"
      onPress={() => onPress(ticker, item.entry.market, name)}
      android_ripple={{ color: '#f2f4f6' }}
    >
      <ListRow
        leading={<TickerAvatar ticker={ticker} />}
        title={
          <Text className="text-base font-bold text-[#191f28]" numberOfLines={1}>
            {name ? (
              <>
                <Text className="text-[#8b95a1]">{ticker}</Text>
                {` ${name}`}
              </>
            ) : (
              ticker
            )}
          </Text>
        }
        // 속도·기울기는 최근 10초 창의 순간값 한 줄(분속·기울기, 2026-08-29 행 정리 — 시계열 2줄은 소음).
        // 라벨 단독 "기울기" 금지 규칙은 %단위 병기로 지킨다(도메인 문서 §2).
        subtitle={
          <View className="mt-0.5">
            <Text className="text-xs text-[#8b95a1]" style={{ fontVariant: ['tabular-nums'] }} numberOfLines={1}>
              {`분속 ${perMinute}틱 · 기울기 ${formatSlopeRate(item.view.slopeRate)}%`}
            </Text>
            {item.feedRejected ? (
              // 체결가 구독이 KIS에 거절됨(2026-08-28) — 틱이 안 오니 판정도 진입도 없다. 옛 봉 판정 줄 대신 이유를 보인다.
              // 주간 키(R+BAQ…) 거절은 대개 주간거래 미지원 종목 — 16:00 KST 뒤 D키로 회전하면 다시 받는다.
              <Text className="text-xs text-[#f04452]" numberOfLines={1}>
                {formatFeedRejectedLine(item.feedRejected)}
              </Text>
            ) : MARTINGALE_MODE && getActiveEngineMode() === 'martingale' ? (
              // ±3% 단타 모드 — 엔진 모드 설정(2026-09-01)이 martingale일 때. 1분봉 정배열·5선 돌파 상태.
              // 진행 중 봉 포함 실시간 판정을 우선한다(2026-09-01 실시간 진입) — 엔진이 사는 기준을 그대로 보인다.
              <Text className="text-xs text-[#8b95a1]" style={{ fontVariant: ['tabular-nums'] }} numberOfLines={1}>
                {formatMartingaleLine(item.view.martingaleLive ?? item.view.martingale)}
              </Text>
            ) : MODEL_MODE && getActiveEngineMode() === 'model' ? (
              // 모델 모드(2026-08-22) — 마지막 봉의 판정 확률과 임계값. 왜 안 사는지 한눈에.
              <Text className="text-xs text-[#8b95a1]" style={{ fontVariant: ['tabular-nums'] }} numberOfLines={1}>
                {formatModelLine(item.view.modelVerdict)}
              </Text>
            ) : TREND_MODE ? (
              // 추세 모드(2026-08-18, 롤백 보존) — 4선 방향·위치·봉 수.
              // "지금"은 진행 중 봉까지 넣은 판정(2026-08-22) — 매도는 이 기준으로 나간다.
              <Text className="text-xs text-[#8b95a1]" style={{ fontVariant: ['tabular-nums'] }} numberOfLines={1}>
                {formatTrendLine(item.view.trend, item.view.trendLive)}
              </Text>
            ) : null}
          </View>
        }
        trailing={
          <View className="items-end">
            <View className="mb-1 rounded-full bg-[#f2f4f6] px-2 py-0.5">
              <Text className="text-[10px] font-semibold text-[#6b7684]">{rankingSourceLabelOf(item.entry.source)}</Text>
            </View>
            <Text className="text-base font-bold text-[#191f28]">{formatPrice(item.view.price)}</Text>
            <SlotBadge row={item} activeTickers={activeTickers} candidates={candidates} />
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
  const [view, setView] = useState<AutoPilotView>(() => autopilot.getView());
  const [rows, setRows] = useState<readonly AutoPilotSlotRow[]>(() => autopilot.getRows());
  const [events, setEvents] = useState<readonly AutoPilotEvent[]>(() => autopilot.recentEvents);
  // 계좌 잔고 보유분을 그리드에 다시 태우는 시트(FAULT 이후 복구 경로).
  const [adoptVisible, setAdoptVisible] = useState(false);
  // 시세 피드 진단 — 매니저가 이미 보존 중인 연결 상태·마지막 진단 이벤트를 구독해 그린다.
  const [feedStatus, setFeedStatus] = useState<FeedStatus>(() => manager.getFeedStatus());
  const [feedEvent, setFeedEvent] = useState<FeedEvent | null>(() => manager.lastFeedEvent);
  // 오늘 성과 원화 병기용 환율(잔고 기준·30분 캐시) — 못 구하면 null이라 USD만 보여준다.
  const usdKrw = useUsdKrwRate();

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

  const handleRun = useCallback(async () => {
    // 정지 → 시작 사이에는 화면 포커스 이벤트가 없어 포커스마다 도는 설정 재적용 경로가 돌지 않는다.
    // 매매 중에 저장한 진입금액·최소 속도·동시 그리드는 setConfig의 IDLE 게이트에 막혀 있던 상태라,
    // 여기서(이제 IDLE) 한 번 더 흘려 넣지 않으면 옛값 그대로 시작된다(2026-08-14 제보).
    try {
      await refreshLiveSettings(autopilot);
    } catch {
      // 설정 로드 실패 — 마지막으로 적용된 값으로 시작한다.
    }
    if (!autopilot.getView().config) {
      Alert.alert('알림', '진입금액을 먼저 정해 주세요. 상단바 설정 > 트레이딩 설정에서 바꿀 수 있어요.');
      return;
    }
    try {
      autopilot.start();
    } catch (e) {
      Alert.alert('알림', e instanceof Error ? e.message : String(e));
    }
  }, [autopilot]);

  /**
   * 게이지 두 번 누르기 → 확인 → 전량 매도(2026-08-22 사용자 요청).
   * 앱이 판단하는 게 아니라 사용자가 판단한 매도다 — 그래서 확인 창에 종목·수량·현재가를 그대로 적고,
   * "예"를 누른 뒤에는 자동 매도와 똑같이 **체결될 때까지 현재가를 따라가는 매매**로 넘어간다.
   */
  const handleSellNow = useCallback(
    (grid: AutoPilotGridView) => {
      const priceText = grid.currentPrice === null ? '현재가 확인 중' : `현재가 ${formatUsd(grid.currentPrice, 2)}`;
      Alert.alert(
        `${grid.ticker} 전량 매도할까요?`,
        `${grid.holdingQty}주 · ${priceText}
체결될 때까지 현재가로 따라가며 팔아요. 취소는 계좌 화면의 미체결에서 해요.`,
        [
          { text: '아니요', style: 'cancel' },
          {
            text: '매도하기',
            style: 'destructive',
            onPress: () => {
              const reason = autopilot.sellNow(grid.ticker);
              if (reason !== null) Alert.alert('알림', reason);
            },
          },
        ],
      );
    },
    [autopilot],
  );

  const handleStop = useCallback(() => autopilot.stop(), [autopilot]);
  const handleResume = useCallback(() => autopilot.resume(), [autopilot]);

  // 행 탭 → 종목 상세화면(차트/댓글/호가) — 3거래소 병합 리스트라 행마다 채용 거래소를 넘긴다.
  // 종목명도 함께 넘겨 상세 상단바가 티커만 덩그러니 뜨지 않게 한다(리스트와 같은 제목).
  const handleRowPress = useCallback((ticker: string, market: string, name?: string) => {
    router.push({ pathname: '/stock/[ticker]', params: name ? { ticker, market, name } : { ticker, market } });
  }, []);

  const renderRow = useCallback(
    ({ item }: { item: AutoPilotSlotRow }) => (
      <SlotRow
        item={item}
        activeTickers={view.activeTickers}
        candidates={view.watched}
        onPress={handleRowPress}
      />
    ),
    [view.activeTickers, view.watched, handleRowPress],
  );

  const config = view.config;
  const idleWatch = view.state === 'SCANNING' && view.watched.length === 0 && rows.length > 0;
  const feedAckSummary = formatFeedAckSummary(rows);

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
              {/* 오늘 성과 — 누르면 "오늘 거래 기록" 화면(사이클별 상세)으로. 설정 요약·사이클·그리드 줄은 뺐다(2026-08-29 행 정리). */}
              <ListRow
                title="오늘 성과"
                onPress={() => router.push('/trades')}
                trailing={
                  // 누적 손익은 USD로 쌓이지만 체감은 원화라 둘 다 보여준다 —
                  // 환율(잔고 기준)을 못 구했을 때만 예전처럼 USD 한 줄.
                  <View className="flex-row items-center">
                    <View className="items-end">
                      {usdKrw !== null ? (
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
                      )}
                    </View>
                    <Ionicons name="chevron-forward" size={16} color="#b0b8c1" style={{ marginLeft: 6 }} />
                  </View>
                }
              />
              {!config && (
                <View className="px-5 pb-2">
                  <Text className="text-xs leading-5 text-[#8b95a1]">
                    진입금액이 아직 없어요 — 설정 &gt; 트레이딩 설정에서 정해 주세요
                  </Text>
                </View>
              )}
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
                    {/* getLive(2026-09-02) — 게이지가 250ms로 스스로 신선값을 당겨 부드럽게 움직인다(화면 전체 리렌더 없음). */}
                    <GridGauge
                      grid={grid}
                      onDoubleTapSell={() => handleSellNow(grid)}
                      getLive={() => autopilot.getGridLive(grid.ticker)}
                    />
                  </View>
                ))}
              </Panel>
            )}
            {/* "트레이딩 리스트" 패널 헤더 — 행들은 FlatList 아이템으로 이어진다. */}
            <View className="bg-white">
              <View className="flex-row items-center justify-between px-5 pb-2 pt-4">
                <Text className="text-[15px] font-bold text-[#191f28]">트레이딩 리스트</Text>
                <Text className="text-xs text-[#8b95a1]">순위 상위 {rows.length}종목 · 원천은 설정에서</Text>
              </View>
              {feedAckSummary !== null && (
                // 시세 구독 ACK 집계(2026-08-28) — 장이 닫혀 가격으로 셀 수 없을 때도 "요청·수락·거절"을 숫자로. 거절이 있을 때만.
                <Text className="px-5 pb-2 text-xs text-[#f04452]">{feedAckSummary}</Text>
              )}
              {MARTINGALE_MODE && getActiveEngineMode() === 'martingale' && (
                // ±3% 단타 모드(2026-09-01, 물타기 제거) — 규칙 요약을 여기 한 번만.
                <Text className="px-5 pb-2 text-xs text-[#8b95a1]">
                  {`±3% 단타 모드 · 1분봉 5·20·60·120선 정배열(4선 상승)이고 가격이 5선 위면 매수 — 봉 마감을 기다리지 않고 진행 중 봉으로 실시간 판정해요(봉당 1회) · 프리·정규·애프터만(주간거래 제외 · 후보 안에서만 · 오늘 이미 산 종목은 5선 돌파·정배열 성립·4선 상승 성립 때만). 익절 평단 +${(MARTINGALE_CONFIG.tpPct * 100).toFixed(0)}% · 손절 평단 −${(MARTINGALE_CONFIG.stopLossPct * 100).toFixed(0)}% · 물타기 없음, ${Math.floor(MARTINGALE_CONFIG.closeAtMin / 60)}:${String(
                    MARTINGALE_CONFIG.closeAtMin % 60,
                  ).padStart(2, '0')} ET 전량 청산.`}
                </Text>
              )}
              {MODEL_MODE && getActiveEngineMode() === 'model' && (
                // 모델이 뭘 예측하는지·기준값·매수 시간대 — 행마다 반복하지 않고 여기 한 번만(2026-08-25).
                <Text className="px-5 pb-2 text-xs text-[#8b95a1]">
                  {`모델 % = 지금 사면 손절(−${(MODEL_SYMMETRIC_EXIT_CONFIG.stopLossPct * 100).toFixed(0)}%)보다 익절(+${(
                    MODEL_SYMMETRIC_EXIT_CONFIG.tpPct * 100
                  ).toFixed(0)}%)에 먼저 닿을 확률. ${MODEL_BAR_MINUTES}분봉마다 갱신, ${(
                    loadModel().threshold * 100
                  ).toFixed(1)}%를 넘으면 정규장에서 매수해요. 익절선에서 모델이 아직 좋으면(상위 10%) 팔지 않고 밴드를 올려 달아요(래칫). 최장 ${MODEL_SYMMETRIC_EXIT_CONFIG.maxHoldMin}분 보유. (참고) = 정규장 밖 판정.`}
                </Text>
              )}
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
            {/* 오늘 거래 기록 패널은 /trades 화면으로 분리(2026-08-29) — "오늘 성과" 행을 눌러 들어간다. */}
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
