// 7단계 종단(E2E) 테스트 하네스.
// 가짜는 kis 경계 바로 바깥(fetch·WebSocket)에만 심는다 — 그 안쪽은 전부 실물:
//   합성 WS 프레임 → kis/realtimePrice.OverseasRealtimePriceClient(실물, createRealtimeFeed 경유)
//   → ScalperManager/ScalperInstance(실물) → core/resample·detector·cycle(실물)
//   → OrderPortAdapter(실물) → createKisBroker(실물) → kis/order·orderCancel·nccs·token(실물)
//   → 가짜 fetch(URL·TR_ID 라우팅) → JSON 응답.
// 체결확인은 미체결내역(inquire-nccs, TTTS3018R) 기준 — 주문체결내역(inquire-ccnl)은 이 계좌에서
// APTR0058로 거절되어 더 이상 쓰지 않는다(createKisBroker.ts 상단 주석 참조). 가짜 fetch도 이에 맞춰
// "완전 체결·취소된 주문은 미체결 목록에서 사라진다"만 흉내내고, 체결 여부 역산은 실물 createKisBroker가 한다.
import { vi } from 'vitest';
import { ScalperManager, type ScalperManagerDeps } from '../../features/scalper/scalperManager';
import { createKisBroker } from '../../features/scalper/createKisBroker';
import { createRealtimeFeed } from '../../features/scalper/createRealtimeFeed';
import { fakeClock, flush, noopScheduler, FakeStore } from '../../features/scalper/fakes';
import { getAccessToken } from '../../kis/token';
import type { WebSocketLike, StorageLike, KisAccount, KisCredentials } from '../../kis/types';
import type { OverseasExchangeCode } from '../../kis/trId';
import type { ScalperInstanceConfig } from '../../features/scalper/types';

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

export interface MakeHarnessOptions {
  chunkSeconds?: number;
  bufferSize?: number;
  fillTimeoutMs?: number;
  /** true면 tick()이 매 라운드 끝에 미체결 주문을 즉시 전량 체결 처리한다(미체결 시나리오에서는 false). */
  autoFillOrders?: boolean;
  /** BUY 거래량 스파이크 게이트(배수, 0=끔) — 게이트 e2e 시나리오용. */
  minVolumeSpikeRatio?: number;
  /** BUY 체결강도 게이트(STRN, 0=끔) — 게이트 e2e 시나리오용. */
  minStrength?: number;
  /** 매수 모멘텀 문턱 — 게이트 e2e에서 "게이트만 켠 구성"을 만들 때 0을 명시한다. */
  minBuyMomentum?: number;
}

export interface Harness {
  manager: ScalperManager;
  clock: ReturnType<typeof fakeClock>;
  api: FakeKisApi;
  store: FakeStore;
  autoFillOrders: boolean;
  /** 매니저가 공유하는 RealtimeFeed(WS 단일 연결) — Run 없이 WS만 연결하는 시나리오(③)에서 직접 사용. */
  realtime: ReturnType<typeof createRealtimeFeed>;
  /** 매니저가 만든 단일 WS 연결의 최신 가짜 소켓. */
  socket(): FakeWebSocket;
  /**
   * 인스턴스들이 등록한 타이머 콜백 모음.
   * 등록 순서는 인스턴스마다 [폴, 리프라이스] 쌍이라 **홀수 인덱스가 리프라이스**다(advanceAndReprice가 이용).
   */
  scheduler: ReturnType<typeof noopScheduler>;
}

/**
 * kis 경계(fetch·WebSocket) 바로 바깥에만 가짜를 심은 종단 하네스를 만든다.
 * ScalperManager → ScalperInstance → OrderPortAdapter → createKisBroker/createRealtimeFeed → kis/*(실물) 전부 통과한다.
 */
export function makeHarness(opts: MakeHarnessOptions = {}): Harness {
  FakeWebSocket.instances.length = 0;
  const clock = fakeClock(0);
  const api = new FakeKisApi();
  vi.stubGlobal('fetch', api.fetch);

  const store = new FakeStore();
  // 인스턴스들이 공유하는 스케줄러 — 등록 순서가 [폴, 리프라이스] 쌍이라 홀수 인덱스가 리프라이스다.
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

  const deps: ScalperManagerDeps = {
    realtime,
    storage: store,
    clock,
    scheduler,
    chunkSeconds: opts.chunkSeconds ?? 1,
    bufferSize: opts.bufferSize ?? 7,
    fillTimeoutMs: opts.fillTimeoutMs ?? 5000,
    throttleMs: 0,
    // 이 e2e 하네스는 종단 체인(WS→판정→사이클→기록)을 검증한다 — 매도 확인 단계 이전의 "전환 즉시 매도"를
    // 가정하는 짧은 역V 시퀀스를 쓰므로 매도 문턱 0(끔)을 명시해 의미를 보존한다.
    minSellMomentum: 0,
    minBuyMomentum: opts.minBuyMomentum,
    minVolumeSpikeRatio: opts.minVolumeSpikeRatio,
    minStrength: opts.minStrength,
    makeBroker: (config: ScalperInstanceConfig) =>
      createKisBroker({
        environment: 'live',
        credentials: CREDENTIALS,
        account: ACCOUNT,
        pdno: config.ticker,
        ovrsExcgCd: (config.exchange ?? 'NASD') as OverseasExchangeCode,
        getToken,
        clock,
      }),
  };

  const manager = new ScalperManager(deps);

  return {
    manager,
    clock,
    api,
    store,
    autoFillOrders: opts.autoFillOrders ?? false,
    realtime,
    socket: () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1],
    scheduler,
  };
}

/** manager.startAll() + WS 접속 완료 시뮬레이션(register frame들이 재전송되도록). */
export function startAndOpen(h: Harness): void {
  h.manager.startAll();
  h.socket().open();
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
 * 리프라이스 타이머를 1회 발화시킨다(clock 전진 포함).
 * noopScheduler는 등록 순서대로 콜백을 모으고 인스턴스마다 [폴, 리프라이스] 쌍이라 홀수 인덱스가 리프라이스다.
 */
export async function advanceAndReprice(h: Harness, ms = 1000): Promise<void> {
  h.clock.advance(ms);
  await flush();
  for (let i = 1; i < h.scheduler.fired.length; i += 2) h.scheduler.fired[i]();
  await flush();
}

/** 틱 1개를 합성 WS 프레임으로 흘리고(clock 전진 포함), 전 인스턴스의 체결 폴 사이클을 1회 구동한다. */
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
  for (const inst of h.manager.getInstances()) await inst.pollCycle();
  await flush();
}

/** 가격 배열을 순서대로 흘린다 + 마지막 청크를 닫기 위한 캡 틱(직전 값 반복) 1회 추가. fieldsAt(i)로 틱별 필드(EVOL 등) 오버라이드. */
export async function tickSeries(
  h: Harness,
  ticker: string,
  prices: number[],
  stepMs = 1000,
  fieldsAt?: (i: number) => TickFieldMap,
): Promise<void> {
  for (let i = 0; i < prices.length; i++) await tick(h, ticker, prices[i], stepMs, fieldsAt?.(i) ?? {});
  await tick(h, ticker, prices[prices.length - 1], stepMs, fieldsAt?.(prices.length) ?? {});
}

/**
 * 매 틱마다 최신 호가(bid1/ask1)를 체결가 직전에 흘린다 — 발주 시점에 호가가 항상 신선하도록.
 * 호가를 먼저(시계 전진 후) 보내고, 그 다음 체결가로 신호를 유발하므로 buy는 같은 시각의 ask1을 쓴다.
 */
export async function tickSeriesWithQuote(
  h: Harness,
  ticker: string,
  prices: number[],
  bid1: number,
  ask1: number,
  stepMs = 1000,
): Promise<void> {
  const step = async (p: number) => {
    h.clock.advance(stepMs);
    h.socket().serverSend(quoteFrame(ticker, bid1, ask1));
    h.socket().serverSend(priceFrame(ticker, p));
    await flush();
    if (h.autoFillOrders) autoFillPending(h.api);
    for (const inst of h.manager.getInstances()) await inst.pollCycle();
    await flush();
  };
  for (const p of prices) await step(p);
  await step(prices[prices.length - 1]);
}

/** 새 시세 틱 없이 시계만 전진시키고(미체결 타임아웃 유도) 폴 사이클을 구동한다. */
export async function advanceAndPoll(h: Harness, ms: number): Promise<void> {
  h.clock.advance(ms);
  await flush();
  for (const inst of h.manager.getInstances()) await inst.pollCycle();
  await flush();
}

// ---- 검증된 신호 시퀀스(core/detector, core/integration 테스트에서 증명된 배열 재사용) ----

/** V자(하락 후 상승) — BUY 변곡점이 정확히 1회. */
export const V_SHAPE = [20, 16, 12, 8, 4, 2, 4, 8, 12, 16, 20];
/** 하락-상승-하락 — BUY 1회 후 SELL 1회. */
export const DOWN_UP_DOWN = [20, 16, 12, 8, 4, 2, 4, 8, 12, 16, 20, 18, 14, 10, 6, 2];
/** 역V자(상승 후 하락) — SELL 변곡점이 정확히 1회. */
export const INV_V_SHAPE = [1, 3, 5, 7, 9, 10, 9, 7, 5, 3, 1];
