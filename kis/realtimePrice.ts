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
 * 주간거래(미국, 10:00~16:00 KST) 전용 시장구분 — docs/koreainvestment/실시간지연체결가.txt
 * 원문: "미국 주간거래 실시간 조회 시 R+시장구분(3자리)+종목코드, 예) RBAQAAPL". D(무료시세) 옵션 자체가
 * 없다 — 유료시세 신청 여부와 무관하게 주간거래는 R 고정(KIS 공식 GitHub 예제도 동일).
 * RealtimeMarketCode(D 전용 빌더가 쓰는 시장구분)와 값 공간이 겹치지 않게 별도 타입으로 분리해,
 * 실수로 buildFreeQuoteTrKey(D 접두)에 BAY/BAQ/BAA를 넣어 구독이 조용히 실패하는 걸 원천 차단한다.
 */
export type DaytimeMarketCode = 'BAY' | 'BAQ' | 'BAA';

/** R+시장구분(3자리)+종목코드 조립 — 주간거래 체결가 구독용. */
export function buildDaytimeQuoteTrKey(market: DaytimeMarketCode, symbol: string): string {
  return `R${market}${symbol}`;
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
  onRawFields?(fields: string[], trKey: string): void;
  /** PINGPONG 이외의 JSON 프레임(구독 등록/해제 ACK 등) — 성공/실패 판단은 호출부에서. */
  onControl?(msg: RealtimeControlMessage): void;
  onError?(err: unknown): void;
  onStatusChange?(status: 'connecting' | 'open' | 'closed' | 'reconnecting'): void;
  reconnect?: RealtimeReconnectOptions;
  /**
   * 첫 연결이 열리자마자 **해제(tr_type '2') 프레임을 보낼 옛 구독** — 직전 실행이 강제 종료돼(해제 프레임 없이
   * 끊김) 서버에 남은 등록을 쓸어내는 용도. 2026-08-28 실사고: 앱을 여러 번 껐다 켠 뒤 새 연결에서 3건만 성공하고
   * 18건이 "MAX SUBSCRIBE OVER" — KIS가 등록 수(41)를 세션이 아니라 계정 단위로 세고 죽은 세션 등록이 남는 정황.
   * 구독 집합(subscriptions)에는 넣지 않는다 — 재연결 복원 대상이 아니다. 한 번 보내고 버린다.
   */
  staleSubscriptions?: readonly { trKey: string; trId: string }[];
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
  /** (trId|trKey) → 구독 — 재연결 시 모두 복원한다. */
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
    this.staleToSweep = [...(config.staleSubscriptions ?? [])];
  }

  /** 첫 열림에 해제 프레임으로 쓸어낼 옛 구독(생성자에서 복사, 보낸 뒤 비운다). */
  private staleToSweep: { trKey: string; trId: string }[];

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
   * 구독 등록. trId는 기본 HDFSCNT0(체결가) — 현재 쓰는 TR은 체결가뿐이다
   * (실시간호가 HDFSASP0 구독은 2026-08-14 제거 — 1호가는 체결가 페이로드의 PBID/PASK로 받는다).
   * 예) subscribe(buildFreeQuoteTrKey('NAS','AAPL'))
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
      // 직전 실행의 잔재 구독을 먼저 쓸어낸다(첫 열림 한 번만) — 아래 복원보다 앞서야 같은 키를 해제→등록 순서로 보낸다.
      if (this.staleToSweep.length > 0) {
        for (const { trKey, trId } of this.staleToSweep) this.sendRegisterFrame(trKey, trId, '2');
        this.staleToSweep = [];
      }
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
    // 데이터 프레임 — 체결가(HDFSCNT0)만 소비한다(다른 TR은 무시).
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
