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
import { WATCH_SOURCES, type RankingSnapshot, type WatchCandidateRow } from '../watchlist';

export interface ManagerBootstrap {
  /** 피드 허브 — WS 단일 연결 소유, 자동 단타·상세화면으로 틱·호가 분배. */
  manager: ScalperManager;
  /** 자동관리(오토파일럿) 매니저 — 피드 허브와 WS 연결을 나눠 쓴다(setAuxRoutes). */
  autopilot: AutoPilotManager;
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

  manager = new ScalperManager({ realtime, clock });

  // ---- 자동관리(오토파일럿) — plan docs/development/2026-07-31_단타-자동관리-plan.md ----

  const getTokenStr = async () => {
    const token = await getAccessToken(environment, credentials, { storage: secureTokenStorage });
    return token.accessToken;
  };

  // 랭킹 응답 행의 공통 부분집합 — 병합 정렬 지표(tvol 등)는 인덱스 시그니처로 함께 들고 간다.
  type RawRankingRow = {
    symb: string; rate: string; sign?: string; e_ordyn?: string; last?: string; name?: string; ename?: string;
  } & Record<string, unknown>;

  // 종목명은 한글명(name) 우선, 비어 있으면 영문명(ename) — 순위 4종 모두 두 필드를 함께 내려준다.
  const toWatchRows = (rows: RawRankingRow[]): WatchCandidateRow[] =>
    rows.map((r) => ({
      symb: r.symb,
      rate: r.rate,
      sign: r.sign,
      e_ordyn: r.e_ordyn,
      last: r.last,
      excd: r.excd as string | undefined,
      name: r.name?.trim() || r.ename?.trim() || undefined,
    }));

  // 순위 4종 × 미국 거래소(NAS·NYS) 폴링 — 유량을 아끼려 직렬 호출(2026-08-08 3거래소 확대, 2026-08-10 아멕스 제외).
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
    fetchBuyableUsd,
    fetchHoldings,
    // 매도 관리 그리드 인계(D5) — 폭·매수배율은 설정 탭(매매파라미터)에서 조절한다(Phase B).
    gridConfig: { width: appSettings.gridWidthPct / 100, buyMultiplier: appSettings.gridBuyMultiplier },
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

  return {
    manager,
    autopilot,
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
 * 캐시된 매니저에 최신 설정을 다시 흘려 넣는다 — 설정 탭의 매매파라미터 **전부**.
 *
 * ⚠ 매니저는 모듈 스코프 싱글턴이라 buildManager()가 앱 부팅에 딱 한 번만 돈다. 그래서 설정 탭에서
 *   값을 바꿔 저장해도 앱을 완전히 껐다 켜기 전에는 반영되지 않았다(실제 사고 — 항상 부팅 때 값).
 *   그리드 폭·배율만 이 경로가 있었고 진입 감지(간격·홀 횟수)·매수 미체결 취소는 빠져 있어,
 *   사용자가 저장할 때마다 앱을 껐다 켜야 했다(2026-08-11 제보). 셋 다 여기서 갈아끼운다.
 *   (청크·버퍼·문턱은 설정에서 제거된 코드 고정값이라 대상이 아니다.)
 */
async function refreshLiveSettings(boot: ManagerBootstrap): Promise<void> {
  const appSettings = await loadAppSettings();
  boot.autopilot.setGridConfig({
    width: appSettings.gridWidthPct / 100,
    buyMultiplier: appSettings.gridBuyMultiplier,
  });
  boot.autopilot.setEntryLadder({
    interval: ladderIntervalToRatio(appSettings.entryLadderIntervalPct),
    triggerCount: ladderCountOf(appSettings.entryLadderCount),
  });
  boot.autopilot.setBuyCancelAfterMs(buyCancelAfterToMs(appSettings.buyCancelAfterSec));
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
