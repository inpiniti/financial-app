// 대화 기록 — 챗봇 대화를 **여러 개** 만들어 기기에 남긴다(2026-08-22. 처음엔 한 개였는데 사용자 요청으로 목록화).
//
// 왜: ChatGPT처럼 주제별로 대화를 나눠 두고 싶다는 요청. 하나뿐이면 "아까 그 진단"과 "오늘 새 질문"이 한 줄기로
// 섞이고, 프롬프트로 가는 히스토리(trimHistory 8턴)도 엉뚱한 맥락을 끌고 간다.
//
// 어디에: 기기 로컬 AsyncStorage. 서버로 보내지 않는다 — 대화에는 보유 종목·계좌 진단이 섞인다.
//   `help.chats`      → 요약 목록(최신순): { id, title, updatedAt, messageCount }
//   `help.chat.<id>`  → 그 대화의 말풍선 배열
//   `help.chat`       → **옛 단일 대화 키**. 처음 읽을 때 대화 하나로 옮기고 지운다(migrateLegacyChat).
//
// 무엇을: 성공한 말풍선만 저장한다(pending·failed는 다음 세션의 맥락으로 쓸모가 없다).
// 제목은 **첫 사용자 질문**에서 뽑는다 — 따로 물어보지 않는다(제목 짓기를 시키면 대화가 한 번 더 왕복한다).
import type { KeyValueStore } from '../scalper/types';
import type { HelpMessage } from './helpChat';

/** 요약 목록 키. */
export const CHAT_INDEX_KEY = 'help.chats';
/** 대화 본문 키 접두. */
export const CHAT_KEY_PREFIX = 'help.chat.';
/** 2026-08-22 오전에 쓰던 단일 대화 키 — 이관 대상. */
export const LEGACY_CHAT_KEY = 'help.chat';

/** 한 대화의 말풍선 상한. 넘치면 오래된 쪽부터 버린다. */
export const MAX_MESSAGES_PER_CHAT = 200;
/** 보관하는 대화 수 상한. 넘치면 가장 오래 손대지 않은 대화부터 지운다. */
export const MAX_CHATS = 30;
/** 목록에 보여줄 제목 최대 길이. */
export const MAX_TITLE_LENGTH = 40;

/** 저장 레코드 — 표시 순서와 시각만 더한다. */
export interface StoredHelpMessage extends HelpMessage {
  /** 보낸 시각(epoch ms). 옛 기록에는 없을 수 있어 optional. */
  at?: number;
}

/** 목록 한 줄. */
export interface ChatSummary {
  id: string;
  /** 첫 사용자 질문에서 뽑은 제목. 질문이 아직 없으면 '새 대화'. */
  title: string;
  /** 마지막으로 저장된 시각(epoch ms) — 목록 정렬 기준. */
  updatedAt: number;
  messageCount: number;
}

export const NEW_CHAT_TITLE = '새 대화';

/** 대화 id — 만든 시각 기반. 같은 ms에 두 번 만들 일은 사람 손으로는 없다. */
export function newChatId(nowMs: number): string {
  return `c${Math.floor(nowMs)}`;
}

const chatKey = (id: string): string => `${CHAT_KEY_PREFIX}${id}`;

/** 첫 사용자 질문 → 제목. 줄바꿈은 공백으로 접고, 길면 잘라 …를 붙인다. */
export function titleFrom(messages: readonly StoredHelpMessage[]): string {
  const first = messages.find((m) => m.role === 'user')?.text.replace(/\s+/g, ' ').trim();
  if (!first) return NEW_CHAT_TITLE;
  return first.length <= MAX_TITLE_LENGTH ? first : `${first.slice(0, MAX_TITLE_LENGTH)}…`;
}

function isMessage(m: unknown): m is StoredHelpMessage {
  if (typeof m !== 'object' || m === null) return false;
  const role = (m as HelpMessage).role;
  return (role === 'user' || role === 'model') && typeof (m as HelpMessage).text === 'string';
}

async function readJson(storage: KeyValueStore, key: string): Promise<unknown> {
  const raw = await storage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // 파손된 저장값 — 없는 것으로 본다(다음 저장이 덮어쓴다).
    return null;
  }
}

/** 대화 목록(최신순). 없거나 파손이면 빈 배열. */
export async function listChats(storage: KeyValueStore): Promise<ChatSummary[]> {
  const parsed = await readJson(storage, CHAT_INDEX_KEY);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(
      (c): c is ChatSummary =>
        typeof c === 'object' &&
        c !== null &&
        typeof (c as ChatSummary).id === 'string' &&
        typeof (c as ChatSummary).title === 'string' &&
        Number.isFinite((c as ChatSummary).updatedAt),
    )
    .map((c) => ({ ...c, messageCount: Number.isFinite(c.messageCount) ? c.messageCount : 0 }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 대화 하나의 말풍선. 없거나 파손이면 빈 배열. */
export async function readChat(storage: KeyValueStore, id: string): Promise<StoredHelpMessage[]> {
  const parsed = await readJson(storage, chatKey(id));
  return Array.isArray(parsed) ? parsed.filter(isMessage) : [];
}

/**
 * 대화 하나를 덮어쓰고 목록을 갱신한다. 빈 대화는 저장하지 않고 **지운다**
 * (새 대화를 열었다 아무것도 안 묻고 나가면 빈 줄이 목록에 쌓인다).
 * 상한을 넘긴 오래된 대화는 목록과 본문을 함께 지운다.
 */
export async function saveChat(
  storage: KeyValueStore,
  id: string,
  messages: readonly StoredHelpMessage[],
  nowMs: number,
): Promise<ChatSummary[]> {
  const kept = messages.slice(-MAX_MESSAGES_PER_CHAT);
  if (kept.length === 0) return deleteChat(storage, id);

  await storage.setItem(chatKey(id), JSON.stringify(kept));
  const summary: ChatSummary = {
    id,
    title: titleFrom(kept),
    updatedAt: nowMs,
    messageCount: kept.length,
  };
  const rest = (await listChats(storage)).filter((c) => c.id !== id);
  const next = [summary, ...rest];
  const dropped = next.slice(MAX_CHATS);
  const head = next.slice(0, MAX_CHATS);
  for (const c of dropped) await storage.removeItem(chatKey(c.id));
  await storage.setItem(CHAT_INDEX_KEY, JSON.stringify(head));
  return head;
}

/** 대화 하나를 지운다(본문 + 목록). 남은 목록을 돌려준다. */
export async function deleteChat(storage: KeyValueStore, id: string): Promise<ChatSummary[]> {
  await storage.removeItem(chatKey(id));
  const next = (await listChats(storage)).filter((c) => c.id !== id);
  await storage.setItem(CHAT_INDEX_KEY, JSON.stringify(next));
  return next;
}

/**
 * 옛 단일 대화(`help.chat`)를 대화 하나로 옮긴다 — 앱을 올리면서 기록이 사라지지 않게.
 * 이관했으면 그 대화의 id, 옮길 게 없으면 null. 두 번째 호출부터는 옛 키가 없어 항상 null이다.
 */
export async function migrateLegacyChat(storage: KeyValueStore, nowMs: number): Promise<string | null> {
  const parsed = await readJson(storage, LEGACY_CHAT_KEY);
  await storage.removeItem(LEGACY_CHAT_KEY);
  if (!Array.isArray(parsed)) return null;
  const messages = parsed.filter(isMessage);
  if (messages.length === 0) return null;
  const id = newChatId(nowMs);
  await saveChat(storage, id, messages, nowMs);
  return id;
}
