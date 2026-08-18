// createKisBroker — ScalperBroker를 kis/ REST 모듈로 구현(실서비스 글루).
//  · placeOrder   → kis/order.placeOverseasOrder (지정가)
//  · cancelOrder  → kis/orderCancel.cancelOverseasOrder (RVSE_CNCL_DVSN_CD=02)
//  · fetchFills   → kis/nccs.inquireOverseasUnfilled (미체결내역, TTTS3018R) → odno별 체결 상태 역산
//
// 주간거래(2026-08-10 실거래 재개): 발주 시각이 미국 주간거래 창(KST 10~16시, 실전 전용)이면 주문·정정·취소를
// 주간거래 API 계열(TTTS6036U/6037U/6038U, daytime-order*)로 보낸다. 체결 확인(미체결내역)·잔고는 정규장과
// 같은 TR을 그대로 쓴다 — 주간정정취소.txt가 원주문번호를 "inquire-nccs에서 참조"하라고 명시(공식 근거).
//
// 주문체결내역(TTTS3035R)이 이 계좌에서 APTR0058("처리계좌의 ID와 사용자정보가 상이")로 거절되는 것이
// 실측·재현으로 확정되어(kis/nccs.ts 상단 주석 참조), 체결 확인은 정상 동작이 확인된 미체결내역(TTTS3018R)
// 폴링으로 대체한다. 이 TR은 "지금 미체결인 주문"만 돌려주므로, 체결 여부는 다음처럼 역산해야 한다:
//   · 목록에 odno가 있으면 → 부분체결: ft_ord_qty - nccs_qty
//   · 목록에서 odno가 사라지면 → 전량체결로 "추론"(취소된 주문도 사라지므로 100% 확실하진 않다 — 아래 tracked 참고)
// 이 추론에 필요한 "우리가 이 odno를 얼마 주문했는지 · 몇 번 조회했는지" 상태는 nccs 응답에 없으므로
// 이 브로커 인스턴스가 로컬로 들고 있어야 한다(tracked 맵). ScalperBroker 계약(odno별 체결 수량 반환)은 그대로.
import { placeOverseasOrder } from '../../kis/order';
import { cancelOrAmendOverseasOrder, cancelOverseasOrder, normalizeOdno } from '../../kis/orderCancel';
import { inquireOverseasBalance } from '../../kis/balance';
import { inquireOverseasUnfilled } from '../../kis/nccs';
import type { OverseasExchangeCode } from '../../kis/trId';
import type { ClockLike, KisAccount, KisCredentials, KisEnvironment } from '../../kis/types';
import { isDaytimeSessionOpen } from './daySession';
import type { BrokerFill, ScalperBroker } from './types';

export interface KisBrokerConfig {
  environment: KisEnvironment;
  credentials: KisCredentials;
  account: KisAccount;
  /** 이 인스턴스의 종목코드(PDNO). */
  pdno: string;
  ovrsExcgCd: OverseasExchangeCode;
  /** 유효 접근토큰 공급(캐시·갱신은 kis/token 책임). */
  getToken: () => Promise<string>;
  clock?: ClockLike;
}

/** 이 브로커 인스턴스가 발주한 주문 1건의 체결 판정용 로컬 상태(odno 키). */
interface TrackedOrder {
  qty: number;
  /** fetchFills가 이 odno를 최소 1회 조회했는가 — 발주 직후 서버 반영 지연 유예(최소 1폴)에 쓴다. */
  polled: boolean;
  /** 미체결 목록에 한 번이라도 나타난 적이 있는가. */
  everListed: boolean;
  /**
   * 주간주문(TTTS6036U/6037U)으로 나간 주문인가 — 발주 시각 기준으로 고정해 기억한다.
   * 정정·취소는 **원주문과 같은 API 계열**(주간이면 TTTS6038U·daytime-order-rvsecncl)을 써야 하므로,
   * 취소 시각에 세션이 바뀌어 있어도 이 플래그를 따른다(주간주문 API는 KST 18시까지 열려 있다).
   */
  daytime: boolean;
}

function toNum(v: string | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function createKisBroker(config: KisBrokerConfig): ScalperBroker {
  const { environment, credentials, account, ovrsExcgCd, pdno, getToken } = config;
  const now = () => (config.clock ?? { now: () => Date.now() }).now();
  /**
   * 지금이 미국 주간거래 창(KST 10~16시)이면 주간주문 API 계열을 쓴다.
   * 주간거래는 실전 전용(모의 미지원)이라 paper 환경에서는 판정 자체를 끈다 —
   * 켜두면 모의투자로 주간거래 창에 진입할 때 TR 해석 실패로 전 주문이 막힌다.
   */
  const daytimeNow = () => environment === 'live' && isDaytimeSessionOpen(now());

  /** placeOrder가 등록하고 fetchFills가 매 폴 미체결 목록과 대조해 갱신하는 로컬 추적 상태. */
  const tracked = new Map<string, TrackedOrder>();
  /**
   * 정정 요청이 왕복 중인 원주문번호들.
   * 정정에 성공하면 KIS가 옛 ODNO를 미체결 목록에서 즉시 빼는데, 그 사이 fetchFills가 돌면
   * "목록 부재 = 전량체결"로 오판해 가짜 DONE이 난다. 왕복 구간에는 그 추론을 보류한다.
   */
  const amending = new Set<string>();

  return {
    async placeOrder(input) {
      const token = await getToken();
      // 발주 시각의 세션으로 API 계열을 고정한다 — 이후 정정·취소도 이 플래그를 따른다.
      const daytime = daytimeNow();
      const res = await placeOverseasOrder(environment, credentials, token, {
        account,
        ovrsExcgCd,
        side: input.side,
        pdno: input.pdno,
        orderQty: input.qty,
        orderUnitPrice: input.price,
        daytime,
      });
      // 주문 응답 odno를 10자리 0패딩으로 정규화해 추적·대조·취소 전 구간에서 키를 일관되게 유지한다.
      const odno = normalizeOdno(res.odno);
      tracked.set(odno, { qty: input.qty, polled: false, everListed: false, daytime });
      return { odno };
    },

    async cancelOrder(input) {
      const token = await getToken();
      await cancelOverseasOrder(environment, credentials, token, {
        account,
        ovrsExcgCd,
        pdno: input.pdno,
        orgnOdno: input.odno,
        orderQty: input.qty,
        // 원주문이 주간주문이었으면 주간정정취소(TTTS6038U)로 — 추적에 없는 odno(비정상)는 현재 세션 판정.
        daytime: tracked.get(normalizeOdno(input.odno))?.daytime ?? daytimeNow(),
      });
      // 취소가 성공한 주문만 추적을 끊는다(cancelOrder가 throw 없이 반환한 경우) — 목록에서 사라진 것을
      // "전량체결"로 오판하지 않도록. 어댑터도 이 성공을 cancelState='confirmed'로 받아 관찰을 멈춘다.
      // ※ 취소가 거절되면(이미 체결 추정) 이 줄에 오기 전에 throw하므로 tracked가 유지된다 →
      //   다음 fetchFills에서 "목록 부재→전량체결" 유예 규칙으로 늦은 체결이 정상 레코닝된다.
      tracked.delete(normalizeOdno(input.odno));
    },

    async amendOrder(input) {
      const token = await getToken();
      const oldOdno = normalizeOdno(input.odno);
      // 원주문의 API 계열을 그대로 잇는다 — 주간주문의 정정은 주간정정취소(TTTS6038U)로만 가능하다.
      const daytime = tracked.get(oldOdno)?.daytime ?? daytimeNow();
      // 왕복 동안 "목록 부재→전량체결" 추론을 막는다. finally에서 반드시 해제한다.
      amending.add(oldOdno);
      try {
        const res = await cancelOrAmendOverseasOrder(environment, credentials, token, {
          account,
          ovrsExcgCd,
          pdno: input.pdno,
          orgnOdno: oldOdno,
          action: 'amend',
          orderQty: input.qty,
          orderUnitPrice: input.price,
          side: input.side,
          daytime,
        });
        const newOdno = normalizeOdno(res.odno);
        // ★ 원자 교체 — await 없는 동기 구간이라 중간 상태를 아무도 관찰하지 못한다.
        //   옛 odno를 지우지 않으면 다음 폴에서 "목록 부재→전량체결" 오판이 난다(1순위 사고 지점).
        //   새 odno는 유예 플래그를 초기화해 등록한다(발주 직후와 같은 취급). API 계열은 원주문을 승계.
        tracked.delete(oldOdno);
        tracked.set(newOdno, { qty: input.qty, polled: false, everListed: false, daytime });
        return { odno: newOdno };
      } finally {
        amending.delete(oldOdno);
      }
    },

    async fetchFills(): Promise<BrokerFill[]> {
      const token = await getToken();
      const { output } = await inquireOverseasUnfilled(environment, credentials, token, {
        account,
        ovrsExcgCd,
      });
      // 미체결 목록의 odno도 정규화해 대조한다 — 앞자리 0 패딩 불일치로 "목록 부재→전량체결" 오판이 나던 문제 방지.
      const listed = new Map(output.map((item) => [normalizeOdno(item.odno), item]));

      const fills: BrokerFill[] = [];
      for (const [odno, state] of tracked) {
        const item = listed.get(odno);
        if (item) {
          state.everListed = true;
          state.polled = true;
          const filledQty = toNum(item.ft_ord_qty) - toNum(item.nccs_qty);
          const price = toNum(item.ft_ccld_unpr3);
          // listed=true — 미체결 목록 실측(주문 생존 + 잔량 역산). 정정 거절 구제의 생존 판정 근거.
          fills.push({ odno, orderQty: state.qty, filledQty, filledPrice: price > 0 ? price : null, listed: true });
          continue;
        }
        // 정정 왕복 중인 주문은 "사라짐"의 원인이 체결이 아니라 정정일 수 있다 — 추론을 통째로 보류한다.
        // (정정 성공 시 KIS가 옛 ODNO를 목록에서 빼므로, 이 가드가 없으면 가짜 전량체결이 난다.)
        if (amending.has(odno)) {
          fills.push({ odno, orderQty: state.qty, filledQty: 0, filledPrice: null });
          continue;
        }
        // 목록에 없음 — 유예 조건(직전까지 한 번이라도 목록에 보였거나, 이미 1회 이상 조회했음)을
        // 만족할 때만 전량체결로 확정한다. 발주 직후 첫 조회에서 아직 안 보이는 것은 서버 반영
        // 지연일 수 있으므로 최소 1폴은 유예하고 미체결로 둔다.
        const confirmedFilled = state.everListed || state.polled;
        state.polled = true;
        fills.push({
          odno,
          orderQty: state.qty,
          filledQty: confirmedFilled ? state.qty : 0,
          filledPrice: null,
        });
      }
      // TODO(선택): 매도 체결을 "목록 부재→전량체결"로 확정하기 직전, kis/balance.ts
      // inquireOverseasBalance로 보유 수량 감소를 보조 검증하는 훅을 여기 둘 수 있다(현재는 nccs 단독 판정).
      return fills;
    },

    async fetchPosition(): Promise<{ qty: number; avgPrice: number } | null> {
      const token = await getToken();
      const { output1 } = await inquireOverseasBalance(environment, credentials, token, { account });
      // 이 브로커의 종목(pdno)과 일치하는 잔고 원소를 찾아 평단(avg_unpr3)·수량(ccld_qty_smtl1)을 읽는다(D1).
      // 수량은 체결기준(ccld_qty_smtl1) — 결제보유수량(cblc_qty13)은 T+1 결제 전인 당일 매수분이 0이라
      // FAULT 당일 재등록이 항상 실패한다.
      const want = String(pdno ?? '').trim();
      const row = output1.find((p) => String(p.pdno ?? '').trim() === want);
      if (!row) return null;
      const qty = toNum(row.ccld_qty_smtl1);
      const avgPrice = toNum(row.avg_unpr3);
      if (qty <= 0 || avgPrice <= 0) return null;
      return { qty, avgPrice };
    },
  };
}
