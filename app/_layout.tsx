import '../global.css';
import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { installKisTokenRefresher } from '../lib/kisTokenRefresher';
import { initLogoStore } from '../lib/logoStore';

// KIS 토큰 만료(EGW00123) 자동 복구 등록 — 화면 렌더 전에 끝나야 첫 요청부터 보호된다.
installKisTokenRefresher();

// Stack 루트 — 게이트(index) → 홈(home) → 검색/계좌/설정. 홈 화면은 게이트 통과 후 최초 화면이자
// 트레이딩 매매가 진행되는 화면이라, 여기서 매니저 싱글턴을 별도 Provider로 감쌀 필요는 없다
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
        <Stack.Screen name="search" />
        <Stack.Screen name="help" />
        <Stack.Screen name="account" />
        <Stack.Screen name="settings" />
        <Stack.Screen name="stock/[ticker]" />
        <Stack.Screen name="trades" />
      </Stack>
    </SafeAreaProvider>
  );
}
