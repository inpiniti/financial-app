// createRealtimeFeed — RealtimeFeed를 kis/realtimePrice.OverseasRealtimePriceClient로 구현(실서비스 글루).
// WS 단일 연결 1개를 감싸고, 매니저가 이 위로 티커별 구독을 멀티플렉스한다. 테스트는 이 파일을 import하지 않는다.
import {
  OverseasRealtimePriceClient,
  type RealtimeControlMessage,
  type RealtimePriceClientConfig,
  type RealtimePriceClientDeps,
} from '../../kis/realtimePrice';
import type { ClockLike, FeedStatus, RealtimeFeed, TickExtras } from './types';

export interface RealtimeFeedConfig {
  approvalKey: string;
  custtype?: 'P' | 'B';
  clock?: ClockLike;
  onError?: (err: unknown) => void;
  onStatusChange?: RealtimePriceClientConfig['onStatusChange'];
}

/**
 * kis/realtimePrice의 원본 상태('connecting'|'open'|'closed'|'reconnecting')를
 * 매니저가 쓰는 FeedStatus로 매핑한다. 이름이 이미 일치하지만, kis 쪽 표현이 바뀌어도
 * 이 함수 하나만 고치면 되도록 명시적으로 둔다.
 */
function mapKisStatus(status: 'connecting' | 'open' | 'closed' | 'reconnecting'): FeedStatus {
  switch (status) {
    case 'connecting':
      return 'connecting';
    case 'open':
      return 'open';
    case 'reconnecting':
      return 'reconnecting';
    case 'closed':
    default:
      return 'closed';
  }
}

/**
 * WS 지연체결가 → (symb, price, tsMs) 틱으로 정규화한다.
 * price = LAST(문자열) 파싱, tsMs = 수신 시각(clock.now) — 리샘플은 단조 증가 ms만 필요.
 */
export function createRealtimeFeed(
  config: RealtimeFeedConfig,
  deps: RealtimePriceClientDeps = {},
): RealtimeFeed {
  const clock = config.clock ?? { now: () => Date.now() };
  let handler: ((symb: string, price: number, tsMs: number, extras?: TickExtras) => void) | null = null;
  let quoteHandler:
    | ((symb: string, bid1: number, ask1: number, tsMs: number, bidVol1?: number, askVol1?: number) => void)
    | null = null;
  let statusHandler: ((status: FeedStatus) => void) | null = null;
  let controlHandler: ((msg: RealtimeControlMessage) => void) | null = null;

  const client = new OverseasRealtimePriceClient(
    {
      approvalKey: config.approvalKey,
      custtype: config.custtype,
      onError: config.onError,
      onStatusChange: (status) => {
        config.onStatusChange?.(status);
        statusHandler?.(mapKisStatus(status));
      },
      onTick: (tick, symb) => {
        const price = Number(tick.LAST);
        if (!Number.isFinite(price)) return;
        // 게이트용 부가 정보 — 파싱 실패면 필드를 빼고 흘린다(하류 fail-open). 잔량(bidVol1) 패턴과 동일.
        const volume = Number(tick.EVOL);
        const strength = Number(tick.STRN);
        const extras: TickExtras = {};
        if (Number.isFinite(volume)) extras.volume = volume;
        if (Number.isFinite(strength)) extras.strength = strength;
        const now = clock.now();
        handler?.(symb, price, now, extras);
        // 1호가는 체결가 페이로드(PBID/PASK/VBID/VASK)에 함께 실려 온다 — 별도 호가(HDFSASP0) 구독 없이
        // 여기서 quoteHandler로 흘린다(2026-08-14). 유효성(양수) 판정은 하류(FeedSlot/어댑터)가 한다.
        const bid1 = Number(tick.PBID);
        const ask1 = Number(tick.PASK);
        if (Number.isFinite(bid1) && Number.isFinite(ask1)) {
          const bidVol1 = Number(tick.VBID);
          const askVol1 = Number(tick.VASK);
          quoteHandler?.(
            symb,
            bid1,
            ask1,
            now,
            Number.isFinite(bidVol1) ? bidVol1 : undefined,
            Number.isFinite(askVol1) ? askVol1 : undefined,
          );
        }
      },
      onControl: (msg) => {
        controlHandler?.(msg);
      },
    },
    deps,
  );

  return {
    connect: () => client.connect(),
    close: () => client.close(),
    subscribe: (trKey, trId) => client.subscribe(trKey, trId),
    unsubscribe: (trKey, trId) => client.unsubscribe(trKey, trId),
    setTickHandler: (h) => {
      handler = h;
    },
    setQuoteHandler: (h) => {
      quoteHandler = h;
    },
    setStatusHandler: (h) => {
      statusHandler = h;
    },
    setControlHandler: (h) => {
      controlHandler = h;
    },
  };
}
