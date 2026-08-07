import '../global.css';
import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { initLogoStore } from '../lib/logoStore';

// Stack 루트 — 게이트(index) → 홈(home) → 조회/설정. 홈 화면은 게이트 통과 후 최초 화면이자
// 단타 매매가 진행되는 화면이라, 여기서 매니저 싱글턴을 별도 Provider로 감쌀 필요는 없다
// (features/scalper/ui/managerProvider.tsx가 모듈 스코프 싱글턴이라 화면 이동과 무관하게 유지된다).
export default function RootLayout() {
  // 로고 도메인 부트스트랩 — 캐시 즉시 로드 + 24h 지난 경우만 백그라운드 재조회(실패 시 캐시 유지).
  useEffect(() => {
    void initLogoStore();
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="home" />
        <Stack.Screen name="inquiry" />
        <Stack.Screen name="settings" />
        <Stack.Screen name="stock/[ticker]" />
      </Stack>
    </SafeAreaProvider>
  );
}
