// "+ 추가" 점선 카드 — 탭하면 상위(스크린)가 관리하는 추가 시트를 연다. 상한 도달 시 비활성 + 안내.
import { Pressable, Text, View } from 'react-native';

import { MAX_INSTANCES } from '../scalperManager';

export interface AddCardProps {
  disabled: boolean;
  onPress: () => void;
}

export function AddCard({ disabled, onPress }: AddCardProps) {
  return (
    <View className="mb-2 bg-white px-5 py-3">
      <Pressable
        onPress={disabled ? undefined : onPress}
        disabled={disabled}
        className="items-center justify-center rounded-2xl border border-dashed border-[#c3c9d1] py-6 active:opacity-70"
        style={{ minHeight: 44 }}
      >
        <Text className="text-sm font-semibold text-[#4e5968]">{disabled ? `최대 ${MAX_INSTANCES}개까지 만들 수 있어요` : '+ 추가'}</Text>
      </Pressable>
    </View>
  );
}
