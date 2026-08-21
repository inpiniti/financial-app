// 도움말 화면 — 홈 상단바 말풍선 버튼으로 진입. 앱 사용법 챗봇(features/help)과 설명서 원문을 담는다.
// 매매와 무관한 조회 화면이라 KIS 세션을 만들지 않는다(HelpChat이 돌고 있는 매니저만 곁눈질한다).
import { View } from 'react-native';
import { BackHeader } from '../components/BackHeader';
import { HelpChat } from '../features/help/ui/HelpChat';

export default function HelpScreen() {
  return (
    <View className="flex-1 bg-[#f2f4f6]">
      <BackHeader title="도움말" />
      <HelpChat />
    </View>
  );
}
