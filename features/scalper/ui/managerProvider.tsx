// 단타 탭 매니저 싱글턴 부트스트랩 (6단계 UI 전용, features/scalper 로직 파일은 건드리지 않는다).
// 저장된 KIS 키(lib/kisSettings)·매매 파라미터(lib/appSettings)로 ScalperManager 1개를 만들고
// 앱에서 단타 탭에 처음 진입할 때 restore()까지 실행한다. 이후에는 모듈 스코프 싱글턴을 재사용해
// 탭을 오가도(화면이 언마운트/리마운트돼도) 인스턴스·WS 연결이 끊기지 않는다.
import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getAccessToken } from '../../../kis/token';
import { getApprovalKey } from '../../../kis/wsApproval';
import type { KisAccount, KisCredentials, KisEnvironment } from '../../../kis/types';
import {
  commissionRateToRatio,
  gateThreshold,
  loadAppSettings,
  momentumThresholdToRatio,
} from '../../../lib/appSettings';
import { loadKisSettings } from '../../../lib/kisSettings';
import { secureTokenStorage } from '../../../lib/secureTokenStorage';
import { inquireOverseasBalance } from '../../../kis/balance';
import { buyableUsdOf, inquirePsAmount } from '../../../kis/psamount';
import {
  inquireTradeGrowthRanking,
  inquireTradeTurnoverRanking,
  inquireTradeVolumeRanking,
  inquireUpDownRateRanking,
} from '../../../kis/ranking';
import { AutoPilotManager } from '../autopilotManager';
import { createKisBroker } from '../createKisBroker';
import { createRealtimeFeed } from '../createRealtimeFeed';
import { expoKeepAwake } from '../keepAwake';
import { ScalperManager } from '../scalperManager';
import type { ScalperInstanceConfig } from '../types';
import { WATCH_SOURCES, type RankingSnapshot, type WatchCandidateRow } from '../watchlist';

export interface ManagerBootstrap {
  manager: ScalperManager;
  /** 자동관리(오토파일럿) 매니저 — 수동 매니저와 WS 연결을 나눠 쓴다(setAuxRoutes). */
  autopilot: AutoPilotManager;
  /** 새 카드 폼의 기본 수량(설정 탭 "주문 수량") — 카드별 수량은 여전히 사용자가 바꿀 수 있다. */
  defaultQty: number;
  /** 워밍업 진행률 표시용(설정 탭 값 그대로) — 정확한 틱 카운트가 아니라 경과시간 추정에 쓰인다. */
  bufferSize: number;
  chunkSeconds: number;
}

export type ManagerBootstrapState =
  | { kind: 'loading' }
  /** KIS 키가 설정 탭에 아직 없음 — "설정 탭에서 키를 먼저 등록해 주세요" 안내 대상. */
  | { kind: 'needsSetup' }
  | { kind: 'error'; message: string }
  | ({ kind: 'ready' } & ManagerBootstrap);

// 모듈 스코프 싱글턴 — 탭 전환으로 화면이 리마운트돼도 매니저·WS 연결·인스턴스는 유지한다.
let cached: ManagerBootstrap | null = null;
let inFlight: Promise<ManagerBootstrap> | null = null;

const clock = { now: () => Date.now() };

async function buildManager(): Promise<ManagerBootstrap> {
  const [kisSettings, appSettings] = await Promise.all([loadKisSettings(), loadAppSettings()]);
  if (!kisSettings) {
    throw new NeedsSetupError();
  }

  const credentials: KisCredentials = { appKey: kisSettings.appKey, appSecret: kisSettings.appSecret };
  const account: KisAccount = { cano: kisSettings.cano, acntPrdtCd: kisSettings.acntPrdtCd };
  const environment: KisEnvironment = appSettings.environment;

  const approvalKey = await getApprovalKey(environment, credentials);
  // manager는 realtime 다음에 만들어지므로, onError는 클로저로 나중에 할당되는 manager를 참조한다.
  let manager: ScalperManager | undefined;
  const realtime = createRealtimeFeed({
    approvalKey,
    clock,
    onError: (err) => manager?.reportFeedError(err),
  });

  manager = new ScalperManager({
    realtime,
    storage: AsyncStorage,
    clock,
    makeBroker: (config: ScalperInstanceConfig) =>
      createKisBroker({
        environment,
        credentials,
        account,
        pdno: config.ticker,
        ovrsExcgCd: config.exchange ?? 'NASD',
        getToken: async () => {
          const token = await getAccessToken(environment, credentials, { storage: secureTokenStorage });
          return token.accessToken;
        },
        clock,
      }),
    keepAwake: expoKeepAwake,
    chunkSeconds: appSettings.chunkSeconds,
    bufferSize: appSettings.bufferSize,
    // 매수 모멘텀 문턱(% → 상대 기울기 소수). 0이면 detector가 끔(전환 즉시 매수)으로 동작한다.
    minBuyMomentum: momentumThresholdToRatio(appSettings.momentumThresholdPct),
    // 매도 모멘텀 문턱(% → 하락 상대 기울기 크기 소수). 0이면 detector가 끔(전환 즉시 매도)으로 동작한다.
    minSellMomentum: momentumThresholdToRatio(appSettings.sellMomentumThresholdPct),
    // BUY 게이트(거래량 스파이크 배수·체결강도) — 0이면 끔. %가 아니라 변환 없이 정리만 한다.
    minVolumeSpikeRatio: gateThreshold(appSettings.buyVolumeSpikeRatio),
    minStrength: gateThreshold(appSettings.buyStrengthThreshold),
    // 거래 수수료율(% → 소수). 0이면 손익에서 수수료를 빼지 않는다(기존 동작).
    feeRate: commissionRateToRatio(appSettings.commissionRatePct),
  });

  await manager.restore();

  // ---- 자동관리(오토파일럿) — plan docs/development/2026-07-31_단타-자동관리-plan.md ----

  const getTokenStr = async () => {
    const token = await getAccessToken(environment, credentials, { storage: secureTokenStorage });
    return token.accessToken;
  };

  const toWatchRows = (rows: Array<{ symb: string; rate: string; sign?: string; e_ordyn?: string }>): WatchCandidateRow[] =>
    rows.map((r) => ({ symb: r.symb, rate: r.rate, sign: r.sign, e_ordyn: r.e_ordyn }));

  // 순위 4종 폴링(NAS·당일) — 유량을 아끼려 직렬 호출. 순위 7종은 전부 실전 도메인 전용(kis/ranking.ts).
  // 원천별 부분 실패 허용(확장 plan §4-3): 한 순위가 실패해도 나머지로 리스트를 구성한다.
  // 전부 실패하면 throw — ScalperWatchlist가 직전 리스트를 그대로 유지하고 다음 주기에 재시도한다.
  const callSource = async (
    label: string,
    fn: () => Promise<{ output2: Array<{ symb: string; rate: string; sign?: string; e_ordyn?: string }> }>,
    failures: string[],
  ): Promise<WatchCandidateRow[]> => {
    try {
      return toWatchRows((await fn()).output2);
    } catch (err) {
      failures.push(label);
      manager.reportFeedError(err);
      return [];
    }
  };

  const fetchSnapshot = async (): Promise<RankingSnapshot> => {
    const accessToken = await getTokenStr();
    const failures: string[] = [];
    const tradeVolume = await callSource('거래량순위', () =>
      inquireTradeVolumeRanking(credentials, accessToken, { excd: 'NAS', nday: '0' }), failures);
    const tradeGrowth = await callSource('거래증가율순위', () =>
      inquireTradeGrowthRanking(credentials, accessToken, { excd: 'NAS', nday: '0' }), failures);
    const tradeTurnover = await callSource('거래회전율순위', () =>
      inquireTradeTurnoverRanking(credentials, accessToken, { excd: 'NAS', nday: '0' }), failures);
    // 상승률만 VOL_RANG='3'(1만주 이상) — 등락률만 보는 순위라 저유동성 잡주가 상단을 점거한다(확장 plan §1-1 C).
    const upDownRate = await callSource('상승율순위', () =>
      inquireUpDownRateRanking(credentials, accessToken, { excd: 'NAS', gubn: '1', nday: '0', volRang: '3' }), failures);

    if (failures.length === WATCH_SOURCES.length) {
      throw new Error(`순위 조회 전건 실패 (${failures.join(', ')})`);
    }
    return { tradeVolume, tradeGrowth, tradeTurnover, upDownRate };
  };

  // 재시작 보유 감지(plan §2-6) — 잔고에 수량이 남은 종목 티커 목록.
  const fetchHoldings = async (): Promise<string[]> => {
    const accessToken = await getTokenStr();
    const res = await inquireOverseasBalance(environment, credentials, accessToken, { account });
    return res.output1.filter((p) => Number(p.cblc_qty13) > 0).map((p) => p.pdno);
  };

  // 현금 부족 PAUSED 사전 판정(세션 확장 plan §2-4) — 조회 실패 시 null(판정 생략, FAULT 인터록이 최후 방어선).
  const fetchBuyableUsd = async (ticker: string, price: number): Promise<number | null> => {
    try {
      const accessToken = await getTokenStr();
      const output = await inquirePsAmount(environment, credentials, accessToken, {
        account,
        ovrsExcgCd: 'NASD',
        ordUnpr: price,
        itemCd: ticker,
      });
      return buyableUsdOf(output);
    } catch {
      return null;
    }
  };

  const finalManager = manager;
  const autopilot = new AutoPilotManager({
    realtime,
    storage: AsyncStorage,
    clock,
    // 리스트는 NAS 전용(plan §1-A) — 주문 거래소도 NASD 고정.
    makeBroker: (ticker: string) =>
      createKisBroker({
        environment,
        credentials,
        account,
        pdno: ticker,
        ovrsExcgCd: 'NASD',
        getToken: getTokenStr,
        clock,
      }),
    fetchSnapshot,
    isManualBusy: () => finalManager.anyRunning,
    fetchBuyableUsd,
    fetchHoldings,
    keepAwake: expoKeepAwake,
    chunkSeconds: appSettings.chunkSeconds,
    bufferSize: appSettings.bufferSize,
    minBuyMomentum: momentumThresholdToRatio(appSettings.momentumThresholdPct),
    minSellMomentum: momentumThresholdToRatio(appSettings.sellMomentumThresholdPct),
    minVolumeSpikeRatio: gateThreshold(appSettings.buyVolumeSpikeRatio),
    minStrength: gateThreshold(appSettings.buyStrengthThreshold),
    feeRate: commissionRateToRatio(appSettings.commissionRatePct),
    onError: (err) => finalManager.reportFeedError(err),
  });
  // WS 단일 연결 공유 — 수동 매니저의 라우터가 오토파일럿 슬롯으로도 흘려보낸다.
  manager.setAuxRoutes(autopilot.routeTick, autopilot.routeQuote);
  await autopilot.restore();

  return {
    manager,
    autopilot,
    defaultQty: appSettings.orderQty,
    bufferSize: appSettings.bufferSize,
    chunkSeconds: appSettings.chunkSeconds,
  };
}

class NeedsSetupError extends Error {}

/** 이미 만든 매니저가 있으면 그대로, 없으면(또는 이전 시도가 실패했으면) 새로 만든다. */
function getOrCreateManager(): Promise<ManagerBootstrap> {
  if (cached) return Promise.resolve(cached);
  if (!inFlight) {
    inFlight = buildManager()
      .then((result) => {
        cached = result;
        return result;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/**
 * 단타 탭 진입 시 매니저를 준비한다. KIS 키 미설정/네트워크 오류를 상태로 노출하고,
 * 설정 탭에서 키를 저장한 뒤 다시 단타 탭으로 돌아오면(포커스) 자동으로 재시도한다.
 */
export function useScalperManager(): ManagerBootstrapState {
  const [state, setState] = useState<ManagerBootstrapState>(cached ? { kind: 'ready', ...cached } : { kind: 'loading' });

  useFocusEffect(
    useCallback(() => {
      if (cached) {
        setState({ kind: 'ready', ...cached });
        return;
      }
      let cancelled = false;
      setState({ kind: 'loading' });
      getOrCreateManager()
        .then((result) => {
          if (!cancelled) setState({ kind: 'ready', ...result });
        })
        .catch((e) => {
          if (cancelled) return;
          if (e instanceof NeedsSetupError) setState({ kind: 'needsSetup' });
          else setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
        });
      return () => {
        cancelled = true;
      };
    }, []),
  );

  return state;
}
