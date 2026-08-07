// 종목 상세화면 실시간 시세 구독 훅 — 2026-08-07 종목상세화면 plan §4.
// 화면 focus 시 체결가(HDFSCNT0)+호가(HDFSASP0)를 refcount로 획득(acquireFeed)하고 blur/unmount 시
// 해제(releaseFeed)한다. 같은 종목을 수동 카드·자동 단타가 이미 구독 중이어도 안전하다(매니저가 판단).
// 수신 값은 ref에 쌓고 1초 주기로만 상태에 반영한다 — 매 틱 리렌더 금지(시트들과 동일 원칙).
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import {
  buildFreeQuoteTrKey,
  buildDaytimeQuoteTrKey,
  REALTIME_PRICE_TR_ID,
  REALTIME_QUOTE_TR_ID,
} from '../../kis/realtimePrice';
import { isDaytimeSessionOpen } from '../scalper/daySession';
import type { ScalperManager } from '../scalper/scalperManager';
import { MARKET_TO_DAYTIME, type StockMarketCode } from './marketCodes';

export interface QuoteFeedState {
  price: number | null;
  lastTickAt: number | null;
  tickCount: number;
  bid1: number | null;
  ask1: number | null;
  bidVol1: number | null;
  askVol1: number | null;
  lastQuoteAt: number | null;
  quoteCount: number;
}

const EMPTY: QuoteFeedState = {
  price: null,
  lastTickAt: null,
  tickCount: 0,
  bid1: null,
  ask1: null,
  bidVol1: null,
  askVol1: null,
  lastQuoteAt: null,
  quoteCount: 0,
};

/** 구독 tr_key — 정규장은 D+시장, 주간거래 창(KST 10~16시)은 R+주간시장. 진입 시점 세션으로 고정한다. */
export function buildDetailTrKey(market: StockMarketCode, ticker: string, nowMs: number): string {
  return isDaytimeSessionOpen(nowMs)
    ? buildDaytimeQuoteTrKey(MARKET_TO_DAYTIME[market], ticker)
    : buildFreeQuoteTrKey(market, ticker);
}

/**
 * manager가 null이면(부트스트랩 미완료·키 미설정) 아무것도 구독하지 않는다 — 호가 탭이 안내를 표시한다.
 * 반환 trKey는 QuotePanel의 구독 ACK 진단(getSubscriptionStatus)에 쓴다.
 */
export function useQuoteFeed(
  manager: ScalperManager | null,
  ticker: string,
  market: StockMarketCode | null,
): { state: QuoteFeedState; trKey: string | null } {
  const [state, setState] = useState<QuoteFeedState>(EMPTY);
  const latest = useRef<QuoteFeedState>(EMPTY);
  // 진입 시점 세션(정규장/주간거래)으로 키를 고정 — 화면을 보는 도중 세션이 바뀌는 희귀 케이스는
  // 재진입으로 해소된다(구독·해제 키 불일치로 고아 구독이 남는 것보다 낫다).
  const [trKey] = useState(() => (market ? buildDetailTrKey(market, ticker, Date.now()) : null));

  useFocusEffect(
    useCallback(() => {
      if (!manager || !trKey) return;

      latest.current = EMPTY;
      setState(EMPTY);

      manager.acquireFeed(trKey, REALTIME_PRICE_TR_ID);
      manager.acquireFeed(trKey, REALTIME_QUOTE_TR_ID);

      const unsubData = manager.subscribeFeedData(ticker, {
        onTick: (price, tsMs) => {
          latest.current = {
            ...latest.current,
            price,
            lastTickAt: tsMs,
            tickCount: latest.current.tickCount + 1,
          };
        },
        onQuote: (bid1, ask1, tsMs, bidVol1, askVol1) => {
          latest.current = {
            ...latest.current,
            bid1,
            ask1,
            bidVol1: bidVol1 ?? null,
            askVol1: askVol1 ?? null,
            lastQuoteAt: tsMs,
            quoteCount: latest.current.quoteCount + 1,
          };
        },
      });

      // 1초 주기 반영 — 수신이 없어도 "n초 전" 표시가 흘러가도록 매 틱이 아니라 타이머로 갱신한다.
      const timer = setInterval(() => setState(latest.current), 1000);

      return () => {
        clearInterval(timer);
        unsubData();
        manager.releaseFeed(trKey, REALTIME_PRICE_TR_ID);
        manager.releaseFeed(trKey, REALTIME_QUOTE_TR_ID);
      };
    }, [manager, ticker, trKey]),
  );

  return { state, trKey };
}
