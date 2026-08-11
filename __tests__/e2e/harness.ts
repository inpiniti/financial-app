// 7단계 종단(E2E) 테스트 하네스 — 자동 단타(AutoPilot) 경로(수동 카드 제거 후 2026-08-08 개조).
// 가짜는 kis 경계 바로 바깥(fetch·WebSocket)에만 심는다 — 그 안쪽은 전부 실물:
//   합성 WS 프레임 → kis/realtimePrice.OverseasRealtimePriceClient(실물, createRealtimeFeed 경유)
//   → ScalperManager(피드 허브, 실물) → setAuxRoutes → AutoPilotManager/AutoPilot(실물)
//   → core/resample·detector·cycle(실물) → OrderPortAdapter(실물) → createKisBroker(실물)
//   → kis/order·orderCancel·nccs·token(실물) → 가짜 fetch(URL·TR_ID 라우팅) → JSON 응답.
// (순위 폴링만 fetchSnapshot 데이터 주입 — kis/ranking REST는 자체 단위 테스트가 검증한다.)
// 체결확인은 미체결내역(inquire-nccs, TTTS3018R) 기준 — 주문체결내역(inquire-ccnl)은 이 계좌에서
// APTR0058로 거절되어 더 이상 쓰지 않는다(createKisBroker.ts 상단 주석 참조). 가짜 fetch도 이에 맞춰
// "완전 체결·취소된 주문은 미체결 목록에서 사라진다"만 흉내내고, 체결 여부 역산은 실물 createKisBroker가 한다.
import { vi } from 'vitest';
import { kisFlowConfig } from '../../kis/flow';
import { ScalperManager } from '../../features/scalper/scalperManager';
import { AutoPilotManager } from '../../features/scalper/autopilotManager';
import { createKisBroker } from '../../features/scalper/createKisBroker';
import { createRealtimeFeed } from '../../features/scalper/createRealtimeFeed';
import { fakeClock, flush, noopScheduler, FakeStore } from '../../features/scalper/fakes';
import type { RankingSnapshot } from '../../features/scalper/watchlist';
import { getAccessToken } from '../../kis/token';
import type { WebSocketLike, StorageLike, KisAccount, KisCredentials } from '../../kis/types';
import type { OverseasExchangeCode } from '../../kis/trId';

export { flush };

// ---- 합성 WS 프레임 인코딩 (docs/koreainvestment/실시간지연체결가.md Body 표 인덱스 0~25 그대로) ----

const FIELD_ORDER = [
  'RSYM', 'SYMB', 'ZDIV', 'TYMD', 'XYMD', 'XHMS', 'KYMD', 'KHMS', 'OPEN', 'HIGH', 'LOW', 'LAST',
  'SIGN', 'DIFF', 'RATE', 'PBID', 'PASK', 'VBID', 'VASK', 'EVOL', 'TVOL', 'TAMT', 'BIVL', 'ASVL', 'STRN', 'MTYP',
] as const;

type TickFieldKey = (typeof FIELD_ORDER)[number];
export type TickFieldMap = Partial<Record<TickFieldKey, string>>;

const DEFAULT_TICK_FIELDS: Record<TickFieldKey, string> = {
  RSYM: 'DNASAAPL', SYMB: 'AAPL', ZDIV: '2', TYMD: '20260729', XYMD: '20260729', XHMS: '090000',
  KYMD: '20260729', KHMS: '220000', OPEN: '100', HIGH: '105', LOW: '95', LAST: '100',
  SIGN: '2', DIFF: '0', RATE: '0', PBID: '0', PASK: '0', VBID: '0', VASK: '0',
  EVOL: '1', TVOL: '1000', TAMT: '1000', BIVL: '0', ASVL: '0', STRN: '100', MTYP: '1',
};

/** 문서 필드 순서 그대로 ^로 이어붙인 시세 1건. */
export function encodeTickFields(overrides: TickFieldMap): string {
  const merged: Record<TickFieldKey, string> = { ...DEFAULT_TICK_FIELDS, ...overrides };
  return FIELD_ORDER.map((key) => merged[key]).join('^');
}

/** `<flag>|<TR_ID>|<데이터건수>|<필드^필드...>` envelope(realtimePrice.ts의 parseRawFrame 판단과 동일 관례). */
export function encodeFrame(tickFieldStrings: string[]): string {
  return `0|HDFSCNT0|${tickFieldStrings.length}|${tickFieldStrings.join('^')}`;
}

/** 시세 틱 1건짜리 프레임 — symb·price만 지정, 나머지는 문서 예시값 그대로(fields로 EVOL·STRN 등 오버라이드). */
export function priceFrame(symb: string, price: number, fields: TickFieldMap = {}): string {
  return encodeFrame([encodeTickFields({ SYMB: symb, LAST: String(price), ...fields })]);
}

// ---- 합성 실시간호가(HDFSASP0) 프레임 — KIS 공식 샘플(asking_price.py) columns 순서(RSYM 없음, 실측 검증 2026-07-31) ----

/** 호가 1건 프레임 — 헤더 10필드(0~9) + 1호가 6필드(10~15). symb·bid1·ask1만 지정. */
export function quoteFrame(symb: string, bid1: number, ask1: number): string {
  const fields = [
    symb, // 0 SYMB
    '2', // 1 ZDIV
    '20260729', // 2 XYMD
    '090000', // 3 XHMS
    '20260729', // 4 KYMD
    '220000', // 5 KHMS
    '5000', // 6 BVOL
    '6000', // 7 AVOL
    '10', // 8 BDVL
    '20', // 9 ADVL
    String(bid1), // 10 PBID1
    String(ask1), // 11 PASK1
    '100', // 12 VBID1
    '120', // 13 VASK1
    '1', // 14 DBID1
    '2', // 15 DASK1
  ];
  return `0|HDFSASP0|001|${fields.join('^')}`;
}

// ---- WebSocket 경계의 가짜 ----

/** real OverseasRealtimePriceClient가 그대로 사용하는 WebSocket 생성자 가짜. */
export class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  readonly sent: string[] = [];

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  /** 서버 접속 완료 시점 — 실제로는 비동기지만 테스트가 직접 통제한다. */
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.({});
  }

  /** 서버 → 클라이언트 원문 프레임 주입. */
  serverSend(raw: string): void {
    this.onmessage?.({ data: raw });
  }
}

// ---- fetch 경계의 가짜(URL·TR_ID 라우팅) ----

export interface PlacedOrder {
  trId: string;
  side: 'buy' | 'sell';
  pdno: string;
  qty: number;
  price: number;
  odno: string;
}

export interface CanceledOrder {
  trId: string;
  pdno: string;
  odno: string;
  qty: number;
}

/** 정정(RVSE_CNCL_DVSN_CD='01') 1건 — 원주문번호가 새 번호로 바뀐다. */
export interface AmendedOrder {
  trId: string;
  pdno: string;
  /** 원주문번호(ORGN_ODNO). */
  from: string;
  /** 정정으로 새로 채번된 주문번호. */
  to: string;
  qty: number;
  price: number;
}

function jsonResponse(body: unknown): Response {
  return { json: async () => body } as unknown as Response;
}

/** 주문/취소/체결내역/토큰 REST를 URL·TR_ID로 라우팅해 KIS 응답 JSON을 흉내내는 가짜 fetch. */
export class FakeKisApi {
  readonly placed: PlacedOrder[] = [];
  readonly canceled: CanceledOrder[] = [];
  readonly amended: AmendedOrder[] = [];
  tokenCalls = 0;
  nccsCalls = 0;
  private seq = 0;
  private readonly fills = new Map<string, { qty: number; price: number }>();
  /** 정정으로 대체된(더 이상 살아있지 않은) 원주문번호 — 실물처럼 미체결 목록에서 사라진다. */
  private readonly superseded = new Set<string>();

  isCanceled(odno: string): boolean {
    return this.canceled.some((c) => c.odno === odno);
  }

  /** 정정으로 대체됐는가 — 취소도 체결도 아니지만 미체결 목록에서는 빠진다(가짜 체결 오판의 원천). */
  isSuperseded(odno: string): boolean {
    return this.superseded.has(odno);
  }

  /** 지금 살아있는(정정 체인의 최신) 매도 주문. 리프라이스 e2e에서 체결시킬 대상. */
  liveOrder(side: 'buy' | 'sell'): PlacedOrder | undefined {
    return [...this.placed]
      .reverse()
      .find((p) => p.side === side && !this.isFilled(p.odno) && !this.isCanceled(p.odno) && !this.isSuperseded(p.odno));
  }

  isFilled(odno: string): boolean {
    return this.fills.has(odno);
  }

  /** odno의 체결 상태를 세팅 — 미호출이면 영구 미체결(미체결 타임아웃 시나리오용). */
  setFilled(odno: string, qty: number, price: number): void {
    this.fills.set(odno, { qty, price });
  }

  fetch = async (
    input: unknown,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<Response> => {
    const url = String(input);
    const headers = init?.headers ?? {};
    const trId = headers['tr_id'] ?? '';

    if (url.endsWith('/oauth2/tokenP')) {
      this.tokenCalls += 1;
      return jsonResponse({ access_token: 'e2e-token', token_type: 'Bearer', expires_in: 86_400 });
    }

    if (url.includes('/uapi/overseas-stock/v1/trading/order-rvsecncl')) {
      const body = JSON.parse(init?.body ?? '{}') as Record<string, string>;
      const orgnOdno = body.ORGN_ODNO;
      // ⚠ 정정(01)과 취소(02)를 반드시 분기한다 — 정정을 취소처럼 다루면 "정정 후 옛 ODNO가 미체결
      //   목록에서 사라져 전량체결로 오판되는" 함정이 재현되지 않아 테스트가 무의미해진다.
      if (body.RVSE_CNCL_DVSN_CD === '01') {
        const prev = this.placed.find((p) => p.odno === orgnOdno);
        const next = `E2E-ODNO-${++this.seq}`;
        this.amended.push({
          trId,
          pdno: body.PDNO,
          from: orgnOdno,
          to: next,
          qty: Number(body.ORD_QTY),
          price: Number(body.OVRS_ORD_UNPR),
        });
        // 실물 의미: 원주문은 사라지고 새 주문번호로 다시 접수된다.
        this.superseded.add(orgnOdno);
        this.placed.push({
          trId,
          side: prev?.side ?? 'sell',
          pdno: body.PDNO,
          qty: Number(body.ORD_QTY),
          price: Number(body.OVRS_ORD_UNPR),
          odno: next,
        });
        return jsonResponse({
          rt_cd: '0', msg_cd: '0000', msg1: '정정 주문 완료',
          output: { KRX_FWDG_ORD_ORGNO: '0', ODNO: next, ORD_TMD: '090500' },
        });
      }
      this.canceled.push({ trId, pdno: body.PDNO, odno: orgnOdno, qty: Number(body.ORD_QTY) });
      return jsonResponse({
        rt_cd: '0', msg_cd: '0000', msg1: '정정취소 주문 완료',
        output: { KRX_FWDG_ORD_ORGNO: '0', ODNO: orgnOdno, ORD_TMD: '090500' },
      });
    }

    if (url.includes('/uapi/overseas-stock/v1/trading/order') && init?.method === 'POST') {
      const body = JSON.parse(init?.body ?? '{}') as Record<string, string>;
      const odno = `E2E-ODNO-${++this.seq}`;
      const side: 'buy' | 'sell' = body.SLL_TYPE === '00' ? 'sell' : 'buy';
      this.placed.push({
        trId,
        side,
        pdno: body.PDNO,
        qty: Number(body.ORD_QTY),
        price: Number(body.OVRS_ORD_UNPR),
        odno,
      });
      return jsonResponse({
        rt_cd: '0', msg_cd: '0000', msg1: '주문 접수 완료',
        output: { KRX_FWDG_ORD_ORGNO: '0', ODNO: odno, ORD_TMD: '090000' },
      });
    }

    if (url.includes('/uapi/overseas-stock/v1/trading/inquire-nccs')) {
      this.nccsCalls += 1;
      // 미체결내역은 "아직 미체결인" 주문만 돌려준다 — 전량체결됐거나 취소된 주문은 목록에서 빠진다
      // (실물 TTTS3018R 의미 그대로). createKisBroker가 이 부재를 "전량체결"로 역산한다.
      const output = this.placed
        .filter((p) => !this.isFilled(p.odno) && !this.isCanceled(p.odno) && !this.isSuperseded(p.odno))
        .map((p) => ({
          ord_dt: '20260729', ord_gno_brno: '00000', odno: p.odno, orgn_odno: '',
          pdno: p.pdno, prdt_name: p.pdno,
          sll_buy_dvsn_cd: p.side === 'buy' ? '02' : '01', sll_buy_dvsn_cd_name: '',
          rvse_cncl_dvsn_cd: '00', rvse_cncl_dvsn_cd_name: '',
          rjct_rson: '', rjct_rson_name: '', ord_tmd: '090000',
          tr_mket_name: '', tr_crcy_cd: 'USD', natn_cd: '840', natn_kor_name: '미국',
          ft_ord_qty: String(p.qty), ft_ccld_qty: '0', nccs_qty: String(p.qty),
          ft_ord_unpr3: String(p.price), ft_ccld_unpr3: '0', ft_ccld_amt3: '0',
          ovrs_excg_cd: 'NASD', prcs_stat_name: '미체결',
          loan_type_cd: '', loan_dt: '', usa_amk_exts_rqst_yn: '', splt_buy_attr_name: '',
        }));
      return jsonResponse({ rt_cd: '0', msg_cd: '0000', msg1: '', output, ctx_area_fk200: '', ctx_area_nk200: '' });
    }

    throw new Error(`FakeKisApi: 처리하지 않은 URL — ${url}`);
  };
}

// ---- 하네스 조립 ----

const CREDENTIALS: KisCredentials = { appKey: 'e2e-app-key', appSecret: 'e2e-app-secret' };
const ACCOUNT: KisAccount = { cano: '12345678', acntPrdtCd: '01' };

/** 순위 스냅샷(12종) — AAPL을 선두에 두고 나머지는 틱이 없는 더미 티커로 채운다. */
export function snapshotOf(tickers: string[]): RankingSnapshot {
  return { tossVolume: tickers.map((t) => ({ symb: t, rate: '1' })) };
}

export const TWELVE = ['AAPL', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];

export interface MakeHarnessOptions {
  chunkSeconds?: number;
  bufferSize?: number;
  /** true면 tick()이 매 라운드 끝에 미체결 주문을 즉시 전량 체결 처리한다(미체결 시나리오에서는 false). */
  autoFillOrders?: boolean;
  /** 종목당 진입금액(USD) — qty = ⌊금액÷가격⌋. */
  startAmountUsd?: number;
}

export interface Harness {
  /** 피드 허브 — WS 핸들러 유일 소유, setAuxRoutes로 오토파일럿에 분배. */
  manager: ScalperManager;
  /** 자동관리 매니저(실물) — start()가 WS 연결·순위 폴링·슬롯 구독까지 수행한다. */
  autopilot: AutoPilotManager;
  clock: ReturnType<typeof fakeClock>;
  api: FakeKisApi;
  store: FakeStore;
  autoFillOrders: boolean;
  /** 공유 RealtimeFeed(WS 단일 연결) — start 없이 WS만 연결하는 시나리오에서 직접 사용. */
  realtime: ReturnType<typeof createRealtimeFeed>;
  /** 단일 WS 연결의 최신 가짜 소켓. */
  socket(): FakeWebSocket;
  scheduler: ReturnType<typeof noopScheduler>;
}

/**
 * kis 경계(fetch·WebSocket) 바로 바깥에만 가짜를 심은 종단 하네스를 만든다.
 * ScalperManager(허브) → AutoPilotManager/AutoPilot → OrderPortAdapter → createKisBroker/createRealtimeFeed
 * → kis/*(실물) 전부 통과한다. 순위 폴링만 스냅샷 데이터를 직접 주입한다.
 */
export function makeHarness(opts: MakeHarnessOptions = {}): Harness {
  FakeWebSocket.instances.length = 0;
  const clock = fakeClock(0);
  const api = new FakeKisApi();
  vi.stubGlobal('fetch', api.fetch);
  // 유량 제어(kis/flow) 대기를 끈다 — 대기는 실제 setTimeout이라 이 하네스의 가짜 시계와 어긋나
  // 발주가 단정 시점 뒤로 밀린다. 가짜 fetch는 즉답이므로 유량 방어가 필요 없다.
  kisFlowConfig.minIntervalMs = 0;

  const store = new FakeStore();
  const scheduler = noopScheduler();
  const tokenCache = new Map<string, string>();
  const tokenStorage: StorageLike = {
    get: (key) => tokenCache.get(key) ?? null,
    set: (key, value) => {
      tokenCache.set(key, value);
    },
  };
  const getToken = () =>
    getAccessToken('live', CREDENTIALS, { storage: tokenStorage, clock }).then((t) => t.accessToken);

  const realtime = createRealtimeFeed({ approvalKey: 'e2e-approval-key', clock }, { WebSocketImpl: FakeWebSocket });

  const manager = new ScalperManager({ realtime, clock });

  const autopilot = new AutoPilotManager({
    realtime,
    storage: store,
    clock,
    scheduler,
    makeBroker: (ticker: string, exchange?: OverseasExchangeCode) =>
      createKisBroker({
        environment: 'live',
        credentials: CREDENTIALS,
        account: ACCOUNT,
        pdno: ticker,
        ovrsExcgCd: exchange ?? 'NASD',
        getToken,
        clock,
      }),
    fetchSnapshot: async () => snapshotOf(TWELVE),
    chunkSeconds: opts.chunkSeconds ?? 1,
    bufferSize: opts.bufferSize ?? 7,
    // 짧은 역V 시퀀스로 "전환 즉시 매도"를 검증하므로 매도 문턱 0(끔)을 명시해 의미를 보존한다.
    minSellMomentum: 0,
  });
  // WS 단일 연결 공유 — 허브의 라우터가 오토파일럿 슬롯으로 흘려보낸다(managerProvider와 동일 배선).
  manager.setAuxRoutes(autopilot.routeTick, autopilot.routeQuote);
  manager.setFeedUseProbe((trKey, trId) => autopilot.usesTrKey(trKey, trId));

  // 속도 필터가 사실상 안 걸리는 문턱(단위 테스트 CONFIG_100과 동일 취지).
  autopilot.pilot.setConfig({
    startAmountUsd: opts.startAmountUsd ?? 100,
    minTickRate: 0.01,
  });

  return {
    manager,
    autopilot,
    clock,
    api,
    store,
    autoFillOrders: opts.autoFillOrders ?? false,
    realtime,
    socket: () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1],
    scheduler,
  };
}

/** autopilot.start() + 순위 로드 대기 + WS 접속 완료 시뮬레이션(register frame들이 재전송되도록). */
export async function startAndOpen(h: Harness): Promise<void> {
  h.autopilot.start();
  await vi.waitFor(() => {
    if (h.autopilot.watchlist.size !== TWELVE.length) throw new Error('watchlist not loaded');
  });
  await flush();
  h.socket().open();
  await flush();
}

function autoFillPending(api: FakeKisApi): void {
  for (const p of api.placed) {
    // 정정으로 대체된 옛 주문은 이미 죽었으므로 체결시키지 않는다(실물과 동일).
    if (!api.isFilled(p.odno) && !api.isCanceled(p.odno) && !api.isSuperseded(p.odno)) {
      api.setFilled(p.odno, p.qty, p.price);
    }
  }
}

/**
 * 틱 1개를 합성 WS 프레임으로 흘리고(clock 전진 포함) 재선정·체결 폴 사이클을 1회 구동한다.
 * 재선정은 실제로는 30초 타이머 몫 — 틱이 흘러야 자격(최소 속도)이 생기므로 매 틱 뒤 호출한다.
 */
export async function tick(
  h: Harness,
  ticker: string,
  price: number,
  stepMs = 1000,
  fields: TickFieldMap = {},
): Promise<void> {
  h.clock.advance(stepMs);
  h.socket().serverSend(priceFrame(ticker, price, fields));
  await flush();
  if (h.autoFillOrders) autoFillPending(h.api);
  h.autopilot.pilot.reselect();
  await h.autopilot.pilot.pollCycle();
  await flush();
}

/** 가격 배열을 순서대로 흘린다 + 마지막 청크를 닫기 위한 캡 틱(직전 값 반복) 1회 추가. */
export async function tickSeries(
  h: Harness,
  ticker: string,
  prices: number[],
  stepMs = 1000,
): Promise<void> {
  for (const p of prices) await tick(h, ticker, p, stepMs);
  await tick(h, ticker, prices[prices.length - 1], stepMs);
}

/** 새 시세 틱 없이 시계만 전진시키고 폴 사이클을 구동한다. */
export async function advanceAndPoll(h: Harness, ms: number): Promise<void> {
  h.clock.advance(ms);
  await flush();
  await h.autopilot.pilot.pollCycle();
  await flush();
}

// ---- 검증된 신호 시퀀스(core/detector, core/integration 테스트에서 증명된 배열 재사용) ----

/** V자(하락 후 상승) — BUY 변곡점이 정확히 1회. */
export const V_SHAPE = [20, 16, 12, 8, 4, 2, 4, 8, 12, 16, 20];
/** 하락-상승-하락 — BUY 1회 후 SELL 1회. */
export const DOWN_UP_DOWN = [20, 16, 12, 8, 4, 2, 4, 8, 12, 16, 20, 18, 14, 10, 6, 2];
/** 역V자(상승 후 하락) — SELL 변곡점이 정확히 1회. */
export const INV_V_SHAPE = [1, 3, 5, 7, 9, 10, 9, 7, 5, 3, 1];
