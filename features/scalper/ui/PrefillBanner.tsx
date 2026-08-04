// 조회 탭 순위 행 탭 → 'scalper.prefill' AsyncStorage 키 소비 배너.
// 화면 포커스마다 키를 확인해 배너로 제안하고, 표시 즉시 키를 지운다(재노출 방지 — "표시 후 소비").
import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Pressable, Text, View } from 'react-native';
import { SCALPER_PREFILL_KEY, type ScalperPrefillPayload } from '../../inquiry/Ranking';
import type { OverseasExchangeCode } from '../../../kis/trId';
import type { RealtimeMarketCode } from '../../../kis/realtimePrice';

/** 순위 탭의 EXCD(RankingExchangeCode 중 미국 3종)를 단타 인스턴스의 시장/거래소 코드로 변환한다. */
const EXCD_TO_MARKET: Record<string, RealtimeMarketCode> = { NAS: 'NAS', NYS: 'NYS', AMS: 'AMS' };
const EXCD_TO_EXCHANGE: Record<string, OverseasExchangeCode> = { NAS: 'NASD', NYS: 'NYSE', AMS: 'AMEX' };

export interface PrefillAccept {
  ticker: string;
  market?: RealtimeMarketCode;
  exchange?: OverseasExchangeCode;
}

export interface PrefillBannerProps {
  onAccept: (payload: PrefillAccept) => void;
}

export function PrefillBanner({ onAccept }: PrefillBannerProps) {
  const [payload, setPayload] = useState<ScalperPrefillPayload | null>(null);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        const raw = await AsyncStorage.getItem(SCALPER_PREFILL_KEY);
        if (!raw) return;
        // 표시 후 소비 — 재진입 시 같은 제안이 반복되지 않도록 즉시 지운다.
        await AsyncStorage.removeItem(SCALPER_PREFILL_KEY);
        if (cancelled) return;
        try {
          const parsed = JSON.parse(raw) as ScalperPrefillPayload;
          if (parsed?.ticker) setPayload(parsed);
        } catch {
          // 파손된 값 — 조용히 무시.
        }
      })();
      return () => {
        cancelled = true;
      };
    }, []),
  );

  if (!payload) return null;

  const handleAccept = () => {
    onAccept({
      ticker: payload.ticker,
      market: EXCD_TO_MARKET[payload.excd],
      exchange: EXCD_TO_EXCHANGE[payload.excd],
    });
    setPayload(null);
  };

  return (
    <View className="mx-4 mb-3 flex-row items-center justify-between rounded-2xl bg-[#eaf2ff] px-4 py-3">
      <Text className="flex-1 text-sm text-[#191f28]">
        {payload.name ? `${payload.name}(${payload.ticker})` : payload.ticker}을 담아뒀어요 — 카드로 만들까요?
      </Text>
      <View className="flex-row" style={{ gap: 12 }}>
        <Pressable onPress={() => setPayload(null)} hitSlop={8}>
          <Text className="text-sm text-[#8b95a1]">닫기</Text>
        </Pressable>
        <Pressable onPress={handleAccept} hitSlop={8}>
          <Text className="text-sm font-semibold text-[#3182f6]">담을게요</Text>
        </Pressable>
      </View>
    </View>
  );
}
