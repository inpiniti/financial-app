// createKisBroker.fetchFills — 미체결내역(TTTS3018R, kis/nccs.ts) 기반 체결 판정 검증.
// 주문체결내역(TTTS3035R)이 이 계좌에서 APTR0058로 거절되어(실측) 더 이상 쓰지 않는다.
// 가짜는 kis 경계 바로 바깥(전역 fetch)에만 심는다 — createKisBroker/kis/order·orderCancel·nccs는 전부 실물.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKisBroker } from './createKisBroker';
import type { KisAccount, KisCredentials } from '../../kis/types';

const account: KisAccount = { cano: '12345678', acntPrdtCd: '01' };
const credentials: KisCredentials = { appKey: 'app-key', appSecret: 'app-secret' };

function jsonResponse(body: unknown): Response {
  return { json: async () => body } as unknown as Response;
}

/** 미체결내역.md "output(배열 원소)" 필드명 그대로 채운 항목 — filledQty만큼 이미 체결된 것으로 계산한다. */
function unfilledItem(odno: string, orderQty: number, filledQty: number, filledPrice = 0) {
  return {
    ord_dt: '20260730', ord_gno_brno: '00000', odno, orgn_odno: '',
    pdno: 'AAPL', prdt_name: 'AAPL',
    sll_buy_dvsn_cd: '02', sll_buy_dvsn_cd_name: '매수',
    rvse_cncl_dvsn_cd: '00', rvse_cncl_dvsn_cd_name: '',
    rjct_rson: '', rjct_rson_name: '', ord_tmd: '090000',
    tr_mket_name: '', tr_crcy_cd: 'USD', natn_cd: '840', natn_kor_name: '미국',
    ft_ord_qty: String(orderQty), ft_ccld_qty: String(filledQty), nccs_qty: String(orderQty - filledQty),
    ft_ord_unpr3: '100', ft_ccld_unpr3: String(filledPrice), ft_ccld_amt3: '0',
    ovrs_excg_cd: 'NASD', prcs_stat_name: '미체결',
    loan_type_cd: '', loan_dt: '', usa_amk_exts_rqst_yn: '', splt_buy_attr_name: '',
  };
}

/** 라우팅 가능한 가짜 fetch — nccsQueue.push(...)로 다음 fetchFills 호출의 미체결 목록 응답을 예약한다. */
function makeFakeFetch() {
  let seq = 0;
  const nccsQueue: Array<ReturnType<typeof unfilledItem>[]> = [];
  const nccsCalls: unknown[] = [];
  const fetchImpl = vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input);

    if (url.includes('/uapi/overseas-stock/v1/trading/order-rvsecncl')) {
      const body = JSON.parse(init?.body ?? '{}') as Record<string, string>;
      return jsonResponse({
        rt_cd: '0', msg_cd: '0000', msg1: '정정취소 주문 완료',
        output: { KRX_FWDG_ORD_ORGNO: '0', ODNO: body.ORGN_ODNO, ORD_TMD: '090500' },
      });
    }

    if (url.includes('/uapi/overseas-stock/v1/trading/order')) {
      const odno = `O${++seq}`;
      return jsonResponse({
        rt_cd: '0', msg_cd: '0000', msg1: '주문 접수 완료',
        output: { KRX_FWDG_ORD_ORGNO: '0', ODNO: odno, ORD_TMD: '090000' },
      });
    }

    if (url.includes('/uapi/overseas-stock/v1/trading/inquire-nccs')) {
      nccsCalls.push(url);
      const output = nccsQueue.shift() ?? [];
      return jsonResponse({ rt_cd: '0', msg_cd: '0000', msg1: '', output, ctx_area_fk200: '', ctx_area_nk200: '' });
    }

    throw new Error(`makeFakeFetch: 처리하지 않은 URL — ${url}`);
  });

  return { fetchImpl, nccsQueue, nccsCalls };
}

function makeBroker(fetchImpl: unknown) {
  vi.stubGlobal('fetch', fetchImpl);
  return createKisBroker({
    environment: 'live',
    credentials,
    account,
    pdno: 'AAPL',
    ovrsExcgCd: 'NASD',
    getToken: async () => 'access-token',
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createKisBroker.fetchFills — 미체결내역(nccs) 기반 체결 판정', () => {
  it('① 미체결 목록에 odno가 있고 nccs_qty>0이면 부분체결 수량(ft_ord_qty-nccs_qty)을 미체결로 반환한다', async () => {
    const { fetchImpl, nccsQueue } = makeFakeFetch();
    const broker = makeBroker(fetchImpl);

    const { odno } = await broker.placeOrder({ side: 'buy', pdno: 'AAPL', qty: 10, price: 100 });
    nccsQueue.push([unfilledItem(odno, 10, 3, 100)]); // 10주 주문 중 3주만 체결, 7주 미체결로 목록에 남음

    const fills = await broker.fetchFills();

    expect(fills).toEqual([{ odno, orderQty: 10, filledQty: 3, filledPrice: 100 }]);
  });

  it('② 목록에서 사라지고(직전 폴에서는 목록에 보였음) 유예를 거쳤다면 전량체결로 확정한다', async () => {
    const { fetchImpl, nccsQueue } = makeFakeFetch();
    const broker = makeBroker(fetchImpl);

    const { odno } = await broker.placeOrder({ side: 'buy', pdno: 'AAPL', qty: 5, price: 100 });

    // 1차 폴: 아직 미체결로 목록에 보임 → everListed=true로 기록된다.
    nccsQueue.push([unfilledItem(odno, 5, 0)]);
    const first = await broker.fetchFills();
    expect(first).toEqual([{ odno, orderQty: 5, filledQty: 0, filledPrice: null }]);

    // 2차 폴: 목록에서 사라짐 → 직전에 보였으므로 전량체결로 확정.
    nccsQueue.push([]);
    const second = await broker.fetchFills();
    expect(second).toEqual([{ odno, orderQty: 5, filledQty: 5, filledPrice: null }]);
  });

  it('③ 발주 직후 첫 폴에서 목록에 없어도 즉시 체결로 판정하지 않는다(최소 1폴 유예) — 유예 후에는 확정된다', async () => {
    const { fetchImpl, nccsQueue } = makeFakeFetch();
    const broker = makeBroker(fetchImpl);

    const { odno } = await broker.placeOrder({ side: 'buy', pdno: 'AAPL', qty: 4, price: 100 });

    // 발주 후 첫 조회인데 서버 반영 지연으로 아직 목록에 안 잡힘 → 체결로 오판하면 안 된다.
    nccsQueue.push([]);
    const first = await broker.fetchFills();
    expect(first).toEqual([{ odno, orderQty: 4, filledQty: 0, filledPrice: null }]);

    // 유예(1폴)를 거친 뒤에도 계속 목록에 없으면 그제서야 전량체결로 확정한다.
    nccsQueue.push([]);
    const second = await broker.fetchFills();
    expect(second).toEqual([{ odno, orderQty: 4, filledQty: 4, filledPrice: null }]);
  });

  it('④ nccs 조회 자체가 실패하면(rt_cd 오류) fetchFills가 throw한다 — 인터록(FAULT) 경로를 깨지 않는다', async () => {
    const fetchImpl = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/uapi/overseas-stock/v1/trading/inquire-nccs')) {
        return jsonResponse({ rt_cd: '1', msg_cd: 'APTR0058', msg1: '처리계좌의 ID와 사용자정보가 상이합니다' });
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const broker = makeBroker(fetchImpl);

    await expect(broker.fetchFills()).rejects.toThrow();
  });

  it('odno 앞자리 0 패딩이 어긋나도(주문 응답 vs 미체결목록) 정규화로 대조에 성공한다', async () => {
    // 주문 응답 odno는 10자리 0패딩("0031370465")인데, 미체결목록 응답 odno는 앞자리 0이 잘린 형태("31370465")로
    // 온다고 가정한다(실계좌에서 자릿수 관례가 어긋나던 상황 재현). 정규화 없이는 "목록 부재→전량체결"로 오판한다.
    let placedOnce = false;
    const fetchImpl = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/uapi/overseas-stock/v1/trading/order') && !url.includes('rvsecncl')) {
        placedOnce = true;
        return jsonResponse({
          rt_cd: '0', msg_cd: '0000', msg1: '주문 접수 완료',
          output: { KRX_FWDG_ORD_ORGNO: '0', ODNO: '0031370465', ORD_TMD: '090000' },
        });
      }
      if (url.includes('/uapi/overseas-stock/v1/trading/inquire-nccs')) {
        // 미체결 목록은 앞자리 0이 빠진 odno로 응답 — 여전히 같은 주문이다.
        const output = placedOnce ? [unfilledItem('31370465', 5, 2, 100)] : [];
        return jsonResponse({ rt_cd: '0', msg_cd: '0000', msg1: '', output, ctx_area_fk200: '', ctx_area_nk200: '' });
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const broker = makeBroker(fetchImpl);

    const { odno } = await broker.placeOrder({ side: 'buy', pdno: 'AAPL', qty: 5, price: 100 });
    expect(odno).toBe('0031370465'); // 브로커가 반환하는 odno는 정규화된 10자리

    const fills = await broker.fetchFills();
    // 패딩이 어긋난 목록과도 매칭되어 부분체결(2/5)로 정확히 판정한다("전량체결" 오판 아님).
    expect(fills).toEqual([{ odno: '0031370465', orderQty: 5, filledQty: 2, filledPrice: 100 }]);
  });

  it('취소된 주문은 목록 부재를 전량체결로 오판하지 않도록 추적을 끊는다', async () => {
    const { fetchImpl, nccsQueue } = makeFakeFetch();
    const broker = makeBroker(fetchImpl);

    const { odno } = await broker.placeOrder({ side: 'buy', pdno: 'AAPL', qty: 5, price: 100 });
    await broker.cancelOrder({ pdno: 'AAPL', odno, qty: 5 });

    // 취소 후 목록에도 당연히 없음 — 하지만 더 이상 추적 대상이 아니므로 결과에 아예 나타나지 않는다.
    nccsQueue.push([]);
    const fills = await broker.fetchFills();

    expect(fills).toEqual([]);
  });
});
