// 홈 섹션 공통 UI 조각 — 스켈레톤/빈 상태/설정 유도 안내 (toss-design 스킬 톤 준수).
import { View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export function SkeletonRow() {
  return (
    <View className="px-5 py-[13px]">
      <View className="mb-2 h-4 w-1/3 rounded-full bg-[#e5e8eb]" />
      <View className="h-3 w-1/2 rounded-full bg-[#f2f4f6]" />
    </View>
  );
}

export function SkeletonList({ count = 4 }: { count?: number }) {
  return (
    <View className="bg-white pt-1">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonRow key={i} />
      ))}
    </View>
  );
}

export function EmptyState({
  icon,
  title,
  description,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  description: string;
}) {
  return (
    <View className="flex-1 items-center justify-center px-8 py-16">
      <Ionicons name={icon} size={40} color="#8b95a1" style={{ marginBottom: 12 }} />
      <Text className="mb-1 text-base font-semibold text-[#191f28]">{title}</Text>
      <Text className="text-center text-sm text-[#8b95a1]">{description}</Text>
    </View>
  );
}

/** KIS 키 미설정 안내 — PRD 지시 문구 그대로. */
export function SetupNotice() {
  return (
    <EmptyState
      icon="key-outline"
      title="아직 키가 등록되지 않았어요"
      description="계좌 화면에서 키를 먼저 등록해 주세요"
    />
  );
}

export function ErrorNotice({ message }: { message: string }) {
  return (
    <EmptyState
      icon="alert-circle-outline"
      title="잠시 연결이 어려워요"
      description={`조금 뒤에 다시 시도해 주세요. (${message})`}
    />
  );
}
