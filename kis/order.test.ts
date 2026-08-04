import { describe, expect, it, vi } from 'vitest';
import {
  formatOverseasOrderPrice,
  placeOverseasOrder,
  roundOverseasOrderPrice,
  roundingForSide,
} from './order';
import { cancelOverseasOrder } from './orderCancel';
import { resolveOrderTrId } from './trId';

const account = { cano: '12345678', acntPrdtCd: '01' };
const credentials = { appKey: 'appkey-value', appSecret: 'appsecret-value' };

describe('resolveOrderTrId (주문.md TR ID 표)', () => {
  it('미국 매수/매도 실전·모의 TR ID를 문서 표와 일치하게 해석한다', () => {
    expect(resolveOrderTrId('NASD', 'buy', 'live')).toBe('TTTT1002U');
    expect(resolveOrderTrId('NASD', 'sell', 'live')).toBe('TTTT1006U');
    expect(resolveOrderTrId('NYSE', 'buy', 'paper')).toBe('VTTT1002U');
    expect(resolveOrderTrId('NYSE', 'sell', 'paper')).toBe('VTTT1001U');
  });
});

describe('placeOverseasOrder', () => {
  it('② TR ID가 해석되지 않으면 fetch 호출 전에 throw한다', async () => {
    const fetchImpl = vi.fn();
    // 존재하지 않는 거래소 코드를 강제로 넣어 resolveOrderTrId가 undefined를 반환하게 만든다.
    const bogusExchange = 'ZZZZ' as never;

    await expect(
      placeOverseasOrder(
        'live',
        credentials,
        'access-token',
        {
          account,
          ovrsExcgCd: bogusExchange,
          side: 'buy',
          pdno: 'AAPL',
          orderQty: 1,
          orderUnitPrice: 200,
        },
        { fetchImpl },
      ),
    ).rejects.toThrow(/TR ID/);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('③ 매수 주문 요청 바디가 주문.md 필드명과 일치한다', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return {
        json: async () => ({
          rt_cd: '0',
          msg_cd: 'MSG',
          msg1: 'ok',
          output: { KRX_FWDG_ORD_ORGNO: '00001', ODNO: '0000000001', ORD_TMD: '093000' },
        }),
      };
    });

    const result = await placeOverseasOrder(
      'live',
      credentials,
      'access-token',
      {
        account,
        ovrsExcgCd: 'NASD',
        side: 'buy',
        pdno: 'AAPL',
        orderQty: 3,
        orderUnitPrice: 195.5,
      },
      { fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://openapi.koreainvestment.com:9443/uapi/overseas-stock/v1/trading/order');
    expect((init.headers as Record<string, string>).tr_id).toBe('TTTT1002U');
    expect((init.headers as Record<string, string>).appkey).toBe('appkey-value');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer access-token');

    // 주문.md Body 표의 Element명 그대로 (대문자) 인지 검증.
    expect(capturedBody).toMatchObject({
      CANO: '12345678',
      ACNT_PRDT_CD: '01',
      OVRS_EXCG_CD: 'NASD',
      PDNO: 'AAPL',
      ORD_QTY: '3',
      OVRS_ORD_UNPR: '195.50',
      ORD_SVR_DVSN_CD: '0',
      ORD_DVSN: '00',
    });
    // 매수 주문은 SLL_TYPE을 생략한다 (문서: "제거 : 매수").
    expect(capturedBody).not.toHaveProperty('SLL_TYPE');

    expect(result).toEqual({ krxFwdgOrdOrgno: '00001', odno: '0000000001', ordTmd: '093000' });
  });

  it('매도 주문은 SLL_TYPE=00을 포함한다', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return {
        json: async () => ({
          rt_cd: '0',
          msg_cd: 'MSG',
          msg1: 'ok',
          output: { KRX_FWDG_ORD_ORGNO: '00001', ODNO: '0000000002', ORD_TMD: '093001' },
        }),
      };
    });

    await placeOverseasOrder(
      'live',
      credentials,
      'access-token',
      { account, ovrsExcgCd: 'NASD', side: 'sell', pdno: 'AAPL', orderQty: 1, orderUnitPrice: 200 },
      { fetchImpl },
    );

    expect(capturedBody).toMatchObject({ SLL_TYPE: '00' });
  });

  it('rt_cd가 0이 아니면 msg_cd/msg1을 포함한 에러를 던진다', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      json: async () => ({ rt_cd: '1', msg_cd: 'APBK0013', msg1: '주문가능금액 부족' }),
    });

    await expect(
      placeOverseasOrder(
        'live',
        credentials,
        'access-token',
        { account, ovrsExcgCd: 'NASD', side: 'buy', pdno: 'AAPL', orderQty: 1, orderUnitPrice: 200 },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({ rtCd: '1', msgCd: 'APBK0013', msg1: '주문가능금액 부족' });
  });
});

describe('cancelOverseasOrder (정정취소주문.md)', () => {
  it('취소 요청 바디가 문서 필드명과 일치하고 RVSE_CNCL_DVSN_CD=02, OVRS_ORD_UNPR=0 이다', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return {
        json: async () => ({
          rt_cd: '0',
          msg_cd: 'MSG',
          msg1: 'ok',
          output: { KRX_FWDG_ORD_ORGNO: '00001', ODNO: '0000000001', ORD_TMD: '093000' },
        }),
      };
    });

    await cancelOverseasOrder(
      'live',
      credentials,
      'access-token',
      { account, ovrsExcgCd: 'NASD', pdno: 'AAPL', orgnOdno: '0000000001', orderQty: 3 },
      { fetchImpl },
    );

    const [, init] = fetchImpl.mock.calls[0];
    expect((init.headers as Record<string, string>).tr_id).toBe('TTTT1004U');
    expect(capturedBody).toMatchObject({
      ORGN_ODNO: '0000000001',
      RVSE_CNCL_DVSN_CD: '02',
      OVRS_ORD_UNPR: '0',
    });
  });

  it('원주문번호(ORGN_ODNO)가 10자리 미만이면 0패딩해서 보낸다 — 앞자리 0 유실로 인한 취소 거절 방지', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return {
        json: async () => ({
          rt_cd: '0', msg_cd: 'MSG', msg1: 'ok',
          output: { KRX_FWDG_ORD_ORGNO: '00001', ODNO: '0031370465', ORD_TMD: '093000' },
        }),
      };
    });

    // 앞자리 0이 잘려 전달된 원주문번호(예: 숫자 파싱으로 31370465가 된 경우).
    await cancelOverseasOrder(
      'live',
      credentials,
      'access-token',
      { account, ovrsExcgCd: 'NASD', pdno: 'AAPL', orgnOdno: '31370465', orderQty: 3 },
      { fetchImpl },
    );

    expect(capturedBody?.ORGN_ODNO).toBe('0031370465'); // 10자리 0패딩
  });

  it('상해/심천/베트남은 정정(amend)을 지원하지 않아 fetch 전에 throw한다', async () => {
    const fetchImpl = vi.fn();
    await expect(
      import('./orderCancel').then(({ cancelOrAmendOverseasOrder }) =>
        cancelOrAmendOverseasOrder(
          'live',
          credentials,
          'access-token',
          { account, ovrsExcgCd: 'SHAA', pdno: 'X', orgnOdno: '1', action: 'amend', orderQty: 1, orderUnitPrice: 1 },
          { fetchImpl },
        ),
      ),
    ).rejects.toThrow(/정정/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('formatOverseasOrderPrice — KIS 미국 주문가 자릿수 규칙', () => {
  it('$1 이상은 소수점 2자리로 절사한다 (실계좌 거절 사례 재현 방지)', () => {
    expect(formatOverseasOrderPrice(2.8533333333)).toBe('2.85');
    expect(formatOverseasOrderPrice(2.856)).toBe('2.86');
    expect(formatOverseasOrderPrice(1)).toBe('1.00');
    expect(formatOverseasOrderPrice(343.059999)).toBe('343.06');
  });

  it('$1 미만은 소수점 4자리까지 허용한다', () => {
    expect(formatOverseasOrderPrice(0.123456)).toBe('0.1235');
    expect(formatOverseasOrderPrice(0.95)).toBe('0.9500');
  });

  it('0 이하·비정상 값은 throw한다', () => {
    expect(() => formatOverseasOrderPrice(0)).toThrow();
    expect(() => formatOverseasOrderPrice(NaN)).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// side별 절사(2026-08-04) — 공격적 지정가가 반대편 호가를 반드시 크로스하게 한다.
// 예전 반올림 고정의 근거였던 "미체결 취소→재대기 루프"는 무한 대기 전환으로 제거돼 무효다.
// ─────────────────────────────────────────────────────────────────────────────
describe('roundOverseasOrderPrice / roundingForSide — side별 절사 방향', () => {
  it('① 매도는 내림 — 절사가 매수1호가보다 위로 올라가지 않는다', () => {
    expect(roundingForSide('sell')).toBe('floor');
    expect(formatOverseasOrderPrice(12.345, 'floor')).toBe('12.34');
    expect(formatOverseasOrderPrice(12.349, 'floor')).toBe('12.34');
  });

  it('② 매수는 올림 — 절사가 매도1호가보다 아래로 내려가지 않는다', () => {
    expect(roundingForSide('buy')).toBe('ceil');
    expect(formatOverseasOrderPrice(12.341, 'ceil')).toBe('12.35');
    expect(formatOverseasOrderPrice(12.3401, 'ceil')).toBe('12.35');
  });

  it('③ [사고 재현] 반올림이면 매도가가 매수1호가보다 높아져 안 붙는다 — 내림은 그 일이 없다', () => {
    const bid1 = 12.345;
    // 기존 동작(반올림): 12.35 > bid1 → 매수1호가를 크로스하지 못한다.
    expect(Number(formatOverseasOrderPrice(bid1, 'nearest'))).toBeGreaterThan(bid1);
    // 새 동작(내림): 항상 bid1 이하 → 크로스 보장.
    expect(Number(formatOverseasOrderPrice(bid1, 'floor'))).toBeLessThanOrEqual(bid1);
  });

  it('④ 부동소수 경계에서 한 틱 밀리지 않는다 (12.35*100 = 1234.9999…)', () => {
    // 보정이 없으면 floor가 12.34를 내어 정확히 호가에 있는 값을 한 틱 아래로 민다.
    expect(roundOverseasOrderPrice(12.35, 'floor')).toBe(12.35);
    expect(roundOverseasOrderPrice(0.8725, 'floor')).toBe(0.8725);
    expect(roundOverseasOrderPrice(12.35, 'ceil')).toBe(12.35);
    expect(roundOverseasOrderPrice(1.15, 'floor')).toBe(1.15);
  });

  it('⑤ 이미 격자 위의 값은 방향과 무관하게 그대로다', () => {
    for (const rounding of ['floor', 'ceil', 'nearest'] as const) {
      expect(roundOverseasOrderPrice(12.34, rounding)).toBe(12.34);
      expect(roundOverseasOrderPrice(0.1234, rounding)).toBe(0.1234);
    }
  });

  it('⑥ 절사가 $1 경계를 넘으면 자릿수도 2자리로 따라간다', () => {
    // 0.99999를 올리면 1.0000 — 원본 기준 4자리를 쓰면 "1$ 이상 2자리" 규칙에 걸린다.
    expect(formatOverseasOrderPrice(0.99999, 'ceil')).toBe('1.00');
  });

  it('⑦ 내림으로 0이 되는 값은 throw한다(주문가 소실 방지)', () => {
    expect(() => roundOverseasOrderPrice(0.00005, 'floor')).toThrow();
  });

  it('⑧ 기본값은 nearest — 기존 호출부 동작이 바뀌지 않는다', () => {
    expect(formatOverseasOrderPrice(2.856)).toBe(formatOverseasOrderPrice(2.856, 'nearest'));
    expect(roundOverseasOrderPrice(2.856)).toBe(2.86);
  });
});
