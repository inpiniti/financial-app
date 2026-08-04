// 종목 선택용 하단 시트 — 댓글/차트/호가 시트와 동일한 공용 BottomSheet 껍데기를 써서 시각을 통일한다
// (edge-to-edge, 상단 라운딩, 그랩 핸들, 딤 페이드+슬라이드). 옵션은 ListRow 톤으로 세로 나열한다.
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BottomSheet } from './BottomSheet';

export interface ActionSheetOption {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  /** 누르면 시트를 먼저 닫은 뒤 실행된다. */
  onPress: () => void;
}

export interface ActionSheetProps {
  visible: boolean;
  onClose: () => void;
  /** 상단 제목(선택). 예: 대상 종목 티커. */
  title?: string;
  options: ActionSheetOption[];
}

export function ActionSheet({ visible, onClose, title, options }: ActionSheetProps) {
  // 옵션을 누르면 시트를 먼저 닫고(onClose) 그다음 액션을 실행한다 — 호출자가 매번 닫기를 반복하지 않게.
  const handleOptionPress = (onPress: () => void) => {
    onClose();
    onPress();
  };

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <View className="flex-row items-center justify-between px-6 pb-2 pt-3">
        <Text className="text-lg font-bold text-[#191f28]">{title ?? '보기'}</Text>
        <Pressable onPress={onClose} hitSlop={8} className="p-1">
          <Text className="text-lg text-[#8b95a1]">×</Text>
        </Pressable>
      </View>

      <View className="pb-4">
        {options.map((opt) => (
          <Pressable
            key={opt.label}
            onPress={() => handleOptionPress(opt.onPress)}
            className="flex-row items-center px-6"
            style={({ pressed }) => ({ minHeight: 56, backgroundColor: pressed ? '#f7f9fc' : 'transparent' })}
          >
            <Ionicons name={opt.icon} size={22} color="#3182f6" style={{ marginRight: 14 }} />
            <Text className="text-base font-semibold text-[#191f28]">{opt.label}</Text>
          </Pressable>
        ))}
      </View>
    </BottomSheet>
  );
}
