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

/** 도구 호출 왕복 상한 — 한 질문에 도구를 몇 번까지 부를 수 있나(무한 호출 방어). */
export const MAX_TOOL_ROUNDS = 4;

/** 프록시가 functionCall 파트를 실어 보내는 마커(bitcoin-simulation api/simple/gemini.js와 같은 문자열). */
export const FN_OPEN = '[[FN_CALL]]';
export const FN_CLOSE = '[[/FN_CALL]]';

export interface HelpMessage {
  role: 'user' | 'model';
  text: string;
}

/** Gemini contents의 한 턴 — 텍스트 턴이거나, 도구 호출/응답 턴이다. */
type Content = { role: string; parts: unknown[] };

/** 프록시가 넘긴 functionCall 파트(그대로 되돌려야 한다 — thoughtSignature 포함). */
export interface ToolCallPart {
  functionCall: { name: string; args?: Record<string, unknown> };
  [key: string]: unknown;
}

export interface StreamSplit {
  /** 마커를 걷어낸 사람이 읽을 텍스트. */
  text: string;
  /** 모델이 부르려는 도구들(파트 원본 그대로). */
  calls: ToolCallPart[];
}

/**
 * 스트림 원문 → 텍스트와 도구 호출로 분리. 마커가 없으면 지금까지와 똑같이 전문이 텍스트다.
 * 스트리밍 도중 마커가 반쯤 온 조각도 화면에 새지 않도록, 닫히지 않은 여는 마커 뒤는 잘라 낸다.
 */
export function splitToolCalls(raw: string): StreamSplit {
  const calls: ToolCallPart[] = [];
  let text = '';
  let rest = raw;
  for (;;) {
    const open = rest.indexOf(FN_OPEN);
    if (open < 0) {
      text += rest;
      break;
    }
    text += rest.slice(0, open);
    const close = rest.indexOf(FN_CLOSE, open);
    if (close < 0) break; // 아직 덜 온 마커 — 뒤는 버린다(다음 조각에서 다시 판단).
    const json = rest.slice(open + FN_OPEN.length, close);
    try {
      const part = JSON.parse(json) as ToolCallPart;
      if (part?.functionCall?.name) calls.push(part);
    } catch {
      /* 깨진 마커는 무시 */
    }
    rest = rest.slice(close + FN_CLOSE.length);
  }
  return { text: text.trim(), calls };
}

/**
 * 답변 규칙. 상태 블록이 없을 때 그 블록을 언급하지 않는다 — 없는 자료를 가리키면 모델이 값을 지어낸다.
 */
export function systemInstructionHead(hasState: boolean): string {
  const stateBlock = hasState ? '와 [사용자의 현재 상태]' : '';
  return [
    '너는 SEEDTICK 앱을 쓰는 사람을 돕는 도우미다. 앱 사용법은 물론이고 주식·시장·용어 같은 일반적인 질문에도 아는 만큼 답한다.',
    '',
    '근거를 고르는 규칙:',
    `1. **앱이 어떻게 동작하는지**(매매 규칙·설정·화면·버튼)는 아래 [사용 설명서]${stateBlock}만 근거로 삼는다. 기억에 있는 값을 쓰지 않는다. 설명서에 없으면 "설명서에 없어서 확실하지 않아요"라고 말한다.`,
    '2. **사용자의 실제 데이터**(보유 종목·미체결·오늘 매매·시세·감시 목록)가 필요하면 추측하지 말고 도구를 부른다. 도구 결과에 있는 숫자만 쓴다.',
    '3. **앱 밖의 최신 소식**은 searchWeb / getStockNews 도구로 찾아보고, 찾은 내용을 근거로 답한다.',
    '4. 그 밖의 일반 지식(용어 뜻, 시장 상식, 개념 설명)은 네가 아는 대로 답해도 된다. 다만 확실하지 않으면 확실하지 않다고 말하고, 시세·실적처럼 시점을 타는 숫자는 기억으로 말하지 말고 도구로 확인한다.',
    '',
    '지켜야 할 선:',
    '- 종목 추천, 주가 예측, 매매 조언, 수익 보장은 하지 않는다. 물어보면 이 앱과 도우미는 그런 판단을 하지 않는다고 알려 주고, 대신 사실(뉴스·지표·앱 규칙)을 정리해 준다.',
    '- 너는 조회만 할 수 있다. 주문·정정·취소·자동매매 시작이나 정지·설정 변경은 할 수 없다. 그런 요청을 받으면 어느 화면의 어느 버튼으로 직접 하면 되는지 안내한다.',
    '',
    // 화면은 마크다운을 렌더하지 않는 RN <Text>다 — **굵게**가 별표 그대로 보인다(2026-08-21 실측).
    '답하는 방식: 한국어 "~해요"체, 3~6문장 또는 짧은 목록으로 간결하게.',
    '서식은 쓰지 않는다 — 표·코드블록·제목(#)·굵게(**)를 쓰지 말고, 목록이 필요하면 "- "로 시작하는 줄만 쓴다.',
    '무엇을 눌러야 하는지 물으면 화면 이름과 버튼 이름을 그대로 짚어 준다.',
  ].join('\n');
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

/** 대화 메시지 → Gemini contents. 도구 왕복이 붙으면 이 뒤에 model(functionCall)·user(functionResponse) 턴이 쌓인다. */
export function contentsFrom(messages: readonly HelpMessage[]): Content[] {
  return trimHistory(messages).map((m) => ({ role: m.role, parts: [{ text: m.text }] }));
}

/**
 * 프록시 요청 바디 — 기업 탭과 달리 JSON 모드가 아니다(자유 텍스트).
 * tools를 주면 모델이 도구를 부를 수 있다(읽기 전용 — features/help/tools.ts).
 */
export function buildHelpRequestBody(
  messagesOrContents: readonly HelpMessage[] | Content[],
  ctx: HelpPromptContext = {},
  tools?: readonly unknown[],
): unknown {
  const contents = Array.isArray(messagesOrContents) && messagesOrContents.some((m) => 'parts' in (m as object))
    ? (messagesOrContents as Content[])
    : contentsFrom(messagesOrContents as HelpMessage[]);
  return {
    contents,
    systemInstruction: { parts: [{ text: buildHelpSystemInstruction(ctx) }] },
    generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
    ...(tools && tools.length ? { tools: [{ functionDeclarations: tools }] } : {}),
  };
}

export interface AskHelpDeps {
  /** HTTP 구현. 미주입이면 스트리밍 가능한 expo/fetch(없으면 전역 fetch). */
  fetchImpl?: typeof fetch;
  endpoint?: string;
  /** 지금까지 받은 답변 누적 — 화면이 타이핑처럼 그린다. */
  onProgress?: (text: string) => void;
  /** 모델에게 알려 줄 도구 선언(HELP_TOOL_DECLARATIONS). 없으면 도구 없이 답한다. */
  tools?: readonly unknown[];
  /** 도구 실행기(runHelpTool). tools가 있어도 이게 없으면 호출을 무시하고 텍스트만 쓴다. */
  runTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** 도구를 부르기 시작할 때 — 화면이 "보유 종목을 확인하고 있어요" 같은 표시를 하기 위해. */
  onToolStart?: (names: string[]) => void;
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
 * 남은 마크다운 표시를 걷어낸다 — 프롬프트로 막아도 모델이 가끔 **굵게**·### 를 쓴다.
 * 화면이 RN <Text>라 그대로 두면 별표가 글자로 보인다. 목록의 "- "는 읽기 좋아 남긴다.
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(^|\s)\*(?!\s)(.+?)(?<!\s)\*(?=\s|$)/g, '$1$2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[*+]\s+/gm, '- ');
}

/** 프록시 1회 호출 — 원문(마커 포함)을 돌려준다. */
async function callProxy(
  body: unknown,
  deps: AskHelpDeps,
  onChunk?: (accumulated: string) => void,
): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? (await loadStreamingFetch());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(deps.endpoint ?? HELP_CHAT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
    return await readBodyStreaming(res, onChunk);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 대화 한 턴 — messages의 마지막이 사용자 질문이어야 한다. 답변 전문을 돌려주고, 도중엔 onProgress로 흘린다.
 *
 * 도구를 주면(deps.tools + deps.runTool) **왕복 루프**가 돈다:
 *   질문 → 모델이 functionCall → 앱이 도구 실행 → functionResponse를 붙여 재요청 → … → 텍스트 답변.
 * functionCall 파트는 **받은 그대로** 되돌린다 — Gemini 3.x는 thoughtSignature가 빠지면 400을 낸다.
 * 왕복은 MAX_TOOL_ROUNDS까지만(모델이 도구만 계속 부르는 상황 방어).
 * 프록시가 200이 아니면 본문을 메시지로 throw(화면이 "답을 못 가져왔어요"로 받는다).
 */
export async function askHelp(
  messages: readonly HelpMessage[],
  ctx: HelpPromptContext = {},
  deps: AskHelpDeps = {},
): Promise<string> {
  const contents = contentsFrom(messages);
  const tools = deps.tools;
  let answered = '';

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    // 도구를 부르는 중에는 마커가 화면에 새지 않게 splitToolCalls로 걸러서 흘린다.
    const raw = await callProxy(buildHelpRequestBody(contents, ctx, tools), deps, (acc) => {
      const text = stripMarkdown(splitToolCalls(acc).text);
      if (text) deps.onProgress?.(answered ? `${answered}\n${text}` : text);
    });
    const { text: rawText, calls } = splitToolCalls(raw);
    const text = stripMarkdown(rawText);

    if (calls.length === 0 || !deps.runTool || round === MAX_TOOL_ROUNDS) {
      const merged = [answered, text].filter(Boolean).join('\n').trim();
      // 도구만 부르고 끝난 경우(텍스트 없음) — 빈 답 대신 안내를 돌려준다.
      return merged || '지금은 답을 정리하지 못했어요. 조금 다르게 물어봐 주세요.';
    }

    // 도구를 부르기 전에 모델이 남긴 말이 있으면 살려 둔다("확인해 볼게요" 같은 한 줄).
    if (text) answered = answered ? `${answered}\n${text}` : text;
    deps.onToolStart?.(calls.map((c) => c.functionCall.name));

    const results = await Promise.all(
      calls.map(async (call) => ({
        name: call.functionCall.name,
        response: await deps.runTool!(call.functionCall.name, call.functionCall.args ?? {}),
      })),
    );
    contents.push({ role: 'model', parts: calls as unknown[] });
    contents.push({
      role: 'user',
      parts: results.map((r) => ({
        // response는 객체여야 한다(배열·원시값은 Gemini가 거절한다) — 아니면 값으로 감싼다.
        functionResponse: {
          name: r.name,
          response:
            r.response && typeof r.response === 'object' && !Array.isArray(r.response)
              ? (r.response as object)
              : { value: r.response },
        },
      })),
    });
  }
  return answered.trim();
}

/** 빈 화면에 띄우는 추천 질문 — 설명서·도구·검색을 골고루 보여 주는 것들로 고른다. */
export const SUGGESTED_QUESTIONS: readonly string[] = [
  '자동 트레이딩은 어떻게 시작해요?',
  '지금 내 보유 종목이랑 평가손익 알려줘',
  '오늘 매매한 내역이랑 왜 팔았는지 알려줘',
  '시작했는데 왜 아무것도 안 사요?',
  '엔비디아 요즘 무슨 일 있어?',
];
