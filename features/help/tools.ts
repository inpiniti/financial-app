// 도움말 챗봇이 부를 수 있는 도구 — **전부 읽기 전용이다.**
//
// ⚠ 불변식(사용자 확정, 2026-08-21): 주문·정정·취소·시작·정지·설정 저장은 도구로 만들지 않는다.
//   AI 판단이 실계좌를 건드리는 경로를 아예 두지 않는다는 뜻이다. 새 도구를 더할 때도 "조회만" 이어야 하고,
//   쓰기가 필요해지면 도구가 아니라 화면 버튼으로 안내한다("설정 > 트레이딩 설정에서 바꿔요").
//
// 실행 경로: 모델이 functionCall을 내면(프록시가 [[FN_CALL]] 마커로 전달) helpChat이 runHelpTool로 실행하고
// 결과를 functionResponse로 되돌린다. 결과 객체는 그대로 프롬프트에 들어가므로 **작고 사람이 읽을 수 있게** 만든다.
//
// RN 전용 모듈(expo-secure-store 등)은 도구가 실제로 불릴 때만 동적 import 한다 — 그래야 vitest(node)에서
// 이 파일을 그냥 import 할 수 있다.
import { searchStocks } from '../../lib/tossSearch';
import { readTodayTrades } from '../scalper/tradeStore';
import { fetchYahooArticles, fetchYahooSearch } from '../stock/yahooSearch';
import { searchNews, searchWebPages, type NewsLang } from './webSearch';

/** UI가 넘겨주는 "지금 앱 상태" 스냅샷 — 오토파일럿이 안 돌면 null. */
export interface HelpAutopilotSnapshot {
  state: string;
  activeTickers: readonly string[];
  cycles: number;
  cumPnlUsd: number;
  maxGrids: number;
  /**
   * 최근 이벤트 로그(최신순) — "왜 안 샀는지/왜 안 팔았는지"의 1차 증거. 진입 포기·감시 교체·시드
   * 실패가 전부 여기 남는다(2026-08-22 추가 — 실거래 진단이 매번 이 로그를 못 읽어서 막혔다).
   */
  events?: Array<{ at: number; text: string }>;
  /** 트레이딩 리스트 — 티커·이름·현재가·속도·모델 판정 한 줄. */
  list: Array<{
    ticker: string;
    name?: string;
    price: number | null;
    tickRate: number | null;
    /**
     * 그 종목의 현행 감지 요약 — 모델 모드면 "모델 확률 x.x%", 추세 모드면 4선 방향.
     * 2026-08-24까지 이 자리는 추세 4선 고정이라 모델 모드에서 전 종목이 "봉 부족"으로 나왔다.
     */
    signal: string;
    /** 지금 매수가 허용되는 종목인가(속도 상위 watchCount종). */
    candidate?: boolean;
  }>;
}

export interface HelpToolDeps {
  /** 오토파일럿 스냅샷 제공자(UI 주입). 없으면 "지금 안 돌고 있어요"로 답한다. */
  autopilot?: () => HelpAutopilotSnapshot | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Gemini functionDeclarations — 이름·설명·인자. 설명은 모델이 "언제 부를지" 고르는 유일한 근거라
 * 한 줄이라도 구체적으로 쓴다(무엇을 돌려주는지 + 언제 쓰는지).
 */
export const HELP_TOOL_DECLARATIONS = [
  {
    name: 'getAutopilotStatus',
    description:
      '지금 자동 트레이딩이 어떤 상태인지(대기·감시·매수·보유·매도), 보유 종목, 오늘 완료된 매매 횟수와 누적 손익(USD), 그리드 한도를 돌려준다. "지금 뭐 하고 있어?", "왜 안 사?" 같은 질문에 먼저 쓴다.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'getWatchlist',
    description:
      '지금 트레이딩 리스트를 돌려준다(티커·이름·현재가·틱속도·진입 판정 요약·매수 후보 여부). 어떤 종목을 보고 있는지, 왜 진입 신호가 없는지 설명할 때 쓴다. candidate=false면 진입 조건이 맞아도 사지 않는다(속도 상위 밖).',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'getHoldings',
    description:
      '증권 계좌의 실제 보유 종목과 평가손익을 조회한다(한국투자증권 잔고). 앱이 관리하지 않는 종목까지 포함한 계좌 전체다.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'getPendingOrders',
    description: '아직 체결되지 않은 주문(미체결)을 조회한다. "주문이 안 붙어요" 같은 질문에 쓴다.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'getTodayTrades',
    description:
      '앱이 오늘 기록한 매수→매도 사이클(진입가·청산가·수량·손익·청산 사유)을 돌려준다. "오늘 왜 팔았어?"에 쓴다.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'getQuote',
    description: '미국 종목 하나의 현재 시세 상세(현재가·등락·거래량·시총·PER·52주)를 조회한다.',
    parameters: {
      type: 'OBJECT',
      properties: { ticker: { type: 'STRING', description: '티커. 예: TSLA' } },
      required: ['ticker'],
    },
  },
  {
    name: 'searchStock',
    description: '종목명이나 티커 일부로 미국 종목을 찾는다. 사용자가 한글 종목명으로 물을 때 티커를 알아내는 용도.',
    parameters: {
      type: 'OBJECT',
      properties: { query: { type: 'STRING', description: '검색어. 예: 엔비디아, tsla' } },
      required: ['query'],
    },
  },
  {
    name: 'getStockNews',
    description:
      '특정 종목의 최근 기사 제목과 **본문 일부**를 읽어 온다(Yahoo Finance). 종목에 무슨 일이 있었는지 근거를 갖고 답해야 할 때 쓴다.',
    parameters: {
      type: 'OBJECT',
      properties: { ticker: { type: 'STRING', description: '티커. 예: NVDA' } },
      required: ['ticker'],
    },
  },
  {
    name: 'searchNews',
    description:
      '최신 뉴스를 검색한다(Google 뉴스). 제목·언론사·날짜까지만 주고 본문은 없다. **뉴스성 질문은 무조건 이걸 먼저 쓴다**(횟수 제한이 없다). 종목 기사 본문이 필요하면 getStockNews를 쓴다.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: '검색어' },
        lang: { type: 'STRING', description: '"ko"(한국 뉴스) 또는 "en"(영어 뉴스). 기본 ko' },
      },
      required: ['query'],
    },
  },
  {
    name: 'searchWeb',
    description:
      '인터넷을 검색해 웹페이지의 제목·주소·본문 발췌를 가져온다. 뉴스가 아닌 것(개념 설명, 사용법, 문서, 자료 확인)에 쓴다. **월 사용 횟수가 제한돼 있으니 뉴스성 질문에는 쓰지 말고 searchNews를 쓴다.**',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: '검색어' },
        limit: { type: 'NUMBER', description: '가져올 결과 수(1~10, 기본 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'getAccountBinding',
    description:
      '지금 앱이 어느 계좌에 묶여 있는지 진단한다 — 로그인(승인) 계좌와 KIS 설정에 저장된 계좌가 같은지, 앱키·시크릿이 있는지, 거래 환경이 무엇인지. 계좌가 이상하게 물려 있다고 할 때 쓴다. 계좌번호는 일부를 가려서 돌려준다.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'getRawApiResponse',
    description:
      '한국투자증권 API의 **원본 응답 JSON**을 가공 없이 돌려준다. 사용자가 "응답 원본을 보여 달라", "무슨 값이 오는지 보자"고 할 때 쓴다. api는 balance(잔고) · unfilled(미체결) · priceDetail(시세, ticker 필요) 중 하나.',
    parameters: {
      type: 'OBJECT',
      properties: {
        api: { type: 'STRING', description: 'balance | unfilled | priceDetail' },
        ticker: { type: 'STRING', description: 'priceDetail일 때 티커' },
      },
      required: ['api'],
    },
  },
  {
    name: 'getMinuteCandles',
    description:
      '미국 종목의 분봉을 토스 차트에서 가져오고, 엔진과 똑같은 절차로 진입 판정(±3% 단타 모드면 1분봉 4선 정배열·5선 돌파, 모델 모드면 확률·기준값)까지 계산해 돌려준다. ' +
      '기본은 자동매매가 실제로 쓰는 봉 주기다. "왜 안 사?", "차트랑 앱 판정이 왜 달라?" 같은 질문에 쓴다. ' +
      '봉은 진행 중(미완성) 봉을 빼고 본다 — 엔진도 닫힌 봉만 판정하기 때문이다.',
    parameters: {
      type: 'OBJECT',
      properties: {
        ticker: { type: 'STRING', description: '티커. 예: ADXN' },
        intervalMin: { type: 'NUMBER', description: '봉 주기(분). 1·3·5·15. 기본은 엔진과 같은 주기' },
        count: { type: 'NUMBER', description: '가져올 봉 수(1~300, 기본 130). 4선을 재려면 121봉 이상 필요' },
      },
      required: ['ticker'],
    },
  },
  {
    name: 'getPeriodChart',
    description:
      '미국 종목의 일봉·주봉·월봉(최근 100건)을 조회한다. 며칠~몇 달 흐름을 볼 때 쓴다(분 단위는 getMinuteCandles).',
    parameters: {
      type: 'OBJECT',
      properties: {
        ticker: { type: 'STRING', description: '티커' },
        period: { type: 'STRING', description: 'D(일) · W(주) · M(월). 기본 D' },
      },
      required: ['ticker'],
    },
  },
  {
    name: 'getEvents',
    description:
      '자동 트레이딩이 남긴 최근 이벤트 로그를 최신순으로 돌려준다(진입 포기 사유·감시 교체·추세 시드 결과·현금 부족 등). ' +
      '"왜 안 샀어?", "왜 안 팔았어?", "아까 무슨 일 있었어?"처럼 지난 동작의 이유를 물으면 반드시 이걸 먼저 본다.',
    parameters: {
      type: 'OBJECT',
      properties: { limit: { type: 'NUMBER', description: '가져올 개수(1~50, 기본 20)' } },
    },
  },
  {
    name: 'getSettings',
    description:
      '지금 저장돼 있는 트레이딩 설정값을 돌려준다(진입금액·동시 그리드 수·최소 틱속도·손절선·리스트 원천·모의/실전 등). ' +
      '"내 설정 어떻게 돼 있어?", "왜 이 값으로 사?" 같은 질문에 쓴다. 값을 바꾸는 건 도구가 아니라 설정 화면에서 한다.',
    parameters: { type: 'OBJECT', properties: {} },
  },
] as const;

export type HelpToolName = (typeof HELP_TOOL_DECLARATIONS)[number]['name'];

const NOT_RUNNING = {
  running: false,
  note: '자동 트레이딩이 지금 돌고 있지 않아요. 홈 트레이딩 탭에서 "자동 트레이딩 시작하기"를 눌러야 감시가 시작돼요.',
};

const NEEDS_KIS = {
  error: 'KIS 계좌가 연결돼 있지 않아요. 상단바 계좌 화면에서 앱키·앱시크릿·계좌번호를 먼저 저장해 주세요.',
};

/** KIS 세션(키·계좌·토큰) — RN 전용 모듈이라 호출 시점에만 동적 import 한다. 미설정이면 null. */
async function loadKisSession() {
  const [{ loadKisSettings }, { loadAppSettings }, { getAccessToken }, { secureTokenStorage }] = await Promise.all([
    import('../../lib/kisSettings'),
    import('../../lib/appSettings'),
    import('../../kis/token'),
    import('../../lib/secureTokenStorage'),
  ]);
  const kis = await loadKisSettings();
  if (!kis) return null;
  const appSettings = await loadAppSettings();
  const credentials = { appKey: kis.appKey, appSecret: kis.appSecret };
  const account = { cano: kis.cano, acntPrdtCd: kis.acntPrdtCd };
  const token = await getAccessToken(appSettings.environment, credentials, { storage: secureTokenStorage });
  return { credentials, account, environment: appSettings.environment, accessToken: token.accessToken };
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** 계좌번호는 앞 4자리만 — 진단에는 충분하고, 외부 프록시로 전체가 나가지 않는다. */
function mask(accountNo: string | null | undefined): string | null {
  if (!accountNo) return null;
  const digits = accountNo.replace(/\D/g, '');
  if (digits.length <= 4) return `${digits}…`;
  return `${digits.slice(0, 4)}${'*'.repeat(Math.max(0, digits.length - 6))}${digits.slice(-2)}`;
}

/** 원본 JSON 상한 — 잔고가 크면 프롬프트를 통째로 먹는다. 넘치면 잘라내고 잘렸다고 알린다. */
const RAW_MAX_CHARS = 6000;

function capRaw(value: unknown): unknown {
  const text = JSON.stringify(value);
  if (text.length <= RAW_MAX_CHARS) return value;
  return {
    truncated: true,
    note: `원본이 너무 길어(${text.length}자) 앞부분만 보여요. 필요한 항목을 콕 집어 물어보면 그 값만 찾아 줄게요.`,
    raw: `${text.slice(0, RAW_MAX_CHARS)}…`,
  };
}

/**
 * 도구 실행 — 이름이 모르는 것이거나 실행이 실패해도 **throw 하지 않는다.**
 * 모델은 결과 객체를 읽고 답을 만들어야 하므로, 실패도 `{ error }` 객체로 돌려주는 편이 대화가 이어진다.
 */
export async function runHelpTool(
  name: string,
  args: Record<string, unknown>,
  deps: HelpToolDeps = {},
): Promise<unknown> {
  try {
    switch (name) {
      case 'getAutopilotStatus': {
        const snap = deps.autopilot?.() ?? null;
        if (!snap) return NOT_RUNNING;
        return {
          running: true,
          state: snap.state,
          holdings: snap.activeTickers,
          todayCycles: snap.cycles,
          todayPnlUsd: Number(snap.cumPnlUsd.toFixed(2)),
          gridLimit: snap.maxGrids,
          watchlistCount: snap.list.length,
        };
      }
      case 'getWatchlist': {
        const snap = deps.autopilot?.() ?? null;
        if (!snap) return NOT_RUNNING;
        return { count: snap.list.length, stocks: snap.list.slice(0, 30) };
      }
      case 'getHoldings': {
        const session = await loadKisSession();
        if (!session) return NEEDS_KIS;
        const { inquireOverseasBalance } = await import('../../kis/balance');
        const res = await inquireOverseasBalance(
          session.environment,
          session.credentials,
          session.accessToken,
          { account: session.account },
          { fetchImpl: deps.fetchImpl },
        );
        return {
          positions: res.output1.map((p) => ({
            ticker: p.pdno,
            name: p.prdt_name,
            qty: num(p.cblc_qty13),
            avgPrice: num(p.avg_unpr3),
            nowPrice: num(p.ovrs_now_pric1),
            pnl: num(p.evlu_pfls_amt2),
            pnlPct: num(p.evlu_pfls_rt1),
            market: p.tr_mket_name,
          })),
          summaryKrw: {
            총평가: num(res.output3?.evlu_amt_smtl),
            평가손익: num(res.output3?.evlu_pfls_amt_smtl),
            수익률: num(res.output3?.evlu_erng_rt1),
            예수금: num(res.output3?.tot_dncl_amt),
          },
        };
      }
      case 'getPendingOrders': {
        const session = await loadKisSession();
        if (!session) return NEEDS_KIS;
        const { inquireOverseasUnfilled } = await import('../../kis/nccs');
        const res = await inquireOverseasUnfilled(
          session.environment,
          session.credentials,
          session.accessToken,
          { account: session.account, ovrsExcgCd: 'NASD' },
          { fetchImpl: deps.fetchImpl },
        );
        return {
          orders: res.output.map((o) => ({
            ticker: o.pdno,
            name: o.prdt_name,
            side: o.sll_buy_dvsn_cd_name,
            orderQty: num(o.ft_ord_qty),
            filledQty: num(o.ft_ccld_qty),
            remainQty: num(o.nccs_qty),
            time: o.ord_tmd,
            market: o.tr_mket_name,
          })),
        };
      }
      case 'getTodayTrades': {
        const { default: AsyncStorage } = await import('@react-native-async-storage/async-storage');
        const trades = await readTodayTrades(AsyncStorage, { now: deps.now ?? Date.now });
        return {
          count: trades.length,
          trades: trades.slice(0, 20).map((t) => ({
            ticker: t.ticker,
            qty: t.qty,
            entryPrice: t.entryPrice,
            exitPrice: t.exitPrice,
            pnlUsd: Number(num(t.pnl).toFixed(2)),
            reason: t.exitReason,
          })),
        };
      }
      case 'getQuote': {
        const ticker = String(args.ticker ?? '').trim().toUpperCase();
        if (!ticker) return { error: '티커가 필요해요' };
        const session = await loadKisSession();
        if (!session) return NEEDS_KIS;
        const [{ inquireOverseasPriceDetail }, { toStockMarketCode }] = await Promise.all([
          import('../../kis/priceDetail'),
          import('../stock/marketCodes'),
        ]);
        // 거래소는 종목 검색으로 알아낸다 — 못 찾으면 나스닥으로 시도한다(대부분 맞고, 틀리면 조회가 빈다).
        const hits = await searchStocks(ticker, { fetchImpl: deps.fetchImpl }).catch(() => []);
        const market = hits.find((h) => h.symbol.toUpperCase() === ticker)?.market;
        const detail = await inquireOverseasPriceDetail(
          session.credentials,
          session.accessToken,
          { excd: toStockMarketCode(market) ?? 'NAS', symb: ticker },
          { fetchImpl: deps.fetchImpl },
        );
        return {
          ticker,
          price: num(detail.last),
          prevClose: num(detail.base),
          high: num(detail.high),
          low: num(detail.low),
          volume: num(detail.tvol),
          marketCap: num(detail.mcap),
          per: num(detail.perx),
          week52High: num(detail.h52p),
          week52Low: num(detail.l52p),
        };
      }
      case 'searchStock': {
        const query = String(args.query ?? '').trim();
        if (!query) return { error: '검색어가 필요해요' };
        const hits = await searchStocks(query, { fetchImpl: deps.fetchImpl });
        return { results: hits.slice(0, 8).map((h) => ({ ticker: h.symbol, name: h.name, market: h.market })) };
      }
      case 'getStockNews': {
        const ticker = String(args.ticker ?? '').trim().toUpperCase();
        if (!ticker) return { error: '티커가 필요해요' };
        const yahoo = await fetchYahooSearch(ticker, { fetchImpl: deps.fetchImpl }).catch(() => null);
        if (!yahoo || yahoo.news.length === 0) return { ticker, news: [], note: '최근 기사를 찾지 못했어요' };
        // 본문은 앞 3건만 — 프롬프트에 들어갈 양을 스스로 제한한다.
        const bodies = await fetchYahooArticles(yahoo.news, 3, { fetchImpl: deps.fetchImpl });
        return {
          ticker,
          profile: yahoo.profile ?? null,
          news: yahoo.news.slice(0, 6).map((n, i) => ({
            title: n.title,
            publisher: n.publisher,
            body: bodies[i]?.text?.slice(0, 1200) ?? null,
          })),
        };
      }
      case 'searchNews': {
        const query = String(args.query ?? '').trim();
        if (!query) return { error: '검색어가 필요해요' };
        const lang: NewsLang = args.lang === 'en' ? 'en' : 'ko';
        const hits = await searchNews(query, lang, 8, { fetchImpl: deps.fetchImpl });
        if (hits.length === 0) return { query, results: [], note: '검색 결과를 못 가져왔어요' };
        return {
          query,
          note: '제목·언론사·날짜까지만 있어요. 기사 본문은 없어요.',
          results: hits,
        };
      }
      case 'searchWeb': {
        const query = String(args.query ?? '').trim();
        if (!query) return { error: '검색어가 필요해요' };
        const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 10);
        const found = await searchWebPages(query, limit, { fetchImpl: deps.fetchImpl });
        if (found.error) return { query, results: [], error: found.error };
        if (found.results.length === 0) return { query, results: [], note: '검색 결과가 없어요' };
        return found;
      }
      case 'getAccountBinding': {
        // 계좌가 이상하게 물렸을 때의 첫 진단 — 로그인(게이트) 계좌와 KIS 설정 계좌가 다른 경우가 대표적이다.
        const [{ loadKisSettings }, { loadApprovedAccountNo }, { loadAppSettings }] = await Promise.all([
          import('../../lib/kisSettings'),
          import('../../lib/gateStorage'),
          import('../../lib/appSettings'),
        ]);
        const [kis, approved, appSettings] = await Promise.all([
          loadKisSettings(),
          loadApprovedAccountNo(),
          loadAppSettings(),
        ]);
        const kisAccountNo = kis ? `${kis.cano}-${kis.acntPrdtCd}` : null;
        const approvedDigits = (approved ?? '').replace(/\D/g, '');
        const kisDigits = kisAccountNo ? kisAccountNo.replace(/\D/g, '') : '';
        return {
          로그인계좌: mask(approved),
          KIS설정계좌: mask(kisAccountNo),
          // 숫자만 비교한다 — 게이트는 "12345678-01", 설정은 8+2로 쪼개 저장돼 표기가 다를 수 있다.
          두계좌가같은가: Boolean(approvedDigits) && approvedDigits === kisDigits,
          앱키저장됨: Boolean(kis?.appKey),
          앱시크릿저장됨: Boolean(kis?.appSecret),
          거래환경: appSettings.environment,
          note: '계좌번호는 앞 4자리만 보여요. 전체는 상단바 계좌 화면에서 볼 수 있어요.',
        };
      }
      case 'getRawApiResponse': {
        const api = String(args.api ?? '').trim();
        const session = await loadKisSession();
        if (!session) return NEEDS_KIS;
        if (api === 'balance') {
          const { inquireOverseasBalance } = await import('../../kis/balance');
          return capRaw(
            await inquireOverseasBalance(
              session.environment,
              session.credentials,
              session.accessToken,
              { account: session.account },
              { fetchImpl: deps.fetchImpl },
            ),
          );
        }
        if (api === 'unfilled') {
          const { inquireOverseasUnfilled } = await import('../../kis/nccs');
          return capRaw(
            await inquireOverseasUnfilled(
              session.environment,
              session.credentials,
              session.accessToken,
              { account: session.account, ovrsExcgCd: 'NASD' },
              { fetchImpl: deps.fetchImpl },
            ),
          );
        }
        if (api === 'priceDetail') {
          const ticker = String(args.ticker ?? '').trim().toUpperCase();
          if (!ticker) return { error: 'priceDetail은 ticker가 필요해요' };
          const [{ inquireOverseasPriceDetail }, { toStockMarketCode }] = await Promise.all([
            import('../../kis/priceDetail'),
            import('../stock/marketCodes'),
          ]);
          const hits = await searchStocks(ticker, { fetchImpl: deps.fetchImpl }).catch(() => []);
          const market = hits.find((h) => h.symbol.toUpperCase() === ticker)?.market;
          return capRaw(
            await inquireOverseasPriceDetail(
              session.credentials,
              session.accessToken,
              { excd: toStockMarketCode(market) ?? 'NAS', symb: ticker },
              { fetchImpl: deps.fetchImpl },
            ),
          );
        }
        return { error: `모르는 api예요: ${api} (balance · unfilled · priceDetail 중 하나)` };
      }
      case 'getMinuteCandles': {
        const ticker = String(args.ticker ?? '').trim().toUpperCase();
        if (!ticker) return { error: '티커가 필요해요' };
        const [
          { fetchTossMinuteCandles, fetchTossDailyCloses, resolveTossProductCode },
          model,
          { MODEL_BAR_MINUTES },
          { MARTINGALE_BAR_MINUTES, MARTINGALE_MODE },
          martingaleCore,
        ] = await Promise.all([
          import('../../lib/tossMinuteChart'),
          import('../../core/model'),
          import('../scalper/modelMode'),
          import('../scalper/martingaleMode'),
          import('../../core/martingale'),
        ]);
        const barKeyOf = (tsMs: number, m: number) => Math.floor(tsMs / (60_000 * m)) * m;
        // 엔진 봉 주기·판정 종류 — 활성 엔진 모드(설정, 2026-09-01)를 따른다. 예전 실수(커밋 56ec78e가
        // 매뉴얼·챗 화면만 ±3%로 바꾸고 이 도구는 5분봉 모델로 남아 "엔진과 같은 계산"이라 잘못 주장)의 재발 방지.
        const { getActiveEngineMode } = await import('../scalper/engineMode');
        const mgEngine = MARTINGALE_MODE && getActiveEngineMode() === 'martingale';
        const engineBarMin = mgEngine ? MARTINGALE_BAR_MINUTES : MODEL_BAR_MINUTES;
        const intervalMin = Math.max(1, Math.floor(num(args.intervalMin) || engineBarMin));
        const count = Math.max(1, Math.min(300, Math.floor(num(args.count) || 130)));
        // 거래소는 종목 검색으로 — 못 찾으면 나스닥으로 시도(getQuote와 같은 관례).
        const hits = await searchStocks(ticker, { fetchImpl: deps.fetchImpl }).catch(() => []);
        const market = hits.find((h) => h.symbol.toUpperCase() === ticker)?.market ?? 'NAS';
        const code = await resolveTossProductCode(ticker, market, { fetchImpl: deps.fetchImpl });
        if (!code) return { error: `토스에서 ${ticker}를 찾지 못했어요` };
        // 응답은 최신순 — 오름차순으로 뒤집어 4선 계산 순서(과거→최신)에 맞춘다.
        const candles = (await fetchTossMinuteCandles(code, intervalMin, count, { fetchImpl: deps.fetchImpl }))
          .slice()
          .reverse();
        if (candles.length === 0) return { ticker, intervalMin, bars: 0, note: '아직 봉이 없어요' };
        const nowBarKey = barKeyOf(deps.now ? deps.now() : Date.now(), intervalMin);
        const closed = candles.filter((c) => c.minuteKey < nowBarKey);
        const cur = candles.find((c) => c.minuteKey >= nowBarKey) ?? null;

        // 진입 판정 — 엔진과 **같은 절차·같은 코드**로 낸다. 화면·챗봇이 자기 방식으로 다시 계산해 엔진과
        // 다른 답을 말하던 사고(2026-08-22)를 되풀이하지 않기 위한 단일 통로다.
        // 봉 주기가 엔진과 다르면 다른 입력이므로 아예 판정하지 않는다 — 참고 수치도 지어내지 않는다.
        const sameBar = intervalMin === engineBarMin;
        // ±3% 단타 모드(현행) — 1분봉 4선(core/martingale.evaluateMartingaleBars). 모델은 돌지 않는다.
        const martingaleVerdict =
          sameBar && mgEngine ? martingaleCore.evaluateMartingaleBars(closed.map((c) => c.close)) : null;
        const daily = sameBar && !mgEngine
          ? await fetchTossDailyCloses(code, 5, { fetchImpl: deps.fetchImpl }).catch(() => [])
          : [];
        const verdict = sameBar && !mgEngine
          ? model.inspectModel(model.loadModel(), {
              bars: closed.map((c) => ({
                minuteKey: c.minuteKey,
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
                volume: c.volume,
              })),
              dailyCloses: daily,
              barMinutes: intervalMin,
            })
          : null;
        return {
          ticker,
          intervalMin,
          engineIntervalMin: engineBarMin,
          note: sameBar
            ? mgEngine
              ? '자동매매 엔진(±3% 단타)과 같은 봉 주기예요 — 아래 martingaleVerdict는 엔진이 내리는 것과 같은 계산(1분봉 4선 정배열·5선 돌파)이에요. 청산은 판정이 아니라 보유 평단 ±3%·19:55 ET 마감이라 여기 없어요.'
              : '자동매매 엔진과 같은 봉 주기예요 — 아래 modelVerdict는 엔진이 내리는 것과 같은 계산이에요.'
            : `엔진은 ${engineBarMin}분봉으로만 판정해요 — 다른 주기로는 판정을 돌리지 않고 봉만 보여 줘요.`,
          closedBars: closed.length,
          inProgressBar: cur
            ? { time: cur.dt, close: cur.close, volume: cur.volume, note: '아직 안 끝난 봉이라 판정에 넣지 않아요' }
            : null,
          martingaleVerdict: martingaleVerdict
            ? {
                // 진입 조건(정배열 ∧ 4선 상승 ∧ 종가>5선)이 마지막 닫힌 봉에서 성립하는가.
                condition: martingaleVerdict.condition,
                entryEvent: martingaleVerdict.entryEvent,
                aligned: martingaleVerdict.aligned,
                ordered: martingaleVerdict.ordered,
                up: martingaleVerdict.up,
                ma5: martingaleVerdict.ma5,
                bars: martingaleVerdict.bars,
                note:
                  '실제 매수는 이 조건에 더해 ①진입 시간대(04:00~19:55 ET — 주간거래 제외) ②매수 후보(틱속도 상위 N) ③그리드 빈자리 ④당일 매매 종목은 이벤트 봉만 ⑤현금을 모두 통과해야 나가요.',
              }
            : null,
          modelVerdict: verdict
            ? {
                buy: verdict.signal === 'BUY',
                probPct: verdict.prob === null ? null : Number((verdict.prob * 100).toFixed(2)),
                thresholdPct: Number((verdict.threshold * 100).toFixed(2)),
                whyNot: model.describeReject(verdict),
                dayBars: verdict.dayBars,
                cumDollarVolumeUsd: Math.round(verdict.cumDollarVolume),
                etDate: verdict.etDate,
              }
            : null,
          // 최근 12봉만 — 전부 넣으면 프롬프트를 통째로 먹는다.
          recentCandles: candles.slice(-12).map((c) => ({
            time: c.dt,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
            inProgress: c.minuteKey >= nowBarKey,
          })),
        };
      }
      case 'getPeriodChart': {
        const ticker = String(args.ticker ?? '').trim().toUpperCase();
        if (!ticker) return { error: '티커가 필요해요' };
        const session = await loadKisSession();
        if (!session) return NEEDS_KIS;
        const raw = String(args.period ?? 'D').trim().toUpperCase();
        const period = raw === 'W' || raw === 'M' ? raw : 'D';
        const [{ inquireOverseasPeriodChart }, { toStockMarketCode }] = await Promise.all([
          import('../../kis/periodChart'),
          import('../stock/marketCodes'),
        ]);
        const hits = await searchStocks(ticker, { fetchImpl: deps.fetchImpl }).catch(() => []);
        const market = hits.find((h) => h.symbol.toUpperCase() === ticker)?.market;
        const res = await inquireOverseasPeriodChart(
          session.environment,
          session.credentials,
          session.accessToken,
          { excd: toStockMarketCode(market) ?? 'NAS', symb: ticker, period },
          { fetchImpl: deps.fetchImpl },
        );
        return {
          ticker,
          period,
          count: res.candles.length,
          // 최근 30건만 — 100건 전부는 프롬프트에 과하다.
          candles: res.candles.slice(-30).map((c) => ({
            date: c.ymd,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
          })),
        };
      }
      case 'getEvents': {
        const snap = deps.autopilot?.() ?? null;
        if (!snap) return NOT_RUNNING;
        const limit = Math.max(1, Math.min(50, Math.floor(num(args.limit) || 20)));
        const events = snap.events ?? [];
        return {
          count: events.length,
          // 이미 최신순으로 온다 — 시각은 사람이 읽는 HH:MM:SS(UTC)로 줄인다.
          events: events.slice(0, limit).map((e) => ({
            time: new Date(e.at).toISOString().slice(11, 19),
            text: e.text,
          })),
        };
      }
      case 'getSettings': {
        const [{ loadAppSettings }, { loadKisSettings }] = await Promise.all([
          import('../../lib/appSettings'),
          import('../../lib/kisSettings'),
        ]);
        const app = await loadAppSettings();
        const kis = await loadKisSettings();
        // 앱키·앱시크릿은 절대 내보내지 않는다 — 연결 여부만.
        const safe = { ...(app as unknown as Record<string, unknown>) };
        delete safe.appKey;
        delete safe.appSecret;
        return { settings: capRaw(safe), kisConnected: kis !== null, account: mask(kis ? `${kis.cano}` : null) };
      }
      default:
        return { error: `모르는 도구예요: ${name}` };
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
