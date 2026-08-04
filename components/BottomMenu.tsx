// 화면 내부 고정 하단 메뉴(OS 탭바 아님) — 조회/설정 화면에서 서브 섹션 전환에 쓴다.
// 기존 하단 탭 스타일(아이콘 + 라벨)과 유사하게 맞춘다.
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export interface BottomMenuItem<T extends string> {
  key: T;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  activeIcon: keyof typeof Ionicons.glyphMap;
}

export function BottomMenu<T extends string>({
  items,
  value,
  onChange,
}: {
  items: BottomMenuItem<T>[];
  value: T;
  onChange: (next: T) => void;
}) {
  const insets = useSafeAreaInsets();

  return (
    <View
      className="flex-row bg-white"
      style={{ paddingBottom: insets.bottom, borderTopWidth: 1, borderTopColor: '#f2f4f6' }}
    >
      {items.map((item) => {
        const active = item.key === value;
        const color = active ? '#3182f6' : '#8b95a1';
        return (
          <Pressable
            key={item.key}
            onPress={() => onChange(item.key)}
            className="flex-1 items-center justify-center py-2 active:opacity-70"
            style={{ minHeight: 52 }}
          >
            <Ionicons name={active ? item.activeIcon : item.icon} size={22} color={color} />
            <Text className="mt-0.5 text-[11px] font-semibold" style={{ color }}>
              {item.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
