// 공용 선택 필드 — 눌리면 BottomSheet가 올라와 옵션을 ListRow로 보여준다 (.claude/skills/app-ui-style 참고).
// 데스크탑식 드롭다운·가로 칩 나열 대신 이 컴포넌트로 통일한다 — 선택 UI는 반드시 바텀시트 방식.
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BottomSheet } from './BottomSheet';
import { ListRow } from './ListRow';

export interface SelectBoxOption {
  value: string;
  label: string;
}

export interface SelectBoxProps {
  label: string;
  value: string;
  options: SelectBoxOption[];
  onChange: (value: string) => void;
}

export function SelectBox({ label, value, options, onChange }: SelectBoxProps) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);

  const handleSelect = (next: string) => {
    onChange(next);
    setOpen(false);
  };

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        className="flex-1 rounded-2xl bg-[#f2f4f6] px-3 py-2 active:opacity-70"
        style={{ minHeight: 44, justifyContent: 'center' }}
      >
        <Text className="text-[11px] text-[#8b95a1]" numberOfLines={1}>
          {label}
        </Text>
        <View className="flex-row items-center">
          <Text className="mr-1 flex-1 text-sm font-semibold text-[#191f28]" numberOfLines={1}>
            {current?.label ?? value}
          </Text>
          <Ionicons name="chevron-down" size={14} color="#8b95a1" />
        </View>
      </Pressable>

      <BottomSheet visible={open} onClose={() => setOpen(false)}>
        <Text className="px-5 pb-2 pt-1 text-base font-bold text-[#191f28]">{label}</Text>
        {options.map((opt) => (
          <ListRow
            key={opt.value}
            title={opt.label}
            onPress={() => handleSelect(opt.value)}
            trailing={opt.value === value ? <Ionicons name="checkmark" size={20} color="#3182f6" /> : undefined}
          />
        ))}
      </BottomSheet>
    </>
  );
}
