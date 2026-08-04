// Supabase 클라이언트 — 접근 제어(approved_users 조회) 전용. 시세·주문 중계는 하지 않는다 (PRD §4-A).
// env(EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY) 미설정 시 명확한 안내와 함께 throw한다 —
// 게이트 화면은 이 에러를 잡아 "Supabase 설정이 필요해요" 안내 화면으로 전환한다.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface SupabaseEnv {
  url: string | undefined;
  anonKey: string | undefined;
}

export function getSupabaseEnv(): SupabaseEnv {
  return {
    url: process.env.EXPO_PUBLIC_SUPABASE_URL,
    anonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
  };
}

/** env 두 개가 모두 채워져 있는지만 확인한다 (실제 접속 가능 여부는 보장하지 않음). */
export function isSupabaseConfigured(env: SupabaseEnv = getSupabaseEnv()): boolean {
  return Boolean(env.url && env.anonKey);
}

let cachedClient: SupabaseClient | null = null;

/**
 * Supabase 클라이언트를 반환한다 (싱글턴). env 미설정 시 throw —
 * 호출부(게이트 화면)는 isSupabaseConfigured()로 먼저 분기해 이 에러를 실사용자에게 노출하지 않는다.
 */
export function getSupabaseClient(): SupabaseClient {
  if (cachedClient) return cachedClient;

  const env = getSupabaseEnv();
  if (!isSupabaseConfigured(env)) {
    throw new Error(
      'Supabase 설정이 필요해요. EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY 를 .env에 채워주세요 (.env.example 참고).',
    );
  }

  cachedClient = createClient(env.url!, env.anonKey!, {
    auth: { persistSession: false },
  });
  return cachedClient;
}
