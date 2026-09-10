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
import { formatKrw, formatSignedKrw, formatSignedPercentFromRatio, formatSignedUsd, formatUsd, pnlColor } from '../../../lib/format';
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
import { SLOPE_MODE } from '../slopeMode';
import { SLOPE_CONFIG, SLOPE_EXIT_TICK_MS } from '../../../core/slope';
import { describeEngineOptions, getActiveEngineMode, getActiveEngineOptions } from '../engineMode';
import { MODEL_SYMMETRIC_EXIT_CONFIG } from '../../../core/model/exitRule';
import { loadModel } from '../../../core/model';
import { MARTINGALE_CONFIG, MARTINGALE_MIN_BARS, type MartingaleBarEval } from '../../../core/martingale';
import { etMinuteOfDay, TRADING_DAY_START_MIN } from '../../../core/model/session';
import { TREND_MODE } from '../trendMode';
import type { TrendEval } from '../../../core/trend/signal';
import { AdoptSheet } from './AdoptSheet';
import { refreshLiveSettings } from './managerProvider';
import { formatHHMM, formatPrice, formatSlopeRate, formatSlopeRates, formatTickRates } from './format';
import { gaugeScaleOf, normalizeGridPosition } from './gridGaugeMath';

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
 * 추세 스냅샷 한 줄 — "추세 5↑ 20↑ 60↑ 120↓ · 종가>60선".
 * 봉이 없으면 null을 돌려 행에 표시하지 않는다.
 *
 * 2026-08-22: 진행 중(미완성) 봉 판정이 마감 판정과 다르면 **그 차이를 같이 적는다** — 매도는 진행 중 봉
 * 기준으로 나가므로(차트에 그려진 4선과 같은 것), 화면이 마감 기준만 보여 주면 또 어긋나 보인다.
 */
function formatTrendLine(trend: TrendEval | null, live: TrendEval | null): string | null {
  if (trend === null) return null;
  const closedArrows = trendArrows(trend.up);
  const liveArrows = live === null ? null : trendArrows(live.up);
  const now = liveArrows !== null && liveArrows !== closedArrows ? ` · 지금 ${liveArrows}` : '';
  const above = trend.aboveMa60 === null ? '' : trend.aboveMa60 ? ' · 종가>60선' : ' · 종가≤60선';
  return `추세 ${closedArrows}${now}${above}`;
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

/** 기울기 단타 한 줄(2026-09-02 ADR 0011) — 문턱(+1%) 대비 지금 상태. 값 자체는 행 머리의 "기울기"가 이미 보인다. */
function formatSlopeModeLine(rate: number | null): string {
  if (rate === null) return `기울기 판정 불가(10초 봉이 비었어요) — 보유 중이면 매도`;
  if (rate >= SLOPE_CONFIG.entryPct) return `기울기 +${rate.toFixed(1)}% ≥ +${SLOPE_CONFIG.entryPct}% — 올라선 순간 매수, 내려오면 매도`;
  return `기울기 ${rate > 0 ? '+' : ''}${rate.toFixed(1)}% < +${SLOPE_CONFIG.entryPct}% — 대기(보유 중이면 매도)`;
}

/**
 * 5선 물타기 단타 모드 한 줄(2026-09-02) — "5선 방향 · 돌파 봉인가 · 봉 수".
 * 입력은 진행 중 봉 포함 실시간 판정을 우선한다(2026-09-01 실시간 진입 — 차트·엔진과 같은 기준).
 * 신호는 5선이 오르는 중에 종가가 5선을 아래→위로 뚫는 **그 봉**에만 나므로 대부분의 봉은 "돌파 대기"다.
 */
function formatMartingaleLine(ev: MartingaleBarEval | null, nowMs: number = Date.now()): string {
  if (ev === null) return '5선 계산 중';
  if (ev.ma5Up === null) return '5선 계산 중';
  // 세션 게이트를 화면에도 반영(2026-09-01) — 예전엔 주간거래 시간대(한국 낮)에 전 종목 "진입 가능"이
  // 떴는데 엔진은 절대 사지 않아 화면-엔진이 어긋났다. 진입 창은 04:00~19:55 ET(엔진 isMartingaleEntryBar와 동일).
  const m = etMinuteOfDay(Math.floor(nowMs / 60_000));
  const entryWindow = m > TRADING_DAY_START_MIN && m < MARTINGALE_CONFIG.closeAtMin;
  if (ev.entry) {
    return entryWindow
      ? `5선 돌파${filterTag(ev)} → 매수 신호(미보유면 진입${getActiveEngineOptions().martingale ? ' · 보유 중이면 평단 −3% 아래일 때 물타기' : ''})`
      : '5선 돌파 · 매매 시간대 아님(04:00~19:55 ET만 사요)';
  }
  if (ev.crossUp && ev.filtersPass !== true) return `5선 돌파했지만 옵션 미충족(${missingFilters(ev)})`;
  return ev.ma5Up ? '5선 상승 중 · 돌파 대기' : '5선 하락 중 · 돌파 대기';
}

/** 체크된 진입 필터 중 이 봉에서 어긋난 것 — "정배열 아님 · 4선 상승 아님". */
function missingFilters(ev: MartingaleBarEval): string {
  const o = getActiveEngineOptions();
  const miss: string[] = [];
  if (o.ordered && ev.ordered !== true) miss.push('정배열 아님');
  if (o.ma5Up && ev.ma5Up !== true) miss.push('5선 상승 아님');
  if (o.allUp && ev.allUp !== true) miss.push('4선 상승 아님');
  return miss.length ? miss.join(' · ') : '판정 불가';
}

/** 진입 필터가 켜져 있으면 " + 정배열 · 5선 상승" 꼬리표. */
function filterTag(_ev: MartingaleBarEval): string {
  const o = getActiveEngineOptions();
  const on: string[] = [];
  if (o.ordered) on.push('정배열');
  if (o.ma5Up) on.push('5선 상승');
  if (o.allUp) on.push('4선 상승');
  return on.length ? ` + ${on.join('·')}` : '';
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

function markerPosition(value: number | null, lo: number, hi: number): number | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  return normalizeGridPosition(value, lo, hi);
}

function ma5Of(row: AutoPilotSlotRow): number | null {
  const realtimeMa5 = row.view.realtimeMa5?.ma5;
  if (realtimeMa5 !== null && realtimeMa5 !== undefined && Number.isFinite(realtimeMa5)) return realtimeMa5;
  const martingaleLiveMa5 = row.view.martingaleLive?.ma5;
  if (martingaleLiveMa5 !== null && martingaleLiveMa5 !== undefined && Number.isFinite(martingaleLiveMa5)) return martingaleLiveMa5;
  const martingaleMa5 = row.view.martingale?.ma5;
  if (martingaleMa5 !== null && martingaleMa5 !== undefined && Number.isFinite(martingaleMa5)) return martingaleMa5;
  return null;
}

function InlineGrid({
  min,
  ma5,
  current,
  avg,
  max,
  showAverage,
}: {
  min: number | null;
  ma5: number | null;
  current: number | null;
  avg: number | null;
  max: number | null;
  showAverage: boolean;
}) {
  const fallbackLo = min ?? current ?? ma5 ?? avg ?? 1;
  const fallbackHi = max ?? current ?? ma5 ?? avg ?? fallbackLo * 1.001;
  const scale = gaugeScaleOf([min, ma5, current, avg, max], fallbackLo, fallbackHi);

  // 최소/최대는 사용자가 기대한 대로 양끝 고정으로 그린다.
  const minPos = min !== null ? 0 : markerPosition(min, scale.lo, scale.hi);
  const maxPos = max !== null ? 1 : markerPosition(max, scale.lo, scale.hi);
  const ma5Pos = markerPosition(ma5, scale.lo, scale.hi);
  const currentPos = markerPosition(current, scale.lo, scale.hi);
  const avgPos = showAverage ? markerPosition(avg, scale.lo, scale.hi) : null;

  const POINT_WIDTH = 68;
  const CURRENT_BUBBLE_WIDTH = 80;
  const [trackWidth, setTrackWidth] = useState(0);

  const pctLeft = (pos: number) => `${(pos * 100).toFixed(2)}%` as `${number}%`;

  const Marker = ({ pos, color, height, width = 2 }: { pos: number | null; color: string; height: number; width?: number }) => {
    if (pos === null) return null;
    const left = pctLeft(pos);
    return (
      <View
        style={{
          position: 'absolute',
          left,
          top: (16 - height) / 2,
          width,
          height,
          backgroundColor: color,
          borderRadius: 1,
          transform: [{ translateX: -width / 2 }],
        }}
      />
    );
  };

  const Point = ({
    pos,
    align,
    label,
    value,
    labelColor,
  }: {
    pos: number | null;
    align: 'left' | 'center' | 'right';
    label: string;
    value: string;
    labelColor?: string;
  }) => {
    if (pos === null) return null;
    return (
      <View
        style={{
          position: 'absolute',
          left: pctLeft(pos),
          width: POINT_WIDTH,
          transform: [{ translateX: align === 'center' ? -POINT_WIDTH / 2 : align === 'right' ? -POINT_WIDTH : 0 }],
          alignItems: align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center',
        }}
      >
        <Text className="text-[10px] font-semibold" style={{ color: labelColor ?? '#8b95a1' }}>
          {label}
        </Text>
        <Text className="text-[11px] font-bold text-[#191f28]" style={{ fontVariant: ['tabular-nums'] }}>
          {value}
        </Text>
      </View>
    );
  };

  const currentBubbleLeft = (() => {
    if (currentPos === null || trackWidth <= 0) return null;
    const half = CURRENT_BUBBLE_WIDTH / 2;
    const x = currentPos * trackWidth;
    return Math.min(trackWidth - half, Math.max(half, x)) - half;
  })();

  return (
    <View className="mt-3">
      <View className="relative" style={{ height: 38 }}>
        {currentBubbleLeft !== null && (
          <View
            style={{
              position: 'absolute',
              left: currentBubbleLeft,
              top: 0,
              width: CURRENT_BUBBLE_WIDTH,
              alignItems: 'center',
            }}
          >
            <Text className="text-[10px] font-semibold text-[#8b95a1]">현재</Text>
            <Text className="text-[11px] font-bold text-[#191f28]" style={{ fontVariant: ['tabular-nums'] }}>
              {formatPrice(current)}
            </Text>
            <Text style={{ color: '#191f28', fontSize: 11, lineHeight: 12, marginTop: 1 }}>▼</Text>
          </View>
        )}
      </View>

      <View className="relative" style={{ height: 16 }} onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}>
        <View className="absolute left-0 right-0" style={{ top: 7, height: 2, backgroundColor: '#e5e8eb', borderRadius: 999 }} />
        <Marker pos={minPos} color="#8b95a1" height={10} width={1.5} />
        <Marker pos={ma5Pos} color="#f59e0b" height={12} />
        <Marker pos={currentPos} color="#191f28" height={13} />
        {showAverage && <Marker pos={avgPos} color="#3182f6" height={13} />}
        <Marker pos={maxPos} color="#8b95a1" height={10} width={1.5} />
      </View>

      <View className="relative mt-2" style={{ height: 30 }}>
        <Point pos={minPos} align="left" label="최소" value={formatPrice(min)} />
        <Point pos={ma5Pos} align="center" label="5선" value={formatPrice(ma5)} labelColor="#f59e0b" />
        {showAverage && <Point pos={avgPos} align="center" label="평단" value={formatPrice(avg)} />}
        <Point pos={maxPos} align="right" label="최대" value={formatPrice(max)} />
      </View>
    </View>
  );
}

/** 리스트 행 — "트레이딩 리스트" 패널의 연속이므로(FlatList 아이템) 직접 흰 배경을 입힌다.
 * 탭하면 부모가 액션시트(댓글/차트/호가)를 띄운다 — onPress는 표시용 UI 상태만 바꾼다(매매 로직 무관). */
function SlotRow({
  item,
  grid,
  usdKrw,
  activeTickers,
  candidates,
  onPress,
}: {
  item: AutoPilotSlotRow;
  grid: AutoPilotGridView | null;
  usdKrw: number | null;
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
  const statusLine = item.feedRejected
    ? formatFeedRejectedLine(item.feedRejected)
    : SLOPE_MODE && getActiveEngineMode() === 'slope'
      ? formatSlopeModeLine(item.view.slopeRate) + (item.view.entryFilterPass === false ? ' · 옵션 조건 미충족' : '')
      : MARTINGALE_MODE && getActiveEngineMode() === 'martingale'
        ? formatMartingaleLine(item.view.martingaleLive ?? item.view.martingale)
        : MODEL_MODE && getActiveEngineMode() === 'model'
          ? formatModelLine(item.view.modelVerdict) + (item.view.entryFilterPass === false ? ' · 옵션 조건 미충족' : '')
          : TREND_MODE
            ? formatTrendLine(item.view.trend, item.view.trendLive)
            : null;

  const currentPrice = grid?.currentPrice ?? item.view.price;
  const ma5 = ma5Of(item);
  const min = item.view.dayLow ?? grid?.sinceEntryLow ?? grid?.buyPrice ?? null;
  const max = item.view.dayHigh ?? grid?.sinceEntryHigh ?? grid?.sellPrice ?? null;
  const currentKrw = currentPrice !== null && usdKrw !== null ? formatKrw(currentPrice * usdKrw) : null;

  const holdingValueUsd = grid && currentPrice !== null ? currentPrice * grid.holdingQty : null;
  const holdingValueKrw = holdingValueUsd !== null && usdKrw !== null ? holdingValueUsd * usdKrw : null;
  const pnlRatio = grid && currentPrice !== null && grid.avgPrice > 0 ? (currentPrice - grid.avgPrice) / grid.avgPrice : null;
  const pnlUsd = grid && currentPrice !== null ? (currentPrice - grid.avgPrice) * grid.holdingQty : null;
  const pnlAmountText =
    pnlUsd === null ? '—' : holdingValueKrw !== null ? formatSignedKrw(pnlUsd * usdKrw!) : formatSignedUsd(pnlUsd);

  return (
    <Pressable
      className="bg-white"
      onPress={() => onPress(ticker, item.entry.market, name)}
      android_ripple={{ color: '#f2f4f6' }}
    >
      <View className="px-5 py-[13px]">
        <View className="flex-row">
          <View className="mr-3 pt-0.5">
            <TickerAvatar ticker={ticker} />
          </View>
          <View className="flex-1">
            <View className="flex-row items-start justify-between" style={{ columnGap: 10 }}>
              <View className="flex-1">
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
                <View className="mt-0.5 flex-row items-center" style={{ columnGap: 8 }}>
                  <Text className="text-xs text-[#8b95a1]" style={{ fontVariant: ['tabular-nums'] }}>
                    {`${perMinute}틱/분`}
                  </Text>
                  <View className="mb-0.5 rounded-full bg-[#f2f4f6] px-2 py-0.5">
                    <Text className="text-[10px] font-semibold text-[#6b7684]">{rankingSourceLabelOf(item.entry.source)}</Text>
                  </View>
                </View>
              </View>

              <View className="items-end">
                <Text className="text-base font-bold text-[#191f28]">{formatPrice(currentPrice)}</Text>
                {currentKrw !== null && <Text className="text-xs text-[#8b95a1]">{currentKrw}</Text>}
              </View>
            </View>

            <View className="mt-1 flex-row items-start justify-between" style={{ columnGap: 8 }}>
              <View className="flex-1">
                <SlotBadge row={item} activeTickers={activeTickers} candidates={candidates} />
                {statusLine !== null && (
                  <Text
                    className="mt-0.5 text-xs"
                    style={{ color: item.feedRejected ? '#f04452' : '#8b95a1', fontVariant: ['tabular-nums'] }}
                    numberOfLines={1}
                  >
                    {statusLine}
                  </Text>
                )}
                {!item.feedRejected && statusLine === null && (
                  <Text className="mt-0.5 text-xs text-[#8b95a1]" style={{ fontVariant: ['tabular-nums'] }} numberOfLines={1}>
                    {`${formatTickRates(item.view.tickRate)} · ${formatSlopeRates(item.view.slopeRate)}`}
                  </Text>
                )}
              </View>

              {grid !== null && (
                <View className="items-end">
                  <Text className="text-xs text-[#4e5968]">
                    {holdingValueUsd === null ? `${grid.holdingQty}주` : `${grid.holdingQty}주 ${formatUsd(holdingValueUsd, 2)}`}
                    {holdingValueKrw !== null ? ` ${formatKrw(holdingValueKrw)}` : ''}
                  </Text>
                  <Text className="text-xs font-semibold" style={{ color: pnlColor(pnlRatio) }}>
                    {`${formatSignedPercentFromRatio(pnlRatio, 2)} ${pnlAmountText}`}
                  </Text>
                </View>
              )}
            </View>

            <InlineGrid
              min={min}
              ma5={ma5}
              current={currentPrice}
              avg={grid?.avgPrice ?? null}
              max={max}
              showAverage={grid !== null}
            />
          </View>
        </View>
      </View>
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

  const handleStop = useCallback(() => autopilot.stop(), [autopilot]);
  const handleResume = useCallback(() => autopilot.resume(), [autopilot]);

  // 행 탭 → 종목 상세화면(차트/댓글/호가) — 3거래소 병합 리스트라 행마다 채용 거래소를 넘긴다.
  // 종목명도 함께 넘겨 상세 상단바가 티커만 덩그러니 뜨지 않게 한다(리스트와 같은 제목).
  const handleRowPress = useCallback((ticker: string, market: string, name?: string) => {
    router.push({ pathname: '/stock/[ticker]', params: name ? { ticker, market, name } : { ticker, market } });
  }, []);

  const renderRow = useCallback(
    ({ item }: { item: AutoPilotSlotRow }) => (
      // 보유 중인 종목만 AutoPilot 그리드 스냅샷이 있다. 미보유 종목은 평단/보유손익 없이 축(최소·5선·현재·최대)만 그린다.
      // 리스트 내부에서 모두 보여 주되, 보유 정보는 보유 종목에서만 조건부 노출.
      <SlotRow
        item={item}
        grid={view.grids.find((g) => g.ticker === item.entry.ticker) ?? null}
        usdKrw={usdKrw}
        activeTickers={view.activeTickers}
        candidates={view.watched}
        onPress={handleRowPress}
      />
    ),
    [view.activeTickers, view.grids, view.watched, handleRowPress, usdKrw],
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
              {SLOPE_MODE && getActiveEngineMode() === 'slope' && (
                // 기울기 단타(2026-09-02 ADR 0011) — 규칙 요약을 여기 한 번만.
                <Text className="px-5 pb-2 text-xs text-[#8b95a1]">
                  {`기울기 단타 · 기울기/10초가 +${SLOPE_CONFIG.entryPct}% 이상으로 올라서면 매수(후보 안에서만), 보유 중 +${SLOPE_CONFIG.exitPct}% 아래로 내려오면 손익 무관 즉시 전량 매도 — 틱마다 + ${SLOPE_EXIT_TICK_MS}ms 재판정. 익절·손절·시간대·마감 청산 없음 · 옵션: ${describeEngineOptions()}.`}
                </Text>
              )}
              {MARTINGALE_MODE && getActiveEngineMode() === 'martingale' && (
                // 5선 물타기 단타 모드(2026-09-02) — 규칙 요약을 여기 한 번만.
                <Text className="px-5 pb-2 text-xs text-[#8b95a1]">
                  {`5선 돌파 · 1분봉 가격이 5선을 아래→위로 뚫으면 매수 — 봉 마감을 기다리지 않고 진행 중 봉으로 실시간 판정해요(봉당 1회) · 프리·정규·애프터만(주간거래 제외 · 후보 안에서만) · 옵션: ${describeEngineOptions()}${getActiveEngineOptions().martingale ? ` — 보유 중 평단 −${(MARTINGALE_CONFIG.dropStartPct * 100).toFixed(0)}% 아래에서 같은 돌파가 오면 낙폭 k%당 보유량 ×(k−1)` : ''} · 손절 없음. 익절 평단 +${(MARTINGALE_CONFIG.tpPct * 100).toFixed(0)}%, ${Math.floor(MARTINGALE_CONFIG.closeAtMin / 60)}:${String(
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
                  ).toFixed(1)}%를 넘으면 정규장에서 매수해요(옵션: ${describeEngineOptions()}). 익절선에서 모델이 아직 좋으면(상위 10%) 팔지 않고 밴드를 올려 달아요(래칫). 최장 ${MODEL_SYMMETRIC_EXIT_CONFIG.maxHoldMin}분 보유. (참고) = 정규장 밖 판정.`}
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
