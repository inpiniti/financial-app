// KIS REST 전역 유량 제어 — "초당 거래건수 초과"(EGW00201) 방어 계층.
//
// KIS 게이트웨이는 앱키당 초당 REST 호출 수를 제한하고, 넘치면 rt_cd=1·msg_cd=EGW00201로
// **요청 자체를 거부**한다(주문도 접수되지 않음 — 재전송해도 중복 실행 위험이 없다).
// 기존에는 kis/ 어디에도 유량 제어가 없어 그리드 리브래킷 1회에 REST 4~6건(미체결조회→
// 취소→잔고 3연타→매도·매수 발주)이 무지연 연속 발사됐고, EGW00201이 다른 치명 오류와
// 똑같이 즉시 FAULT로 승격돼 자동매매 전체가 동결됐다(실사고 — 추가 매수 시점 빈발).
//
// 두 겹으로 막는다:
//  ① 전 KIS REST 호출이 공유하는 최소 간격(KIS_MIN_INTERVAL_MS) — 버스트 평탄화.
//     슬롯 예약은 동기(원자적), 대기만 비동기 — 느린 응답이 다음 호출을 막지 않는다.
//  ② 그래도 EGW00201이 오면 점증 백오프 후 재시도(최대 KIS_FLOW_RETRY_LIMIT회).
//     백오프는 전역 슬롯도 함께 미룬다 — 동시에 몰린 다른 호출까지 같이 물러난다.
//
// kis/ 각 REST 모듈의 기본 fetch(deps.fetchImpl ?? kisFlowFetch)로 끼워진다.
// 테스트가 fetchImpl을 직접 주입하면 이 계층을 건너뛴다(기존 테스트 불변).
// OAuth(token/wsApproval)는 제외 — 캐시로 호출이 드물고 응답 형태(rt_cd 없음)도 다르다.
import { isTokenExpiredMsgCd } from './token';
import type { FetchLike, KisCredentials, KisEnvironment } from './types';

/** 호출 간 최소 간격(ms) — 초당 최대 4건. KIS 공식 한도가 미문서화라 보수적으로 잡는다. */
export const KIS_MIN_INTERVAL_MS = 250;
/** EGW00201 재시도 횟수 — 이걸 다 소진하면 응답을 그대로 돌려준다(호출부 assertRtCdOk가 던짐). */
export const KIS_FLOW_RETRY_LIMIT = 3;
/** 재시도 백오프 기본(ms) — 시도마다 1배·2배·3배로 점증한다. */
export const KIS_FLOW_BACKOFF_MS = 700;
export const KIS_RATE_LIMIT_MSG_CD = 'EGW00201';

export interface KisFlowConfig {
  minIntervalMs: number;
  retryLimit: number;
  backoffMs: number;
}

/**
 * 전역 인스턴스(kisFlowFetch)가 매 호출마다 읽는 라이브 설정.
 * e2e 하네스처럼 가짜 fetch·가짜 시계를 쓰는 환경은 minIntervalMs=0으로 대기를 끈다
 * (유량 대기는 실제 setTimeout이라 가짜 시계와 어긋난다).
 */
export const kisFlowConfig: KisFlowConfig = {
  minIntervalMs: KIS_MIN_INTERVAL_MS,
  retryLimit: KIS_FLOW_RETRY_LIMIT,
  backoffMs: KIS_FLOW_BACKOFF_MS,
};

interface FlowFetchDeps {
  fetchImpl?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  config?: KisFlowConfig;
  refreshToken?: KisTokenRefresher;
}

// ---- 토큰 만료(EGW00123) 자동 복구 ----
//
// KIS는 앱키당 유효 토큰을 1개만 유지해서, 다른 기기·스모크 스크립트가 발급하면 앱이 들고 있던 토큰이
// 서버에서 조용히 폐기된다. 앱은 만료시각을 로컬에서 계산해 캐시하므로(kis/token.ts) 그 사실을 모른 채
// 죽은 토큰을 최대 24시간 계속 쓴다 — 화면마다 "기간이 만료된 token 입니다"만 뜨는 실증상(2026-08-11).
// 화면들이 accessToken 문자열을 state에 들고 있어 캐시만 비워선 복구되지 않으므로, 모든 REST가 지나는
// 이 계층에서 헤더의 토큰을 갈아끼우고 같은 요청을 1회 재전송한다.
// 재발급 자체는 앱 계층이 주입한다 — kis/는 저장소(expo-secure-store)를 알면 안 되기 때문.

export interface KisTokenRefreshRequest {
  environment: KisEnvironment;
  credentials: KisCredentials;
  /** 방금 거절당한 토큰 — 다른 요청이 이미 갱신했는지 판별해 중복 발급을 막는 데 쓴다. */
  expiredToken: string;
}

/** 새 accessToken을 돌려준다. 복구 불가면 null(원래 오류를 그대로 호출부에 보낸다). */
export type KisTokenRefresher = (req: KisTokenRefreshRequest) => Promise<string | null>;

let tokenRefresher: KisTokenRefresher | null = null;

/** 앱 시작 시 1회 등록(lib/kisTokenRefresher.ts). null로 해제 — 테스트 격리용. */
export function setKisTokenRefresher(refresher: KisTokenRefresher | null): void {
  tokenRefresher = refresher;
}

function isTokenExpired(body: unknown): boolean {
  return typeof body === 'object' && body !== null && isTokenExpiredMsgCd((body as { msg_cd?: unknown }).msg_cd);
}

/** init.headers를 평범한 소문자 키 객체로 편다 (kis/는 Record로 넘기지만 Headers·배열도 받아둔다). */
function toHeaderRecord(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const entries: Iterable<[string, string]> =
    typeof (headers as Headers).forEach === 'function' && !Array.isArray(headers)
      ? (() => {
          const acc: [string, string][] = [];
          (headers as Headers).forEach((v, k) => acc.push([k, v]));
          return acc;
        })()
      : Array.isArray(headers)
        ? (headers as [string, string][])
        : Object.entries(headers as Record<string, string>);
  for (const [k, v] of entries) out[k.toLowerCase()] = v;
  return out;
}

/** 재발급에 필요한 재료(현재 토큰·앱키·환경)를 요청 자체에서 되짚는다. */
function readTokenContext(
  input: unknown,
  headers: Record<string, string>,
): { token: string; credentials: KisCredentials; environment: KisEnvironment } | null {
  const bearer = headers.authorization ?? '';
  const token = bearer.startsWith('Bearer ') ? bearer.slice('Bearer '.length) : '';
  const appKey = headers.appkey;
  const appSecret = headers.appsecret;
  if (!token || !appKey || !appSecret) return null;
  const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input);
  return {
    token,
    credentials: { appKey, appSecret },
    environment: url.includes('openapivts') ? 'paper' : 'live',
  };
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isRateLimited(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { msg_cd?: unknown }).msg_cd === KIS_RATE_LIMIT_MSG_CD
  );
}

/** 유량 제어 fetch 팩토리 — 테스트에서 now/sleep을 주입해 결정론적으로 검증한다. */
export function createFlowFetch(deps: FlowFetchDeps = {}): FetchLike {
  const base: FetchLike = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? defaultSleep;
  const config = deps.config ?? kisFlowConfig;
  /** 다음 호출이 나갈 수 있는 가장 이른 시각(전역 공유 슬롯). */
  let nextSlotAt = 0;

  const acquireSlot = async (): Promise<void> => {
    // 예약(아래 두 줄)은 동기라 동시 진입해도 슬롯이 겹치지 않는다 — 대기만 비동기.
    const at = Math.max(now(), nextSlotAt);
    nextSlotAt = at + config.minIntervalMs;
    const wait = at - now();
    if (wait > 0) await sleep(wait);
  };

  /** 만료 응답을 받은 요청의 init을 새 토큰 헤더로 바꿔 돌려준다 — 복구 불가면 null. */
  const refreshExpiredToken = async (
    input: unknown,
    init: RequestInit | undefined,
  ): Promise<RequestInit | null> => {
    const refresher = deps.refreshToken ?? tokenRefresher;
    if (!refresher) return null;
    const headers = toHeaderRecord(init?.headers);
    const ctx = readTokenContext(input, headers);
    if (!ctx) return null;
    let fresh: string | null = null;
    try {
      fresh = await refresher({
        environment: ctx.environment,
        credentials: ctx.credentials,
        expiredToken: ctx.token,
      });
    } catch {
      // 재발급 실패(네트워크·1분 1회 제한 등) — 원래 만료 오류를 호출부에 그대로 보낸다.
      return null;
    }
    if (!fresh || fresh === ctx.token) return null;
    return { ...init, headers: { ...headers, authorization: `Bearer ${fresh}` } };
  };

  return async (input, init) => {
    // 토큰 재발급 재시도는 유량 재시도와 별개로 딱 1회 — 무한 재발급 루프를 막는다.
    let currentInit = init;
    let tokenRetried = false;

    for (let attempt = 0; ; attempt++) {
      await acquireSlot();
      const res = await base(input, currentInit);
      let body: unknown;
      try {
        body = await res.json();
      } catch (err) {
        // JSON이 아닌 응답 — 유량 판정 불가. 호출부가 같은 실패를 보도록 json만 재생한다.
        return replay(res, () => Promise.reject(err));
      }
      if (isTokenExpired(body) && !tokenRetried) {
        tokenRetried = true;
        const refreshed = await refreshExpiredToken(input, currentInit);
        if (refreshed) {
          currentInit = refreshed;
          attempt = -1; // 유량 재시도 예산은 새 토큰 요청에 온전히 남겨 둔다.
          continue;
        }
      }
      if (!isRateLimited(body) || attempt >= config.retryLimit) {
        return replay(res, () => Promise.resolve(body));
      }
      // 유량 초과 — 전역 슬롯을 함께 미뤄 다른 호출도 물러나게 한 뒤 재시도한다.
      nextSlotAt = Math.max(nextSlotAt, now() + config.backoffMs * (attempt + 1));
    }
  };
}

/**
 * 본문을 이미 읽은 Response의 대역 — 호출부는 json()·ok·status·headers만 쓴다(kis/ 전수 확인).
 * headers를 빠뜨리면 연속조회(응답 헤더 tr_cont 판독 — periodProfit)가 항상 첫 페이지에서 끝나는
 * 실사고(2026-08-08, 월 손익 일부 누락)가 재발한다.
 */
function replay(res: Response, json: () => Promise<unknown>): Response {
  return { ok: res.ok, status: res.status, statusText: res.statusText, headers: res.headers, json } as Response;
}

/** 앱 전역 공유 인스턴스 — kis/ REST 모듈들의 기본 fetch. */
export const kisFlowFetch: FetchLike = createFlowFetch();
