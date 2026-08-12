import { describe, expect, it, vi } from 'vitest';
import { checkApprovedAccount, registerAccount, type ApprovedUsersClient } from './accessControl';

function makeClient(
  result: {
    data: { is_active: boolean | null } | null;
    error: { message: string } | null;
  },
  insert: {
    result?: { error: { message: string; code?: string } | null };
    spy?: (values: Record<string, unknown>) => void;
  } = {},
): ApprovedUsersClient {
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                async maybeSingle() {
                  return result;
                },
              };
            },
          };
        },
        async insert(values: Record<string, unknown>) {
          insert.spy?.(values);
          return insert.result ?? { error: null };
        },
      };
    },
  };
}

describe('checkApprovedAccount', () => {
  it('is_active=true인 계좌는 approved다', async () => {
    const client = makeClient({ data: { is_active: true }, error: null });
    expect(await checkApprovedAccount('12345678-01', client)).toEqual({ status: 'approved' });
  });

  it('행이 없으면 notFound다 (등록 신청 유도)', async () => {
    const client = makeClient({ data: null, error: null });
    expect(await checkApprovedAccount('00000000-00', client)).toEqual({ status: 'notFound' });
  });

  it('is_active=false면 pending이다 (승인 대기)', async () => {
    const client = makeClient({ data: { is_active: false }, error: null });
    expect(await checkApprovedAccount('12345678-01', client)).toEqual({ status: 'pending' });
  });

  it('is_active가 null이어도 pending이다 — 승인은 명시적 true일 때만', async () => {
    const client = makeClient({ data: { is_active: null }, error: null });
    expect(await checkApprovedAccount('12345678-01', client)).toEqual({ status: 'pending' });
  });

  it('쿼리 에러는 error 상태와 메시지를 반환한다', async () => {
    const client = makeClient({ data: null, error: { message: 'network down' } });
    expect(await checkApprovedAccount('12345678-01', client)).toEqual({
      status: 'error',
      message: 'network down',
    });
  });

  it('클라이언트가 throw해도 error 상태로 안전하게 감싼다', async () => {
    const client: ApprovedUsersClient = {
      from() {
        throw new Error('boom');
      },
    };
    expect(await checkApprovedAccount('12345678-01', client)).toEqual({
      status: 'error',
      message: 'boom',
    });
  });
});

describe('registerAccount', () => {
  it('is_active=false와 memo(이름/회사명)로 insert한다 — 앱이 스스로 승인할 수 없다', async () => {
    const spy = vi.fn();
    const client = makeClient({ data: null, error: null }, { spy });
    const result = await registerAccount('12345678-01', '홍길동', client);

    expect(result).toEqual({ status: 'registered' });
    expect(spy).toHaveBeenCalledWith({ account_no: '12345678-01', memo: '홍길동', is_active: false });
  });

  it('RLS 거부(42501)는 마이그레이션 안내 메시지로 바꿔 준다', async () => {
    const client = makeClient(
      { data: null, error: null },
      { result: { error: { message: 'new row violates row-level security policy', code: '42501' } } },
    );
    const result = await registerAccount('12345678-01', '홍길동', client);
    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.message).toContain('0003');
  });

  it('PK 충돌(23505)은 duplicate다 — 이미 신청된 계좌', async () => {
    const client = makeClient(
      { data: null, error: null },
      { result: { error: { message: 'duplicate key', code: '23505' } } },
    );
    expect(await registerAccount('12345678-01', '홍길동', client)).toEqual({ status: 'duplicate' });
  });

  it('그 외 insert 실패는 error다', async () => {
    const client = makeClient(
      { data: null, error: null },
      { result: { error: { message: 'rls denied' } } },
    );
    expect(await registerAccount('12345678-01', '홍길동', client)).toEqual({
      status: 'error',
      message: 'rls denied',
    });
  });
});
