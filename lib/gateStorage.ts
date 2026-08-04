// 게이트 통과 계좌번호 로컬 저장 — 재실행 시 자동 통과를 위함 (PRD §4-A / app/index.tsx §3).
// 민감정보가 아닌 계좌번호 문자열 하나만 다루므로 AsyncStorage로 충분하다 (KIS 키는 lib/kisSettings.ts에서 secure-store로 분리).
import AsyncStorage from '@react-native-async-storage/async-storage';

const APPROVED_ACCOUNT_KEY = 'gate:approvedAccountNo';

export async function loadApprovedAccountNo(): Promise<string | null> {
  return AsyncStorage.getItem(APPROVED_ACCOUNT_KEY);
}

export async function saveApprovedAccountNo(accountNo: string): Promise<void> {
  await AsyncStorage.setItem(APPROVED_ACCOUNT_KEY, accountNo);
}

/** "다른 계좌로 로그인" — 저장된 통과 계좌번호를 지우고 다시 입력받게 한다. */
export async function clearApprovedAccountNo(): Promise<void> {
  await AsyncStorage.removeItem(APPROVED_ACCOUNT_KEY);
}
