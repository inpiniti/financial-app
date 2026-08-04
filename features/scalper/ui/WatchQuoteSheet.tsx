// 자동 단타 "단타 리스트" 행 → 호가 조회 바텀시트(조회 전용, 공용 BottomSheet 껍데기 사용).
// QuoteSheet.tsx(수동 카드용)와 같은 시각 패턴(1호가·스프레드·"n초 전"·ASK/BID 색)을 재사용하되,
// 데이터 소스가 다르다 — 인스턴스 구독 대신 getRow()가 반환하는 AutoPilotSlotRow.view(FeedSlotView)를
// 시트가 열려 있는 동안 1초 폴링으로 다시 읽는다. autopilotManager.ts는 이미 공개된 getRows()(→ getRow로
// 티커 하나만 찾아 전달)만 쓰고, 매매 로직에는 손대지 않는다. 구독 ACK 세부 진단은 범위 밖 —
// 1호가·스프레드·수신 시각만 보여준다.
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { BottomSheet } from '../../../components/BottomSheet';
import type { AutoPilotSlotRow } from '../autopilotManager';
import { formatPrice } from './format';

export interface WatchQuoteSheetProps {
  visible: boolean;
  ticker: string;
  /** 호출 시점의 최신 행을 반환 — 리스트에서 빠졌으면(감시 대상 아님) undefined. */
  getRow: () => AutoPilotSlotRow | undefined;
  onClose: () => void;
}

const NEUTRAL_COLOR = '#8b95a1';
/** 호가는 매도1호가(높은 쪽)=상승 관례 색, 매수1호가(낮은 쪽)=하락 관례 색 — QuoteSheet.tsx와 동일 톤. */
const ASK_COLOR = '#f04452';
const BID_COLOR = '#3182f6';

function SectionLabel({ children }: { children: string }) {
  return <Text className="text-xs font-semibold text-[#8b95a1]">{children}</Text>;
}

export function WatchQuoteSheet({ visible, ticker, getRow, onClose }: WatchQuoteSheetProps) {
  const [row, setRow] = useState<AutoPilotSlotRow | undefined>(() => (visible ? getRow() : undefined));
  const [now, setNow] = useState(() => Date.now());

  // 시트가 열려 있는 동안만 1초 폴링 — getRow()가 매번 최신 스냅샷을 반환한다(구독 아님, 신규 요청 없음).
  useEffect(() => {
    if (!visible) return;
    setRow(getRow());
    setNow(Date.now());
    const timer = setInterval(() => {
      setRow(getRow());
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, [visible, ticker, getRow]);

  const view = row?.view;
  const bid1 = view?.bid1 ?? null;
  const ask1 = view?.ask1 ?? null;
  const hasQuote = bid1 !== null && ask1 !== null;

  const spread = hasQuote ? (ask1 as number) - (bid1 as number) : null;
  const spreadPct = spread !== null && bid1 ? (spread / bid1) * 100 : null;

  const secondsSinceLastTick =
    view?.lastTickAt != null ? Math.max(0, Math.floor((now - view.lastTickAt) / 1000)) : null;

  return (
    <BottomSheet visible={visible} onClose={onClose} heightRatio={0.5}>
      <View className="flex-row items-center justify-between px-6 pt-5">
        <Text className="text-lg font-bold text-[#191f28]">{ticker} 호가</Text>
        <Pressable onPress={onClose} hitSlop={8} className="p-1">
          <Text className="text-lg text-[#8b95a1]">×</Text>
        </Pressable>
      </View>

      <View className="px-6 pb-6 pt-4">
        <SectionLabel>호가 현황</SectionLabel>

        {!hasQuote ? (
          <View className="mt-6 items-center pb-2">
            <Text className="text-center text-sm font-semibold" style={{ color: NEUTRAL_COLOR }}>
              이 종목은 현재 감시 대상이 아니라 호가를 안 받고 있어요
            </Text>
          </View>
        ) : (
          <>
            <View className="mt-3 items-center">
              <Text className="text-xs text-[#8b95a1]">매도1호가</Text>
              <Text className="text-2xl font-bold" style={{ color: ASK_COLOR }}>
                {formatPrice(ask1)}
              </Text>
            </View>

            <View className="items-center py-2">
              <Text className="text-xs text-[#8b95a1]">
                {spread !== null
                  ? `스프레드 $${spread.toFixed(2)} · ${(spreadPct ?? 0).toFixed(2)}%`
                  : '스프레드 —'}
              </Text>
            </View>

            <View className="items-center">
              <Text className="text-xs text-[#8b95a1]">매수1호가</Text>
              <Text className="text-2xl font-bold" style={{ color: BID_COLOR }}>
                {formatPrice(bid1)}
              </Text>
            </View>

            <Text className="mt-3 text-center text-xs" style={{ color: NEUTRAL_COLOR }}>
              {secondsSinceLastTick !== null ? `마지막 ${secondsSinceLastTick}초 전` : '수신 시각 —'}
            </Text>
          </>
        )}
      </View>
    </BottomSheet>
  );
}
