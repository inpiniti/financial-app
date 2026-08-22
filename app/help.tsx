// 대화 화면 — 홈 상단바 말풍선 버튼으로 진입. 챗봇(features/help)과 설명서 원문을 담는다.
// 화면 이름은 2026-08-22에 "도움말" → "대화"로 바꿨다(사용법만 묻는 곳이 아니라 종목·시세·로그까지 묻는 곳이 됐다).
// 라우트는 /help 그대로 둔다 — 이름만 바꾸려고 링크를 전부 옮길 이유가 없다.
// 매매와 무관한 조회 화면이라 KIS 세션을 만들지 않는다(HelpChat이 돌고 있는 매니저만 곁눈질한다).
import { View } from 'react-native';
import { BackHeader } from '../components/BackHeader';
import { HelpChat } from '../features/help/ui/HelpChat';

export default function HelpScreen() {
  return (
    <View className="flex-1 bg-[#f2f4f6]">
      <BackHeader title="대화" />
      <HelpChat />
    </View>
  );
}
