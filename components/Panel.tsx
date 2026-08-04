// 풀폭 패널(섹션) — 토스 모바일 문법: 좌우 여백 0, 라운딩·그림자 없음, 패널 사이는 부모 배경(갭)으로만 구분.
// 화면에서 카드를 직접 만들지 말고 이 컴포넌트로 섹션을 감싼다 (.claude/skills/app-ui-style 참고).
import type { ReactNode } from 'react';
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';

export interface PanelProps {
  /** 섹션 헤더 좌측 타이틀(굵게 15pt). 생략하면 헤더 자체를 그리지 않는다. */
  title?: string;
  /** 헤더 우측 보조 액션/텍스트. 문자열이면 회색 캡션 스타일로 감싼다. */
  headerRight?: ReactNode;
  children: ReactNode;
  /**
   * 패널 간 기본 갭(marginBottom 8)을 덮어써야 할 때만 쓴다 — 예: 화면을 꽉 채우는 단일 패널(flex:1, marginBottom:0).
   */
  style?: StyleProp<ViewStyle>;
}

export function Panel({ title, headerRight, children, style }: PanelProps) {
  return (
    <View className="bg-white" style={[{ marginBottom: 8 }, style]}>
      {(title || headerRight) && (
        <View className="flex-row items-center justify-between px-5 pb-2 pt-4">
          {title ? <Text className="text-[15px] font-bold text-[#191f28]">{title}</Text> : <View />}
          {typeof headerRight === 'string' ? (
            <Text className="text-xs text-[#8b95a1]">{headerRight}</Text>
          ) : (
            headerRight
          )}
        </View>
      )}
      {children}
    </View>
  );
}
