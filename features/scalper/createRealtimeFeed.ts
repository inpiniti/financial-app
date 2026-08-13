// createRealtimeFeed — RealtimeFeed를 kis/realtimePrice.OverseasRealtimePriceClient로 구현(실서비스 글루).
// WS 단일 연결 1개를 감싸고, 매니저가 이 위로 티커별 구독을 멀티플렉스한다. 테스트는 이 파일을 import하지 않는다.
import {
  OverseasRealtimePriceClient,
  type RealtimeControlMessage,
  type RealtimePriceClientConfig,
  type RealtimePriceClientDeps,
} from '../../kis/realtimePrice';
import type { ClockLike, FeedStatus, QuoteExtras, RealtimeFeed, TickExtras } from './types';

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
    | ((
        symb: string,
        bid1: number,
        ask1: number,
        tsMs: number,
        bidVol1?: number,
        askVol1?: number,
        extras?: QuoteExtras,
      ) => void)
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
        handler?.(symb, price, clock.now(), extras);
      },
      onQuote: (quote, symb) => {
        // 1호가 매수/매도 가격을 숫자로 정규화해 흘린다(유효성/신선도 판정은 어댑터가). ZDIV 미적용은 체결가와 동일.
        // 잔량(VBID1/VASK1)은 진단 표시 전용 — 파싱 실패면 undefined로 흘려 신호 로직에 영향을 주지 않는다.
        const bidVol1 = Number(quote.VBID1);
        const askVol1 = Number(quote.VASK1);
        // 2호가는 페이로드에 담겨 왔고 파싱 가능할 때만 extras로 흘린다(급등주 찾기 기록용 — 없으면 하류 null 기록).
        const bid2 = Number(quote.PBID2);
        const ask2 = Number(quote.PASK2);
        const extras: QuoteExtras = {};
        if (quote.PBID2 !== undefined && Number.isFinite(bid2) && bid2 > 0) extras.bid2 = bid2;
        if (quote.PASK2 !== undefined && Number.isFinite(ask2) && ask2 > 0) extras.ask2 = ask2;
        quoteHandler?.(
          symb,
          Number(quote.PBID1),
          Number(quote.PASK1),
          clock.now(),
          Number.isFinite(bidVol1) ? bidVol1 : undefined,
          Number.isFinite(askVol1) ? askVol1 : undefined,
          extras,
        );
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
