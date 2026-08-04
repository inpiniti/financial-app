import { describe, expect, it } from 'vitest';
import { checkApprovedAccount, type ApprovedUsersClient } from './accessControl';

function makeClient(result: {
  data: { is_active: boolean | null } | null;
  error: { message: string } | null;
}): ApprovedUsersClient {
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
      };
    },
  };
}

describe('checkApprovedAccount', () => {
  it('is_active=true인 계좌는 approved다', async () => {
    const client = makeClient({ data: { is_active: true }, error: null });
    const result = await checkApprovedAccount('12345678-01', client);
    expect(result).toEqual({ status: 'approved' });
  });

  it('행이 없으면 rejected다 (미등록 계좌)', async () => {
    const client = makeClient({ data: null, error: null });
    const result = await checkApprovedAccount('00000000-00', client);
    expect(result).toEqual({ status: 'rejected' });
  });

  it('is_active=false면 rejected다 (비활성 계좌)', async () => {
    const client = makeClient({ data: { is_active: false }, error: null });
    const result = await checkApprovedAccount('12345678-01', client);
    expect(result).toEqual({ status: 'rejected' });
  });

  it('쿼리 에러는 error 상태와 메시지를 반환한다', async () => {
    const client = makeClient({ data: null, error: { message: 'network down' } });
    const result = await checkApprovedAccount('12345678-01', client);
    expect(result).toEqual({ status: 'error', message: 'network down' });
  });

  it('클라이언트가 throw해도 error 상태로 안전하게 감싼다', async () => {
    const client: ApprovedUsersClient = {
      from() {
        throw new Error('boom');
      },
    };
    const result = await checkApprovedAccount('12345678-01', client);
    expect(result).toEqual({ status: 'error', message: 'boom' });
  });
});
