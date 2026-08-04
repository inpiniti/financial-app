// 단타 카드 수량 수정 시트 — IDLE/DONE/FAULT에서만 열린다(AddInstanceSheet 스타일 준용).
import { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { BottomSheet } from '../../../components/BottomSheet';

export interface EditQtySheetProps {
  visible: boolean;
  ticker: string;
  initialQty: number;
  onClose: () => void;
  onSubmit: (qty: number) => void;
}

export function EditQtySheet({ visible, ticker, initialQty, onClose, onSubmit }: EditQtySheetProps) {
  const [qty, setQty] = useState(String(initialQty));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setQty(String(initialQty));
      setError(null);
    }
  }, [visible, initialQty]);

  const handleSubmit = () => {
    const parsedQty = Number(qty);
    if (!Number.isFinite(parsedQty) || parsedQty <= 0) {
      setError('수량은 0보다 큰 숫자로 입력해 주세요.');
      return;
    }
    onSubmit(parsedQty);
  };

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <View className="p-6" style={{ paddingBottom: 32 }}>
        <Text className="mb-4 text-lg font-bold text-[#191f28]">{ticker} 수량 수정</Text>

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
            <Text className="text-base font-semibold text-white">변경하기</Text>
          </Pressable>
        </View>
      </View>
    </BottomSheet>
  );
}
