// 종목 상세화면 "차트" 탭 — 옛 ChartSheet.tsx(바텀시트)에서 추출한 유일한 차트 구현.
// 분봉/일봉/주봉/월봉 통합 — 진입·기간(모드/분봉 간격) 변경·새로고침 버튼 때만 조회한다(폴링 금지).
// 분봉 원천은 토스 c-chart(lib/tossMinuteChart, 2026-08-18) — 한투 분봉조회는 정규장만 줘서 프리·애프터·주간거래에
// 4선 오버레이가 꼬였다. 일/주/월봉은 그대로 한투 기간별시세.
// 캔들 렌더는 react-native-svg(기설치)로 직접 그린다 — 차트 라이브러리 추가 설치 없음.
import { useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Line, Polyline, Rect, Text as SvgText } from 'react-native-svg';
import { computeTrendSeries } from '../../../core/trend';
import { barKeyOf } from '../../../core/trend/bars';
import { describeReject, inspectModel, loadModel, type ModelInspection } from '../../../core/model';
import { MODEL_BAR_MINUTES } from '../../../features/scalper/modelMode';
import { MARTINGALE_BAR_MINUTES, MARTINGALE_MODE } from '../../../features/scalper/martingaleMode';
import { getAccessToken } from '../../../kis/token';
import type { MinuteChartExchangeCode } from '../../../kis/minuteChart';
import { inquireOverseasPeriodChart, type PeriodChartPeriod } from '../../../kis/periodChart';
import type { KisCredentials, KisEnvironment } from '../../../kis/types';
import { loadAppSettings } from '../../../lib/appSettings';
import { fetchTossDailyCloses, fetchTossMinuteCandles, resolveTossProductCode } from '../../../lib/tossMinuteChart';
import { loadKisSettings } from '../../../lib/kisSettings';
import { secureTokenStorage } from '../../../lib/secureTokenStorage';
import { formatUsd } from '../../../lib/format';

export interface ChartPanelProps {
  ticker: string;
  /** EXCD — 상세화면 라우트 파라미터(market)에서 정규화된 미국 3거래소 코드. */
  excd: MinuteChartExchangeCode;
}

type ChartMode = 'minute' | 'daily' | 'weekly' | 'monthly';
type MinuteInterval = 1 | 3 | 5;

/**
 * 자동매매 엔진이 실제로 쓰는 봉 주기 — 차트 기본값을 여기에 맞춘다(2026-08-22).
 * 8-18~21 실거래에서 "차트는 꺾였는데 앱은 안 판다"의 큰 몫이 **차트 1분봉 vs 엔진 5분봉**이었다.
 * 지금 엔진은 ±3% 단타 모드(1분봉 4선 판정)이고, MARTINGALE_MODE=false로 모델 복귀 시 모델 주기를 따른다.
 */
const ENGINE_INTERVAL: MinuteInterval = (MARTINGALE_MODE ? MARTINGALE_BAR_MINUTES : MODEL_BAR_MINUTES) as MinuteInterval;

const MODE_OPTIONS: Array<{ value: ChartMode; label: string }> = [
  { value: 'minute', label: '분봉' },
  { value: 'daily', label: '일봉' },
  { value: 'weekly', label: '주봉' },
  { value: 'monthly', label: '월봉' },
];

const MINUTE_INTERVAL_OPTIONS: Array<{ value: MinuteInterval; label: string }> = [
  { value: 1, label: '1분' },
  { value: 3, label: '3분' },
  { value: 5, label: '5분' },
].map((o) => (o.value === ENGINE_INTERVAL ? { ...o, label: `${o.label}(엔진)` } : o)) as Array<{
  value: MinuteInterval;
  label: string;
}>;

const PERIOD_BY_MODE: Record<Exclude<ChartMode, 'minute'>, PeriodChartPeriod> = {
  daily: 'D',
  weekly: 'W',
  monthly: 'M',
};

/** 최근 최대 80봉만 그린다(분봉은 문서상 한 번에 최대 120건, 기간별시세는 최대 100건 오지만 화면은 80봉으로 충분). */
const MAX_CANDLES = 80;

const UP_COLOR = '#f04452'; // 종가 > 시가 (한국 관례 — 상승 빨강)
const DOWN_COLOR = '#3182f6'; // 종가 < 시가
const DOJI_COLOR = '#8b95a1'; // 종가 == 시가

const RIGHT_AXIS_WIDTH = 52; // 우측 가격축 라벨 예약 폭

/** 렌더러가 필요로 하는 최소 형태 — 분봉(MinuteCandle)·기간봉(PeriodCandle)을 조회 직후 이 모양으로 맞춘다. */
interface ChartCandle {
  /** React key + 정렬 확인용 고유 문자열. */
  key: string;
  /** 하단 시간축에 표시할 문구(분봉 HH:MM, 일봉 MM/DD, 주/월봉 YY/MM). */
  label: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /**
   * 아직 안 끝난 봉인가 — 토스는 현재 진행 중인 봉도 내려준다. 차트는 그걸 그대로 그리는데
   * 엔진은 닫힌 봉만 보므로, 그 차이를 화면에서 눈에 보이게 한다(2026-08-22).
   */
  inProgress?: boolean;
}

type LoadState =
  | { kind: 'sessionLoading' }
  | { kind: 'sessionError'; message: string }
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; candles: ChartCandle[]; verdict: ModelInspection | null };

interface Session {
  credentials: KisCredentials;
  environment: KisEnvironment;
  accessToken: string;
}

/** "093000"(HHMMSS) → "09:30". 형식이 다르면 원본을 그대로 돌려준다. */
/** 토스 dt("2026-08-18T01:33:00-04:00") → 현지(ET) "HH:MM" — 오프셋 뒤 시각을 문자열에서 그대로 자른다(옛 한투 xhms 라벨과 같은 기준). */
function formatTossClock(dt: string): string {
  const m = /T(d{2}):(d{2})/.exec(dt);
  return m ? `${m[1]}:${m[2]}` : dt;
}

/** "20260729"(YYYYMMDD) → 일봉은 "07/29", 주/월봉은 "26/07". 형식이 다르면 원본을 그대로 돌려준다. */
function formatDateLabel(ymd: string, mode: Exclude<ChartMode, 'minute'>): string {
  if (ymd.length < 8) return ymd;
  const yy = ymd.slice(2, 4);
  const mm = ymd.slice(4, 6);
  const dd = ymd.slice(6, 8);
  return mode === 'daily' ? `${mm}/${dd}` : `${yy}/${mm}`;
}

function SkeletonChart({ height }: { height: number }) {
  return (
    <View className="px-4 pt-4">
      <View className="mb-3 h-3 w-1/3 rounded-full bg-[#f7f9fc]" />
      <View style={{ height }} className="items-end justify-around rounded-2xl bg-[#f7f9fc] px-3 py-3">
        {[1, 2, 3, 4].map((i) => (
          <View key={i} style={{ height: 10, width: `${60 + i * 8}%` }} className="rounded-full bg-white" />
        ))}
      </View>
    </View>
  );
}

/** 상단 모드(분/일/주/월)와 분봉 하위 간격에 재사용하는 pill 세그먼트. */
function SegmentedToggle<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <View className="flex-row rounded-xl bg-[#f7f9fc] p-1">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            onPress={() => onChange(opt.value)}
            className={`items-center justify-center rounded-lg px-4 py-2 ${active ? 'bg-white' : ''}`}
            style={{ minHeight: 32 }}
          >
            <Text className={`text-xs font-semibold ${active ? 'text-[#191f28]' : 'text-[#8b95a1]'}`}>{opt.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** 캔들 SVG 본체 — 심지+몸통, 거래량 미니 바, 마지막 종가 점선+태그, 가격/시간 축 라벨. */
/** 추세 4선 색 — 분봉5선·20선·60선·120선(HTS 관례에 가깝게 빨강·보라·파랑·초록). */
const TREND_LINE_COLORS: Record<'ma5' | 'ma20' | 'ma60' | 'ma120', string> = {
  ma5: '#f04452',
  ma20: '#a855f7',
  ma60: '#3182f6',
  ma120: '#22c55e',
};

function CandleChart({
  candles,
  width,
  height,
  trendOverlay = false,
}: {
  candles: ChartCandle[];
  width: number;
  height: number;
  /** 분봉 모드 — 추세 4선(core/trend) 오버레이. 전체 봉으로 계산해 표시 구간만 그린다. */
  trendOverlay?: boolean;
}) {
  // 시트(고정 260)와 달리 상세화면은 세로 공간이 넉넉하다 — height를 받아 영역을 나눈다.
  const volumeHeight = Math.round(height * 0.15);
  const priceHeight = height - volumeHeight - 8; // 8 = 가격/거래량 영역 사이 여백

  const shown = candles.slice(-MAX_CANDLES);
  const chartWidth = Math.max(0, width - RIGHT_AXIS_WIDTH);
  const slotWidth = shown.length > 0 ? chartWidth / shown.length : chartWidth;
  const bodyWidth = Math.max(2, slotWidth * 0.6);

  const highs = shown.map((c) => c.high);
  const lows = shown.map((c) => c.low);
  const priceMax = Math.max(...highs);
  const priceMin = Math.min(...lows);
  const priceRange = priceMax - priceMin || 1;

  const volumes = shown.map((c) => c.volume);
  const volumeMax = Math.max(...volumes, 1);

  const priceToY = (price: number) => priceHeight - ((price - priceMin) / priceRange) * priceHeight;
  const volumeToH = (vol: number) => (vol / volumeMax) * volumeHeight;

  const last = shown[shown.length - 1];
  const lastY = priceToY(last.close);

  // 추세 4선 — 전체 candles로 SMA를 계산하고(표시 구간 앞의 봉이 창을 채운다) 표시 구간만 폴리라인으로.
  const trendLines = (() => {
    if (!trendOverlay || candles.length < 2) return [];
    const series = computeTrendSeries(candles.map((c) => c.close));
    const offset = candles.length - shown.length;
    return (Object.keys(TREND_LINE_COLORS) as Array<keyof typeof TREND_LINE_COLORS>).map((key) => {
      const pts: string[] = [];
      for (let i = 0; i < shown.length; i += 1) {
        const v = series[key][offset + i];
        if (v === null) continue;
        pts.push(`${(i * slotWidth + slotWidth / 2).toFixed(1)},${priceToY(v).toFixed(1)}`);
      }
      return { key, color: TREND_LINE_COLORS[key], points: pts.join(' ') };
    });
  })();

  const priceLabels = [priceMax, priceMin + priceRange / 2, priceMin];
  const timeLabels =
    shown.length >= 2
      ? [shown[0], shown[Math.floor((shown.length - 1) / 2)], shown[shown.length - 1]]
      : shown;

  return (
    <View>
      <Svg width={width} height={height + 20}>
        {/* 캔들 — 심지 + 몸통 */}
        {shown.map((candle, i) => {
          const cx = i * slotWidth + slotWidth / 2;
          const color = candle.close > candle.open ? UP_COLOR : candle.close < candle.open ? DOWN_COLOR : DOJI_COLOR;
          const yHigh = priceToY(candle.high);
          const yLow = priceToY(candle.low);
          const yOpen = priceToY(candle.open);
          const yClose = priceToY(candle.close);
          const bodyTop = Math.min(yOpen, yClose);
          const bodyHeight = Math.max(1, Math.abs(yClose - yOpen));

          return (
            <View key={candle.key}>
              <Line
                x1={cx}
                x2={cx}
                y1={yHigh}
                y2={yLow}
                stroke={color}
                strokeWidth={1}
                strokeDasharray={candle.inProgress ? '2,2' : undefined}
              />
              {/* 아직 안 끝난 봉은 속을 비운다 — "이 봉은 확정이 아니다"를 한눈에. */}
              <Rect
                x={cx - bodyWidth / 2}
                y={bodyTop}
                width={bodyWidth}
                height={bodyHeight}
                fill={candle.inProgress ? 'none' : color}
                stroke={candle.inProgress ? color : undefined}
                strokeWidth={candle.inProgress ? 1 : undefined}
                strokeDasharray={candle.inProgress ? '2,2' : undefined}
              />
            </View>
          );
        })}

        {/* 확정/미확정 경계 — 이 선 왼쪽까지가 엔진이 판정에 쓰는 봉이다. */}
        {(() => {
          const idx = shown.findIndex((c) => c.inProgress === true);
          if (idx <= 0) return null;
          const x = idx * slotWidth;
          return (
            <Line x1={x} x2={x} y1={0} y2={priceHeight} stroke="#d1d6db" strokeWidth={1} strokeDasharray="3,3" />
          );
        })()}

        {/* 추세 4선 오버레이(분봉) */}
        {trendLines.map((l) =>
          l.points.length > 0 ? (
            <Polyline key={`trend-${l.key}`} points={l.points} fill="none" stroke={l.color} strokeWidth={1.2} />
          ) : null,
        )}

        {/* 마지막 종가 점선 + 우측 가격 태그 */}
        <Line
          x1={0}
          x2={chartWidth}
          y1={lastY}
          y2={lastY}
          stroke="#8b95a1"
          strokeWidth={1}
          strokeDasharray="4,4"
        />
        <Rect x={chartWidth + 2} y={lastY - 8} width={RIGHT_AXIS_WIDTH - 2} height={16} rx={4} fill="#191f28" />
        <SvgText x={chartWidth + 6} y={lastY + 4} fontSize={10} fill="#ffffff">
          {formatUsd(last.close)}
        </SvgText>

        {/* 우측 가격축 라벨 3개 */}
        {priceLabels.map((price, i) => (
          <SvgText
            key={i}
            x={chartWidth + 4}
            y={Math.min(Math.max(priceToY(price), 8), priceHeight - 2)}
            fontSize={10}
            fill="#8b95a1"
          >
            {formatUsd(price)}
          </SvgText>
        ))}

        {/* 거래량 미니 바(같은 색, 하단 15% 영역) */}
        {shown.map((candle, i) => {
          const cx = i * slotWidth + slotWidth / 2;
          const color = candle.close > candle.open ? UP_COLOR : candle.close < candle.open ? DOWN_COLOR : DOJI_COLOR;
          const h = Math.max(1, volumeToH(candle.volume));
          const y = priceHeight + 8 + (volumeHeight - h);
          return (
            <Rect
              key={`vol-${candle.key}`}
              x={cx - bodyWidth / 2}
              y={y}
              width={bodyWidth}
              height={h}
              fill={color}
              opacity={0.6}
            />
          );
        })}

        {/* 하단 시간 라벨 3개 */}
        {timeLabels.map((candle, i) => {
          const idx = shown.indexOf(candle);
          const x = idx * slotWidth + slotWidth / 2;
          const anchor = i === 0 ? 'start' : i === timeLabels.length - 1 ? 'end' : 'middle';
          return (
            <SvgText key={`time-${candle.key}`} x={x} y={height + 16} fontSize={10} fill="#8b95a1" textAnchor={anchor}>
              {candle.label}
            </SvgText>
          );
        })}
      </Svg>
    </View>
  );
}

const UP_MARK = { true: '상', false: '하', null: '?' } as const;

/**
 * 엔진 판정 요약 — "그래프와 감지가 일치하는가"를 화면에서 바로 확인하는 자리(2026-08-22 신설,
 * 2026-08-24 모델 기준으로 교체).
 *
 * ⚠ 이 패널은 **자기 방식으로 다시 계산하지 않는다.** 자동매매 엔진(ModelScanner)과 같은 함수
 * (`core/model/inspect`)에 같은 봉을 넣어 나온 답을 그대로 적는다. 화면이 독자적으로 판정하다
 * 엔진과 다른 답을 보여 준 게 2026-08-22 사고의 본질이었다.
 *
 * 봉 주기가 엔진과 다르면 확률을 지어내지 않고 "그 주기로는 판정하지 않는다"고만 말한다 —
 * 모델은 학습한 주기의 봉으로만 의미가 있다.
 */
function EngineVerdict({
  verdict,
  interval,
  closedBars,
}: {
  verdict: ModelInspection | null;
  interval: MinuteInterval;
  closedBars: number;
}) {
  if (interval !== ENGINE_INTERVAL || verdict === null) {
    return (
      <View className="mt-2 bg-white py-1">
        <Text className="px-5 py-[13px] text-xs leading-5 text-[#8b95a1]">
          자동매매는 {ENGINE_INTERVAL}분봉으로만 판정해요. 지금 보는 {interval}분봉으로는 모델을 돌리지 않아요 —
          위 탭에서 {ENGINE_INTERVAL}분을 고르면 앱이 지금 이 종목을 어떻게 보고 있는지 그대로 보여 줘요.
        </Text>
      </View>
    );
  }

  const why = describeReject(verdict);
  const buy = verdict.signal === 'BUY';

  return (
    <View className="mt-2 bg-white py-1">
      <View className="flex-row items-center justify-between px-5 py-[13px]">
        <Text className="text-sm text-[#4e5968]">모델 판정</Text>
        <Text className="text-sm font-semibold" style={{ color: buy ? '#f04452' : '#191f28' }}>
          {buy ? '살 자리예요' : '안 사요'}
        </Text>
      </View>
      <View className="flex-row items-center justify-between px-5 py-[13px]">
        <Text className="text-sm text-[#4e5968]">확률 / 기준</Text>
        <Text className="text-sm font-semibold text-[#191f28]" style={{ fontVariant: ['tabular-nums'] }}>
          {verdict.prob === null ? '—' : `${(verdict.prob * 100).toFixed(1)}%`} / {(verdict.threshold * 100).toFixed(1)}%
        </Text>
      </View>
      <View className="flex-row items-center justify-between px-5 py-[13px]">
        <Text className="text-sm text-[#4e5968]">오늘 판정에 쓴 봉</Text>
        <Text className="text-sm font-semibold text-[#191f28]" style={{ fontVariant: ['tabular-nums'] }}>
          {verdict.dayBars}개 · 거래대금 ${Math.round(verdict.cumDollarVolume / 10_000) / 100}M
        </Text>
      </View>
      <Text className="px-5 pb-3 pt-1 text-xs leading-5 text-[#8b95a1]">
        {why ?? '지금 봉 마감 기준으로는 매수 조건을 만족해요.'} 점선 왼쪽까지가 확정된 봉이고, 아직 안 끝난 봉은
        판정에 넣지 않아요(엔진도 같아요). 전체 {closedBars}봉 중 오늘(04:00 ET 이후) 봉만 판정에 써요.
      </Text>
    </View>
  );
}

export function ChartPanel({ ticker, excd }: ChartPanelProps) {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [mode, setMode] = useState<ChartMode>('minute');
  const [minuteInterval, setMinuteInterval] = useState<MinuteInterval>(ENGINE_INTERVAL);
  const [session, setSession] = useState<Session | null>(null);
  const [state, setState] = useState<LoadState>({ kind: 'sessionLoading' });
  const [sessionReloadKey, setSessionReloadKey] = useState(0);
  const [chartReloadKey, setChartReloadKey] = useState(0);
  /** 티커→토스 productCode 캐시(불변) — 분봉 조회마다 검색을 다시 하지 않는다. */
  const tossCodeRef = useRef<{ ticker: string; code: string } | null>(null);
  // 좌우 드래그로 과거 보기(2026-08-29 데스크탑에서 이식) — 오른쪽 끝에서 숨긴 봉 수. 0 = 최신.
  const [viewOffset, setViewOffset] = useState(0);
  const panStart = useRef(0);
  const offsetRef = useRef(0);
  const applyOffset = (n: number) => {
    offsetRef.current = n;
    setViewOffset(n);
  };
  const totalRef = useRef(0);
  const slotRef = useRef(1);
  const pan = useMemo(
    () =>
      PanResponder.create({
        // 핸들러는 한 번만 만든다(ref로 상태 접근) — 매 렌더 재생성하면 렌더 순간 제스처가 끊긴다(2026-08-30 데스크탑 실측).
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 2,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          panStart.current = offsetRef.current;
        },
        onPanResponderMove: (_e, g) => {
          const max = Math.max(0, totalRef.current - MAX_CANDLES);
          const next = Math.round(panStart.current + g.dx / slotRef.current);
          applyOffset(Math.max(0, Math.min(max, next)));
        },
      }),
    [],
  );

  // 진입 시 한 번 세션(설정 탭 KIS 키 → accessToken) 로드.
  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'sessionLoading' });

    (async () => {
      const [kisSettings, appSettings] = await Promise.all([loadKisSettings(), loadAppSettings()]);
      if (cancelled) return;
      if (!kisSettings) {
        setState({ kind: 'sessionError', message: '설정 탭에서 KIS 키를 먼저 등록해 주세요.' });
        return;
      }
      try {
        const credentials: KisCredentials = { appKey: kisSettings.appKey, appSecret: kisSettings.appSecret };
        const token = await getAccessToken(appSettings.environment, credentials, { storage: secureTokenStorage });
        if (cancelled) return;
        setSession({ credentials, environment: appSettings.environment, accessToken: token.accessToken });
      } catch (e) {
        if (!cancelled) {
          setState({ kind: 'sessionError', message: e instanceof Error ? e.message : String(e) });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionReloadKey]);

  // 세션이 준비되면(그리고 모드/분봉 간격/새로고침 변경 시에만) 차트를 조회한다.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setState({ kind: 'loading' });

    (async () => {
      try {
        let candles: ChartCandle[];
        if (mode === 'minute') {
          let code = tossCodeRef.current?.ticker === ticker ? tossCodeRef.current.code : null;
          if (!code) {
            code = await resolveTossProductCode(ticker, excd);
            if (!code) throw new Error('토스에서 종목을 찾지 못했어요');
            tossCodeRef.current = { ticker, code };
          }
          // 최신순으로 오므로 오름차순으로 뒤집는다. 표시 80봉 + 4선(120선) 워밍업 몫으로 넉넉히 받는다.
          const result = await fetchTossMinuteCandles(code, minuteInterval, 300);
          // 지금 진행 중인 봉의 키 — 이 키 이상은 아직 안 끝난 봉이다(엔진은 여기를 빼고 판정한다).
          const nowBarKey = barKeyOf(Date.now(), minuteInterval);
          candles = result
            .slice()
            .reverse()
            .map((c) => ({
              key: String(c.minuteKey),
              label: formatTossClock(c.dt),
              open: c.open,
              high: c.high,
              low: c.low,
              close: c.close,
              volume: c.volume,
              inProgress: c.minuteKey >= nowBarKey,
            }));
        } else {
          const result = await inquireOverseasPeriodChart(session.environment, session.credentials, session.accessToken, {
            excd,
            symb: ticker,
            period: PERIOD_BY_MODE[mode],
          });
          candles = result.candles.map((c) => ({
            key: c.ymd,
            label: formatDateLabel(c.ymd, mode),
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
          }));
        }
        if (cancelled) return;
        if (candles.length === 0) {
          setState({ kind: 'empty' });
          return;
        }
        // 모델 판정 — 엔진과 같은 봉 주기일 때만, 엔진과 같은 함수로. 실패해도 차트는 그대로 그린다.
        let verdict: ModelInspection | null = null;
        if (mode === 'minute' && minuteInterval === ENGINE_INTERVAL) {
          try {
            const code = tossCodeRef.current?.code;
            const daily = code ? await fetchTossDailyCloses(code, 5).catch(() => []) : [];
            if (cancelled) return;
            verdict = inspectModel(loadModel(), {
              bars: candles
                .filter((c) => c.inProgress !== true)
                .map((c) => ({
                  minuteKey: Number(c.key),
                  open: c.open,
                  high: c.high,
                  low: c.low,
                  close: c.close,
                  volume: c.volume,
                })),
              dailyCloses: daily,
              barMinutes: ENGINE_INTERVAL,
            });
          } catch {
            verdict = null; // 모델을 못 돌려도 차트는 보여 준다.
          }
        }
        if (cancelled) return;
        // 새 데이터가 오면(티커·모드 전환, 새로고침) 과거 보기를 풀고 최신으로.
        applyOffset(0);
        setState({ kind: 'ready', candles, verdict });
      } catch (e) {
        if (!cancelled) {
          setState({ kind: 'error', message: e instanceof Error ? e.message : '차트를 불러오지 못했어요' });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [session, excd, ticker, mode, minuteInterval, chartReloadKey]);

  const handleRefresh = () => {
    if (state.kind === 'sessionError') {
      setSessionReloadKey((k) => k + 1);
    } else {
      setChartReloadKey((k) => k + 1);
    }
  };

  const svgWidth = windowWidth - 32; // px-4 좌우 여백 상당
  // 세로 공간이 넉넉한 상세화면 — 창 높이의 42%(최소 260, 최대 420)로 그린다.
  const chartHeight = Math.min(420, Math.max(260, Math.round(windowHeight * 0.42)));

  return (
    <View className="flex-1 bg-white">
      <View className="flex-row items-center justify-between px-4 pt-4">
        <SegmentedToggle options={MODE_OPTIONS} value={mode} onChange={setMode} />
        <Pressable onPress={handleRefresh} hitSlop={8} className="p-1">
          <Ionicons name="refresh-outline" size={18} color="#191f28" />
        </Pressable>
      </View>
      {mode === 'minute' && (
        <View className="mt-2 px-4">
          <SegmentedToggle options={MINUTE_INTERVAL_OPTIONS} value={minuteInterval} onChange={setMinuteInterval} />
        </View>
      )}

      <View className="flex-1 pt-3">
        {state.kind === 'sessionLoading' || state.kind === 'loading' ? (
          <SkeletonChart height={chartHeight} />
        ) : state.kind === 'sessionError' ? (
          <View className="flex-1 items-center justify-center px-8">
            <Ionicons name="key-outline" size={40} color="#8b95a1" style={{ marginBottom: 12 }} />
            <Text className="mb-1 text-center text-base font-semibold text-[#191f28]">{state.message}</Text>
          </View>
        ) : state.kind === 'error' ? (
          <View className="flex-1 items-center justify-center px-8">
            <Ionicons name="alert-circle-outline" size={40} color="#8b95a1" style={{ marginBottom: 12 }} />
            <Text className="mb-1 text-center text-base font-semibold text-[#191f28]">차트를 불러오지 못했어요</Text>
            <Pressable
              onPress={handleRefresh}
              className="mt-4 rounded-2xl bg-[#3182f6] px-5 py-3 active:opacity-80"
              style={{ minHeight: 44 }}
            >
              <Text className="text-sm font-semibold text-white">다시 시도하기</Text>
            </Pressable>
          </View>
        ) : state.kind === 'empty' ? (
          <View className="flex-1 items-center justify-center px-8">
            <Ionicons name="bar-chart-outline" size={40} color="#8b95a1" style={{ marginBottom: 12 }} />
            <Text className="mb-1 text-center text-base font-semibold text-[#191f28]">아직 데이터가 없어요</Text>
            <Text className="text-center text-sm text-[#8b95a1]">장 시작 후에 데이터가 쌓여요</Text>
          </View>
        ) : (
          <View>
            {(() => {
              totalRef.current = state.candles.length;
              slotRef.current = Math.max(1, (svgWidth - RIGHT_AXIS_WIDTH) / MAX_CANDLES);
              const visible = viewOffset > 0 ? state.candles.slice(0, state.candles.length - viewOffset) : state.candles;
              return (
                <View className="px-4" {...pan.panHandlers}>
                  <CandleChart candles={visible} width={svgWidth} height={chartHeight} trendOverlay={mode === 'minute'} />
                  {viewOffset > 0 && (
                    <Pressable
                      onPress={() => applyOffset(0)}
                      className="absolute right-6 top-2 rounded-full bg-[#191f28]/70 px-3 py-1 active:opacity-80"
                    >
                      <Text className="text-[11px] font-semibold text-white">최신으로</Text>
                    </Pressable>
                  )}
                </View>
              );
            })()}
            {mode === 'minute' && (
              <EngineVerdict
                verdict={state.verdict}
                interval={minuteInterval}
                closedBars={state.candles.filter((c) => c.inProgress !== true).length}
              />
            )}
          </View>
        )}
      </View>
    </View>
  );
}
