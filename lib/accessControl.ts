// 게이트 화면의 approved_users 조회 로직 — UI(app/index.tsx)와 분리해 테스트 가능하게 한다 (PRD §4-A).
// 실제 Supabase 클라이언트 대신 최소 인터페이스만 요구해 테스트에서 모킹하기 쉽게 한다.
import { getSupabaseClient } from './supabase';

export type GateResult =
  | { status: 'approved' }
  | { status: 'rejected' }
  | { status: 'error'; message: string };

interface MaybeSingleResult {
  data: { is_active: boolean | null } | null;
  error: { message: string } | null;
}

/** approved_users 조회에 필요한 최소 클라이언트 인터페이스 (테스트 모킹용). */
export interface ApprovedUsersClient {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        maybeSingle(): Promise<MaybeSingleResult>;
      };
    };
  };
}

/**
 * account_no로 approved_users를 조회해 is_active=true인지 판정한다.
 * - 행이 없거나 is_active가 true가 아니면 'rejected'
 * - 쿼리 자체가 실패(네트워크 등)하면 'error'
 */
export async function checkApprovedAccount(
  accountNo: string,
  client: ApprovedUsersClient = getSupabaseClient() as unknown as ApprovedUsersClient,
): Promise<GateResult> {
  try {
    const { data, error } = await client
      .from('approved_users')
      .select('is_active')
      .eq('account_no', accountNo)
      .maybeSingle();

    if (error) {
      return { status: 'error', message: error.message };
    }
    if (!data || data.is_active !== true) {
      return { status: 'rejected' };
    }
    return { status: 'approved' };
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}
