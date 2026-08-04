import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { isSupabaseConfigured } from '../lib/supabase';
import { checkApprovedAccount } from '../lib/accessControl';
import { clearApprovedAccountNo, loadApprovedAccountNo, saveApprovedAccountNo } from '../lib/gateStorage';

/**
 * 게이트 화면 — 승인된 계좌만 하단 탭으로 진입할 수 있게 막는다 (PRD §4-A).
 *
 * 상태 흐름:
 * 1) 'loading'  — env·로컬 저장 계좌를 확인하는 중 (스켈레톤)
 * 2) 'needsEnv' — Supabase env 미설정 안내 화면 (죽지 않고 안내만)
 * 3) 'autoPass' — 이전에 통과한 계좌번호가 저장돼 있음 → 확인 후 자동 진입 or 다른 계좌로 로그인
 * 4) 'form'     — 계좌번호 입력 → approved_users 조회
 */
type GateState = 'loading' | 'needsEnv' | 'autoPass' | 'form';

export default function GateScreen() {
  const [state, setState] = useState<GateState>('loading');
  const [savedAccountNo, setSavedAccountNo] = useState<string | null>(null);
  const [accountNo, setAccountNo] = useState('');
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    (async () => {
      if (!isSupabaseConfigured()) {
        setState('needsEnv');
        return;
      }
      const saved = await loadApprovedAccountNo();
      if (saved) {
        setSavedAccountNo(saved);
        setState('autoPass');
      } else {
        setState('form');
      }
    })();
  }, []);

  const enterApp = () => {
    router.replace('/home');
  };

  const handleContinueWithSaved = () => {
    if (savedAccountNo) enterApp();
  };

  const handleSwitchAccount = async () => {
    await clearApprovedAccountNo();
    setSavedAccountNo(null);
    setAccountNo('');
    setState('form');
  };

  const handleSubmit = async () => {
    const trimmed = accountNo.trim();
    if (!trimmed) return;

    setChecking(true);
    try {
      const result = await checkApprovedAccount(trimmed);
      if (result.status === 'approved') {
        await saveApprovedAccountNo(trimmed);
        enterApp();
        return;
      }
      if (result.status === 'rejected') {
        Alert.alert('알림', '등록되지 않은 계좌예요. 개발자에게 연락해 주세요.');
        return;
      }
      Alert.alert('알림', '잠시 연결이 어려워요. 조금 뒤에 다시 시도해 주세요.');
    } finally {
      setChecking(false);
    }
  };

  if (state === 'loading') {
    return (
      <View className="flex-1 items-center justify-center bg-[#f7f9fc]">
        <ActivityIndicator color="#3182f6" />
      </View>
    );
  }

  if (state === 'needsEnv') {
    return (
      <View className="flex-1 items-center justify-center bg-[#f7f9fc] px-6">
        <Text className="mb-2 text-xl font-bold text-[#191f28]">Supabase 설정이 필요해요</Text>
        <Text className="text-center text-sm leading-5 text-[#4e5968]">
          .env 파일에 EXPO_PUBLIC_SUPABASE_URL과{'\n'}EXPO_PUBLIC_SUPABASE_ANON_KEY를 채운 뒤{'\n'}
          앱을 다시 시작해 주세요.
        </Text>
        <Text className="mt-4 text-center text-xs text-[#8b95a1]">
          값은 .env.example을 참고해 주세요.
        </Text>
      </View>
    );
  }

  if (state === 'autoPass') {
    return (
      <View className="flex-1 justify-center bg-[#f7f9fc] px-6">
        <View className="rounded-3xl bg-white p-6 shadow-sm">
          <Text className="mb-2 text-xl font-bold text-[#191f28]">다시 오셨네요</Text>
          <Text className="mb-6 text-sm text-[#4e5968]">
            {savedAccountNo} 계좌로 계속할게요.
          </Text>
          <Pressable
            onPress={handleContinueWithSaved}
            className="items-center rounded-2xl bg-[#3182f6] py-4 active:opacity-80"
          >
            <Text className="text-base font-semibold text-white">계속하기</Text>
          </Pressable>
          <Pressable onPress={handleSwitchAccount} className="mt-4 items-center py-2">
            <Text className="text-sm text-[#8b95a1]">다른 계좌로 로그인</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const canSubmit = accountNo.trim().length > 0 && !checking;

  return (
    <View className="flex-1 justify-center bg-[#f7f9fc] px-6">
      <View className="rounded-3xl bg-white p-6 shadow-sm">
        <Text className="mb-2 text-xl font-bold text-[#191f28]">계좌번호로 시작해요</Text>
        <Text className="mb-6 text-sm text-[#4e5968]">
          승인된 계좌만 이용할 수 있어요. KIS 계좌번호를 입력해 주세요.
        </Text>
        <TextInput
          value={accountNo}
          onChangeText={setAccountNo}
          placeholder="예: 12345678-01"
          placeholderTextColor="#8b95a1"
          keyboardType="numbers-and-punctuation"
          autoCapitalize="none"
          autoCorrect={false}
          className="mb-6 rounded-2xl border border-[#e5e8eb] px-4 py-3 text-base text-[#191f28]"
        />
        <Pressable
          onPress={handleSubmit}
          disabled={!canSubmit}
          className={`items-center rounded-2xl py-4 active:opacity-80 ${
            canSubmit ? 'bg-[#3182f6]' : 'bg-[#e5e8eb]'
          }`}
        >
          {checking ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <Text className={`text-base font-semibold ${canSubmit ? 'text-white' : 'text-[#8b95a1]'}`}>
              확인할게요
            </Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}
