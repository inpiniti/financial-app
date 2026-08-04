// 설정 탭에서 입력한 KIS AppKey/AppSecret/계좌번호를 expo-secure-store에 평문 노출 없이 저장한다 (PRD §4-E / §6).
// 계좌번호는 8-2 형식(cano 8자리 + acntPrdtCd 2자리)으로 분리 저장한다 — kis/order.ts 등이 그대로 KisAccount로 사용.
import * as SecureStore from 'expo-secure-store';
import type { KisAccount, KisCredentials } from '../kis/types';

const KEYS = {
  appKey: 'kis.appKey',
  appSecret: 'kis.appSecret',
  cano: 'kis.cano',
  acntPrdtCd: 'kis.acntPrdtCd',
} as const;

export interface KisSettings extends KisCredentials, KisAccount {}

export async function loadKisSettings(): Promise<KisSettings | null> {
  const [appKey, appSecret, cano, acntPrdtCd] = await Promise.all([
    SecureStore.getItemAsync(KEYS.appKey),
    SecureStore.getItemAsync(KEYS.appSecret),
    SecureStore.getItemAsync(KEYS.cano),
    SecureStore.getItemAsync(KEYS.acntPrdtCd),
  ]);

  if (!appKey || !appSecret || !cano || !acntPrdtCd) return null;
  return { appKey, appSecret, cano, acntPrdtCd };
}

export async function saveKisSettings(settings: KisSettings): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(KEYS.appKey, settings.appKey),
    SecureStore.setItemAsync(KEYS.appSecret, settings.appSecret),
    SecureStore.setItemAsync(KEYS.cano, settings.cano),
    SecureStore.setItemAsync(KEYS.acntPrdtCd, settings.acntPrdtCd),
  ]);
}

export async function clearKisSettings(): Promise<void> {
  await Promise.all(Object.values(KEYS).map((key) => SecureStore.deleteItemAsync(key)));
}

/** "12345678-01" 같은 8-2 표기를 KisAccount로 나눈다. 형식이 아니면 null. */
export function parseAccountNo(accountNo: string): KisAccount | null {
  const digitsOnly = accountNo.replace(/[^0-9]/g, '');
  if (digitsOnly.length !== 10) return null;
  return { cano: digitsOnly.slice(0, 8), acntPrdtCd: digitsOnly.slice(8, 10) };
}

/** KisAccount를 "12345678-01" 표기 문자열로 합친다 (입력 폼 표시용). */
export function formatAccountNo(account: KisAccount): string {
  return `${account.cano}-${account.acntPrdtCd}`;
}
