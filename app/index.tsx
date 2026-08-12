import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { isSupabaseConfigured } from '../lib/supabase';
import { checkApprovedAccount, registerAccount, type GateResult } from '../lib/accessControl';
import { clearApprovedAccountNo, loadApprovedAccountNo, saveApprovedAccountNo } from '../lib/gateStorage';

/**
 * 게이트 화면 — 승인된(use=true) 계좌만 하단 탭으로 진입할 수 있게 막는다 (PRD §4-A).
 *
 * 상태 흐름:
 * 1) 'loading'  — env·로컬 저장 계좌를 확인하는 중 (스켈레톤)
 * 2) 'needsEnv' — Supabase env 미설정 안내 화면 (죽지 않고 안내만)
 * 3) 'autoPass' — 이전에 통과한 계좌번호가 저장돼 있음 → 확인 후 자동 진입 or 다른 계좌로 로그인
 * 4) 'form'     — 계좌번호 입력 → approved_users 조회
 * 5) 'register' — 미등록 계좌의 등록 신청(이름/회사명 입력 → use=false로 insert) → 승인 대기
 */
type GateState = 'loading' | 'needsEnv' | 'autoPass' | 'form' | 'register';

const PENDING_TITLE = '승인을 기다리는 중이에요';
const PENDING_BODY = '등록은 완료됐어요. 승인되면 바로 시작할 수 있어요.';

export default function GateScreen() {
  const insets = useSafeAreaInsets();
  const [state, setState] = useState<GateState>('loading');
  const [savedAccountNo, setSavedAccountNo] = useState<string | null>(null);
  const [accountNo, setAccountNo] = useState('');
  const [checking, setChecking] = useState(false);
  // 등록 신청 화면 — 여기서 적은 이름/회사명이 approved_users.memo로 들어간다.
  const [registerName, setRegisterName] = useState('');
  const [registering, setRegistering] = useState(false);

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

  /** 저장된 계좌로도 매번 다시 확인한다 — 승인이 아직이거나 취소됐으면 들여보내면 안 된다. */
  const handleContinueWithSaved = async () => {
    if (!savedAccountNo || checking) return;

    setChecking(true);
    try {
      const result = await checkApprovedAccount(savedAccountNo);
      if (result.status === 'approved') {
        enterApp();
        return;
      }
      if (result.status === 'pending') {
        Alert.alert(PENDING_TITLE, PENDING_BODY);
        return;
      }
      if (result.status === 'notFound' || result.status === 'rejected') {
        // 저장된 계좌가 더는 유효하지 않다 — 저장값을 버리고 계좌번호부터 다시 받는다.
        await clearApprovedAccountNo();
        setSavedAccountNo(null);
        setAccountNo(savedAccountNo);
        setState('form');
        Alert.alert('알림', '이 계좌로는 시작할 수 없어요. 계좌번호를 다시 확인해 주세요.');
        return;
      }
      Alert.alert('알림', '잠시 연결이 어려워요. 조금 뒤에 다시 시도해 주세요.');
    } finally {
      setChecking(false);
    }
  };

  const handleSwitchAccount = async () => {
    await clearApprovedAccountNo();
    setSavedAccountNo(null);
    setAccountNo('');
    setState('form');
  };

  /** 미등록 계좌 — 등록할지 물어보고, 하겠다고 하면 이름/회사명 입력 화면으로 넘어간다. */
  const askToRegister = (trimmed: string) => {
    Alert.alert('등록되지 않은 계좌예요', `${trimmed} 계좌를 등록할까요?`, [
      { text: '아니요', style: 'cancel' },
      {
        text: '등록할게요',
        onPress: () => {
          setRegisterName('');
          setState('register');
        },
      },
    ]);
  };

  const handleGateResult = (result: GateResult, trimmed: string): void => {
    if (result.status === 'pending') {
      Alert.alert(PENDING_TITLE, PENDING_BODY);
      return;
    }
    if (result.status === 'notFound') {
      askToRegister(trimmed);
      return;
    }
    if (result.status === 'rejected') {
      Alert.alert('알림', '이용할 수 없는 계좌예요. 개발자에게 연락해 주세요.');
      return;
    }
    Alert.alert('알림', '잠시 연결이 어려워요. 조금 뒤에 다시 시도해 주세요.');
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
      handleGateResult(result, trimmed);
    } finally {
      setChecking(false);
    }
  };

  /** 등록 신청 — use=false로 넣는다. 승인(use=true)은 개발자가 DB에서 직접 켠다. */
  const handleRegister = async () => {
    const trimmed = accountNo.trim();
    const name = registerName.trim();
    if (!trimmed || !name || registering) return;

    setRegistering(true);
    try {
      const result = await registerAccount(trimmed, name);
      if (result.status === 'registered' || result.status === 'duplicate') {
        setState('form');
        Alert.alert(
          result.status === 'registered' ? '등록이 완료됐어요' : '이미 등록된 계좌예요',
          '승인을 기다리고 있어요. 승인되면 바로 시작할 수 있어요.',
        );
        return;
      }
      // 원인을 삼키지 않는다 — RLS 거부(42501)인지 네트워크인지 바로 알 수 있어야 고칠 수 있다.
      Alert.alert('등록하지 못했어요', `${result.message}\n\n조금 뒤에 다시 시도해 주세요.`);
    } finally {
      setRegistering(false);
    }
  };

  if (state === 'loading') {
    return (
      <View className="flex-1 items-center justify-center bg-white">
        <ActivityIndicator color="#3182f6" />
      </View>
    );
  }

  if (state === 'needsEnv') {
    return (
      <View className="flex-1 items-center justify-center bg-white px-6">
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
      <View
        className="flex-1 bg-white px-5"
        style={{ paddingTop: insets.top + 72, paddingBottom: insets.bottom + 16 }}
      >
        <Text className="text-2xl font-bold text-[#191f28]">다시 오셨네요</Text>
        <Text className="mt-2 text-[15px] text-[#4e5968]">
          {savedAccountNo} 계좌로 계속할게요.
        </Text>
        <View className="flex-1" />
        <Pressable
          onPress={handleContinueWithSaved}
          disabled={checking}
          className="items-center rounded-2xl bg-[#3182f6] py-4 active:opacity-80"
        >
          {checking ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <Text className="text-base font-semibold text-white">계속하기</Text>
          )}
        </Pressable>
        <Pressable onPress={handleSwitchAccount} className="mt-3 items-center py-3">
          <Text className="text-sm text-[#8b95a1]">다른 계좌로 로그인</Text>
        </Pressable>
      </View>
    );
  }

  if (state === 'register') {
    const canRegister = registerName.trim().length > 0 && !registering;

    return (
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        className="flex-1 bg-white"
      >
        <View
          className="flex-1 px-5"
          style={{ paddingTop: insets.top + 72, paddingBottom: insets.bottom + 16 }}
        >
          <Text className="text-2xl font-bold text-[#191f28]">계좌를 등록할게요</Text>
          <Text className="mt-2 text-[15px] text-[#4e5968]">
            {accountNo.trim()} 계좌로 신청해요.{'\n'}누구인지 알 수 있게 이름이나 회사명을 적어 주세요.
          </Text>
          <TextInput
            value={registerName}
            onChangeText={setRegisterName}
            placeholder="이름 또는 회사명"
            placeholderTextColor="#8b95a1"
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={40}
            className="mt-8 rounded-2xl bg-[#f2f4f6] px-4 py-4 text-base text-[#191f28]"
          />
          <Text className="mt-3 text-[13px] leading-5 text-[#8b95a1]">
            등록 후에는 승인을 기다려야 해요. 승인되면 바로 시작할 수 있어요.
          </Text>
          <View className="flex-1" />
          <Pressable
            onPress={handleRegister}
            disabled={!canRegister}
            className={`items-center rounded-2xl py-4 active:opacity-80 ${
              canRegister ? 'bg-[#3182f6]' : 'bg-[#e5e8eb]'
            }`}
          >
            {registering ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Text
                className={`text-base font-semibold ${canRegister ? 'text-white' : 'text-[#8b95a1]'}`}
              >
                등록할게요
              </Text>
            )}
          </Pressable>
          <Pressable onPress={() => setState('form')} className="mt-3 items-center py-3">
            <Text className="text-sm text-[#8b95a1]">계좌번호 다시 입력</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    );
  }

  const canSubmit = accountNo.trim().length > 0 && !checking;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      className="flex-1 bg-white"
    >
      <View
        className="flex-1 px-5"
        style={{ paddingTop: insets.top + 72, paddingBottom: insets.bottom + 16 }}
      >
        <Text className="text-2xl font-bold text-[#191f28]">계좌번호로 시작해요</Text>
        <Text className="mt-2 text-[15px] text-[#4e5968]">
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
          className="mt-8 rounded-2xl bg-[#f2f4f6] px-4 py-4 text-base text-[#191f28]"
        />
        <View className="flex-1" />
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
    </KeyboardAvoidingView>
  );
}
