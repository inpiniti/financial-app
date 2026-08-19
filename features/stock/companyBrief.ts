// 종목 상세화면 "기업" 탭 — 기업 소개·현재 상황·최근 뉴스 요약(2026-08-19, 호가 탭 대체).
// AI 호출은 bitcoin-simulation 프로젝트의 Vercel Edge 프록시(/api/simple/gemini, gemini-3.5-flash-lite 고정)를 통해
// 한다 — 앱에는 Gemini 키가 실리지 않는다. 프록시는 contents/systemInstruction/generationConfig를 그대로 전달하고
// 응답 텍스트를 plain text 스트림으로 돌려준다.
//
// 모델 자체는 인터넷이 없고 생소한 종목을 모를 수 있으므로, 앱이 재료를 모아 프롬프트에 넣는다:
//   KIS 현재가상세(시총·PER·52주·업종코드 등) + Yahoo 검색(yahooSearch: 정식명·섹터·업종·최근 뉴스 헤드라인).
// (Gemini google_search 그라운딩은 무료 할당량 밖(429)이라 2026-08-19 쓰지 않기로 확정 — tools 미전송.)
// 결과는 종목+거래일(ET) 단위로 AsyncStorage에 캐시 — 탭을 열 때마다 호출하지 않는다("새로고침"으로만 재호출).
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { OverseasPriceDetail } from '../../kis/priceDetail';
import { etDateOf } from '../scalper/autopilot';
import { fetchYahooSearch, type YahooSearchResult } from './yahooSearch';

/** bitcoin-simulation Vercel 배포 도메인 — 사용자 확정(2026-08-19). */
export const COMPANY_BRIEF_ENDPOINT = 'https://simulation-inpiniti.vercel.app/api/simple/gemini';
const STORAGE_PREFIX = 'stock:companyBrief:v1:';
const REQUEST_TIMEOUT_MS = 40_000;

export interface CompanyNewsItem {
  title: string;
  /** 원문 링크(Yahoo 검색 결과의 link) — 모델이 재료 목록의 번호로 매칭해 준다. 없으면 빈 문자열. */
  link: string;
  /** 출처(매체명). 없으면 빈 문자열. */
  source: string;
  /** 날짜(YYYY-MM-DD, ET). 없으면 빈 문자열. */
  date: string;
  summary: string;
}

export interface CompanyBrief {
  /** 어떤 회사인지 2~3문장. */
  about: string;
  /** 주력 사업·수익원. */
  business: string;
  /** 오늘/최근 주가·실적 상황 요약. */
  situation: string;
  news: CompanyNewsItem[];
  /** 생성 시각(epoch ms). */
  generatedAt: number;
  /** 파싱 실패 시 모델 원문 — UI는 이 값이 있으면 그대로 보여준다. */
  rawText?: string;
}

export interface CompanyBriefInput {
  ticker: string;
  market: string;
  name?: string;
  detail: OverseasPriceDetail | null;
  /** Yahoo 검색 결과 — 조회 실패면 null(뉴스 없이 진행). */
  yahoo: YahooSearchResult | null;
}

/** 캐시 키 — 종목 + 거래일(ET). 거래일이 바뀌면 자연히 새로 만든다. */
export function companyBriefCacheKey(ticker: string, market: string, nowMs: number): string {
  return `${STORAGE_PREFIX}${market}:${ticker.toUpperCase()}:${etDateOf(nowMs)}`;
}

function n(v: string | undefined): number | null {
  if (v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

/** KIS 현재가상세를 사람이 읽는 몇 줄로 — 값이 비어 있으면 그 줄은 생략(모델이 지어내지 않게). */
export function describePriceDetail(detail: OverseasPriceDetail | null): string {
  if (!detail) return '(시세 데이터 없음)';
  const lines: string[] = [];
  const last = n(detail.last);
  const base = n(detail.base);
  if (last !== null) {
    let s = `현재가 ${last} ${detail.curr || 'USD'}`;
    if (base !== null && base > 0) {
      const pct = ((last - base) / base) * 100;
      s += ` (전일 종가 ${base} 대비 ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
    }
    lines.push(s);
  }
  const high = n(detail.high);
  const low = n(detail.low);
  const open = n(detail.open);
  if (open !== null && high !== null && low !== null) lines.push(`당일 시가 ${open} / 고가 ${high} / 저가 ${low}`);
  const tvol = n(detail.tvol);
  if (tvol !== null) lines.push(`당일 거래량 ${tvol}`);
  const mcap = n(detail.mcap);
  if (mcap !== null && mcap > 0) lines.push(`시가총액 ${mcap}`);
  const per = n(detail.perx);
  const pbr = n(detail.pbrx);
  const eps = n(detail.epsx);
  const ratio: string[] = [];
  if (per !== null && per !== 0) ratio.push(`PER ${per}`);
  if (pbr !== null && pbr !== 0) ratio.push(`PBR ${pbr}`);
  if (eps !== null && eps !== 0) ratio.push(`EPS ${eps}`);
  if (ratio.length) lines.push(ratio.join(', '));
  const h52 = n(detail.h52p);
  const l52 = n(detail.l52p);
  if (h52 !== null && l52 !== null && h52 > 0) lines.push(`52주 최고 ${h52}(${detail.h52d}) / 최저 ${l52}(${detail.l52d})`);
  if (detail.e_icod) lines.push(`업종 코드 ${detail.e_icod}`);
  if (detail.etyp_nm) lines.push(`증권 유형 ${detail.etyp_nm}`);
  return lines.length ? lines.join('\n') : '(시세 데이터 없음)';
}

/** Yahoo 프로필 → 프롬프트 줄. */
export function describeYahooProfile(yahoo: YahooSearchResult | null): string {
  const p = yahoo?.profile;
  if (!p) return '(프로필 없음)';
  const lines: string[] = [];
  if (p.longName) lines.push(`정식 명칭 ${p.longName}`);
  if (p.exchange) lines.push(`거래소 ${p.exchange}`);
  if (p.sector) lines.push(`섹터 ${p.sector}`);
  if (p.industry) lines.push(`업종 ${p.industry}`);
  return lines.length ? lines.join('\n') : '(프로필 없음)';
}

/** Yahoo 뉴스 → 번호 매긴 헤드라인 목록(모델이 index로 되돌려 준다). */
export function describeYahooNews(yahoo: YahooSearchResult | null): string {
  const news = yahoo?.news ?? [];
  if (!news.length) return '(최근 뉴스 없음)';
  return news
    .map((item, i) => {
      const date = item.publishedAt ? etDateOf(item.publishedAt) : '날짜 미상';
      return `${i + 1}. [${date}] ${item.title}${item.publisher ? ` — ${item.publisher}` : ''}`;
    })
    .join('\n');
}

const SYSTEM_INSTRUCTION =
  '너는 한국어로 답하는 주식 리서치 보조원이다. 인터넷 검색은 할 수 없으니 사용자가 준 재료(시세·프로필·뉴스 헤드라인)와 ' +
  '네가 확실히 아는 지식만 쓴다. 모르는 내용은 지어내지 말고 빈 문자열이나 빈 배열로 둔다. ' +
  '반드시 아래 JSON 스키마 하나만 출력한다(마크다운 코드펜스·설명 금지). ' +
  'news는 재료로 준 헤드라인 목록에서만 고른다 — 각 항목에 재료 번호(index, 1부터)를 그대로 넣고 title은 한국어로 번역, ' +
  'summary는 헤드라인에서 알 수 있는 범위로 1문장(모르면 빈 문자열). ' +
  '문체는 "~해요"체, 각 필드는 간결하게(about·business·situation 각각 3문장 이내, news 최대 5건). ' +
  '스키마: {"about":string,"business":string,"situation":string,"news":[{"index":number,"title":string,"summary":string}]}';

export function buildCompanyBriefPrompt(input: CompanyBriefInput, nowMs: number): string {
  const label = input.name ? `${input.name} (${input.ticker}, ${input.market})` : `${input.ticker} (${input.market})`;
  return [
    `종목: ${label}`,
    `기준일(미국 동부): ${etDateOf(nowMs)}`,
    '',
    '[재료 1] 앱이 조회한 현재 시세 데이터(한국투자증권):',
    describePriceDetail(input.detail),
    '',
    '[재료 2] 종목 프로필(Yahoo Finance):',
    describeYahooProfile(input.yahoo),
    '',
    '[재료 3] 최근 뉴스 헤드라인(Yahoo Finance, 최신순):',
    describeYahooNews(input.yahoo),
    '',
    '요청:',
    '1) about — 이 회사가 어떤 회사인지(국가·상장 시장·설립 배경 등). 확실히 아는 범위만.',
    '2) business — 주력 사업과 주요 수익원. 모르면 섹터·업종만으로 짧게.',
    '3) situation — 재료 1의 시세와 재료 3의 헤드라인을 근거로 현재 상황을 요약. 재료에 없는 수치는 만들지 말 것.',
    '4) news — 재료 3에서 투자자에게 의미 있는 순으로 최대 5건 고르고 index를 붙일 것. 목록이 비었으면 빈 배열.',
  ].join('\n');
}

/** 프록시로 보낼 요청 바디 — tools 없음(일반 생성). */
export function buildCompanyBriefRequestBody(input: CompanyBriefInput, nowMs: number): unknown {
  return {
    contents: [{ role: 'user', parts: [{ text: buildCompanyBriefPrompt(input, nowMs) }] }],
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    // JSON 모드 — 자유 텍스트에서 가끔 나오던 구문 깨짐(`"title":,`) 방지. tools와 함께는 못 쓰지만 지금은 tools 없음.
    generationConfig: { temperature: 0.3, maxOutputTokens: 2048, responseMimeType: 'application/json' },
  };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * 모델 응답 텍스트 → CompanyBrief. 코드펜스·앞뒤 잡음을 걷어내고 첫 `{`~마지막 `}`를 JSON으로 시도한다.
 * news는 index(1부터)로 Yahoo 원본 헤드라인을 찾아 매체·날짜·링크를 채운다 — 모델이 이 값들을 지어내지 않게 한다.
 * 실패하면 rawText로만 채운 결과를 돌려준다(빈 화면 대신 원문 표시).
 */
export function parseCompanyBrief(text: string, nowMs: number, yahoo: YahooSearchResult | null = null): CompanyBrief {
  const source = yahoo?.news ?? [];
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
      const newsRaw = Array.isArray(obj.news) ? obj.news : [];
      const news: CompanyNewsItem[] = newsRaw
        .map((item) => {
          const o = (item ?? {}) as Record<string, unknown>;
          const idx = Number(o.index) - 1;
          const src = Number.isInteger(idx) && idx >= 0 && idx < source.length ? source[idx] : null;
          return {
            title: str(o.title) || src?.title || '',
            source: src?.publisher ?? '',
            date: src?.publishedAt ? etDateOf(src.publishedAt) : '',
            summary: str(o.summary),
            link: src?.link ?? '',
          };
        })
        .filter((item) => item.title)
        .slice(0, 5);
      const brief: CompanyBrief = {
        about: str(obj.about),
        business: str(obj.business),
        situation: str(obj.situation),
        news,
        generatedAt: nowMs,
      };
      if (brief.about || brief.business || brief.situation || news.length) return brief;
    } catch {
      /* fall through */
    }
  }
  return { about: '', business: '', situation: '', news: [], generatedAt: nowMs, rawText: cleaned };
}

export interface FetchCompanyBriefDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  endpoint?: string;
}

/**
 * Yahoo 검색(뉴스·프로필) → 프록시 호출. Yahoo 실패는 삼키고 뉴스 없이 진행,
 * 프록시가 200이 아니면 본문을 메시지로 throw. 응답은 plain text(스트림 합침).
 */
export async function fetchCompanyBrief(
  input: Omit<CompanyBriefInput, 'yahoo'>,
  deps: FetchCompanyBriefDeps = {},
): Promise<CompanyBrief> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const nowMs = (deps.now ?? Date.now)();
  const yahoo = await fetchYahooSearch(input.ticker, { fetchImpl }).catch(() => null);
  const full: CompanyBriefInput = { ...input, yahoo };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(deps.endpoint ?? COMPANY_BRIEF_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildCompanyBriefRequestBody(full, nowMs)),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
    return parseCompanyBrief(text, nowMs, yahoo);
  } finally {
    clearTimeout(timer);
  }
}

export async function loadCachedCompanyBrief(ticker: string, market: string, nowMs: number): Promise<CompanyBrief | null> {
  try {
    const raw = await AsyncStorage.getItem(companyBriefCacheKey(ticker, market, nowMs));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CompanyBrief;
    return parsed && typeof parsed === 'object' && Array.isArray(parsed.news) ? parsed : null;
  } catch {
    return null;
  }
}

export async function saveCachedCompanyBrief(ticker: string, market: string, brief: CompanyBrief): Promise<void> {
  try {
    await AsyncStorage.setItem(companyBriefCacheKey(ticker, market, brief.generatedAt), JSON.stringify(brief));
  } catch {
    /* 캐시 실패는 무시 — 다음에 다시 호출하면 된다 */
  }
}
