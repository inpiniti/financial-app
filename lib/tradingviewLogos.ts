// 트레이딩뷰 스크리너에서 미국 전 종목의 로고 아이디를 가져온다 (로고 도메인 plan §2-2).
//
// 공개 API — 쿠키·브라우저 지문 헤더 없이 최소 헤더로만 호출한다(세션ID를 코드에 넣지 않는다 — plan §4-1).
// 컬럼은 ticker-view 하나만 요청한다: 티커는 응답 행의 s("NASDAQ:NVDA")에서, 로고는 d[0].logo.logoid에서 얻는다.
// 실제 로고 이미지는 https://s3-symbol-logo.tradingview.com/{logoid}.svg

export const TRADINGVIEW_SCAN_URL =
  'https://scanner.tradingview.com/america/scan?label-product=screener-stock';

export const LOGO_CDN_BASE = 'https://s3-symbol-logo.tradingview.com';

/** [티커, 로고 아이디] — 사용자 제안 압축 형태 그대로 저장·전달한다. */
export type LogoPair = [ticker: string, logoid: string];

type FetchLike = (input: string, init?: RequestInit) => Promise<{ json(): Promise<unknown> }>;

/** 스크리너 요청 본문 — 사용자 예시의 필터(primary·주식/DR/펀드·pre-ipo 제외)를 유지하고 컬럼·범위만 조정. */
export function buildScanBody(range: [number, number] = [0, 9000]): string {
  return JSON.stringify({
    columns: ['ticker-view'],
    filter: [{ left: 'is_primary', operation: 'equal', right: true }],
    ignore_unknown_fields: false,
    options: { lang: 'ko' },
    range,
    sort: { sortBy: 'market_cap_basic', sortOrder: 'desc' },
    markets: ['america'],
    filter2: {
      operator: 'and',
      operands: [
        {
          operation: {
            operator: 'or',
            operands: [
              {
                operation: {
                  operator: 'and',
                  operands: [
                    { expression: { left: 'type', operation: 'equal', right: 'stock' } },
                    { expression: { left: 'typespecs', operation: 'has', right: ['common'] } },
                  ],
                },
              },
              {
                operation: {
                  operator: 'and',
                  operands: [
                    { expression: { left: 'type', operation: 'equal', right: 'stock' } },
                    { expression: { left: 'typespecs', operation: 'has', right: ['preferred'] } },
                  ],
                },
              },
              {
                operation: {
                  operator: 'and',
                  operands: [{ expression: { left: 'type', operation: 'equal', right: 'dr' } }],
                },
              },
              {
                operation: {
                  operator: 'and',
                  operands: [
                    { expression: { left: 'type', operation: 'equal', right: 'fund' } },
                    { expression: { left: 'typespecs', operation: 'has_none_of', right: ['etf', 'mutual'] } },
                  ],
                },
              },
            ],
          },
        },
        { expression: { left: 'typespecs', operation: 'has_none_of', right: ['pre-ipo'] } },
      ],
    },
  });
}

interface ScanRow {
  s?: string;
  d?: unknown[];
}

/** 응답 1행 → LogoPair. 티커는 s의 콜론 뒤(대문자 그대로 — BRK.A 등 특수 표기 유지), 로고 없으면 null. */
export function parseScanRow(row: ScanRow): LogoPair | null {
  const symbol = row.s?.split(':')[1]?.trim();
  const view = row.d?.[0] as { name?: string; logo?: { logoid?: string } } | undefined;
  const ticker = symbol || view?.name?.trim();
  const logoid = view?.logo?.logoid?.trim();
  if (!ticker || !logoid) return null;
  return [ticker, logoid];
}

/** 스크리너 1콜 → 로고 페어 목록(로고 없는 종목은 스킵). 실패는 throw — 호출부(logoStore)가 캐시 유지로 처리. */
export async function fetchLogoPairs(deps: { fetchImpl?: FetchLike } = {}): Promise<LogoPair[]> {
  const fetchImpl = deps.fetchImpl ?? (fetch as unknown as FetchLike);
  const res = await fetchImpl(TRADINGVIEW_SCAN_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'text/plain;charset=UTF-8',
    },
    body: buildScanBody(),
  });
  const body = (await res.json()) as { data?: ScanRow[]; totalCount?: number };
  if (!Array.isArray(body.data)) {
    throw new Error('트레이딩뷰 스크리너 응답에 data 배열이 없어요');
  }
  const pairs: LogoPair[] = [];
  for (const row of body.data) {
    const pair = parseScanRow(row);
    if (pair) pairs.push(pair);
  }
  return pairs;
}

/** 로고 SVG URL — https://s3-symbol-logo.tradingview.com/{logoid}.svg */
export function logoUrlOf(logoid: string): string {
  return `${LOGO_CDN_BASE}/${logoid}.svg`;
}

/**
 * viewBox 보정 — 트레이딩뷰 로고 일부(nvidia·meta-platforms·apple 등)는 <svg width="18" height="18">만
 * 있고 viewBox가 없다. viewBox가 없으면 렌더러가 스케일링을 못 해 원본 18×18이 좌상단에 그려진다
 * (실기기 제보: 메타·엔비디아 로고 좌상단 쏠림). width/height 속성으로 viewBox를 주입한다.
 */
export function ensureViewBox(svg: string): string {
  const openTag = svg.match(/<svg\b[^>]*>/i)?.[0];
  if (!openTag || /viewBox\s*=/i.test(openTag)) return svg;
  const width = openTag.match(/\bwidth\s*=\s*"([\d.]+)"/i)?.[1];
  const height = openTag.match(/\bheight\s*=\s*"([\d.]+)"/i)?.[1];
  if (!width || !height) return svg;
  return svg.replace(openTag, openTag.replace(/<svg\b/i, `<svg viewBox="0 0 ${width} ${height}"`));
}
