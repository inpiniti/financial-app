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
  loadAppSettings,
  ladderCountOf,
  ladderIntervalToRatio,
} from '../../../lib/appSettings';
import { DEFAULT_BUFFER_SIZE, DEFAULT_CHUNK_SECONDS } from '../../../core/resample';
import { loadKisSettings } from '../../../lib/kisSettings';
import { secureTokenStorage } from '../../../lib/secureTokenStorage';
import { inquireOverseasBalance } from '../../../kis/balance';
import { buyableUsdOf, inquirePsAmount } from '../../../kis/psamount';
import {
  inquireTradeGrowthRanking,
  inquireTradeTurnoverRanking,
  inquireTradeVolumeRanking,
  inquireUpDownRateRanking,
  mergeRankingRows,
  US_RANKING_EXCHANGES,
  type RankingExchangeCode,
  type RankingKind,
} from '../../../kis/ranking';
import type { OverseasExchangeCode } from '../../../kis/trId';
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
  /** 워밍업 진행률 표시용(코드 고정값 3초·31칸) — 정확한 틱 카운트가 아니라 경과시간 추정에 쓰인다. */
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
    // 청크·버퍼·모멘텀 문턱·BUY 게이트·수수료율은 2026-08-08 설정에서 제거 — 미주입 시
    // 코드 기본값(3초·31칸, 문턱 0.0001/0.00005, 게이트·수수료 0=끔)이 옛 설정 기본값과 동일하다.
    // 매수 미체결 자동 취소(0=끔). 과거 사고로 삭제됐던 기능의 매수 한정 재도입이라 기본은 꺼져 있다.
    buyCancelAfterMs: buyCancelAfterToMs(appSettings.buyCancelAfterSec),
  });

  await manager.restore();

  // ---- 자동관리(오토파일럿) — plan docs/development/2026-07-31_단타-자동관리-plan.md ----

  const getTokenStr = async () => {
    const token = await getAccessToken(environment, credentials, { storage: secureTokenStorage });
    return token.accessToken;
  };

  // 랭킹 응답 행의 공통 부분집합 — 병합 정렬 지표(tvol 등)는 인덱스 시그니처로 함께 들고 간다.
  type RawRankingRow = {
    symb: string; rate: string; sign?: string; e_ordyn?: string; last?: string;
  } & Record<string, unknown>;

  const toWatchRows = (rows: RawRankingRow[]): WatchCandidateRow[] =>
    rows.map((r) => ({ symb: r.symb, rate: r.rate, sign: r.sign, e_ordyn: r.e_ordyn, last: r.last, excd: r.excd as string | undefined }));

  // 순위 4종 × 미국 3거래소(NAS·NYS·AMS) 폴링 — 유량을 아끼려 12콜 직렬(2026-08-08 3거래소 확대).
  // 순위 7종은 전부 실전 도메인 전용(kis/ranking.ts). 거래소별 결과는 순위 지표로 재정렬해 하나로 합친다.
  // (순위, 거래소) 콜 단위 부분 실패 허용(확장 plan §4-3의 확장): 실패 콜만 빼고 리스트를 구성한다.
  // 전부 실패하면 throw — ScalperWatchlist가 직전 리스트를 그대로 유지하고 다음 주기에 재시도한다.
  const fetchSnapshot = async (): Promise<RankingSnapshot> => {
    const accessToken = await getTokenStr();
    const failures: string[] = [];
    const fetchAcross = async (
      kind: RankingKind,
      label: string,
      call: (excd: RankingExchangeCode) => Promise<{ output2: RawRankingRow[] }>,
    ): Promise<WatchCandidateRow[]> => {
      const lists: RawRankingRow[][] = [];
      for (const excd of US_RANKING_EXCHANGES) {
        try {
          // 응답의 excd 표기를 믿지 않고 요청 거래소로 덮어쓴다 — 구독·주문 거래소 판별의 근거라 확실해야 한다.
          lists.push((await call(excd)).output2.map((r) => ({ ...r, excd })));
        } catch (err) {
          failures.push(`${label}(${excd})`);
          manager.reportFeedError(err);
        }
      }
      return toWatchRows(mergeRankingRows(kind, lists));
    };

    const tradeVolume = await fetchAcross('tradeVolume', '거래량순위', (excd) =>
      inquireTradeVolumeRanking(credentials, accessToken, { excd, nday: '0' }));
    const tradeGrowth = await fetchAcross('tradeGrowth', '거래증가율순위', (excd) =>
      inquireTradeGrowthRanking(credentials, accessToken, { excd, nday: '0' }));
    const tradeTurnover = await fetchAcross('tradeTurnover', '거래회전율순위', (excd) =>
      inquireTradeTurnoverRanking(credentials, accessToken, { excd, nday: '0' }));
    // 상승률만 VOL_RANG='3'(1만주 이상) — 등락률만 보는 순위라 저유동성 잡주가 상단을 점거한다(확장 plan §1-1 C).
    const upDownRate = await fetchAcross('upDownRate', '상승율순위', (excd) =>
      inquireUpDownRateRanking(credentials, accessToken, { excd, gubn: '1', nday: '0', volRang: '3' }));

    if (failures.length === WATCH_SOURCES.length * US_RANKING_EXCHANGES.length) {
      throw new Error(`순위 조회 전건 실패 (${failures.join(', ')})`);
    }
    return { tradeVolume, tradeGrowth, tradeTurnover, upDownRate };
  };

  // 재시작 보유 감지(plan §2-6) — 잔고에 수량이 남은 종목 티커 목록.
  // ⚠ cblc_qty13(결제보유수량)이 아니라 ccld_qty_smtl1(체결기준 보유수량)을 본다 — 미국주식은 T+1 결제라
  //   결제 기준으로는 당일 매수분(FAULT 복구 대상)이 0으로 빠지고, 이미 청산된 종목이 하루 더 남는다.
  //   현재가 0인 행은 CVR 같은 거래 불능 잔여 권리 — 그리드에 태울 수 없으니 제외한다.
  const fetchHoldings = async (): Promise<string[]> => {
    const accessToken = await getTokenStr();
    const res = await inquireOverseasBalance(environment, credentials, accessToken, { account });
    return res.output1
      .filter((p) => Number(p.ccld_qty_smtl1) > 0 && Number(p.ovrs_now_pric1) > 0)
      .map((p) => p.pdno);
  };

  // 현금 부족 PAUSED 사전 판정 — 조회 실패 시 null(판정 생략, FAULT 인터록이 최후 방어선).
  const fetchBuyableUsd = async (ticker: string, price: number, exchange: OverseasExchangeCode): Promise<number | null> => {
    try {
      const accessToken = await getTokenStr();
      const output = await inquirePsAmount(environment, credentials, accessToken, {
        account,
        ovrsExcgCd: exchange,
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
    // 리스트는 미국 3거래소 병합(2026-08-08) — 주문 거래소는 채용 거래소를 그대로 받는다(NASD/NYSE/AMEX).
    makeBroker: (ticker: string, exchange: OverseasExchangeCode) =>
      createKisBroker({
        environment,
        credentials,
        account,
        pdno: ticker,
        ovrsExcgCd: exchange,
        getToken: getTokenStr,
        clock,
      }),
    fetchSnapshot,
    isManualBusy: () => finalManager.anyRunning,
    fetchBuyableUsd,
    fetchHoldings,
    // 매도 관리 그리드 인계(D5) — 폭·매수배율은 설정 탭(매매파라미터)에서 조절한다(Phase B).
    gridConfig: { width: appSettings.gridWidthPct / 100, buyMultiplier: appSettings.gridBuyMultiplier },
    keepAwake: expoKeepAwake,
    // 청크·버퍼·모멘텀 문턱·BUY 게이트·수수료율은 2026-08-08 설정에서 제거 — 미주입 시 코드 기본값이
    // 옛 설정 기본값과 동일해 자동단타 동작은 그대로다(사다리 감지는 청크 3초 마감가·31칸 워밍업 유지).
    // 사다리 진입 감지(2026-08-07 plan) — 간격 %→소수, 홀 횟수 정수. feedSlot.LADDER_ENTRY가 최종 스위치다.
    entryLadder: {
      interval: ladderIntervalToRatio(appSettings.entryLadderIntervalPct),
      triggerCount: ladderCountOf(appSettings.entryLadderCount),
    },
    buyCancelAfterMs: buyCancelAfterToMs(appSettings.buyCancelAfterSec),
    // 종목 상세화면(acquireFeed)이 잡고 있는 구독은 리스트 이탈 시에도 해제하지 않는다(교차 해제 방지).
    isFeedHeldExternally: (trKey, trId) => finalManager.holdsFeed(trKey, trId),
    onError: (err) => finalManager.reportFeedError(err),
  });

  // WS 단일 연결 공유 — 수동 매니저의 라우터가 오토파일럿 슬롯으로도 흘려보낸다.
  manager.setAuxRoutes((symb, price, tsMs, extras) => {
    autopilot.routeTick(symb, price, tsMs, extras);
  }, autopilot.routeQuote);
  // 반대 방향 프로브 — 상세화면 releaseFeed가 자동 단타의 감시·보유 구독을 끊지 않게 한다.
  manager.setFeedUseProbe((trKey, trId) => autopilot.usesTrKey(trKey, trId));
  await autopilot.restore();

  return {
    manager,
    autopilot,
    defaultQty: appSettings.orderQty,
    // 설정에서 제거된 값 — 워밍업 진행률 표시는 코드 고정값(3초·31칸)을 그대로 쓴다.
    bufferSize: DEFAULT_BUFFER_SIZE,
    chunkSeconds: DEFAULT_CHUNK_SECONDS,
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
