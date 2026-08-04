// 공용 on/off 토글 행 — 좌측 제목·설명, 우측 켜짐/꺼짐 pill. 행 전체가 눌린다.
//
// react-native Switch를 쓰지 않는 이유: 플랫폼별 렌더가 제각각이라 토스풍 톤과 맞지 않고,
// 저장소 어디에도 Switch 사용처가 없다. 원래 InstanceCard에 인라인으로 있던 pill 토글을
// 사용처가 늘면서 그대로(마크업·색상 동일) 공용으로 승격한 것이다.
import { Pressable, Text, View } from 'react-native';

export interface ToggleRowProps {
  title: string;
  /** 한 줄 보조 설명(선택). */
  description?: string;
  value: boolean;
  onValueChange: (next: boolean) => void;
  /** 누를 수 없는 상태 — 값은 그대로 보여주되 흐리게 표시한다(선행 조건이 꺼져 있을 때). */
  disabled?: boolean;
  onLabel?: string;
  offLabel?: string;
  /** 컨테이너 클래스 오버라이드 — 시트 안에서는 배경을 빼는 식으로 쓴다. */
  className?: string;
}

export function ToggleRow({
  title,
  description,
  value,
  onValueChange,
  disabled = false,
  onLabel = '켜짐',
  offLabel = '꺼짐',
  className = 'mt-4 flex-row items-center justify-between rounded-2xl bg-[#f7f9fc] px-3 py-2 active:opacity-80',
}: ToggleRowProps) {
  return (
    <Pressable
      onPress={() => {
        if (!disabled) onValueChange(!value);
      }}
      disabled={disabled}
      hitSlop={8}
      className={className}
      style={disabled ? { opacity: 0.5 } : undefined}
    >
      <View className="flex-1 pr-3">
        <Text className="text-sm font-semibold text-[#191f28]">{title}</Text>
        {description ? <Text className="text-[11px] text-[#8b95a1]">{description}</Text> : null}
      </View>
      <View className="rounded-full px-3 py-1" style={{ backgroundColor: value ? '#eaf2ff' : '#e5e8eb' }}>
        <Text className="text-xs font-semibold" style={{ color: value ? '#3182f6' : '#8b95a1' }}>
          {value ? onLabel : offLabel}
        </Text>
      </View>
    </Pressable>
  );
}
