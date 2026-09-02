// 매도 관리 그리드 게이지 — 진입 후 관리 중(view.grid non-null)일 때 AutoPilotScreen이 Panel로 보여준다.
// 2026-09-02 리디자인(사용자 요청): 축을 **오늘 최저~최고**로 넓히고, 그 위에 ±밴드(평단 −3%/+3%)·평단·
// **실시간 5선**(진행 중 봉 포함, 1초 주기)·진입 후 고저·현재가를 함께 그린다. 현재가 화살표는 250ms
// 라이브 폴(getLive) + Animated(translateX, native driver)로 **부드럽게 미끄러진다** — 이전에는 매니저
// emit(초 단위)마다 순간이동해 뚝뚝 끊겨 보였다. 폴은 게이지 내부에서만 돌아 화면 전체 리렌더를 만들지 않는다.
// 헤더에 현재가의 평단 대비 %(pnlColor)를 함께 보여준다 — 1주 실험에선 금액보다 %가 정보다.
// app-ui-style: 이모지 금지(단순 도형은 SVG 직접), 매도=#f04452·매수=#3182f6·평단/현재가=#191f28 고정 색.
// 5선은 손익 색이 아니라 차트 오버레이 색 계열의 주황(#f59e0b) — 밴드 빨강/파랑과 구분되는 제3색이 필요하다.
import { memo, useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, Text, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Line } from 'react-native-svg';
import { formatKrw, formatSignedPercentFromRatio, formatUsd, pnlColor } from '../../../lib/format';
import { useUsdKrwRate } from '../../../lib/useUsdKrwRate';
import type { AutoPilotGridView } from '../autopilot';
import type { GridLiveSample } from '../autopilotManager';
import { formatPrice } from './format';
import { gaugeScaleOf, normalizeGridPosition } from './gridGaugeMath';

const SELL_COLOR = '#f04452';
const BUY_COLOR = '#3182f6';
const NEUTRAL_COLOR = '#191f28';
const TRACK_COLOR = '#e5e8eb';
const TICK_COLOR = '#c1c9d2';
const MUTED_COLOR = '#8b95a1';
/** 5선 마커 — 밴드(빨강/파랑)·평단(검정)과 구분되는 제3색(차트 이평선 계열 주황). */
const MA5_COLOR = '#f59e0b';

/** 라이브 폴 주기(ms) — 250ms면 초당 4샘플 + 그 사이를 애니메이션이 메워 사람 눈에 연속으로 보인다. */
const LIVE_POLL_MS = 250;

/** 매수 다리 상태 안내 문구 — full이면 없음(정상). */
const BUY_LEG_NOTICE: Record<string, string | undefined> = {
  reduced: '현금에 맞춰 매수 수량을 줄였어요',
  skippedCash: '현금이 부족해서 매수 주문은 생략했어요 — 매도 주문만 걸려 있어요',
  rejected: '매수 주문이 거절돼 매도 주문만 걸려 있어요',
  pending: '매수 주문은 잠시 후 현재가 기준으로 걸려요',
};

const GAUGE_HEIGHT = 28;

/**
 * 두 번 누르기로 인정하는 최대 간격(ms) — 2026-08-22 사용자 요청("연속 두 번 터치하면 매도하시겠습니까").
 * 실수로 팔리면 안 되므로 한 번 누름은 아무 일도 하지 않고, 두 번째 누름에서 확인 창을 띄운다.
 */
const DOUBLE_TAP_MS = 400;

/** 현재가 말풍선 예상 폭(px) — 좌우 클램프에 쓴다. 텍스트 길이에 따라 살짝 어긋날 수 있지만 게이지 폭에 비해 무시할 정도다. */
const BUBBLE_HALF_WIDTH = 24;

export interface GridGaugeProps {
  grid: AutoPilotGridView;
  /** 종목명 — 상위(리스트 행)가 알면 넘긴다. 없으면 티커로 대체 표시한다. */
  name?: string;
  /**
   * 게이지를 **두 번 연속 누르면** 부르는 콜백(2026-08-22) — 상위가 확인 창을 띄우고 전량 매도를 요청한다.
   * 미주입이면 게이지는 그냥 보기 전용이다(누름 없음).
   */
  onDoubleTapSell?: () => void;
  /**
   * 고빈도 라이브 샘플(2026-09-02) — 250ms마다 게이지가 스스로 불러 현재가·밴드·5선·고저를 갱신한다.
   * 미주입이면 grid(emit 스냅샷) 값만으로 그린다(옛 동작 — 테스트·하위호환).
   */
  getLive?: () => GridLiveSample | null;
}

export const GridGauge = memo(function GridGauge({ grid, name, onDoubleTapSell, getLive }: GridGaugeProps) {
  const [trackWidth, setTrackWidth] = useState(0);
  const onTrackLayout = (e: LayoutChangeEvent) => setTrackWidth(e.nativeEvent.layout.width);
  // 두 번 누르기 — 마지막 누름 시각만 기억한다(타이머 없음: 첫 누름은 어차피 아무 일도 하지 않는다).
  const lastTapAt = useRef(0);
  const handleTap = () => {
    if (!onDoubleTapSell) return;
    const now = Date.now();
    if (now - lastTapAt.current <= DOUBLE_TAP_MS) {
      lastTapAt.current = 0; // 세 번째 누름이 곧바로 또 열리지 않게.
      onDoubleTapSell();
      return;
    }
    lastTapAt.current = now;
  };

  // ── 라이브 폴(250ms) — getLive는 렌더마다 새 클로저일 수 있어 ref로 받아 interval은 한 번만 건다.
  const getLiveRef = useRef(getLive);
  getLiveRef.current = getLive;
  const [live, setLive] = useState<GridLiveSample | null>(null);
  useEffect(() => {
    if (getLiveRef.current === undefined) return;
    setLive(getLiveRef.current?.() ?? null);
    const timer = setInterval(() => setLive(getLiveRef.current?.() ?? null), LIVE_POLL_MS);
    return () => clearInterval(timer);
  }, []);

  // 라이브 샘플 우선, 없으면 emit 스냅샷(grid) — 밴드는 래칫으로 움직이므로 라이브가 더 신선하다.
  const avgPrice = live?.avgPrice ?? grid.avgPrice;
  const bandLo = live?.buyPrice ?? grid.buyPrice;
  const bandHi = live?.sellPrice ?? grid.sellPrice;
  const currentPrice = live?.currentPrice ?? grid.currentPrice;
  const holdingQty = live?.holdingQty ?? grid.holdingQty;
  const dayLow = live?.dayLow ?? null;
  const dayHigh = live?.dayHigh ?? null;
  const ma5 = live?.ma5 ?? null;
  const sinceHigh = live?.sinceEntryHigh ?? grid.sinceEntryHigh ?? null;
  const sinceLow = live?.sinceEntryLow ?? grid.sinceEntryLow ?? null;

  // 보유금액 = 보유수량 × 현재가(최근 틱). 틱이 아직 없으면 표시 불가(—).
  // 환율은 잔고 기준 공용 캐시(30분) — 못 구하면 원화 병기 없이 USD만 보여준다.
  const usdKrw = useUsdKrwRate();
  const holdingValueUsd = currentPrice === null ? null : currentPrice * holdingQty;
  const holdingValueKrw = holdingValueUsd !== null && usdKrw !== null ? holdingValueUsd * usdKrw : null;

  const dayRange = grid.rangeKind === 'dayRange';
  // 평단 대비 현재가 비율 — 틱이 없으면 null(—).
  const pnlRatio = currentPrice === null || !(avgPrice > 0) ? null : (currentPrice - avgPrice) / avgPrice;
  const buyLegAbsent = grid.buyLegStatus === 'skippedCash' || grid.buyLegStatus === 'rejected';
  const buyLegNotice = BUY_LEG_NOTICE[grid.buyLegStatus];

  // ── 축: 오늘 고저 기본 + 모든 마커 포함(2026-09-02). 마커 위치는 전부 이 축 위 0~1.
  const scale = gaugeScaleOf(
    [dayLow, dayHigh, bandLo, bandHi, avgPrice, ma5, sinceLow, sinceHigh, currentPrice],
    bandLo,
    bandHi,
  );
  const pos = (v: number | null) => (v === null || !(v > 0) ? null : normalizeGridPosition(v, scale.lo, scale.hi));
  const avgPos = pos(avgPrice) ?? 0.5;

  // ── 현재가 화살표 — Animated(translateX)로 샘플 사이를 미끄러뜨린다(native driver, 레이아웃 대신 transform).
  const arrowPos = pos(currentPrice);
  const rawArrowLeft = arrowPos === null || trackWidth <= 0 ? null : arrowPos * trackWidth;
  const arrowLeft =
    rawArrowLeft === null ? null : Math.min(trackWidth - BUBBLE_HALF_WIDTH, Math.max(BUBBLE_HALF_WIDTH, rawArrowLeft));
  const arrowX = useRef(new Animated.Value(0)).current;
  const arrowInitialized = useRef(false);
  useEffect(() => {
    if (arrowLeft === null) return;
    if (!arrowInitialized.current) {
      arrowInitialized.current = true;
      arrowX.setValue(arrowLeft); // 첫 표시는 점프(0에서 미끄러져 오지 않게).
      return;
    }
    Animated.timing(arrowX, {
      toValue: arrowLeft,
      duration: LIVE_POLL_MS,
      easing: Easing.linear,
      useNativeDriver: true,
    }).start();
  }, [arrowLeft, arrowX]);

  // 밴드 오프셋 %(평단 대비) — 모드마다 폭이 달라 하드코딩하지 않고 실제 값에서 계산한다.
  const bandLoPct = avgPrice > 0 ? ((bandLo - avgPrice) / avgPrice) * 100 : null;
  const bandHiPct = avgPrice > 0 ? ((bandHi - avgPrice) / avgPrice) * 100 : null;
  const fmtPct = (v: number | null) => (v === null ? '' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);

  /** 세로 마커 한 벌 — SVG Line. null 위치는 그리지 않는다. */
  const marker = (v: number | null, stroke: string, half: number, width: number, dash?: string) => {
    const p = v === null ? null : pos(v);
    if (p === null || trackWidth <= 0) return null;
    const x = p * trackWidth;
    return (
      <Line
        x1={x}
        y1={GAUGE_HEIGHT / 2 - half}
        x2={x}
        y2={GAUGE_HEIGHT / 2 + half}
        stroke={stroke}
        strokeWidth={width}
        strokeDasharray={dash}
      />
    );
  };

  return (
    <Pressable
      className="px-5 pb-5 pt-1"
      onPress={handleTap}
      disabled={onDoubleTapSell === undefined}
      accessibilityRole={onDoubleTapSell ? 'button' : undefined}
      accessibilityLabel={onDoubleTapSell ? `${name ?? grid.ticker} 두 번 눌러 전량 매도` : undefined}
    >
      {/* 헤더: 종목명(아래 종목코드·보유수량) · 보유금액(달러, 아래 원화 병기) 2열. */}
      <View className="mb-5 flex-row items-center">
        <View className="flex-1">
          <Text className="text-base font-bold text-[#191f28]" numberOfLines={1}>
            {name ?? grid.ticker}
          </Text>
          <Text className="text-xs text-[#8b95a1]">
            {name !== undefined ? `${grid.ticker} · ` : ''}
            {holdingQty}주
          </Text>
          <Text className="mt-0.5 text-xs font-semibold" style={{ color: pnlColor(pnlRatio) }}>
            평단 대비 {formatSignedPercentFromRatio(pnlRatio, 2)}
          </Text>
        </View>
        <View className="items-end">
          <Text className="text-xs text-[#8b95a1]">보유금액</Text>
          <Text className="text-sm font-semibold text-[#4e5968]">
            {holdingValueUsd === null ? '—' : formatUsd(holdingValueUsd, 2)}
          </Text>
          {holdingValueKrw !== null && (
            <Text className="text-xs text-[#8b95a1]">{formatKrw(holdingValueKrw)}</Text>
          )}
        </View>
      </View>

      {/* 현재가 화살표 + 말풍선 — translateX 애니메이션으로 미끄러진다. 트랙 폭을 모르면 숨긴다. */}
      <View style={{ height: 34 }}>
        {arrowLeft !== null && trackWidth > 0 && (
          <Animated.View
            style={{
              position: 'absolute',
              left: -BUBBLE_HALF_WIDTH,
              width: BUBBLE_HALF_WIDTH * 2,
              alignItems: 'center',
              transform: [{ translateX: arrowX }],
            }}
          >
            <View className="rounded-full px-2 py-0.5" style={{ backgroundColor: NEUTRAL_COLOR }}>
              <Text className="text-[11px] font-semibold text-white" numberOfLines={1}>
                {formatPrice(currentPrice)}
              </Text>
            </View>
            <Text style={{ color: NEUTRAL_COLOR, fontSize: 13, lineHeight: 14, marginTop: -1 }}>▼</Text>
          </Animated.View>
        )}
      </View>

      {/* 게이지 트랙 — 축은 오늘 최저~최고. 마커: 양끝(회색)·진입 후 고저(연회색)·±밴드(파랑/빨강)·평단(검정)·5선(주황 점선). */}
      <View onLayout={onTrackLayout} style={{ height: GAUGE_HEIGHT, justifyContent: 'center' }}>
        {trackWidth > 0 && (
          <Svg width={trackWidth} height={GAUGE_HEIGHT}>
            <Line x1={0} y1={GAUGE_HEIGHT / 2} x2={trackWidth} y2={GAUGE_HEIGHT / 2} stroke={TRACK_COLOR} strokeWidth={3} strokeLinecap="round" />
            {marker(dayLow, MUTED_COLOR, 6, 1.5)}
            {marker(dayHigh, MUTED_COLOR, 6, 1.5)}
            {marker(sinceLow, TICK_COLOR, 4, 1.5)}
            {marker(sinceHigh, TICK_COLOR, 4, 1.5)}
            {!dayRange && marker(bandLo, buyLegAbsent ? MUTED_COLOR : BUY_COLOR, 8, 2)}
            {!dayRange && marker(bandHi, SELL_COLOR, 8, 2)}
            {marker(avgPrice, NEUTRAL_COLOR, 9, 2)}
            {marker(ma5, MA5_COLOR, 8, 2, '2 2')}
          </Svg>
        )}
      </View>

      {/* 하단 라벨 — 좌 오늘 최저 · 중(평단 위치) 평단가 · 우 오늘 최고. 고저가 아직 없으면 밴드 끝을 대신 적는다. */}
      <View className="mt-1 flex-row items-start justify-between">
        <View>
          <Text className="text-[11px] font-semibold" style={{ color: MUTED_COLOR }}>
            오늘 최저
          </Text>
          <Text className="text-xs font-bold text-[#191f28]">{formatPrice(dayLow ?? bandLo)}</Text>
        </View>
        <View
          className="items-center"
          style={
            trackWidth > 0
              ? {
                  position: 'absolute',
                  left: Math.min(trackWidth - BUBBLE_HALF_WIDTH * 2, Math.max(BUBBLE_HALF_WIDTH * 2, avgPos * trackWidth)) - BUBBLE_HALF_WIDTH,
                  width: BUBBLE_HALF_WIDTH * 2,
                }
              : undefined
          }
        >
          <Text className="text-[11px] font-semibold text-[#191f28]">평단가</Text>
          <Text className="text-xs font-bold text-[#191f28]" numberOfLines={1}>
            {formatPrice(avgPrice)}
          </Text>
        </View>
        <View className="items-end">
          <Text className="text-[11px] font-semibold" style={{ color: MUTED_COLOR }}>
            오늘 최고
          </Text>
          <Text className="text-xs font-bold text-[#191f28]">{formatPrice(dayHigh ?? bandHi)}</Text>
        </View>
      </View>

      {/* 마커 값 줄 — 밴드(±%)·진입 후 고저·5선 위치 관계. 색이 트랙 마커와 1:1로 대응한다. */}
      {!dayRange && (
        <Text className="mt-2 text-[11px] text-[#8b95a1]">
          밴드 <Text style={{ color: buyLegAbsent ? MUTED_COLOR : BUY_COLOR }}>{fmtPct(bandLoPct)} {formatPrice(bandLo)}</Text>
          {' · '}
          <Text style={{ color: SELL_COLOR }}>{fmtPct(bandHiPct)} {formatPrice(bandHi)}</Text>
          {sinceLow !== null && sinceHigh !== null && (
            <Text>{`  ·  진입 후 ${formatPrice(sinceLow)}~${formatPrice(sinceHigh)}`}</Text>
          )}
        </Text>
      )}
      {ma5 !== null && currentPrice !== null && (
        <Text className="mt-0.5 text-[11px] text-[#8b95a1]">
          <Text style={{ color: MA5_COLOR }}>5선 {formatPrice(ma5)}</Text>
          {` · 현재가는 5선 ${currentPrice >= ma5 ? '위' : '아래'} · 평단은 5선 ${avgPrice >= ma5 ? '위' : '아래'}`}
        </Text>
      )}

      {/* 상태 안내 — 격리 멈춤(빨강) > 매수 다리 안내 > 주문 준비 중 순으로 하나만 보여준다. */}
      {grid.faultText !== null ? (
        <Text className="mt-3 text-xs font-semibold" style={{ color: SELL_COLOR }}>
          이 종목 관리가 멈췄어요 — {grid.faultText}
        </Text>
      ) : buyLegNotice !== undefined ? (
        <Text className="mt-3 text-xs" style={{ color: MUTED_COLOR }}>
          {buyLegNotice}
        </Text>
      ) : (
        !grid.gridActive && <Text className="mt-3 text-xs text-[#8b95a1]">그리드 주문을 거는 중이에요…</Text>
      )}

      {/* 두 번 누르기 안내 — 숨은 기능이 되지 않게 항상 적어 둔다(격리 멈춤 중에는 누를 수 없으니 숨긴다). */}
      {onDoubleTapSell !== undefined && grid.faultText === null && (
        <Text className="mt-3 text-xs text-[#8b95a1]">두 번 누르면 전량 매도할 수 있어요</Text>
      )}
    </Pressable>
  );
});
