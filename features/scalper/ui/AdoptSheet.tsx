// 보유 종목 등록 시트 — 계좌 잔고에 남은 물량을 그리드 관리에 다시 태운다(다중 그리드 plan D13).
//
// 쓰는 때: FAULT로 Stop을 눌러 인터록을 풀면 앱은 그 포지션을 잊는다(주문 신뢰가 깨진 상태라 자동 복구를
// 하지 않는 게 안전 원칙이다). 계좌에는 주식이 그대로 남으므로, 사람이 확인한 뒤 여기서 다시 등록한다.
//
// ⚠ 계좌에는 자동매매와 무관한 장기 보유분이 섞여 있을 수 있어서 전 종목 자동 등록은 하지 않는다 —
//   목록을 보여주고 사용자가 하나씩 고른다.
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BottomSheet } from '../../../components/BottomSheet';
import { ListRow } from '../../../components/ListRow';
import { TickerAvatar } from '../../../components/TickerAvatar';
import type { AutoPilotManager } from '../autopilotManager';

export interface AdoptSheetProps {
  visible: boolean;
  autopilot: AutoPilotManager;
  onClose: () => void;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; tickers: readonly string[] };

export function AdoptSheet({ visible, autopilot, onClose }: AdoptSheetProps) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  /** 지금 등록 요청 중인 티커 — 같은 종목을 두 번 누르는 걸 막는다(등록은 실제 발주를 낸다). */
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    setError(null);
    try {
      const tickers = await autopilot.listAdoptableHoldings();
      setState({ kind: 'ready', tickers });
    } catch (e) {
      setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }, [autopilot]);

  useEffect(() => {
    if (visible) void load();
  }, [visible, load]);

  const handleAdopt = useCallback(
    async (ticker: string) => {
      if (busy !== null) return;
      setBusy(ticker);
      setError(null);
      try {
        const rejected = await autopilot.adoptHolding(ticker);
        if (rejected) {
          setError(rejected);
          return;
        }
        await load(); // 등록 성공 — 목록에서 빠진다.
      } finally {
        setBusy(null);
      }
    },
    [autopilot, busy, load],
  );

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <View className="p-6" style={{ paddingBottom: 32 }}>
        <Text className="mb-1 text-lg font-bold text-[#191f28]">보유 종목 등록</Text>
        <Text className="mb-4 text-xs leading-5 text-[#8b95a1]">
          계좌에 남아 있는 물량을 그리드 관리에 태워요. 수량과 평단가는 증권사 잔고에서 그대로 읽어서, 평단
          ±폭에 매수·매도 지정가를 걸어요. 자동매매와 상관없는 장기 보유 종목은 고르지 마세요.
        </Text>

        {state.kind === 'loading' && (
          <View className="items-center py-8">
            <ActivityIndicator color="#3182f6" />
            <Text className="mt-3 text-sm text-[#8b95a1]">잔고를 불러오고 있어요…</Text>
          </View>
        )}

        {state.kind === 'error' && (
          <View className="py-6">
            <Text className="mb-3 text-sm text-[#f04452]">잔고를 불러오지 못했어요 · {state.message}</Text>
            <Pressable
              onPress={() => void load()}
              className="items-center rounded-2xl bg-[#f7f9fc] py-4 active:opacity-80"
            >
              <Text className="text-base font-semibold text-[#4e5968]">다시 시도하기</Text>
            </Pressable>
          </View>
        )}

        {state.kind === 'ready' && state.tickers.length === 0 && (
          <View className="py-8">
            <Text className="text-center text-sm text-[#8b95a1]">
              등록할 수 있는 보유 종목이 없어요
            </Text>
          </View>
        )}

        {state.kind === 'ready' &&
          state.tickers.map((ticker) => (
            <ListRow
              key={ticker}
              leading={<TickerAvatar ticker={ticker} />}
              title={ticker}
              subtitle="잔고 보유분"
              trailing={
                busy === ticker ? (
                  <ActivityIndicator color="#3182f6" />
                ) : (
                  <View className="flex-row items-center" style={{ gap: 4 }}>
                    <Text className="text-sm font-semibold text-[#3182f6]">등록</Text>
                    <Ionicons name="chevron-forward" size={16} color="#3182f6" />
                  </View>
                )
              }
              onPress={() => void handleAdopt(ticker)}
            />
          ))}

        {error && <Text className="mt-2 text-xs text-[#f04452]">{error}</Text>}

        <Pressable
          onPress={onClose}
          className="mt-4 items-center rounded-2xl bg-[#f7f9fc] py-4 active:opacity-80"
        >
          <Text className="text-base font-semibold text-[#4e5968]">닫기</Text>
        </Pressable>
      </View>
    </BottomSheet>
  );
}
