// 토스증권 미국 거래량 실시간 순위 — 비공식 API(페이로드 원문: docs/toss/순위.txt).
// 로그인·쿠키 없이 최소 헤더로만 호출한다(curl 실호출 확인 — tossSearch.ts·tossCommunity.ts와 같은 관례).
//
// 순위 응답에는 **티커가 없다**(productCode·한글명뿐). 그래서 2단계로 조회한다:
//   ① /dashboard/wts/overview/ranking  → 순위·productCode·가격·거래량
//   ② /stock-infos?codes=a,b,c         → productCode → symbol·거래소·종목구분(group)
// ②는 100건을 한 콜에 받는다(codes 콤마 구분) — 순위 1회당 총 2콜.
//
// ETF 제외(사용자 요청: 아직 ETF를 거래하지 않음)는 ②의 group 코드로 판정한다.
//   ST(주권)·DR(주식예탁증권)만 통과, EF(ETF)·EN(ETN)·EW(ELW)는 제외.
//   ⚠ 트레이딩뷰 스크리너(lib/tradingviewLogos.ts)로 거르는 안도 검토했지만, 그 필터는 is_primary라
//     원 상장이 해외인 ADR(샤오펑 XPEV·SK하이닉스 SKHY 등)을 통째로 떨어뜨린다. 토스 group은 같은
//     응답에서 정확히 ETF/ETN만 걸러내므로 이쪽을 쓴다.
import { TOSS_MARKET_TO_APP, type TossAppMarket } from './tossSearch';

type FetchLike = typeof fetch;

export interface TossRankingDeps {
  fetchImpl?: FetchLike;
}

export const TOSS_RANKING_URL = 'https://wts-cert-api.tossinvest.com/api/v2/dashboard/wts/overview/ranking';
export const TOSS_STOCK_INFO_URL = 'https://wts-info-api.tossinvest.com/api/v2/stock-infos';

/**
 * 순위 요청 본문 — 미국 거래량 실시간 순위.
 * ⚠ filters는 **빈 배열**이다(2026-08-11 사용자 확정). docs/토스/순위.txt에 적힌
 *   MARKET_CAP_GREATER_THAN_50M·STOCKS_PRICE_GREATER_THAN_ONE_DOLLAR를 넣으면 시총 5천만달러·
 *   주가 $1 미만이 잘려 앱에서 보이는 순위와 다른 목록이 온다. 필터를 넣지 않는 쪽이 화면과 같다.
 */
export const TOSS_VOLUME_RANKING_BODY = {
  id: 'biggest_market_volume',
  filters: [] as string[],
  duration: 'realtime',
  tag: 'us',
} as const;

/** 거래 가능한 종목구분 — 주권·주식예탁증권(ADR)만. ETF(EF)·ETN(EN)·ELW(EW)는 뺀다. */
export const TOSS_TRADABLE_GROUPS = ['ST', 'DR'] as const;

/** 한 번에 조회할 productCode 개수 — URL 길이 방어(코드 13자 × 100 ≈ 1.4KB). */
const STOCK_INFO_CHUNK = 100;

export interface TossRankingRow {
  /** 토스 원본 순위(ETF 제외 **전** 번호 — 화면은 걸러낸 뒤 순서를 다시 매긴다). */
  rank: number;
  productCode: string;
  /** 티커(stock-infos의 symbol). */
  symbol: string;
  /** 한글 종목명(없으면 티커). */
  name: string;
  market: TossAppMarket;
  /** 현재가(USD) — 순위 응답의 price.close. */
  price: number;
  /** 기준가(전일종가, USD) — price.base. */
  base: number;
  /** 등락률(%) — (close - base) / base × 100. 응답에 등락률 필드가 없어 직접 계산한다. */
  ratePct: number;
  /** 거래량(주) — price.marketVolume. */
  volume: number;
  /** 거래대금(원) — price.marketAmount. 토스가 원화로 내려준다. */
  amountKrw: number;
  logoImageUrl?: string;
}

interface RawProduct {
  rank?: number;
  productCode?: string;
  name?: string;
  logoImageUrl?: string;
  price?: { base?: number; close?: number; marketVolume?: number; marketAmount?: number };
}

interface RawStockInfo {
  code?: string;
  symbol?: string;
  name?: string;
  market?: { code?: string };
  group?: { code?: string };
}

/** productCode → 티커·거래소·종목구분. 조회 실패한 코드는 맵에 없다. */
export interface TossStockInfo {
  symbol: string;
  market: TossAppMarket;
  groupCode: string;
  name?: string;
}

/** 순위 응답 파싱 — 스키마 드리프트에 대비해 옵셔널 체이닝으로 방어한다(tossSearch.ts 관례). */
export function parseRankingProducts(body: unknown): RawProduct[] {
  const products = (body as { result?: { products?: unknown } } | null)?.result?.products;
  return Array.isArray(products) ? (products as RawProduct[]) : [];
}

/** stock-infos 응답(배열) 파싱 — 미국 3거래소가 아니거나 티커가 없는 항목은 버린다. */
export function parseStockInfos(body: unknown): Map<string, TossStockInfo> {
  const list = (body as { result?: unknown } | null)?.result;
  const map = new Map<string, TossStockInfo>();
  if (!Array.isArray(list)) return map;
  for (const raw of list as RawStockInfo[]) {
    const code = raw.code?.trim();
    const symbol = raw.symbol?.trim();
    const market = raw.market?.code ? TOSS_MARKET_TO_APP[raw.market.code] : undefined;
    if (!code || !symbol || !market) continue;
    map.set(code, { symbol, market, groupCode: raw.group?.code?.trim() ?? '', name: raw.name?.trim() || undefined });
  }
  return map;
}

/** 거래 가능한 종목구분인가 — ETF·ETN·ELW 제외. 구분을 모르면(빈 값) 제외한다(보수적 판정). */
export function isTradableGroup(groupCode: string): boolean {
  return (TOSS_TRADABLE_GROUPS as readonly string[]).includes(groupCode);
}

/** 순위 원본 + 종목정보 → 주식만 남긴 순위 행. 티커를 못 찾았거나 ETF인 종목은 뺀다. */
export function joinRankingRows(products: RawProduct[], infos: Map<string, TossStockInfo>): TossRankingRow[] {
  const rows: TossRankingRow[] = [];
  for (const p of products) {
    const code = p.productCode?.trim();
    if (!code) continue;
    const info = infos.get(code);
    if (!info || !isTradableGroup(info.groupCode)) continue;
    const close = Number(p.price?.close);
    const base = Number(p.price?.base);
    if (!Number.isFinite(close) || close <= 0) continue;
    const ratePct = Number.isFinite(base) && base > 0 ? ((close - base) / base) * 100 : 0;
    rows.push({
      rank: Number(p.rank) || rows.length + 1,
      productCode: code,
      symbol: info.symbol,
      name: p.name?.trim() || info.name || info.symbol,
      market: info.market,
      price: close,
      base: Number.isFinite(base) ? base : close,
      ratePct,
      volume: Number(p.price?.marketVolume) || 0,
      amountKrw: Number(p.price?.marketAmount) || 0,
      logoImageUrl: p.logoImageUrl,
    });
  }
  return rows;
}

async function postJson(url: string, body: unknown, fetchImpl: FetchLike): Promise<unknown> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

/** productCode 목록 → 종목정보 맵. 100개씩 끊어 직렬 조회한다(대개 1콜). */
export async function fetchStockInfos(codes: readonly string[], deps: TossRankingDeps = {}): Promise<Map<string, TossStockInfo>> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const merged = new Map<string, TossStockInfo>();
  for (let i = 0; i < codes.length; i += STOCK_INFO_CHUNK) {
    const chunk = codes.slice(i, i + STOCK_INFO_CHUNK);
    if (chunk.length === 0) continue;
    const res = await fetchImpl(`${TOSS_STOCK_INFO_URL}?codes=${chunk.join(',')}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    for (const [code, info] of parseStockInfos(await res.json())) merged.set(code, info);
  }
  return merged;
}

/**
 * 토스 거래량 실시간 순위(미국) — ETF·ETN을 뺀 주식만 순위 순서대로 돌려준다.
 * 실패는 throw — 호출부(조회 화면·워치리스트)가 직전 상태 유지/에러 표시로 처리한다.
 */
export async function fetchTossVolumeRanking(deps: TossRankingDeps = {}): Promise<TossRankingRow[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const products = parseRankingProducts(await postJson(TOSS_RANKING_URL, TOSS_VOLUME_RANKING_BODY, fetchImpl));
  if (products.length === 0) throw new Error('토스 순위 응답이 비어 있어요');
  const codes = products.map((p) => p.productCode?.trim()).filter((c): c is string => !!c);
  const infos = await fetchStockInfos(codes, { fetchImpl });
  return joinRankingRows(products, infos);
}
