// 토스 증권 커뮤니티(종목 게시판) 조회 전용 클라이언트 — 비공식 API, 로그인 불필요(오케스트레이터 실호출 확인).
// 티커→productCode 검색은 결과 캐시(AsyncStorage) — 같은 티커를 시트 열 때마다 재검색하지 않는다.
// 쓰기(댓글 작성·좋아요) 기능은 다루지 않는다 — 조회 전용.
import AsyncStorage from '@react-native-async-storage/async-storage';

type FetchLike = typeof fetch;

/** AsyncStorage 최소 계약 — 테스트는 Map 기반 심을 주입(lib/index.ts KeyValueStore와 동일 모양). */
export interface TossKeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface TossCommunityDeps {
  fetchImpl?: FetchLike;
  storage?: TossKeyValueStore;
}

const SEARCH_URL = 'https://wts-info-api.tossinvest.com/api/v2/search-all/wts-auto-complete';
const COMMENTS_URL = 'https://wts-cert-api.tossinvest.com/api/v4/comments';

function productCodeCacheKey(ticker: string): string {
  return `toss.productCode.${ticker}`;
}

// ── 1. 티커 → productCode 검색 ──────────────────────────────────────────
export interface TossSearchItem {
  symbol: string;
  productCode: string;
  productName: string;
  logoImageUrl?: string;
  market?: string;
}

interface TossSearchResponse {
  result: Array<{ data: { items: TossSearchItem[] } }>;
}

/**
 * 티커 → 토스 productCode 조회. items에서 symbol이 티커와 정확히 일치하는 항목만 채택한다
 * (첫 항목을 무조건 쓰면 AAPL 검색에 APLY 같은 유사 종목이 섞여 오답이 날 수 있다).
 * 성공 시 AsyncStorage에 영구 캐시하고, 다음 호출부터는 네트워크를 타지 않는다.
 * 정확히 일치하는 항목이 없으면 null(호출부가 "게시판을 찾지 못했어요" 상태를 보여준다).
 */
export async function resolveTossProductCode(ticker: string, deps: TossCommunityDeps = {}): Promise<string | null> {
  const storage = deps.storage ?? AsyncStorage;
  const normalized = ticker.trim().toUpperCase();
  if (!normalized) return null;

  const cacheKey = productCodeCacheKey(normalized);
  const cached = await storage.getItem(cacheKey);
  if (cached) return cached;

  const fetchImpl = deps.fetchImpl ?? fetch;
  const res = await fetchImpl(SEARCH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query: normalized, sections: [{ type: 'PRODUCT' }] }),
  });
  const body = (await res.json()) as TossSearchResponse;
  const items = body.result?.[0]?.data?.items ?? [];
  const matched = items.find((item) => item.symbol?.toUpperCase() === normalized);
  if (!matched) return null;

  await storage.setItem(cacheKey, matched.productCode);
  return matched.productCode;
}

// ── 2. 종목 댓글 조회 ────────────────────────────────────────────────────
export type TossCommentSort = 'RECENT' | 'POPULAR';

export interface TossCommentBadge {
  title: string;
  color: string;
}

export interface TossCommentAuthor {
  nickname: string;
  profilePictureUrl?: string;
  badge?: TossCommentBadge | null;
}

export interface TossCommentMessage {
  title?: string;
  message: string;
}

export interface TossCommentStatistic {
  likeCount: number;
  replyCount: number;
}

export interface TossComment {
  /** 실호출 응답에서는 숫자로 내려온다(문자열로 오는 경우도 있어 둘 다 받는다). */
  commentId: string | number;
  author: TossCommentAuthor;
  message: TossCommentMessage;
  statistic: TossCommentStatistic;
  createdAt: string;
}

export interface TossCommentsPage {
  results: TossComment[];
  hasNext: boolean;
  /** 다음 페이지 커서 = 이 페이지 마지막 댓글의 commentId. 다음 호출에 `lastCommentId`로 넣는다. */
  key: string | number | null;
}

interface TossCommentsResponse {
  result: {
    results: TossComment[];
    hasNext: boolean;
    key: string | number | null;
  };
}

/**
 * 종목 댓글 1페이지 조회(페이지당 11건). key를 넘기면 그 커서 이후 페이지를 이어 받는다(무한 스크롤용).
 *
 * 커서 쿼리 파라미터는 반드시 `lastCommentId`다 — 응답 필드명이 `key`라고 해서 `key=`로 보내면
 * 서버가 조용히 무시하고 매번 1페이지를 돌려준다(같은 댓글이 무한 반복되는 증상). RECENT/POPULAR 둘 다 동일.
 */
export async function fetchTossComments(
  productCode: string,
  sort: TossCommentSort,
  key?: string | number | null,
  deps: TossCommunityDeps = {},
): Promise<TossCommentsPage> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const params = new URLSearchParams({
    subjectId: productCode,
    subjectType: 'STOCK',
    commentSortType: sort,
  });
  if (key !== undefined && key !== null && key !== '') params.set('lastCommentId', String(key));

  const res = await fetchImpl(`${COMMENTS_URL}?${params.toString()}`, {
    method: 'GET',
    headers: { accept: 'application/json' },
  });
  const body = (await res.json()) as TossCommentsResponse;
  return {
    results: body.result?.results ?? [],
    hasNext: body.result?.hasNext ?? false,
    key: body.result?.key ?? null,
  };
}
