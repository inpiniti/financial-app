// 단타 인스턴스 추가 시트 — 티커·수량 입력 폼(공용 BottomSheet 껍데기 사용 — 네이티브 모듈 추가 금지).
// + 추가 카드 탭, 또는 조회 탭 프리필 배너 수락 시 상위(scalper.tsx)가 initial 값을 채워 연다.
import { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { BottomSheet } from '../../../components/BottomSheet';

export interface AddInstanceInitial {
  ticker: string;
  qty: number;
}

export interface AddInstanceSheetProps {
  visible: boolean;
  initial: AddInstanceInitial;
  onClose: () => void;
  onSubmit: (input: { ticker: string; qty: number }) => void;
}

export function AddInstanceSheet({ visible, initial, onClose, onSubmit }: AddInstanceSheetProps) {
  const [ticker, setTicker] = useState(initial.ticker);
  const [qty, setQty] = useState(String(initial.qty));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setTicker(initial.ticker);
      setQty(String(initial.qty));
      setError(null);
    }
  }, [visible, initial.ticker, initial.qty]);

  const handleSubmit = () => {
    const trimmed = ticker.trim().toUpperCase();
    const parsedQty = Number(qty);
    if (!trimmed) {
      setError('티커를 입력해 주세요.');
      return;
    }
    if (!Number.isFinite(parsedQty) || parsedQty <= 0) {
      setError('수량은 0보다 큰 숫자로 입력해 주세요.');
      return;
    }
    onSubmit({ ticker: trimmed, qty: parsedQty });
  };

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <View className="p-6" style={{ paddingBottom: 32 }}>
        <Text className="mb-4 text-lg font-bold text-[#191f28]">단타 카드 추가</Text>

        <Text className="mb-1 text-xs text-[#8b95a1]">티커</Text>
        <TextInput
          value={ticker}
          onChangeText={setTicker}
          placeholder="예: AAPL"
          placeholderTextColor="#8b95a1"
          autoCapitalize="characters"
          autoCorrect={false}
          className="mb-4 rounded-2xl border border-[#e5e8eb] px-4 py-3 text-base text-[#191f28]"
        />

        <Text className="mb-1 text-xs text-[#8b95a1]">수량</Text>
        <TextInput
          value={qty}
          onChangeText={setQty}
          keyboardType="number-pad"
          className="mb-2 rounded-2xl border border-[#e5e8eb] px-4 py-3 text-base text-[#191f28]"
        />

        {error && <Text className="mb-2 text-xs text-[#f04452]">{error}</Text>}

        <View className="mt-4 flex-row" style={{ gap: 8 }}>
          <Pressable onPress={onClose} className="flex-1 items-center rounded-2xl bg-[#f7f9fc] py-4 active:opacity-80">
            <Text className="text-base font-semibold text-[#4e5968]">닫기</Text>
          </Pressable>
          <Pressable onPress={handleSubmit} className="flex-1 items-center rounded-2xl bg-[#3182f6] py-4 active:opacity-80">
            <Text className="text-base font-semibold text-white">추가하기</Text>
          </Pressable>
        </View>
      </View>
    </BottomSheet>
  );
}
