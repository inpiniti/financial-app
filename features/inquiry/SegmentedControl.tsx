// 조회 탭 상단 세그먼트 컨트롤 — 보유종목/미체결/순위/오늘 거래 4개 전환 (toss-design: 화면당 포인트 컬러 1개).
import { Pressable, ScrollView, Text, View } from 'react-native';

export interface SegmentItem<T extends string> {
  key: T;
  label: string;
}

export function SegmentedControl<T extends string>({
  items,
  value,
  onChange,
}: {
  items: SegmentItem<T>[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <View className="mb-2 bg-white px-2 py-2">
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 8 }}>
        {items.map((item) => {
          const active = item.key === value;
          return (
            <Pressable
              key={item.key}
              onPress={() => onChange(item.key)}
              className={`mr-2 items-center justify-center rounded-2xl px-4 py-2 ${active ? 'bg-[#3182f6]' : 'bg-[#f2f4f6]'}`}
              style={{ minHeight: 44 }}
            >
              <Text className={`text-sm font-semibold ${active ? 'text-white' : 'text-[#4e5968]'}`}>{item.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}
