// 도움말 챗봇 — 앱 사용법을 물어보면 매뉴얼(APP_MANUAL)과 사용자의 현재 설정·상태만 근거로 답한다.
//
// AI 호출은 기업 탭과 같은 bitcoin-simulation Vercel Edge 프록시(/api/simple/gemini)를 쓴다 — 앱에 키가 없다.
// 프록시는 contents/systemInstruction/generationConfig를 그대로 전달하므로, contents에 대화 히스토리를
// 쌓으면 멀티턴이 그대로 된다(프록시 수정 없음). 기업 탭과 다른 점 둘:
//   ① JSON 모드를 쓰지 않는다(자유 텍스트 답변) → 응답 조각이 곧 화면에 그릴 글자다.
//   ② 히스토리가 턴마다 커진다 → 최근 HISTORY_MAX_TURNS 턴만 보낸다(무료 할당량·지연 방어).
//
// ⚠ 프록시는 외부 서비스다 — 계좌번호·앱키·시크릿은 프롬프트에 절대 넣지 않는다. 넣는 것은 매뉴얼,
// 매매 파라미터(금액·수량·속도), 오토파일럿 상태·보유 티커까지다.
import { COMPANY_BRIEF_ENDPOINT } from '../stock/companyBrief';
import {
  APP_MANUAL,
  describeRuntimeState,
  describeUserSettings,
  type HelpRuntimeState,
} from './appManual';
import type { AppSettings } from '../../lib/appSettings';

/** 기업 탭과 같은 프록시. 별칭을 두는 이유는 "도움말도 이 엔드포인트"를 코드에서 읽히게 하려는 것뿐이다. */
export const HELP_CHAT_ENDPOINT = COMPANY_BRIEF_ENDPOINT;

/** 프록시로 보내는 최근 대화 턴 수(질문·답변 각각 1턴). 오래된 맥락은 버린다. */
export const HISTORY_MAX_TURNS = 8;

const REQUEST_TIMEOUT_MS = 60_000;

export interface HelpMessage {
  role: 'user' | 'model';
  text: string;
}

/**
 * 답변 규칙. 상태 블록이 없을 때 그 블록을 언급하지 않는다 — 없는 자료를 가리키면 모델이 값을 지어낸다.
 */
export function systemInstructionHead(hasState: boolean): string {
  const sources = hasState ? '아래 [사용 설명서]와 [사용자의 현재 상태]' : '아래 [사용 설명서]';
  return (
  `너는 SEEDTICK 앱의 사용법을 안내하는 도우미다. ${sources}에 있는 내용만 근거로 답한다. ` +
  '설명서에 없는 내용은 지어내지 말고 "설명서에 없어서 확실하지 않아요"라고 말한다. ' +
  '종목 추천·주가 예측·매매 조언·수익 보장은 절대 하지 않는다(물어보면 이 앱은 그런 판단을 하지 않는다고 알려 준다). ' +
  '규칙 값(봉 주기·손절·상한 등)을 말할 때는 반드시 아래 두 블록의 값을 그대로 쓴다 — 기억하는 값을 쓰지 않는다. ' +
  '답은 한국어 "~해요"체로, 3~6문장 또는 짧은 목록으로 간결하게 쓴다. 마크다운 표·코드블록은 쓰지 않는다. ' +
  '사용자가 무엇을 눌러야 하는지 물으면 화면 이름과 버튼 이름을 그대로 짚어 준다.'
  );
}

export interface HelpPromptContext {
  settings?: AppSettings | null;
  runtime?: HelpRuntimeState | null;
}

/** systemInstruction 본문 — 매뉴얼 + 사용자 현재 상태. 상태는 있는 만큼만 붙인다. */
export function buildHelpSystemInstruction(ctx: HelpPromptContext = {}): string {
  const state: string[] = [];
  if (ctx.settings) state.push(describeUserSettings(ctx.settings));
  if (ctx.runtime) {
    const runtime = describeRuntimeState(ctx.runtime);
    if (runtime) state.push(runtime);
  }
  const blocks = [systemInstructionHead(state.length > 0), '', '[사용 설명서]', APP_MANUAL];
  if (state.length) {
    blocks.push('', '[사용자의 현재 상태] — 설명서의 기본값이 아니라 이 값이 지금 실제로 걸린 값이다.', state.join('\n'));
  }
  return blocks.join('\n');
}

/** 최근 턴만 남긴 대화 — 앞쪽(오래된) 턴부터 버린다. */
export function trimHistory(messages: readonly HelpMessage[], maxTurns = HISTORY_MAX_TURNS): HelpMessage[] {
  return messages.slice(Math.max(0, messages.length - maxTurns));
}

/** 프록시 요청 바디 — 기업 탭과 달리 JSON 모드가 아니다(자유 텍스트). */
export function buildHelpRequestBody(
  messages: readonly HelpMessage[],
  ctx: HelpPromptContext = {},
): unknown {
  return {
    contents: trimHistory(messages).map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
    systemInstruction: { parts: [{ text: buildHelpSystemInstruction(ctx) }] },
    generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
  };
}

export interface AskHelpDeps {
  /** HTTP 구현. 미주입이면 스트리밍 가능한 expo/fetch(없으면 전역 fetch). */
  fetchImpl?: typeof fetch;
  endpoint?: string;
  /** 지금까지 받은 답변 누적 — 화면이 타이핑처럼 그린다. */
  onProgress?: (text: string) => void;
}

/** 스트리밍 가능한 fetch — 기업 탭과 같은 방식(RN 기본 fetch는 body.getReader()가 없다). */
async function loadStreamingFetch(): Promise<typeof fetch> {
  try {
    const mod = (await import('expo/fetch')) as { fetch?: unknown };
    if (typeof mod.fetch === 'function') return mod.fetch as typeof fetch;
  } catch {
    /* expo 런타임 아님 */
  }
  return fetch;
}

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
 * 대화 한 턴 — messages의 마지막이 사용자 질문이어야 한다. 답변 전문을 돌려주고, 도중엔 onProgress로 흘린다.
 * 프록시가 200이 아니면 본문을 메시지로 throw(화면이 "답을 못 가져왔어요"로 받는다).
 */
export async function askHelp(
  messages: readonly HelpMessage[],
  ctx: HelpPromptContext = {},
  deps: AskHelpDeps = {},
): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? (await loadStreamingFetch());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(deps.endpoint ?? HELP_CHAT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildHelpRequestBody(messages, ctx)),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
    const text = await readBodyStreaming(res, deps.onProgress);
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}

/** 빈 화면에 띄우는 추천 질문 — 매뉴얼이 확실히 답할 수 있는 것들로 고른다. */
export const SUGGESTED_QUESTIONS: readonly string[] = [
  '자동 트레이딩은 어떻게 시작해요?',
  '지금 설정으로 한 종목에 얼마가 들어가요?',
  '시작했는데 왜 아무것도 안 사요?',
  '어떤 기준으로 사고팔아요?',
  '앱을 꺼도 매매가 되나요?',
];
