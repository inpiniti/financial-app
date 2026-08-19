// 종목 상세화면 "기업" 탭 — 기업 소개·현재 상황·최근 뉴스 분석(2026-08-19, 호가 탭 대체).
// AI 호출은 bitcoin-simulation 프로젝트의 Vercel Edge 프록시(/api/simple/gemini, gemini-3.5-flash-lite 우선·3.1 폴백)를
// 통해 한다 — 앱에는 Gemini 키가 실리지 않는다. 프록시는 contents/systemInstruction/generationConfig를 그대로 전달하고
// 응답 텍스트를 plain text 스트림으로 돌려준다.
//
// 모델 자체는 인터넷이 없고 생소한 종목을 모를 수 있으므로, 앱이 재료를 모아 프롬프트에 넣는다:
//   [1] KIS 현재가상세(시총·PER·52주·업종코드 등)
//   [2] Yahoo 검색(yahooSearch: 정식명·섹터·업종·최근 뉴스 헤드라인)
//   [3] 최신 기사 N건의 본문(/api/simple/article로 추출) — 사용자는 뉴스 "목록"이 아니라 "읽고 분석한 결과"를 원한다.
// (Gemini google_search 그라운딩은 무료 할당량 밖(429)이라 2026-08-19 쓰지 않기로 확정 — tools 미전송.)
// 결과는 종목+거래일(ET) 단위로 AsyncStorage에 캐시 — 탭을 열 때마다 호출하지 않는다("새로고침"으로만 재호출).
// 2026-08-19 스트리밍: 프록시 응답을 expo/fetch로 조각마다 받아 onProgress로 흘리고(단계 search→articles→generate),
// 화면은 parsePartialCompanyBrief로 JSON 조각에서 미완성 문장을 뽑아 타이핑처럼 그린다(bitcoin-simulation AI 질문과 같은 체감).
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { OverseasPriceDetail } from '../../kis/priceDetail';
import { etDateOf } from '../scalper/autopilot';
import {
  fetchYahooArticles,
  fetchYahooSearch,
  type YahooArticleBody,
  type YahooSearchResult,
} from './yahooSearch';

/** bitcoin-simulation Vercel 배포 도메인 — 사용자 확정(2026-08-19). */
export const COMPANY_BRIEF_ENDPOINT = 'https://simulation-inpiniti.vercel.app/api/simple/gemini';
/** 스키마가 바뀌면 버전을 올린다(옛 캐시 무시). v2: 뉴스 목록 → 뉴스 분석(digest/호재/악재/지켜볼 점). */
const STORAGE_PREFIX = 'stock:companyBrief:v2:';
const REQUEST_TIMEOUT_MS = 60_000;
/** 본문까지 읽는 기사 수 — 최신순 상위 N건. */
export const ARTICLE_READ_COUNT = 5;

/** 근거 기사 — 모델이 index로 가리킨 원본. */
export interface CompanyNewsItem {
  title: string;
  link: string;
  source: string;
  /** YYYY-MM-DD(ET). 없으면 빈 문자열. */
  date: string;
  /** 본문까지 읽었는지(헤드라인만 있었으면 false). */
  read: boolean;
}

/** 호재/악재 한 줄 — 어느 기사(1-based 번호, 원본 news 배열 index+1)에 근거하는지. */
export interface CompanyPoint {
  text: string;
  /** 근거 기사 번호(1부터). 없으면 빈 배열. */
  refs: number[];
}

export interface CompanyBrief {
  /** 어떤 회사인지 2~3문장. */
  about: string;
  /** 주력 사업·수익원. */
  business: string;
  /** 시세+뉴스 근거 현재 상황 요약. */
  situation: string;
  /** 최근 뉴스를 읽고 종합한 3~5문장. */
  newsDigest: string;
  positives: CompanyPoint[];
  negatives: CompanyPoint[];
  /** 앞으로 지켜볼 일정·이슈. */
  watch: string[];
  /** 근거 기사(프롬프트에 넣은 순서 그대로, 번호 = index+1). */
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
  /** yahoo.news와 같은 인덱스의 본문(못 읽었으면 null). 길이는 ARTICLE_READ_COUNT 이하. */
  articles: Array<YahooArticleBody | null>;
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

/**
 * Yahoo 뉴스 → 번호 매긴 기사 블록. 본문이 있으면 헤드라인 아래에 본문을 붙이고, 없으면 "(본문 없음 — 헤드라인만)".
 * 번호(1부터)는 응답의 refs가 가리키는 값이다.
 */
export function describeYahooNews(yahoo: YahooSearchResult | null, articles: Array<YahooArticleBody | null>): string {
  const news = yahoo?.news ?? [];
  if (!news.length) return '(최근 뉴스 없음)';
  return news
    .map((item, i) => {
      const date = item.publishedAt ? etDateOf(item.publishedAt) : '날짜 미상';
      const head = `${i + 1}. [${date}] ${item.title}${item.publisher ? ` — ${item.publisher}` : ''}`;
      const body = articles[i]?.text;
      return body ? `${head}\n본문:\n${body}` : `${head}\n(본문 없음 — 헤드라인만)`;
    })
    .join('\n\n');
}

const SYSTEM_INSTRUCTION =
  '너는 한국어로 답하는 주식 리서치 보조원이다. 인터넷 검색은 할 수 없으니 사용자가 준 재료(시세·프로필·기사 본문)와 ' +
  '네가 확실히 아는 지식만 쓴다. 모르는 내용은 지어내지 말고 빈 문자열이나 빈 배열로 둔다. ' +
  '반드시 아래 JSON 스키마 하나만 출력한다(마크다운 코드펜스·설명 금지). ' +
  '기사 관련 필드(newsDigest·positives·negatives·watch)는 재료로 준 기사 본문/헤드라인에서만 근거를 찾고, ' +
  'positives/negatives의 각 항목에는 근거 기사 번호(refs, 1부터)를 넣는다. 재료가 없으면 빈 값. ' +
  '문체는 "~해요"체. 길이: about·business·situation 각 3문장 이내, newsDigest 3~5문장, positives/negatives 각 최대 3개(한 줄), watch 최대 3개(한 줄). ' +
  '스키마: {"about":string,"business":string,"situation":string,"newsDigest":string,' +
  '"positives":[{"text":string,"refs":number[]}],"negatives":[{"text":string,"refs":number[]}],"watch":string[]}';

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
    '[재료 3] 최근 기사(Yahoo Finance, 최신순 — 번호가 refs 값):',
    describeYahooNews(input.yahoo, input.articles),
    '',
    '요청:',
    '1) about — 이 회사가 어떤 회사인지(국가·상장 시장·설립 배경 등). 확실히 아는 범위만.',
    '2) business — 주력 사업과 주요 수익원. 모르면 섹터·업종만으로 짧게.',
    '3) situation — 재료 1의 시세와 재료 3을 근거로 현재 상황을 요약. 재료에 없는 수치는 만들지 말 것.',
    '4) newsDigest — 재료 3의 기사들을 읽고 "무슨 일이 있었는지" 종합. 헤드라인 나열이 아니라 맥락·인과로 3~5문장.',
    '5) positives / negatives — 투자자 관점의 호재·악재를 각각 최대 3개, 각 항목에 근거 기사 번호(refs).',
    '6) watch — 앞으로 지켜볼 일정·이슈(실적 발표, 제품 출시, 규제·소송, 가이던스 등) 최대 3개. 기사에 없으면 빈 배열.',
  ].join('\n');
}

/** 프록시로 보낼 요청 바디 — tools 없음(일반 생성), JSON 모드. */
export function buildCompanyBriefRequestBody(input: CompanyBriefInput, nowMs: number): unknown {
  return {
    contents: [{ role: 'user', parts: [{ text: buildCompanyBriefPrompt(input, nowMs) }] }],
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    // JSON 모드 — 자유 텍스트에서 가끔 나오던 구문 깨짐(`"title":,`) 방지. tools와 함께는 못 쓰지만 지금은 tools 없음.
    generationConfig: { temperature: 0.3, maxOutputTokens: 4096, responseMimeType: 'application/json' },
  };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function strList(v: unknown, max: number): string[] {
  return (Array.isArray(v) ? v : []).map(str).filter(Boolean).slice(0, max);
}

function pointList(v: unknown, max: number, newsCount: number): CompanyPoint[] {
  return (Array.isArray(v) ? v : [])
    .map((raw) => {
      const o = (raw ?? {}) as Record<string, unknown>;
      const refs = (Array.isArray(o.refs) ? o.refs : [])
        .map((x) => Number(x))
        .filter((x) => Number.isInteger(x) && x >= 1 && x <= newsCount);
      return { text: str(o.text), refs: Array.from(new Set(refs)) };
    })
    .filter((p) => p.text)
    .slice(0, max);
}

/** 근거 기사 목록 — 프롬프트에 넣은 순서 그대로(번호 = index+1). */
export function buildNewsRefs(yahoo: YahooSearchResult | null, articles: Array<YahooArticleBody | null>): CompanyNewsItem[] {
  return (yahoo?.news ?? []).map((item, i) => ({
    title: item.title,
    link: item.link,
    source: item.publisher,
    date: item.publishedAt ? etDateOf(item.publishedAt) : '',
    read: Boolean(articles[i]?.text),
  }));
}

/**
 * 모델 응답 텍스트 → CompanyBrief. 코드펜스·앞뒤 잡음을 걷어내고 첫 `{`~마지막 `}`를 JSON으로 시도한다.
 * refs는 기사 번호 범위 밖이면 버린다. 실패하면 rawText로만 채운 결과를 돌려준다(빈 화면 대신 원문 표시).
 */
export function parseCompanyBrief(
  text: string,
  nowMs: number,
  yahoo: YahooSearchResult | null = null,
  articles: Array<YahooArticleBody | null> = [],
): CompanyBrief {
  const news = buildNewsRefs(yahoo, articles);
  const empty: CompanyBrief = {
    about: '',
    business: '',
    situation: '',
    newsDigest: '',
    positives: [],
    negatives: [],
    watch: [],
    news,
    generatedAt: nowMs,
  };
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
      const brief: CompanyBrief = {
        ...empty,
        about: str(obj.about),
        business: str(obj.business),
        situation: str(obj.situation),
        newsDigest: str(obj.newsDigest),
        positives: pointList(obj.positives, 3, news.length),
        negatives: pointList(obj.negatives, 3, news.length),
        watch: strList(obj.watch, 3),
      };
      if (brief.about || brief.business || brief.situation || brief.newsDigest) return brief;
    } catch {
      /* fall through */
    }
  }
  return { ...empty, rawText: cleaned };
}

/**
 * 진행 단계(2026-08-19 스트리밍) — 화면이 "지금 뭘 하고 있나"를 보여주기 위한 통지.
 *   search   → Yahoo 검색(뉴스·프로필) 중
 *   articles → 기사 본문 읽는 중(total = 읽을 건수)
 *   generate → 모델이 쓰는 중. text는 지금까지 받은 원문 누적(JSON 조각) — 화면은 parsePartialCompanyBrief로
 *              섹션별 미완성 문장을 뽑아 타이핑처럼 그린다.
 */
export type CompanyBriefProgress =
  | { stage: 'search' }
  | { stage: 'articles'; total: number }
  | { stage: 'generate'; text: string };

/** 스트리밍 중 보여줄 수 있는 텍스트 필드 — 목록(호재/악재/지켜볼 점)은 완성 후에만. */
export interface PartialCompanyBrief {
  about: string;
  business: string;
  situation: string;
  newsDigest: string;
  /** 지금 글자가 차오르고 있는 필드(닫는 따옴표가 아직 없는 마지막 문자열). 없으면 null. */
  writing: 'about' | 'business' | 'situation' | 'newsDigest' | null;
}

const PARTIAL_KEYS = ['about', 'business', 'situation', 'newsDigest'] as const;

/** JSON 문자열 리터럴 본문(따옴표 안, 이스케이프 그대로) → 실제 문자열. 끝이 잘린 이스케이프는 떼고 시도한다. */
function unescapeJsonFragment(raw: string): string {
  let s = raw;
  // 끝이 홀수 개 백슬래시로 끝나면(이스케이프 도중 잘림) 마지막 하나를 뗀다.
  const trailing = /\\+$/.exec(s)?.[0].length ?? 0;
  if (trailing % 2 === 1) s = s.slice(0, -1);
  // \uXXXX 도중 잘림도 뗀다.
  s = s.replace(/\\u[0-9a-fA-F]{0,3}$/, '');
  try {
    return JSON.parse(`"${s}"`) as string;
  } catch {
    return s.replace(/\\n/g, '\n').replace(/\\"/g, '"');
  }
}

/**
 * 스트리밍 도중의 JSON 조각에서 텍스트 필드를 **미완성 상태로도** 뽑는다(타이핑 표시용).
 * `"key":"...` 뒤를 이스케이프를 존중하며 닫는 따옴표(또는 끝)까지 읽는다. 없는 필드는 빈 문자열.
 */
export function parsePartialCompanyBrief(text: string): PartialCompanyBrief {
  const out: PartialCompanyBrief = { about: '', business: '', situation: '', newsDigest: '', writing: null };
  let lastOpenPos = -1;
  for (const key of PARTIAL_KEYS) {
    const m = new RegExp(`"${key}"\\s*:\\s*"`).exec(text);
    if (!m) continue;
    const start = m.index + m[0].length;
    let i = start;
    let closed = false;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '"') {
        closed = true;
        break;
      }
      i += 1;
    }
    out[key] = unescapeJsonFragment(text.slice(start, Math.min(i, text.length)));
    if (!closed && m.index > lastOpenPos) {
      lastOpenPos = m.index;
      out.writing = key;
    }
  }
  return out;
}

export interface FetchCompanyBriefDeps {
  /**
   * HTTP 구현. 미주입이면 프록시 호출에는 expo/fetch(응답 body 스트리밍 지원)를, 그 외엔 전역 fetch를 쓴다.
   * RN 기본 fetch는 body.getReader()가 없어 스트리밍이 안 된다 — 그 경우 text()로 폴백(타이핑 표시만 없어진다).
   */
  fetchImpl?: typeof fetch;
  now?: () => number;
  endpoint?: string;
  /** 진행 단계 통지(선택) — 화면 진행 표시·타이핑 표시용. */
  onProgress?: (progress: CompanyBriefProgress) => void;
}

/** 스트리밍 가능한 fetch — expo/fetch가 있으면 그것, 없으면(테스트·웹) 전역 fetch. */
async function loadStreamingFetch(): Promise<typeof fetch> {
  try {
    const mod = (await import('expo/fetch')) as { fetch?: unknown };
    if (typeof mod.fetch === 'function') return mod.fetch as typeof fetch;
  } catch {
    /* expo 런타임 아님 */
  }
  return fetch;
}

/** 응답 본문을 조각마다 onChunk(누적 텍스트)로 알리며 끝까지 읽는다. 스트리밍 미지원이면 text() 한 번. */
async function readBodyStreaming(res: Response, onChunk?: (accumulated: string) => void): Promise<string> {
  const body = res.body as { getReader?: () => { read: () => Promise<{ done: boolean; value?: Uint8Array }> } } | null;
  if (!body?.getReader || typeof TextDecoder === 'undefined') return res.text();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let acc = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      acc += decoder.decode(value, { stream: true });
      onChunk?.(acc);
    }
  }
  acc += decoder.decode();
  return acc;
}

/**
 * Yahoo 검색(뉴스·프로필) → 최신 기사 본문 N건 병렬 → 프록시 호출(스트리밍, 조각마다 onProgress).
 * Yahoo/기사 실패는 삼키고 있는 재료로 진행, 프록시가 200이 아니면 본문을 메시지로 throw.
 */
export async function fetchCompanyBrief(
  input: Omit<CompanyBriefInput, 'yahoo' | 'articles'>,
  deps: FetchCompanyBriefDeps = {},
): Promise<CompanyBrief> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const streamFetch = deps.fetchImpl ?? (await loadStreamingFetch());
  const nowMs = (deps.now ?? Date.now)();
  deps.onProgress?.({ stage: 'search' });
  const yahoo = await fetchYahooSearch(input.ticker, { fetchImpl }).catch(() => null);
  const toRead = yahoo ? Math.min(yahoo.news.length, ARTICLE_READ_COUNT) : 0;
  deps.onProgress?.({ stage: 'articles', total: toRead });
  const articles = yahoo ? await fetchYahooArticles(yahoo.news, ARTICLE_READ_COUNT, { fetchImpl }) : [];
  const full: CompanyBriefInput = { ...input, yahoo, articles };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    deps.onProgress?.({ stage: 'generate', text: '' });
    const res = await streamFetch(deps.endpoint ?? COMPANY_BRIEF_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildCompanyBriefRequestBody(full, nowMs)),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
    const text = await readBodyStreaming(res, (acc) => deps.onProgress?.({ stage: 'generate', text: acc }));
    return parseCompanyBrief(text, nowMs, yahoo, articles);
  } finally {
    clearTimeout(timer);
  }
}

export async function loadCachedCompanyBrief(ticker: string, market: string, nowMs: number): Promise<CompanyBrief | null> {
  try {
    const raw = await AsyncStorage.getItem(companyBriefCacheKey(ticker, market, nowMs));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CompanyBrief;
    return parsed && typeof parsed === 'object' && Array.isArray(parsed.news) && Array.isArray(parsed.positives)
      ? parsed
      : null;
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
