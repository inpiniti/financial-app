import { describe, expect, it, vi } from 'vitest';

import {
  createFlowFetch,
  KIS_FLOW_BACKOFF_MS,
  KIS_FLOW_RETRY_LIMIT,
  KIS_MIN_INTERVAL_MS,
  KIS_RATE_LIMIT_MSG_CD,
} from './flow';

/** 가짜 시계 — sleep이 시간을 즉시 전진시켜 대기를 결정론적으로 만든다. */
function fakeTime() {
  let t = 0;
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
  };
}

const jsonRes = (body: unknown) =>
  ({ ok: true, status: 200, statusText: 'OK', json: async () => body }) as Response;

describe('createFlowFetch — KIS REST 유량 제어', () => {
  it('연속 호출은 최소 간격(KIS_MIN_INTERVAL_MS)만큼 벌어진다', async () => {
    const time = fakeTime();
    const calledAt: number[] = [];
    const base = vi.fn(async () => {
      calledAt.push(time.now());
      return jsonRes({ rt_cd: '0' });
    });
    const ff = createFlowFetch({ fetchImpl: base, now: time.now, sleep: time.sleep });

    await ff('u1');
    await ff('u2');
    await ff('u3');
    expect(calledAt).toEqual([0, KIS_MIN_INTERVAL_MS, KIS_MIN_INTERVAL_MS * 2]);
  });

  it('EGW00201(유량 초과)이면 백오프 후 재시도해 성공 바디를 돌려준다 — 호출부는 오류를 못 본다', async () => {
    const time = fakeTime();
    const base = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ rt_cd: '1', msg_cd: KIS_RATE_LIMIT_MSG_CD, msg1: '초당 거래건수를 초과하였습니다' }))
      .mockResolvedValueOnce(jsonRes({ rt_cd: '0', msg_cd: 'APBK0013', output: { ODNO: '123' } }));
    const ff = createFlowFetch({ fetchImpl: base, now: time.now, sleep: time.sleep });

    const res = await ff('order');
    const body = (await res.json()) as { rt_cd: string; output: { ODNO: string } };
    expect(body.rt_cd).toBe('0');
    expect(body.output.ODNO).toBe('123');
    expect(base).toHaveBeenCalledTimes(2);
    expect(time.now()).toBeGreaterThanOrEqual(KIS_FLOW_BACKOFF_MS); // 백오프만큼 물러났다.
  });

  it('재시도 한도를 소진하면 마지막 응답을 그대로 돌려준다(호출부 assertRtCdOk가 던지게)', async () => {
    const time = fakeTime();
    const base = vi.fn(async () => jsonRes({ rt_cd: '1', msg_cd: KIS_RATE_LIMIT_MSG_CD, msg1: '초과' }));
    const ff = createFlowFetch({ fetchImpl: base, now: time.now, sleep: time.sleep });

    const res = await ff('order');
    const body = (await res.json()) as { msg_cd: string };
    expect(body.msg_cd).toBe(KIS_RATE_LIMIT_MSG_CD);
    expect(base).toHaveBeenCalledTimes(1 + KIS_FLOW_RETRY_LIMIT);
  });

  it('유량 초과가 아닌 오류(rt_cd=1)는 재시도 없이 그대로 통과시킨다', async () => {
    const time = fakeTime();
    const base = vi.fn(async () => jsonRes({ rt_cd: '1', msg_cd: 'APTR0058', msg1: '계좌 상이' }));
    const ff = createFlowFetch({ fetchImpl: base, now: time.now, sleep: time.sleep });

    const body = (await (await ff('u')).json()) as { msg_cd: string };
    expect(body.msg_cd).toBe('APTR0058');
    expect(base).toHaveBeenCalledTimes(1);
  });

  it('EGW00123(만료 토큰)이면 새 토큰으로 헤더를 갈아끼워 1회 재전송한다', async () => {
    const time = fakeTime();
    const base = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ rt_cd: '1', msg_cd: 'EGW00123', msg1: '기간이 만료된 token 입니다' }))
      .mockResolvedValueOnce(jsonRes({ rt_cd: '0', output1: [] }));
    const refreshToken = vi.fn(async () => 'fresh-token');
    const ff = createFlowFetch({ fetchImpl: base, now: time.now, sleep: time.sleep, refreshToken });

    const res = await ff('https://openapi.koreainvestment.com:9443/uapi/x', {
      headers: { authorization: 'Bearer dead-token', appkey: 'k', appsecret: 's', tr_id: 'CTRP6504R' },
    });

    expect((await res.json() as { rt_cd: string }).rt_cd).toBe('0');
    expect(refreshToken).toHaveBeenCalledWith({
      environment: 'live',
      credentials: { appKey: 'k', appSecret: 's' },
      expiredToken: 'dead-token',
    });
    const retryInit = base.mock.calls[1][1] as { headers: Record<string, string> };
    expect(retryInit.headers.authorization).toBe('Bearer fresh-token');
    expect(retryInit.headers.tr_id).toBe('CTRP6504R'); // 나머지 헤더는 그대로 간다.
  });

  it('재발급이 불가하면(refresher 없음·null 반환) 만료 오류를 그대로 호출부에 넘긴다', async () => {
    const time = fakeTime();
    const expired = { rt_cd: '1', msg_cd: 'EGW00123', msg1: '기간이 만료된 token 입니다' };
    const base = vi.fn(async () => jsonRes(expired));
    const ff = createFlowFetch({
      fetchImpl: base,
      now: time.now,
      sleep: time.sleep,
      refreshToken: async () => null,
    });

    const body = (await (await ff('https://openapi.koreainvestment.com:9443/uapi/x', {
      headers: { authorization: 'Bearer dead-token', appkey: 'k', appsecret: 's' },
    })).json()) as { msg_cd: string };

    expect(body.msg_cd).toBe('EGW00123');
    expect(base).toHaveBeenCalledTimes(1);
  });

  it('새 토큰도 만료라고 하면 재발급을 반복하지 않는다(최대 1회)', async () => {
    const time = fakeTime();
    const base = vi.fn(async () => jsonRes({ rt_cd: '1', msg_cd: 'EGW00123', msg1: '만료' }));
    const refreshToken = vi.fn(async () => 'fresh-token');
    const ff = createFlowFetch({ fetchImpl: base, now: time.now, sleep: time.sleep, refreshToken });

    await ff('https://openapi.koreainvestment.com:9443/uapi/x', {
      headers: { authorization: 'Bearer dead-token', appkey: 'k', appsecret: 's' },
    });

    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(base).toHaveBeenCalledTimes(2);
  });

  it('[회귀] 응답 headers를 보존한다 — 연속조회(tr_cont 헤더 판독)가 첫 페이지에서 끊기지 않게', async () => {
    const time = fakeTime();
    const headers = { get: (name: string) => (name === 'tr_cont' ? 'M' : null) } as unknown as Headers;
    const base = vi.fn(async () =>
      ({ ok: true, status: 200, statusText: 'OK', headers, json: async () => ({ rt_cd: '0' }) }) as Response,
    );
    const ff = createFlowFetch({ fetchImpl: base, now: time.now, sleep: time.sleep });

    const res = await ff('u');
    expect(res.headers.get('tr_cont')).toBe('M');
  });

  it('JSON이 아닌 응답은 같은 파싱 실패를 재생한다(재시도 없음)', async () => {
    const time = fakeTime();
    const parseError = new Error('invalid json');
    const base = vi.fn(async () =>
      ({ ok: false, status: 502, statusText: 'Bad Gateway', json: () => Promise.reject(parseError) }) as unknown as Response,
    );
    const ff = createFlowFetch({ fetchImpl: base, now: time.now, sleep: time.sleep });

    const res = await ff('u');
    await expect(res.json()).rejects.toBe(parseError);
    expect(res.status).toBe(502);
    expect(base).toHaveBeenCalledTimes(1);
  });
});
