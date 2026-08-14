// 매도 관리 그리드 게이지 — 진입 후 관리 중(view.grid non-null)일 때 AutoPilotScreen이 Panel로 보여준다.
// 가로 게이지: 왼쪽 끝=매수가(평단−매수폭), 오른쪽 끝=매도가(평단+매도폭), 평단은 두 폭의 비율 위치.
// (2026-08-14 매수·매도폭 분리 — 폭이 비대칭이라 평단이 정중앙이 아닐 수 있다.) 현재가는 ▼ 화살표 + 말풍선.
// app-ui-style: 이모지 금지(Ionicons도 필요 없는 단순 도형이라 SVG 직접), 손익이 아니라 매수/매도 방향 색이라
// pnlColor() 대신 스킬이 지정한 고정 색(매도=#f04452·매수=#3182f6·평단/현재가=#191f28)을 그대로 쓴다.
import { useState } from 'react';
import { Text, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Line } from 'react-native-svg';
import type { AutoPilotGridView } from '../autopilot';
import { formatPrice } from './format';
import { normalizeGridPosition } from './gridGaugeMath';

const SELL_COLOR = '#f04452';
const BUY_COLOR = '#3182f6';
const NEUTRAL_COLOR = '#191f28';
const TRACK_COLOR = '#e5e8eb';
const TICK_COLOR = '#c1c9d2';
const MUTED_COLOR = '#8b95a1';

/** 매수 다리 상태 안내 문구 — full이면 없음(정상). */
const BUY_LEG_NOTICE: Record<string, string | undefined> = {
  reduced: '현금에 맞춰 매수 수량을 줄였어요',
  skippedCash: '현금이 부족해서 매수 주문은 생략했어요 — 매도 주문만 걸려 있어요',
  rejected: '매수 주문이 거절돼 매도 주문만 걸려 있어요',
};

const GAUGE_HEIGHT = 28;

/** 현재가 말풍선 예상 폭(px) — 좌우 클램프에 쓴다. 텍스트 길이에 따라 살짝 어긋날 수 있지만 게이지 폭에 비해 무시할 정도다. */
const BUBBLE_HALF_WIDTH = 24;

export interface GridGaugeProps {
  grid: AutoPilotGridView;
  /** 종목명 — 상위(리스트 행)가 알면 넘긴다. 없으면 티커로 대체 표시한다. */
  name?: string;
}

export function GridGauge({ grid, name }: GridGaugeProps) {
  const [trackWidth, setTrackWidth] = useState(0);
  const onTrackLayout = (e: LayoutChangeEvent) => setTrackWidth(e.nativeEvent.layout.width);

  const buyLegAbsent = grid.buyLegStatus === 'skippedCash' || grid.buyLegStatus === 'rejected';
  const buyLegNotice = BUY_LEG_NOTICE[grid.buyLegStatus];

  const position = grid.currentPrice === null ? null : normalizeGridPosition(grid.currentPrice, grid.buyPrice, grid.sellPrice);
  const rawArrowLeft = position === null ? null : position * trackWidth;
  const arrowLeft =
    rawArrowLeft === null ? null : Math.min(trackWidth - BUBBLE_HALF_WIDTH, Math.max(BUBBLE_HALF_WIDTH, rawArrowLeft));

  // 매수폭·매도폭이 달라(2026-08-14 분리) 평단이 정중앙이 아니다 — 트랙 위 실제 비율 위치에 그린다.
  const avgPos = normalizeGridPosition(grid.avgPrice, grid.buyPrice, grid.sellPrice);
  /** 눈금 5개 — 매수가·중간·평단·중간·매도가. 평단 위치(avgPos) 기준으로 중간 눈금을 이등분한다. */
  const tickFractions = [0, avgPos / 2, avgPos, (1 + avgPos) / 2, 1];

  return (
    <View className="px-5 pb-5 pt-1">
      {/* 헤더: 종목명 · 종목코드 · 보유수량 3열 */}
      <View className="mb-5 flex-row items-center">
        <View className="flex-1">
          <Text className="text-base font-bold text-[#191f28]" numberOfLines={1}>
            {name ?? grid.ticker}
          </Text>
        </View>
        <View className="mr-4 items-end">
          <Text className="text-xs text-[#8b95a1]">종목코드</Text>
          <Text className="text-sm font-semibold text-[#4e5968]">{grid.ticker}</Text>
        </View>
        <View className="items-end">
          <Text className="text-xs text-[#8b95a1]">보유수량</Text>
          <Text className="text-sm font-semibold text-[#4e5968]">{grid.holdingQty}주</Text>
        </View>
      </View>

      {/* 현재가 화살표 + 말풍선 — 트랙 폭을 알아야 위치를 잡을 수 있어 trackWidth가 0이면 숨긴다. */}
      <View style={{ height: 34 }}>
        {arrowLeft !== null && trackWidth > 0 && (
          <View style={{ position: 'absolute', left: arrowLeft - BUBBLE_HALF_WIDTH, width: BUBBLE_HALF_WIDTH * 2, alignItems: 'center' }}>
            <View className="rounded-full px-2 py-0.5" style={{ backgroundColor: NEUTRAL_COLOR }}>
              <Text className="text-[11px] font-semibold text-white" numberOfLines={1}>
                {formatPrice(grid.currentPrice)}
              </Text>
            </View>
            <Text style={{ color: NEUTRAL_COLOR, fontSize: 13, lineHeight: 14, marginTop: -1 }}>▼</Text>
          </View>
        )}
      </View>

      {/* 게이지 트랙 — 왼쪽 끝 매수가 · 오른쪽 끝 매도가 · 중앙 평단가. */}
      <View onLayout={onTrackLayout} style={{ height: GAUGE_HEIGHT, justifyContent: 'center' }}>
        {trackWidth > 0 && (
          <Svg width={trackWidth} height={GAUGE_HEIGHT}>
            <Line x1={0} y1={GAUGE_HEIGHT / 2} x2={trackWidth} y2={GAUGE_HEIGHT / 2} stroke={TRACK_COLOR} strokeWidth={3} strokeLinecap="round" />
            {tickFractions.map((f, i) => {
              const x = trackWidth * f;
              const isEdgeOrMid = i === 0 || i === tickFractions.length - 1 || i === 2;
              const stroke = i === 0 ? BUY_COLOR : i === tickFractions.length - 1 ? SELL_COLOR : i === 2 ? NEUTRAL_COLOR : TICK_COLOR;
              return (
                <Line
                  key={i}
                  x1={x}
                  y1={GAUGE_HEIGHT / 2 - (isEdgeOrMid ? 8 : 5)}
                  x2={x}
                  y2={GAUGE_HEIGHT / 2 + (isEdgeOrMid ? 8 : 5)}
                  stroke={stroke}
                  strokeWidth={isEdgeOrMid ? 2 : 1.5}
                />
              );
            })}
          </Svg>
        )}
      </View>

      {/* 하단 가격 라벨 — 매수가(좌)·평단가(트랙 위 실제 위치)·매도가(우).
          폭이 비대칭이라 평단 라벨은 avgPos에 절대 배치한다(트랙 폭을 모르면 중앙 폴백).
          매수 다리가 없으면(생략·거절) 회색으로 죽인다. */}
      <View className="mt-1 flex-row items-start justify-between">
        <View>
          <Text
            className="text-[11px] font-semibold"
            style={{ color: buyLegAbsent ? MUTED_COLOR : BUY_COLOR }}
          >
            매수가
          </Text>
          <Text className="text-xs font-bold" style={{ color: buyLegAbsent ? MUTED_COLOR : NEUTRAL_COLOR }}>
            {formatPrice(grid.buyPrice)}
          </Text>
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
            {formatPrice(grid.avgPrice)}
          </Text>
        </View>
        <View className="items-end">
          <Text className="text-[11px] font-semibold" style={{ color: SELL_COLOR }}>
            매도가
          </Text>
          <Text className="text-xs font-bold text-[#191f28]">{formatPrice(grid.sellPrice)}</Text>
        </View>
      </View>

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
    </View>
  );
}
