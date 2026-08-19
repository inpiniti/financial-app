// 단타 탭 매니저 싱글턴 부트스트랩 (6단계 UI 전용, features/scalper 로직 파일은 건드리지 않는다).
// 저장된 KIS 키(lib/kisSettings)·매매 파라미터(lib/appSettings)로 피드 허브(ScalperManager)와
// 자동 단타(AutoPilotManager)를 만들어 배선한다. 이후에는 모듈 스코프 싱글턴을 재사용해
// 탭을 오가도(화면이 언마운트/리마운트돼도) 세션·WS 연결이 끊기지 않는다.
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
  saveAppSettings,
  type AppSettings,
} from '../../../lib/appSettings';
import { loadKisSettings } from '../../../lib/kisSettings';
import { secureTokenStorage } from '../../../lib/secureTokenStorage';
import { inquireOverseasBalance } from '../../../kis/balance';
import { buyableUsdOf, inquirePsAmount } from '../../../kis/psamount';
import { fetchTossRankingQueries, type TossRankingRow } from '../../../lib/tossRanking';
import {
  inquirePriceFluctRanking,
  inquireTradeGrowthRanking,
  inquireTradeTurnoverRanking,
  inquireTradeVolumeRanking,
  inquireUpDownRateRanking,
  inquireVolumePowerRanking,
  inquireVolumeSurgeRanking,
  mergeRankingRows,
  US_RANKING_EXCHANGES,
  type RankingExchangeCode,
} from '../../../kis/ranking';
import { planFromSelection, rankingPlanKey, type KisMetric, type KisWindow, type RankingPlan } from '../../../core/ranking';
import { buildRankingSnapshot } from '../rankingSnapshot';
import type { OverseasExchangeCode } from '../../../kis/trId';
import { INFLECTION_THRESHOLDS, TREND_CONFIG } from '../autopilot';
import { MINUTE_BAR_RING_SIZE, TREND_BAR_MINUTES, type MinuteBar } from '../../../core/trend/bars';
import { fetchTossMinuteBars, resolveTossProductCode } from '../../../lib/tossMinuteChart';
import { getSupabaseClient, isSupabaseConfigured } from '../../../lib/supabase';
import { loadApprovedAccountNo } from '../../../lib/gateStorage';
import { TradeResultRecorder, toTradeResultRow, type TradeResultsInsertClient } from '../tradeResults';
import { AutoPilotManager, type AutoPilotManagerDeps } from '../autopilotManager';
import { createKisBroker } from '../createKisBroker';
import { createRealtimeFeed } from '../createRealtimeFeed';
import { expoKeepAwake } from '../keepAwake';
import { ScalperManager } from '../scalperManager';
import type { RankingSnapshot, WatchCandidateRow, WatchMarket } from '../watchlist';

export interface ManagerBootstrap {
  /** 피드 허브 — WS 단일 연결 소유, 자동 단타·상세화면으로 틱·호가 분배. */
  manager: ScalperManager;
  /** 자동관리(오토파일럿) 매니저 — 피드 허브와 WS 연결을 나눠 쓴다(setAuxRoutes). */
  autopilot: AutoPilotManager;
}

export type ManagerBootstrapState =
  | { kind: 'loading' }
  /** KIS 키가 아직 없음 — "계좌 화면에서 키를 먼저 등록해 주세요" 안내 대상. */
  | { kind: 'needsSetup' }
  | { kind: 'error'; message: string }
  | ({ kind: 'ready' } & ManagerBootstrap);

// 모듈 스코프 싱글턴 — 탭 전환으로 화면이 리마운트돼도 매니저·WS 연결·인스턴스는 유지한다.
let cached: ManagerBootstrap | null = null;
let inFlight: Promise<ManagerBootstrap> | null = null;

/**
 * 현재 순위 계획(2026-08-18 순위 도메인) — 설정(rankingSelection)에서 만든다. 폴링(fetchSnapshot)이 매번 이 값을 읽고,
 * refreshLiveSettings가 저장값이 바뀌었을 때 갈아끼운다(매니저 싱글턴이라 부팅 값에 묶이지 않게 — 설정 문서 §6-2).
 */
let liveRankingPlan: RankingPlan = [];
let liveRankingPlanKey = '';

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

  manager = new ScalperManager({ realtime, clock });

  // ---- 자동관리(오토파일럿) — plan docs/development/2026-07-31_단타-자동관리-plan.md ----

  const getTokenStr = async () => {
    const token = await getAccessToken(environment, credentials, { storage: secureTokenStorage });
    return token.accessToken;
  };

  // 리스트 원천 — 순위 선택(설정 rankingSelection → 계획 liveRankingPlan)대로 토스·한투 순위를 조회한다(2026-08-18 순위 도메인).
  // 기본 계획은 옛 구성(토스 거래대금·거래량 실시간, 관리종목 제외, 각 15)이라 설정을 건드리지 않으면 동작이 같다.
  // 토스: 위험미포함 원천은 **관리종목 제외 필터**, 위험포함은 필터 없음. ETF·ETN은 lib/tossRanking.ts가 종목구분으로 걸러낸다.
  //   KIS 토큰이 필요 없다(비공식 공개 API) — 실패하면 throw해서 ScalperWatchlist가 직전 리스트를 유지한다.
  // 한투: kis/ranking 7종을 미국 거래소(NAS·NYS) 직렬 조회 후 지표로 병합(홈 순위 화면과 같은 규칙). 방향은 급등·상승율 고정
  //   (리스트는 어차피 +등락만 채용). 원천 하나가 실패하면 그 원천만 비운다(rankingSnapshot.ts 실패 정책).
  liveRankingPlan = planFromSelection(appSettings.rankingSelection);
  liveRankingPlanKey = rankingPlanKey(liveRankingPlan);

  const tossToRows = (rows: TossRankingRow[]): WatchCandidateRow[] =>
    rows.map((r) => ({
      symb: r.symbol,
      // 등락률은 소수 문자열로 넘긴다 — 부호는 sign 없이 rate 원문 그대로 읽힌다(parseSignedRate).
      rate: r.ratePct.toFixed(2),
      last: String(r.price),
      excd: r.market,
      name: r.name,
    }));

  const fetchKisRanking = async (metric: KisMetric, window: KisWindow): Promise<WatchCandidateRow[]> => {
    const accessToken = await getTokenStr();
    const one = async (excd: RankingExchangeCode): Promise<{ output2: Array<Record<string, unknown>> }> => {
      switch (metric) {
        case 'tradeVolume':
          return inquireTradeVolumeRanking(credentials, accessToken, { excd, nday: window });
        case 'volumeSurge':
          return inquireVolumeSurgeRanking(credentials, accessToken, { excd, minx: window });
        case 'priceFluct':
          return inquirePriceFluctRanking(credentials, accessToken, { excd, gubn: '1', minx: window });
        case 'tradeGrowth':
          return inquireTradeGrowthRanking(credentials, accessToken, { excd, nday: window });
        case 'tradeTurnover':
          return inquireTradeTurnoverRanking(credentials, accessToken, { excd, nday: window });
        case 'volumePower':
          return inquireVolumePowerRanking(credentials, accessToken, { excd, nday: window });
        case 'upDownRate':
          return inquireUpDownRateRanking(credentials, accessToken, { excd, gubn: '1', nday: window });
      }
    };
    const lists: Array<Array<Record<string, unknown>>> = [];
    const errors: unknown[] = [];
    for (const excd of US_RANKING_EXCHANGES) {
      try {
        lists.push((await one(excd)).output2.map((r) => ({ ...r, excd })));
      } catch (e) {
        errors.push(e);
      }
    }
    if (lists.length === 0) throw errors[0] ?? new Error('순위 조회 실패');
    return mergeRankingRows(metric, lists).map((r) => ({
      symb: String(r.symb ?? ''),
      rate: String(r.rate ?? ''),
      sign: typeof r.sign === 'string' ? r.sign : undefined,
      e_ordyn: typeof r.e_ordyn === 'string' ? r.e_ordyn : undefined,
      last: typeof r.last === 'string' ? r.last : undefined,
      excd: String(r.excd),
      name: (typeof r.name === 'string' && r.name) || (typeof r.knam === 'string' && r.knam) || undefined,
    }));
  };

  const fetchSnapshot = async (): Promise<RankingSnapshot> =>
    buildRankingSnapshot(liveRankingPlan, {
      fetchToss: async (queries) =>
        (
          await fetchTossRankingQueries(
            queries.map((q) => ({ kind: q.metric, duration: q.duration, excludeManagement: q.excludeManagement })),
          )
        ).map(tossToRows),
      fetchKis: fetchKisRanking,
    });

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

  // 추세 워밍업(2026-08-18) — 토스 c-chart 분봉(min:TREND_BAR_MINUTES, lib/tossMinuteChart) 최근 130봉(링 크기)을 시드로.
  // 한투 분봉조회는 정규장만 줘서 프리·애프터·주간거래에 4선이 꼬였다(같은 날 확정) — 토스는 세션 무관 연속 봉.
  // 티커→토스 productCode는 검색 1회로 풀고 세션 동안 캐시(코드는 불변). 못 풀면 throw → 매니저 큐가 1회 재시도,
  // 그래도 안 되면 WS 봉만으로 서서히 채운다.
  const tossCodeCache = new Map<string, string>();
  const fetchMinuteBars = async (ticker: string, market: WatchMarket): Promise<MinuteBar[]> => {
    let code = tossCodeCache.get(ticker);
    if (!code) {
      const resolved = await resolveTossProductCode(ticker, market);
      if (!resolved) throw new Error('토스 종목코드를 못 찾았어요');
      tossCodeCache.set(ticker, resolved);
      code = resolved;
    }
    return fetchTossMinuteBars(code, MINUTE_BAR_RING_SIZE, { intervalMin: TREND_BAR_MINUTES });
  };

  // 거래 결과 외부 기록(docs/domain/켈리 §4) — Supabase env와 게이트 계좌번호가 있을 때만. 없으면 로컬 기록만.
  // 매매·켈리 계산과 무관한 "기록만"이다. 정산 시점 계좌 총평가(USD 근사)를 함께 남긴다 — 실패면 null.
  const approvedAccountNo = await loadApprovedAccountNo();
  let recordTradeResult: AutoPilotManagerDeps['recordTradeResult'];
  let tradeRecorder: TradeResultRecorder | null = null;
  if (isSupabaseConfigured() && approvedAccountNo) {
    tradeRecorder = new TradeResultRecorder({
      client: getSupabaseClient() as unknown as TradeResultsInsertClient,
      storage: AsyncStorage,
    });
    const accountNo = approvedAccountNo;
    const fetchEquityUsd = async (): Promise<number | null> => {
      try {
        const accessToken = await getTokenStr();
        const res = await inquireOverseasBalance(environment, credentials, accessToken, { account });
        const totKrw = Number(res.output3?.tot_asst_amt);
        const exrt = res.output1.map((p) => Number(p.bass_exrt)).find((v) => Number.isFinite(v) && v > 0);
        if (!Number.isFinite(totKrw) || totKrw <= 0 || exrt === undefined) return null;
        return totKrw / exrt;
      } catch {
        return null;
      }
    };
    const recorder = tradeRecorder;
    recordTradeResult = async ({ record, strategy, market, name }) => {
      const equityUsd = await fetchEquityUsd();
      const ok = await recorder.record(toTradeResultRow({ accountNo, strategy, record, market, name, equityUsd }));
      // 실패는 매니저가 이벤트로 남긴다(매매는 계속). 행은 로컬 대기열에 있어 다음 부팅 때 재전송된다.
      if (!ok) throw new Error('로컬 대기열에 보관 — 다음에 다시 올려요');
    };
  }

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
    fetchBuyableUsd,
    fetchHoldings,
    // 매도 관리 그리드 인계(D5) — 매수폭·매도폭·매수배율은 설정 탭(매매파라미터)에서 조절한다.
    // ⚠ 아래 inflection이 켜져 있는 동안은 조합 경로가 우선이라 이 값은 쓰이지 않는다(롤백용 보존).
    gridConfig: {
      buyWidth: appSettings.gridBuyWidthPct / 100,
      sellWidth: appSettings.gridSellWidthPct / 100,
      buyMultiplier: appSettings.gridBuyMultiplier,
    },
    // 변곡점+그리드 조합(2026-08-15 도메인 문서) — 문턱은 문서 §5 고정값(+2%/−3%), 설정 탭 없음.
    // 끄려면 feedSlot.INFLECTION_ENTRY·autopilot.INFLECTION_GRID를 false로(한 줄 롤백) 하거나 이 주입을 뺀다.
    inflection: INFLECTION_THRESHOLDS,
    // 추세 → 그리드 → 매매(2026-08-18 도메인 문서) — 위 변곡점 조합·사다리보다 우선한다(단일 스위치 trendMode.TREND_MODE).
    // 끄려면 TREND_MODE=false(한 줄 롤백 → 변곡점 조합) 또는 이 주입 두 줄을 뺀다.
    trend: TREND_CONFIG,
    fetchMinuteBars,
    recordTradeResult,
    keepAwake: expoKeepAwake,
    // 사다리 판정 주기 = 청크 1초 고정 (2026-08-09 사용자 확정 — 설정 제거 전 실사용 값 복원.
    // 설정 제거 때 기본 3초로 잘못 굳었었다). 버퍼는 미주입(기본 31) — 사다리 모드는 워밍업을
    // 기다리지 않아(feedSlot) 버퍼 크기는 판정 시작 시점과 무관하다.
    chunkSeconds: 1,
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

  // WS 단일 연결 공유 — 피드 허브의 라우터가 오토파일럿 슬롯으로 흘려보낸다.
  manager.setAuxRoutes(autopilot.routeTick, autopilot.routeQuote);
  // 반대 방향 프로브 — 상세화면 releaseFeed가 자동 단타의 감시·보유 구독을 끊지 않게 한다.
  manager.setFeedUseProbe((trKey, trId) => autopilot.usesTrKey(trKey, trId));
  await autopilot.restore();
  await syncTradingConfig(autopilot, appSettings);
  // 지난번 업로드 못 한 거래 기록 재전송(직렬) — 실패해도 조용히, 다음 부팅에 다시.
  if (tradeRecorder) void tradeRecorder.flushPending().catch(() => {});

  return {
    manager,
    autopilot,
  };
}

/**
 * 트레이딩 운용 설정(진입금액·최소 속도·동시 그리드)을 설정 화면 저장소 → 오토파일럿으로 흘려 넣는다.
 *
 * 2026-08-12에 이 값들의 편집 위치가 트레이딩 화면 시트(오토파일럿이 스스로 저장)에서 설정 화면
 * (lib/appSettings)으로 옮겨졌다. 그래서 방향을 하나로 고정한다 — appSettings가 원본, 오토파일럿이 사본.
 * 다만 시트 시절에 값을 넣어 둔 기기는 appSettings가 비어 있으므로(startAmountUsd 0), 그 한 번만
 * 반대로 복사해 설정 화면이 빈 칸으로 뜨지 않게 한다.
 *
 * setConfig는 IDLE에서만 통과한다 — 매매 중 저장은 조용히 무시되고 정지 후 다음 포커스에 반영된다.
 */
async function syncTradingConfig(autopilot: AutoPilotManager, appSettings: AppSettings): Promise<void> {
  const current = autopilot.pilot.getView().config;
  if (appSettings.startAmountUsd > 0) {
    // 값이 그대로면 건너뛴다 — setConfig는 매번 저장하고 뷰를 다시 쏘는데, 이 함수는 화면 포커스마다 돈다.
    if (
      current &&
      current.startAmountUsd === appSettings.startAmountUsd &&
      (current.entryQty ?? 0) === appSettings.entryQty &&
      current.minTickRate === appSettings.minTickRate &&
      current.maxConcurrentGrids === appSettings.maxConcurrentGrids
    ) {
      return;
    }
    autopilot.pilot.setConfig({
      startAmountUsd: appSettings.startAmountUsd,
      entryQty: appSettings.entryQty,
      minTickRate: appSettings.minTickRate,
      maxConcurrentGrids: appSettings.maxConcurrentGrids,
    });
    return;
  }
  if (current) {
    await saveAppSettings({
      ...appSettings,
      startAmountUsd: current.startAmountUsd,
      entryQty: current.entryQty ?? appSettings.entryQty,
      minTickRate: current.minTickRate,
      maxConcurrentGrids: current.maxConcurrentGrids ?? appSettings.maxConcurrentGrids,
    });
  }
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
 * 캐시된 매니저에 최신 설정을 다시 흘려 넣는다 — 설정 탭의 매매파라미터 **전부**.
 *
 * ⚠ 매니저는 모듈 스코프 싱글턴이라 buildManager()가 앱 부팅에 딱 한 번만 돈다. 그래서 설정 탭에서
 *   값을 바꿔 저장해도 앱을 완전히 껐다 켜기 전에는 반영되지 않았다(실제 사고 — 항상 부팅 때 값).
 *   그리드 폭·배율만 이 경로가 있었고 진입 감지(간격·홀 횟수)·매수 미체결 취소는 빠져 있어,
 *   사용자가 저장할 때마다 앱을 껐다 켜야 했다(2026-08-11 제보). 셋 다 여기서 갈아끼운다.
 *   (청크·버퍼·문턱은 설정에서 제거된 코드 고정값이라 대상이 아니다.)
 *
 * 호출 시점은 둘이다 — ① 트레이딩 화면 포커스마다(useScalperManager), ② "자동 트레이딩 시작하기"
 * 직전(AutoPilotScreen.handleRun). ②가 없으면 매매 중 저장 → 화면 이동 없이 정지 → 시작 흐름에서
 * 진입금액·최소 속도·동시 그리드가 IDLE 게이트(setConfig)에 막힌 옛값 그대로 시작된다(2026-08-14 제보).
 */
export async function refreshLiveSettings(autopilot: AutoPilotManager): Promise<void> {
  const appSettings = await loadAppSettings();
  autopilot.setGridConfig({
    buyWidth: appSettings.gridBuyWidthPct / 100,
    sellWidth: appSettings.gridSellWidthPct / 100,
    buyMultiplier: appSettings.gridBuyMultiplier,
  });
  autopilot.setEntryLadder({
    interval: ladderIntervalToRatio(appSettings.entryLadderIntervalPct),
    triggerCount: ladderCountOf(appSettings.entryLadderCount),
  });
  autopilot.setBuyCancelAfterMs(buyCancelAfterToMs(appSettings.buyCancelAfterSec));
  // 순위 계획(2026-08-18) — 바뀌었을 때만 갈아끼우고, 폴링 중이면 다음 주기(최대 3분)를 기다리지 않고 즉시 재조회한다.
  // 정지 상태에서는 재조회하지 않는다(start가 즉시 1회 돌며 새 계획을 쓴다 — 정지 중 구독을 만들지 않게).
  const nextPlan = planFromSelection(appSettings.rankingSelection);
  const nextKey = rankingPlanKey(nextPlan);
  if (nextKey !== liveRankingPlanKey) {
    liveRankingPlan = nextPlan;
    liveRankingPlanKey = nextKey;
    if (autopilot.watchlist.running) void autopilot.watchlist.refresh();
  }
  await syncTradingConfig(autopilot, appSettings);
}

/**
 * 트레이딩 섹션 진입 시 매니저를 준비한다. KIS 키 미설정/네트워크 오류를 상태로 노출하고,
 * 계좌 화면에서 키를 저장한 뒤 다시 트레이딩으로 돌아오면(포커스) 자동으로 재시도한다.
 * 이미 만들어진 매니저가 있으면 재생성 대신 **바꿀 수 있는 설정만** 갱신한다(refreshLiveSettings).
 */
export function useScalperManager(): ManagerBootstrapState {
  const [state, setState] = useState<ManagerBootstrapState>(cached ? { kind: 'ready', ...cached } : { kind: 'loading' });

  useFocusEffect(
    useCallback(() => {
      if (cached) {
        const boot = cached;
        setState({ kind: 'ready', ...boot });
        void refreshLiveSettings(boot.autopilot).catch(() => {
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
