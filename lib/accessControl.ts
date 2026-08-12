// 게이트 화면의 approved_users 조회/등록 로직 — UI(app/index.tsx)와 분리해 테스트 가능하게 한다 (PRD §4-A).
// 실제 Supabase 클라이언트 대신 최소 인터페이스만 요구해 테스트에서 모킹하기 쉽게 한다.
//
// 판정 기준 (2026-08-12 — 승인 플래그는 is_active 하나로 통합. 잠깐 쓰던 use 컬럼은 0003에서 없앴다):
//   is_active = true → 진입 가능 (승인은 개발자가 DB에서 직접 켠다)
//   is_active ≠ true → 'pending' (등록은 됐지만 승인 대기 / 승인이 내려간 계좌도 여기)
//   행 없음          → 'notFound' (앱에서 등록 신청을 받는다)
import { getSupabaseClient } from './supabase';

export type GateResult =
  | { status: 'approved' }
  | { status: 'pending' }
  | { status: 'notFound' }
  | { status: 'error'; message: string };

export type RegisterResult =
  | { status: 'registered' }
  | { status: 'duplicate' }
  | { status: 'error'; message: string };

interface ApprovedUserRow {
  is_active: boolean | null;
}

interface MaybeSingleResult {
  data: ApprovedUserRow | null;
  error: { message: string } | null;
}

interface InsertResult {
  error: { message: string; code?: string } | null;
}

/** approved_users 조회/등록에 필요한 최소 클라이언트 인터페이스 (테스트 모킹용). */
export interface ApprovedUsersClient {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        maybeSingle(): Promise<MaybeSingleResult>;
      };
    };
    insert(values: Record<string, unknown>): PromiseLike<InsertResult>;
  };
}

/**
 * account_no로 approved_users를 조회해 진입 가능 여부를 판정한다.
 * - 행이 없으면 'notFound' (등록 신청 화면으로 유도)
 * - is_active가 true가 아니면 'pending' (승인 대기)
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
    if (!data) {
      return { status: 'notFound' };
    }
    if (data.is_active !== true) {
      return { status: 'pending' };
    }
    return { status: 'approved' };
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 미등록 계좌의 등록 신청 — is_active=false로 넣는다(승인은 개발자가 DB에서 직접 켠다).
 * memo에는 사용자가 입력한 이름/회사명이 들어간다.
 * 이미 있는 계좌번호(PK 충돌 23505)는 'duplicate'로 돌려 "이미 신청됐어요"로 안내한다.
 */
export async function registerAccount(
  accountNo: string,
  memo: string,
  client: ApprovedUsersClient = getSupabaseClient() as unknown as ApprovedUsersClient,
): Promise<RegisterResult> {
  try {
    const { error } = await client
      .from('approved_users')
      .insert({ account_no: accountNo, memo, is_active: false });

    if (error) {
      if (error.code === '23505') return { status: 'duplicate' };
      // RLS 거부(42501)는 "등록 신청 정책 마이그레이션을 아직 안 돌렸다"가 거의 전부다 — 원인을 그대로 알려준다.
      if (error.code === '42501') {
        return {
          status: 'error',
          message: 'Supabase에서 등록 신청이 막혀 있어요 (RLS). 0003 마이그레이션을 실행해 주세요.',
        };
      }
      return { status: 'error', message: error.code ? `${error.message} (${error.code})` : error.message };
    }
    return { status: 'registered' };
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}
