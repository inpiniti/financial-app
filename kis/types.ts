// kis/ 공통 타입 — RN(Expo)에서도 core/처럼 테스트 가능하도록 fetch·WebSocket·저장소·시계를 전부 주입받는다.
// kis-openapi 스킬 철칙: 문서(docs/koreainvestment/*.md)가 유일한 스펙.

/** 실전/모의 — 도메인과 TR ID가 모두 다르다 (README.md 참고). */
export type KisEnvironment = 'live' | 'paper';

/** 시계 주입 — 토큰 만료 판정을 테스트에서 결정론적으로 만들기 위함. */
export interface ClockLike {
  now(): number; // epoch ms
}

/** 토큰 캐시 저장소 주입 — RN에서는 expo-secure-store 래퍼(lib/)가 이 인터페이스를 구현한다. */
export interface StorageLike {
  get(key: string): string | null | Promise<string | null>;
  set(key: string, value: string): void | Promise<void>;
  /** 선택 — 없으면 빈 문자열 저장으로 대체한다(readCache가 빈 값을 캐시 없음으로 본다). */
  delete?(key: string): void | Promise<void>;
}

export type FetchLike = typeof fetch;
export type WebSocketCtor = new (url: string) => WebSocketLike;

/** RN/브라우저 WebSocket과 호환되는 최소 인터페이스 (주입/테스트용). */
export interface WebSocketLike {
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
  readyState: number;
}

export interface KisCredentials {
  appKey: string;
  appSecret: string;
}

/** 계좌번호 체계(8-2) — 앞 8자리(cano) + 뒤 2자리(acntPrdtCd). */
export interface KisAccount {
  cano: string;
  acntPrdtCd: string;
}

export interface KisClientDeps {
  fetchImpl?: FetchLike;
  WebSocketImpl?: WebSocketCtor;
  storage?: StorageLike;
  clock?: ClockLike;
}

/** rt_cd가 '0'이 아닌 응답(주문/계좌 계열 REST) 공통 에러. msg_cd/msg1을 그대로 포함한다. */
export class KisApiError extends Error {
  readonly rtCd: string;
  readonly msgCd: string;
  readonly msg1: string;

  constructor(rtCd: string, msgCd: string, msg1: string) {
    super(`KIS API 오류 [rt_cd=${rtCd} msg_cd=${msgCd}] ${msg1}`);
    this.name = 'KisApiError';
    this.rtCd = rtCd;
    this.msgCd = msgCd;
    this.msg1 = msg1;
  }
}

export const defaultClock: ClockLike = { now: () => Date.now() };
