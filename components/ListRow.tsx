// 촘촘한 리스트 행 — 토스 모바일 문법: 행마다 카드로 감싸지 않고, 행 패딩(수평 20·수직 13)만으로 밀도를 낸다.
// 행 사이 간격·구분선은 기본적으로 없다. Panel 내부에서만 쓴다 (.claude/skills/app-ui-style 참고).
import { memo, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

export interface ListRowProps {
  /** 좌측 아바타 등. */
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  /** 우측 값 영역 — 보통 금액/등락/배지. */
  trailing?: ReactNode;
  /** 있으면 Pressable로 감싸고, 눌렸을 때 배경을 #f7f9fc로 바꾼다. */
  onPress?: () => void;
}

// memo — 리스트 리렌더에서 props 참조가 같은 행은 건너뛴다. 단, leading/trailing에 인라인 요소를
// 넘기면 매 렌더 새 참조라 효과가 없다 — 그런 화면은 행 래퍼 컴포넌트를 memo로 감싼다(Ranking 등 참고).
export const ListRow = memo(function ListRow({ leading, title, subtitle, trailing, onPress }: ListRowProps) {
  const body = (
    <View className="flex-row items-center px-5 py-[13px]" style={{ minHeight: 44 }}>
      {leading && <View className="mr-3">{leading}</View>}
      <View className="flex-1">
        {typeof title === 'string' ? (
          <Text className="text-base font-bold text-[#191f28]" numberOfLines={1}>
            {title}
          </Text>
        ) : (
          title
        )}
        {subtitle != null &&
          (typeof subtitle === 'string' ? (
            <Text className="mt-0.5 text-sm text-[#8b95a1]" numberOfLines={1}>
              {subtitle}
            </Text>
          ) : (
            subtitle
          ))}
      </View>
      {trailing && <View className="ml-3 items-end">{trailing}</View>}
    </View>
  );

  if (!onPress) return body;

  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ backgroundColor: pressed ? '#f7f9fc' : 'transparent' })}>
      {body}
    </Pressable>
  );
});
