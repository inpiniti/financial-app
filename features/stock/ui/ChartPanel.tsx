// 종목 상세화면 "차트" 탭 — 옛 ChartSheet.tsx(바텀시트)에서 추출한 유일한 차트 구현.
// 분봉/일봉/주봉/월봉 통합 — 진입·기간(모드/분봉 간격) 변경·새로고침 버튼 때만 조회한다(폴링 금지).
// 캔들 렌더는 react-native-svg(기설치)로 직접 그린다 — 차트 라이브러리 추가 설치 없음.
import { useEffect, useState } from 'react';
import { Pressable, Text, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Line, Rect, Text as SvgText } from 'react-native-svg';
import { getAccessToken } from '../../../kis/token';
import { inquireOverseasMinuteChart, type MinuteChartExchangeCode } from '../../../kis/minuteChart';
import { inquireOverseasPeriodChart, type PeriodChartPeriod } from '../../../kis/periodChart';
import type { KisCredentials, KisEnvironment } from '../../../kis/types';
import { loadAppSettings } from '../../../lib/appSettings';
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
];

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
}

type LoadState =
  | { kind: 'sessionLoading' }
  | { kind: 'sessionError'; message: string }
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; candles: ChartCandle[] };

interface Session {
  credentials: KisCredentials;
  environment: KisEnvironment;
  accessToken: string;
}

/** "093000"(HHMMSS) → "09:30". 형식이 다르면 원본을 그대로 돌려준다. */
function formatClock(hms: string): string {
  if (hms.length < 4) return hms;
  return `${hms.slice(0, 2)}:${hms.slice(2, 4)}`;
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
function CandleChart({ candles, width, height }: { candles: ChartCandle[]; width: number; height: number }) {
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
              <Line x1={cx} x2={cx} y1={yHigh} y2={yLow} stroke={color} strokeWidth={1} />
              <Rect x={cx - bodyWidth / 2} y={bodyTop} width={bodyWidth} height={bodyHeight} fill={color} />
            </View>
          );
        })}

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

export function ChartPanel({ ticker, excd }: ChartPanelProps) {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [mode, setMode] = useState<ChartMode>('minute');
  const [minuteInterval, setMinuteInterval] = useState<MinuteInterval>(1);
  const [session, setSession] = useState<Session | null>(null);
  const [state, setState] = useState<LoadState>({ kind: 'sessionLoading' });
  const [sessionReloadKey, setSessionReloadKey] = useState(0);
  const [chartReloadKey, setChartReloadKey] = useState(0);

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
          const result = await inquireOverseasMinuteChart(session.credentials, session.accessToken, {
            excd,
            symb: ticker,
            nmin: minuteInterval,
          });
          candles = result.candles.map((c) => ({
            key: `${c.ymd}${c.hms}`,
            label: formatClock(c.hms),
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
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
        setState(candles.length === 0 ? { kind: 'empty' } : { kind: 'ready', candles });
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
          <View className="px-4">
            <CandleChart candles={state.candles} width={svgWidth} height={chartHeight} />
          </View>
        )}
      </View>
    </View>
  );
}
