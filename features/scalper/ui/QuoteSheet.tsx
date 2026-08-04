// 단타 카드 → "호가 진단" 바텀시트(조회 전용, 공용 BottomSheet 껍데기 사용).
// 목적: 체결 대기가 길어지는 원인이 "호가(HDFSASP0) 미수신 → 현재가 폴백" 때문인지 실기기에서 눈으로 판별하게 한다.
// 새 네트워크 요청·폴링은 만들지 않는다 — 인스턴스가 이미 받고 있는 실시간호가 구독(기존 스로틀 발행)을
// 그대로 소비하고, 구독 ACK 상태·발주가 미리보기는 manager/instance의 기존 동기 메서드를 1초 간격으로 다시 읽기만 한다.
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { BottomSheet } from '../../../components/BottomSheet';
import { buildFreeQuoteTrKey, buildQuoteTrKey } from '../../../kis/realtimePrice';
import type { ScalperInstance } from '../scalperInstance';
import type { ScalperManager } from '../scalperManager';
import type { ScalperInstanceView } from '../types';
import { formatHHMM, formatPrice } from './format';

export interface QuoteSheetProps {
  visible: boolean;
  instance: ScalperInstance;
  manager: ScalperManager;
  onClose: () => void;
}

const WARN_COLOR = '#ff9500';
const ERROR_COLOR = '#f04452';
const NEUTRAL_COLOR = '#8b95a1';
const PRIMARY_COLOR = '#191f28';
/** 호가는 매도1호가(높은 쪽)=상승 관례 색, 매수1호가(낮은 쪽)=하락 관례 색 — pnlColor와 동일한 톤 배정. */
const ASK_COLOR = '#f04452';
const BID_COLOR = '#3182f6';

function SectionLabel({ children }: { children: string }) {
  return <Text className="text-xs font-semibold text-[#8b95a1]">{children}</Text>;
}

/** 구독 상태 1줄 — 성공/실패/응답없음 3분기(모두 요구된 문구 그대로). */
function SubscriptionLine({
  label,
  trKey,
  trId,
  manager,
}: {
  label: string;
  trKey: string;
  /** 체결가·호가가 같은 trKey 문자열을 쓰므로 trId로 구분한다(기본 HDFSCNT0). */
  trId?: string;
  manager: ScalperManager;
}) {
  const status = manager.getSubscriptionStatus(trKey, trId);
  const text = !status
    ? '응답 없음'
    : status.success
      ? `구독 성공 · ${formatHHMM(status.at)}`
      : `구독 실패 · ${status.message || '알 수 없음'}`;
  const color = !status ? NEUTRAL_COLOR : status.success ? PRIMARY_COLOR : ERROR_COLOR;

  return (
    <View className="mt-2 flex-row items-center justify-between">
      <Text className="text-sm text-[#4e5968]">
        {label} <Text className="text-xs text-[#8b95a1]">· {trKey}</Text>
      </Text>
      <Text className="text-sm font-semibold" style={{ color }}>
        {text}
      </Text>
    </View>
  );
}

export function QuoteSheet({ visible, instance, manager, onClose }: QuoteSheetProps) {
  const [view, setView] = useState<ScalperInstanceView>(() => instance.getView());
  // 구독 ACK·발주가 미리보기는 시간(신선도 10초)에 따라 값이 바뀌므로, 시트가 열려 있는 동안만 1초 주기로 재계산한다.
  const [now, setNow] = useState(() => Date.now());

  // 시트가 열릴 때만 인스턴스 뷰를 구독 — 기존 스로틀 발행을 그대로 소비(추가 요청 없음).
  useEffect(() => {
    if (!visible) return;
    setView(instance.getView());
    return instance.subscribe(setView);
  }, [visible, instance]);

  // 1초 틱 — "n초 전"·구독 ACK 경과 시간·발주가 미리보기(신선도 판정)를 갱신한다. 시트가 닫히면 반드시 clear.
  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [visible]);

  const config = manager.getConfig(instance.id);
  const market = config?.market ?? 'NAS';
  const fillTrKey = buildFreeQuoteTrKey(market, instance.ticker);
  const quoteTrKey = buildQuoteTrKey(market, instance.ticker);

  const secondsSinceLastQuote =
    view.lastQuoteAt !== null ? Math.max(0, Math.floor((now - view.lastQuoteAt) / 1000)) : null;

  const spread = view.ask1 !== null && view.bid1 !== null ? view.ask1 - view.bid1 : null;
  const spreadPct = spread !== null && view.bid1 ? (spread / view.bid1) * 100 : null;

  // `now`를 의존값으로 재계산해 신선도(10초) 경과에 따른 폴백 전환을 시트가 스스로 반영하게 한다.
  const buyPreview = instance.previewOrderPrice('buy');
  const sellPreview = instance.previewOrderPrice('sell');
  const anyFallback = buyPreview.fallback || sellPreview.fallback;

  return (
    <BottomSheet visible={visible} onClose={onClose} heightRatio={0.75}>
      <View className="flex-row items-center justify-between px-6 pt-5">
        <Text className="text-lg font-bold text-[#191f28]">{instance.ticker} 호가 진단</Text>
        <Pressable onPress={onClose} hitSlop={8} className="p-1">
          <Text className="text-lg text-[#8b95a1]">×</Text>
        </Pressable>
      </View>

      <View className="px-6 pb-4 pt-4">
        <SectionLabel>구독 상태</SectionLabel>
        <SubscriptionLine label="체결가" trKey={fillTrKey} manager={manager} />
        <SubscriptionLine label="호가" trKey={quoteTrKey} trId="HDFSASP0" manager={manager} />
      </View>

      <View className="px-6 pb-4 pt-4" style={{ borderTopWidth: 1, borderTopColor: '#f2f4f6' }}>
        <SectionLabel>호가 현황</SectionLabel>

        <View className="mt-3 items-center">
          <Text className="text-xs text-[#8b95a1]">매도1호가</Text>
          <Text className="text-2xl font-bold" style={{ color: ASK_COLOR }}>
            {formatPrice(view.ask1)}
          </Text>
          <Text className="text-xs text-[#8b95a1]">
            {view.askVol1 !== undefined ? `${view.askVol1.toLocaleString()}주` : '—'}
          </Text>
        </View>

        <View className="items-center py-2">
          <Text className="text-xs text-[#8b95a1]">
            {spread !== null
              ? `스프레드 $${spread.toFixed(2)} · ${(spreadPct ?? 0).toFixed(2)}%`
              : '스프레드 — (양쪽 호가가 아직 없어요)'}
          </Text>
        </View>

        <View className="items-center">
          <Text className="text-xs text-[#8b95a1]">매수1호가</Text>
          <Text className="text-2xl font-bold" style={{ color: BID_COLOR }}>
            {formatPrice(view.bid1)}
          </Text>
          <Text className="text-xs text-[#8b95a1]">
            {view.bidVol1 !== undefined ? `${view.bidVol1.toLocaleString()}주` : '—'}
          </Text>
        </View>

        {view.quoteCount === 0 ? (
          <Text className="mt-3 text-center text-xs font-semibold" style={{ color: WARN_COLOR }}>
            호가가 안 들어와요 — 구독이 거절됐을 수 있어요
          </Text>
        ) : (
          <Text className="mt-3 text-center text-xs" style={{ color: NEUTRAL_COLOR }}>
            {view.quoteCount}건 · 마지막 {secondsSinceLastQuote ?? 0}초 전
          </Text>
        )}
      </View>

      <View className="px-6 pb-6 pt-4" style={{ borderTopWidth: 1, borderTopColor: '#f2f4f6' }}>
        <SectionLabel>주문가 미리보기</SectionLabel>
        <Text className="mt-2 text-sm text-[#191f28]">
          지금 매수하면 → <Text className="font-bold">{formatPrice(buyPreview.price)}</Text>{' '}
          {buyPreview.fallback ? '(현재가 폴백)' : '(매도1호가)'}
        </Text>
        <Text className="mt-1 text-sm text-[#191f28]">
          지금 매도하면 → <Text className="font-bold">{formatPrice(sellPreview.price)}</Text>{' '}
          {sellPreview.fallback ? '(현재가 폴백)' : '(매수1호가)'}
        </Text>
        {anyFallback && (
          <Text className="mt-2 text-xs font-semibold" style={{ color: WARN_COLOR }}>
            폴백: 현재가 {formatPrice(view.price)} 사용
          </Text>
        )}
      </View>
    </BottomSheet>
  );
}
