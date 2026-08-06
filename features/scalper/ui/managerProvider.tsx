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
  buyCancelAfterToMs,
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
import { SimExchange } from '../simBroker';
import { buildSimMatrix, SimLab } from '../simLab';
import { flushQueuedEpisodes, recordSimEpisode } from '../../../lib/simEpisodeStore';
import type { ScalperInstanceConfig } from '../types';
import { WATCH_SOURCES, type RankingSnapshot, type WatchCandidateRow } from '../watchlist';

export interface ManagerBootstrap {
  manager: ScalperManager;
  /** 자동관리(오토파일럿) 매니저 — 수동 매니저와 WS 연결을 나눠 쓴다(setAuxRoutes). */
  autopilot: AutoPilotManager;
  /**
   * 시뮬레이션 모드 스위치(mutable ref) — makeBroker·fetchBuyableUsd 등이 매 호출마다 읽는다.
   * 재빌드(WS 재연결) 없이 전환하기 위한 구조. 전환은 refreshLiveSettings가 **오토파일럿 IDLE일 때만** 한다.
   */
  simMode: { current: boolean };
  /** 가상 체결소·전략 매트릭스 — 모드와 무관하게 상주(라이브에서도 관찰 에피소드를 쌓는다). */
  simExchange: SimExchange;
  simLab: SimLab;
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
    // 매수 미체결 자동 취소(0=끔). 과거 사고로 삭제됐던 기능의 매수 한정 재도입이라 기본은 꺼져 있다.
    buyCancelAfterMs: buyCancelAfterToMs(appSettings.buyCancelAfterSec),
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

  // ---- 시뮬레이션(2026-08-06 plan) — 가상 체결소·전략 매트릭스. 모드는 mutable ref로 IDLE 전환 ----
  const simMode = { current: appSettings.simulationMode };
  const simExchange = new SimExchange();
  // SimLab은 모드와 무관하게 상주한다 — 실거래 중에도 20조합 가상 전략이 같은 진입을 관찰(mode='live' 기록).
  // hold/release는 autopilot 생성 뒤에 배선되므로 지연 참조로 잡는다.
  let autopilotRef: AutoPilotManager | undefined;
  const simLab = new SimLab({
    clock,
    matrix: buildSimMatrix({ widthPct: appSettings.gridWidthPct, buyMultiplier: appSettings.gridBuyMultiplier }),
    onRecord: (record) => {
      void recordSimEpisode(record).catch((err) => finalManager.reportFeedError(err));
    },
    hold: (t) => autopilotRef?.holdTick(t),
    release: (t) => autopilotRef?.releaseTick(t),
  });
  void flushQueuedEpisodes().catch(() => {}); // 지난 세션에 못 보낸 에피소드 재전송(실패해도 무해).

  const autopilot = new AutoPilotManager({
    realtime,
    storage: AsyncStorage,
    clock,
    // 리스트는 NAS 전용(plan §1-A) — 주문 거래소도 NASD 고정.
    // ★ 시뮬 모드면 KIS 대신 가상 체결소로 — 브로커는 진입마다 새로 만들어지므로 ref만 읽으면 된다.
    makeBroker: (ticker: string) =>
      simMode.current
        ? simExchange.makeBroker(ticker)
        : createKisBroker({
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
    // 시뮬은 현금 무한(사용자 확정) — null이면 오토파일럿이 현금 부족 판정을 생략한다.
    fetchBuyableUsd: (ticker, price) => (simMode.current ? Promise.resolve(null) : fetchBuyableUsd(ticker, price)),
    // 시뮬은 가상 잔고를 보여준다 — 실계좌 장기 보유가 시뮬 경고·입양 목록에 섞이지 않게.
    fetchHoldings: () => (simMode.current ? Promise.resolve([...simExchange.positions().keys()]) : fetchHoldings()),
    isSimulation: () => simMode.current,
    onEntryFilled: (info) => {
      simLab.onEntry(info.ticker, info.qty, info.avgPrice, {
        tickRate: info.tickRate ?? undefined,
        mode: simMode.current ? 'sim' : 'live',
      });
    },
    // 매도 관리 그리드 인계(D5) — 폭·매수배율은 설정 탭(매매파라미터)에서 조절한다(Phase B).
    gridConfig: { width: appSettings.gridWidthPct / 100, buyMultiplier: appSettings.gridBuyMultiplier },
    keepAwake: expoKeepAwake,
    chunkSeconds: appSettings.chunkSeconds,
    bufferSize: appSettings.bufferSize,
    minBuyMomentum: momentumThresholdToRatio(appSettings.momentumThresholdPct),
    minSellMomentum: momentumThresholdToRatio(appSettings.sellMomentumThresholdPct),
    minVolumeSpikeRatio: gateThreshold(appSettings.buyVolumeSpikeRatio),
    minStrength: gateThreshold(appSettings.buyStrengthThreshold),
    feeRate: commissionRateToRatio(appSettings.commissionRatePct),
    buyCancelAfterMs: buyCancelAfterToMs(appSettings.buyCancelAfterSec),
    onError: (err) => finalManager.reportFeedError(err),
  });
  autopilotRef = autopilot;

  // WS 단일 연결 공유 — 수동 매니저의 라우터가 오토파일럿 슬롯으로도 흘려보낸다.
  // 시뮬 탭: 가상 체결소(주문 판정)와 전략 매트릭스(에피소드 판정)가 같은 틱을 먼저 받는다.
  manager.setAuxRoutes((symb, price, tsMs, extras) => {
    simExchange.onTick(symb, price);
    simLab.onTick(symb, price, tsMs);
    autopilot.routeTick(symb, price, tsMs, extras);
  }, autopilot.routeQuote);
  await autopilot.restore();

  return {
    manager,
    autopilot,
    simMode,
    simExchange,
    simLab,
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
 * 캐시된 매니저에 최신 설정을 다시 흘려 넣는다 — 지금은 그리드 폭·매수배율만.
 *
 * ⚠ 매니저는 모듈 스코프 싱글턴이라 buildManager()가 앱 부팅에 딱 한 번만 돈다. 그래서 설정 탭에서
 *   그리드 폭을 바꿔 저장해도 앱을 완전히 껐다 켜기 전에는 반영되지 않았다(실제 사고 — 항상 10%·1배).
 *   나머지 파라미터(청크·버퍼·문턱 등)는 이미 만들어진 FeedSlot/detector에 박혀 있어 여기서 못 바꾼다.
 */
async function refreshLiveSettings(boot: ManagerBootstrap): Promise<void> {
  const appSettings = await loadAppSettings();
  boot.autopilot.setGridConfig({
    width: appSettings.gridWidthPct / 100,
    buyMultiplier: appSettings.gridBuyMultiplier,
  });
  // 시뮬 모드 전환 — **오토파일럿 IDLE일 때만**. 실행 중 갈아끼우면 실거래/가상 브로커가 한 세션에 섞인다
  // (진행 중 사이클은 옛 브로커를 쥐고 있고, 새 진입만 새 브로커를 받는 상태가 됨).
  if (appSettings.simulationMode !== boot.simMode.current) {
    if (boot.autopilot.pilot.getView().state === 'IDLE') {
      boot.simMode.current = appSettings.simulationMode;
      boot.simExchange.reset(); // 이전 실험의 가상 포지션·주문 잔재 제거.
      boot.simLab.closeAll('stopped'); // 열린 에피소드가 있으면 그 시점 상태로 마감 기록.
      boot.autopilot.notify(
        appSettings.simulationMode
          ? '시뮬레이션 모드를 켰어요 — 주문은 KIS로 나가지 않아요'
          : '시뮬레이션 모드를 껐어요 — 이제 실거래로 주문이 나가요',
      );
    } else {
      boot.autopilot.notify('시뮬레이션 모드 변경은 자동 단타를 정지한 뒤 단타 탭에 다시 들어오면 적용돼요');
    }
  }
}

/**
 * 단타 탭 진입 시 매니저를 준비한다. KIS 키 미설정/네트워크 오류를 상태로 노출하고,
 * 설정 탭에서 키를 저장한 뒤 다시 단타 탭으로 돌아오면(포커스) 자동으로 재시도한다.
 * 이미 만들어진 매니저가 있으면 재생성 대신 **바꿀 수 있는 설정만** 갱신한다(refreshLiveSettings).
 */
export function useScalperManager(): ManagerBootstrapState {
  const [state, setState] = useState<ManagerBootstrapState>(cached ? { kind: 'ready', ...cached } : { kind: 'loading' });

  useFocusEffect(
    useCallback(() => {
      if (cached) {
        const boot = cached;
        setState({ kind: 'ready', ...boot });
        void refreshLiveSettings(boot).catch(() => {
          // 설정 로드 실패 — 기존 값을 그대로 쓴다(매매를 막을 이유는 없다).
        });
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
