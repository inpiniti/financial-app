// [해외주식] 실시간시세 — 해외주식 실시간지연체결가 [실시간-007] (HDFSCNT0).
// docs/koreainvestment/실시간지연체결가.md 그대로.
// kis-openapi 철칙 4: "실시간(WebSocket) 응답의 필드 순서 = 파싱 스펙." 문서 인덱스 열을 그대로 코드에 옮긴다.
//
// 판단(문서에 명시되지 않은 부분 — 애매해서 판단): 문서는 Body(^ 구분 문자열)의 "필드 순서"만 규정하고,
// 그 문자열을 감싸는 소켓 프레임(암/복호화 플래그·tr_id·데이터건수 등 파이프(|) 구분 envelope)은 규정하지 않는다.
// KIS 공식 파이썬 샘플(README 참고 링크)에 따르면 국내/해외 공통으로
//   "<암복호화구분>|<TR_ID>|<데이터건수>|<^로 이어진 필드...>"
// 형태이며, PINGPONG은 JSON({"header":{"tr_id":"PINGPONG",...}})으로 오고 동일 메시지를 그대로 되돌려줘야
// 세션이 유지된다. 이 판단은 9단계 실계좌 리허설에서 RAW_FIELD_DEBUG로 재검증해야 한다(PRD §7-1).

import { WS_QUOTE_DOMAIN } from './domain';
import type { ClockLike, WebSocketCtor, WebSocketLike } from './types';

export const REALTIME_PRICE_TR_ID = 'HDFSCNT0';
/** 해외주식 실시간호가 [실시간-021] — 미국 실시간 무료 10호가. docs/koreainvestment/실시간호가.md. */
export const REALTIME_QUOTE_TR_ID = 'HDFSASP0';

/** 문서 Body 표의 인덱스(0~25) 그대로 — 순서를 바꾸면 안 된다. */
const FIELD_ORDER = [
  'RSYM',
  'SYMB',
  'ZDIV',
  'TYMD',
  'XYMD',
  'XHMS',
  'KYMD',
  'KHMS',
  'OPEN',
  'HIGH',
  'LOW',
  'LAST',
  'SIGN',
  'DIFF',
  'RATE',
  'PBID',
  'PASK',
  'VBID',
  'VASK',
  'EVOL',
  'TVOL',
  'TAMT',
  'BIVL',
  'ASVL',
  'STRN',
  'MTYP',
] as const;

export const REALTIME_PRICE_FIELD_COUNT = FIELD_ORDER.length; // 26

export interface OverseasRealtimeTick {
  RSYM: string;
  SYMB: string;
  ZDIV: string;
  TYMD: string;
  XYMD: string;
  XHMS: string;
  KYMD: string;
  KHMS: string;
  OPEN: string;
  HIGH: string;
  LOW: string;
  LAST: string;
  SIGN: string;
  DIFF: string;
  RATE: string;
  PBID: string;
  PASK: string;
  VBID: string;
  VASK: string;
  EVOL: string;
  TVOL: string;
  TAMT: string;
  BIVL: string;
  ASVL: string;
  STRN: string;
  MTYP: string;
}

/** 문서 순서(FIELD_ORDER) 그대로의 fields 배열 → 틱 객체. 필드 개수가 다르면 명시적으로 throw한다. */
export function parseOverseasRealtimeTick(fields: string[]): OverseasRealtimeTick {
  if (fields.length !== REALTIME_PRICE_FIELD_COUNT) {
    throw new Error(
      `[kis/realtimePrice] 필드 개수가 문서 스펙(${REALTIME_PRICE_FIELD_COUNT})과 다릅니다: ${fields.length}개 수신. ` +
        '실시간지연체결가.md 필드 순서를 다시 확인하세요.',
    );
  }
  const tick = {} as OverseasRealtimeTick;
  FIELD_ORDER.forEach((key, i) => {
    tick[key] = fields[i];
  });
  return tick;
}

/**
 * tr_key 조립 — 문서 표: D+시장구분(3자리)+종목코드 (무료시세, 미국 야간거래/아시아 주간거래는 R 접두).
 * v1 범위는 무료시세(D 접두) 고정.
 */
export type RealtimeMarketCode = 'NYS' | 'NAS' | 'AMS' | 'TSE' | 'HKS' | 'SHS' | 'SZS' | 'HSX' | 'HNX';

export function buildFreeQuoteTrKey(market: RealtimeMarketCode, symbol: string): string {
  return `D${market}${symbol}`;
}

/**
 * 실시간호가(HDFSASP0) tr_key 조립 — **D 접두**(체결가와 동일한 키 문자열, tr_id로만 구분).
 * 문서 표는 "R거래소명종목코드"라고 적혀 있으나 실계좌 실측(2026-07-31)에서 R 키는
 * "SUBSCRIBE ERROR : mci send failed"로 거절됐고, KIS 공식 샘플
 * (examples_llm/overseas_stock/asking_price/asking_price.py)의 예시가 asking_price("1", "DNASAAPL")로
 * D 접두를 사용한다 — 공식 샘플을 정본으로 삼는다. (R은 유료·주간거래 계열로 추정.)
 */
export function buildQuoteTrKey(market: RealtimeMarketCode, symbol: string): string {
  return `D${market}${symbol}`;
}

/**
 * 주간거래(미국, 10:00~16:00 KST) 전용 시장구분 — docs/koreainvestment/실시간지연체결가.txt/실시간호가.txt
 * 원문: "미국 주간거래 실시간 조회 시 R+시장구분(3자리)+종목코드, 예) RBAQAAPL". D(무료시세) 옵션 자체가
 * 없다 — 유료시세 신청 여부와 무관하게 주간거래는 R 고정(KIS 공식 GitHub 예제 asking_price("1","RBAQAAPL")
 * 도 동일). RealtimeMarketCode(D 전용 빌더가 쓰는 시장구분)와 값 공간이 겹치지 않게 별도 타입으로 분리해,
 * 실수로 buildQuoteTrKey(D 접두)에 BAY/BAQ/BAA를 넣어 구독이 조용히 실패하는 걸 원천 차단한다.
 */
export type DaytimeMarketCode = 'BAY' | 'BAQ' | 'BAA';

/** R+시장구분(3자리)+종목코드 조립 — 주간거래 체결가·호가 구독 공용(둘 다 같은 tr_key, tr_id로만 구분). */
export function buildDaytimeQuoteTrKey(market: DaytimeMarketCode, symbol: string): string {
  return `R${market}${symbol}`;
}

/**
 * 실시간호가(HDFSASP0) 필드 인덱스 — **KIS 공식 샘플(asking_price.py)의 columns 순서를 정본**으로 한다:
 *   symb, zdiv, xymd, xhms, kymd, khms, bvol, avol, bdvl, advl, pbid1, pask1, vbid1, vask1, dbid1, dask1 (16개)
 * ⚠ 포탈 문서 표는 맨 앞에 RSYM이 있고 3호가 그룹 중복 표기까지 있어 실데이터와 다르다(실시간호가.md 특이사항).
 *   과거 RSYM 포함 인덱스(PBID1=11)로는 PBID1 자리에서 advl(잔량대비)을 읽는 오파싱이 났다.
 * | 0 SYMB | 1 ZDIV | 2 XYMD | 3 XHMS | 4 KYMD | 5 KHMS |
 * | 6 BVOL | 7 AVOL | 8 BDVL | 9 ADVL |
 * | 10 PBID1 | 11 PASK1 | 12 VBID1 | 13 VASK1 | 14 DBID1 | 15 DASK1 |
 */
const QUOTE_INDEX = {
  SYMB: 0,
  PBID1: 10,
  PASK1: 11,
  VBID1: 12,
  VASK1: 13,
} as const;

/** 1호가(VASK1, 인덱스 13)까지 담기려면 최소 14개 필드가 필요하다. */
export const REALTIME_QUOTE_MIN_FIELD_COUNT = 14;

/** 우리가 소비하는 최소 호가 — 1호가 매수/매도 가격과 잔량. */
export interface OverseasRealtimeQuote {
  SYMB: string;
  PBID1: string;
  PASK1: string;
  VBID1: string;
  VASK1: string;
}

/**
 * RSYM 형태("D"/"R" + 시장구분 3자리 + 종목코드, 예: DNASAAPL)인지 판별한다.
 * 공식 샘플 columns에는 RSYM이 없지만 포탈 문서 표에는 맨 앞에 RSYM이 있다 — 두 스펙이 충돌하므로
 * 실데이터가 어느 쪽이든 파싱되도록 첫 필드를 보고 오프셋을 자동 결정한다(실계좌 실측 2026-07-31:
 * D키 구독 성공인데 수신 0건 — RSYM 포함 레이아웃에서 SYMB 자리에 RSYM을 읽어 라우팅이 전량 탈락한 정황).
 */
function looksLikeRsym(field: string): boolean {
  return /^[DR](NYS|NAS|AMS|TSE|HKS|SHS|SZS|HSX|HNX|BAQ|BAY|BAA).+/.test(field);
}

/**
 * ^ 구분 호가 필드 배열 → 1호가 객체. 필드가 1호가까지 담기지 않을 만큼 적으면 throw한다.
 * 첫 필드가 RSYM이면(포탈 문서 레이아웃) 전체 인덱스를 +1 시프트해 읽는다 — 공식 샘플 레이아웃(RSYM 없음)과
 * 둘 다 지원(관용 파서). 전체 필드 개수는 원문 중복 표기로 불확정이므로 총개수는 검사하지 않는다.
 */
export function parseOverseasRealtimeQuote(fields: string[]): OverseasRealtimeQuote {
  const offset = fields.length > 0 && looksLikeRsym(fields[0]) ? 1 : 0;
  if (fields.length < REALTIME_QUOTE_MIN_FIELD_COUNT + offset) {
    throw new Error(
      `[kis/realtimePrice] 호가 필드 개수가 1호가 최소치(${REALTIME_QUOTE_MIN_FIELD_COUNT + offset})보다 적습니다: ${fields.length}개 수신. ` +
        '실시간호가.md 필드 순서를 다시 확인하세요.',
    );
  }
  return {
    SYMB: fields[QUOTE_INDEX.SYMB + offset],
    PBID1: fields[QUOTE_INDEX.PBID1 + offset],
    PASK1: fields[QUOTE_INDEX.PASK1 + offset],
    VBID1: fields[QUOTE_INDEX.VBID1 + offset],
    VASK1: fields[QUOTE_INDEX.VASK1 + offset],
  };
}

/** 소켓 원문 한 프레임에서 TR_ID와 (26개씩 끊은) 필드 그룹들을 뽑아낸다. PINGPONG 등 비데이터 프레임은 null. */
export function parseRawFrame(raw: string): { trId: string; fieldGroups: string[][] } | null {
  // envelope: <flag>|<trId>|<count>|<body>
  const firstSep = raw.indexOf('|');
  if (firstSep < 0) return null;
  const parts = raw.split('|');
  if (parts.length < 4) return null;
  const trId = parts[1];
  const body = parts.slice(3).join('|');
  const rawFields = body.split('^');
  const fieldGroups: string[][] = [];
  for (let i = 0; i + REALTIME_PRICE_FIELD_COUNT <= rawFields.length; i += REALTIME_PRICE_FIELD_COUNT) {
    fieldGroups.push(rawFields.slice(i, i + REALTIME_PRICE_FIELD_COUNT));
  }
  return { trId, fieldGroups };
}

/**
 * 실시간호가(HDFSASP0) 프레임에서 TR_ID와 호가 레코드 그룹들을 뽑는다.
 * 체결가(고정 26필드)와 달리 호가는 원문 중복 표기로 레코드당 필드 수가 불확정이므로,
 * envelope의 데이터 건수(<count>)로 나눠 레코드를 자른다. 건수를 못 읽으면 전체를 1건으로 본다.
 */
export function parseRawQuoteFrame(raw: string): { trId: string; quoteGroups: string[][] } | null {
  if (raw.indexOf('|') < 0) return null;
  const parts = raw.split('|');
  if (parts.length < 4) return null;
  const trId = parts[1];
  const count = Number(parts[2]);
  const rawFields = parts.slice(3).join('|').split('^');
  const records = Number.isInteger(count) && count > 0 ? count : 1;
  const groupSize = Math.floor(rawFields.length / records);
  // 레코드당 필드 수가 1호가 최소치도 안 되면(비정상 건수) 전체를 1건으로 처리한다.
  if (groupSize < REALTIME_QUOTE_MIN_FIELD_COUNT) {
    return { trId, quoteGroups: [rawFields] };
  }
  const quoteGroups: string[][] = [];
  for (let i = 0; i + groupSize <= rawFields.length; i += groupSize) {
    quoteGroups.push(rawFields.slice(i, i + groupSize));
  }
  return { trId, quoteGroups };
}

function isPingPongFrame(raw: string): boolean {
  if (!raw.startsWith('{')) return false;
  try {
    const parsed = JSON.parse(raw) as { header?: { tr_id?: string } };
    return parsed.header?.tr_id === 'PINGPONG';
  } catch {
    return false;
  }
}

/**
 * 구독 등록/해제 응답(ACK) 등 데이터가 아닌 JSON 제어 프레임.
 * KIS는 등록 성공/실패를 이 형태로 보낸다 — rt_cd '0'이 성공, 그 외는 실패(판단은 상위/UI에서).
 */
export interface RealtimeControlMessage {
  trId: string;
  trKey?: string;
  rtCd?: string;
  msgCd?: string;
  msg1?: string;
}

export interface RealtimeReconnectOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
}

export interface RealtimePriceClientConfig {
  approvalKey: string;
  custtype?: 'P' | 'B';
  /** 원본 필드 배열 노출 모드 — 9단계 실계좌 리허설 필드맵 대조용. */
  rawFieldDebug?: boolean;
  onTick(tick: OverseasRealtimeTick, trKey: string): void;
  /** 실시간호가(HDFSASP0) 1호가 수신 — (quote, symb). 구독하지 않으면 호가 프레임은 무시된다. */
  onQuote?(quote: OverseasRealtimeQuote, symb: string): void;
  onRawFields?(fields: string[], trKey: string): void;
  /** PINGPONG 이외의 JSON 프레임(구독 등록/해제 ACK 등) — 성공/실패 판단은 호출부에서. */
  onControl?(msg: RealtimeControlMessage): void;
  onError?(err: unknown): void;
  onStatusChange?(status: 'connecting' | 'open' | 'closed' | 'reconnecting'): void;
  reconnect?: RealtimeReconnectOptions;
}

export interface RealtimePriceClientDeps {
  WebSocketImpl?: WebSocketCtor;
  clock?: ClockLike;
  /** setTimeout 주입 — 재연결 백오프 테스트용. 기본값 globalThis.setTimeout. */
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
}

const DEFAULT_RECONNECT: Required<RealtimeReconnectOptions> = {
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  maxAttempts: Infinity,
};

/**
 * 해외주식 실시간지연체결가 WS 클라이언트.
 * 단일 연결에 복수 티커를 등록/해제할 수 있고, 끊기면 지수 백오프로 재연결하며 기존 구독을 복원한다.
 */
export class OverseasRealtimePriceClient {
  private readonly config: RealtimePriceClientConfig;
  private readonly WebSocketImpl: WebSocketCtor;
  private readonly setTimeoutImpl: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutImpl: (handle: unknown) => void;
  private readonly reconnectOpts: Required<RealtimeReconnectOptions>;

  private socket: WebSocketLike | null = null;
  /** trKey → tr_id. 하나의 소켓에 체결가(HDFSCNT0)·호가(HDFSASP0) 구독을 함께 담아 재연결 시 모두 복원한다. */
  private readonly subscriptions = new Map<string, { trKey: string; trId: string }>();
  private reconnectAttempt = 0;
  private reconnectTimer: unknown = null;
  private manuallyClosed = false;

  constructor(config: RealtimePriceClientConfig, deps: RealtimePriceClientDeps = {}) {
    this.config = config;
    this.WebSocketImpl = deps.WebSocketImpl ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket!;
    this.setTimeoutImpl = deps.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutImpl = deps.clearTimeoutImpl ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.reconnectOpts = { ...DEFAULT_RECONNECT, ...config.reconnect };
  }

  connect(): void {
    this.manuallyClosed = false;
    // 이미 살아있는(연결 중/열림) 소켓이 있으면 그대로 둔다 — KIS는 앱키당 WS 1세션만 허용하므로
    // 중복 openSocket은 "ALREADY IN USE appkey" 거절과 세션 뺏기 재연결 폭풍을 일으킨다
    // (실기기 실측: 카드 2개 Run 시 connect()가 두 번 불려 소켓이 2개 생기던 버그).
    if (this.socket && (this.socket.readyState === 0 /* CONNECTING */ || this.socket.readyState === 1 /* OPEN */)) {
      return;
    }
    // 재연결 타이머가 예약돼 있으면 그 타이머에 맡긴다 — 즉시 openSocket까지 겹치면 역시 2세션이 된다.
    if (this.reconnectTimer !== null) return;
    this.openSocket();
  }

  /** 사용자가 명시적으로 닫음 — 이후 자동 재연결하지 않는다. */
  close(): void {
    this.manuallyClosed = true;
    if (this.reconnectTimer !== null) {
      this.clearTimeoutImpl(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  /**
   * 구독 등록. trId는 기본 HDFSCNT0(체결가) — 하위호환. 호가는 REALTIME_QUOTE_TR_ID를 넘긴다.
   * 예) subscribe(buildFreeQuoteTrKey('NAS','AAPL')) / subscribe(buildQuoteTrKey('NAS','AAPL'), REALTIME_QUOTE_TR_ID)
   *
   * ⚠ 체결가(HDFSCNT0)와 호가(HDFSASP0)는 **같은 tr_key 문자열**(예: DNASAAPL)을 쓰고 tr_id로만 구분된다
   * (공식 샘플 검증). 따라서 내부 저장은 반드시 (trId, trKey) 복합 키 — trKey 단독 키면 한쪽이 덮어써져
   * 재연결 복원·해제가 반대쪽 구독을 죽인다.
   */
  subscribe(trKey: string, trId: string = REALTIME_PRICE_TR_ID): void {
    this.subscriptions.set(`${trId}|${trKey}`, { trKey, trId });
    this.sendRegisterFrame(trKey, trId, '1');
  }

  unsubscribe(trKey: string, trId: string = REALTIME_PRICE_TR_ID): void {
    this.subscriptions.delete(`${trId}|${trKey}`);
    this.sendRegisterFrame(trKey, trId, '2');
  }

  get subscribedKeys(): ReadonlySet<string> {
    return new Set([...this.subscriptions.values()].map((s) => s.trKey));
  }

  private sendRegisterFrame(trKey: string, trId: string, trType: '1' | '2'): void {
    if (!this.socket || this.socket.readyState !== 1 /* OPEN */) return;
    const frame = {
      header: {
        approval_key: this.config.approvalKey,
        custtype: this.config.custtype ?? 'P',
        tr_type: trType,
        'content-type': 'utf-8',
      },
      body: {
        input: {
          tr_id: trId,
          tr_key: trKey,
        },
      },
    };
    this.socket.send(JSON.stringify(frame));
  }

  private openSocket(): void {
    this.config.onStatusChange?.(this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting');
    const socket = new this.WebSocketImpl(WS_QUOTE_DOMAIN);
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return; // 교체된 낡은 소켓의 늦은 이벤트 무시
      this.reconnectAttempt = 0;
      this.config.onStatusChange?.('open');
      // 재연결 시 기존 구독을 전부(체결가·호가) 복원한다.
      for (const { trKey, trId } of this.subscriptions.values()) {
        this.sendRegisterFrame(trKey, trId, '1');
      }
    };

    socket.onmessage = (ev: { data: unknown }) => {
      try {
        this.handleMessage(String(ev.data));
      } catch (err) {
        this.config.onError?.(err);
      }
    };

    socket.onerror = (err: unknown) => {
      this.config.onError?.(err);
    };

    socket.onclose = () => {
      if (this.socket !== socket) return; // 이미 새 소켓으로 교체됐다면 낡은 소켓의 종료는 무시
      this.config.onStatusChange?.('closed');
      this.socket = null;
      if (!this.manuallyClosed) {
        this.scheduleReconnect();
      }
    };
  }

  private handleMessage(raw: string): void {
    if (isPingPongFrame(raw)) {
      // 세션 유지 — 수신한 PINGPONG 메시지를 그대로 되돌려준다.
      this.socket?.send(raw);
      return;
    }
    // PINGPONG 이외의 JSON 프레임 — 구독 등록/해제 ACK 등 제어 응답(데이터 프레임은 '|' envelope).
    if (raw.startsWith('{')) {
      this.handleControlFrame(raw);
      return;
    }
    // 데이터 프레임 — envelope의 TR_ID로 체결가/호가를 라우팅한다.
    const trId = raw.split('|')[1];
    if (trId === REALTIME_QUOTE_TR_ID) {
      const frame = parseRawQuoteFrame(raw);
      if (!frame) return;
      for (const fields of frame.quoteGroups) {
        if (this.config.rawFieldDebug) {
          this.config.onRawFields?.(fields, fields[QUOTE_INDEX.SYMB] ?? '');
        }
        const quote = parseOverseasRealtimeQuote(fields);
        this.config.onQuote?.(quote, quote.SYMB);
      }
      return;
    }

    const frame = parseRawFrame(raw);
    if (!frame || frame.trId !== REALTIME_PRICE_TR_ID) return;

    for (const fields of frame.fieldGroups) {
      if (this.config.rawFieldDebug) {
        this.config.onRawFields?.(fields, fields[1] ?? '');
      }
      const tick = parseOverseasRealtimeTick(fields);
      this.config.onTick(tick, tick.SYMB);
    }
  }

  private handleControlFrame(raw: string): void {
    try {
      const parsed = JSON.parse(raw) as {
        header?: { tr_id?: string; tr_key?: string };
        body?: { rt_cd?: string; msg_cd?: string; msg1?: string };
      };
      const trId = parsed.header?.tr_id;
      if (!trId) {
        throw new Error('[kis/realtimePrice] 제어 프레임에 header.tr_id가 없습니다: ' + raw);
      }
      this.config.onControl?.({
        trId,
        trKey: parsed.header?.tr_key,
        rtCd: parsed.body?.rt_cd,
        msgCd: parsed.body?.msg_cd,
        msg1: parsed.body?.msg1,
      });
    } catch (err) {
      this.config.onError?.(err);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempt >= this.reconnectOpts.maxAttempts) return;
    this.reconnectAttempt += 1;
    const delay = Math.min(
      this.reconnectOpts.baseDelayMs * 2 ** (this.reconnectAttempt - 1),
      this.reconnectOpts.maxDelayMs,
    );
    this.reconnectTimer = this.setTimeoutImpl(() => {
      this.reconnectTimer = null;
      if (!this.manuallyClosed) this.openSocket();
    }, delay);
  }
}
