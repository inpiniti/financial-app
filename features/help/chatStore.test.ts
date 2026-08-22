import { describe, expect, it } from 'vitest';
import {
  CHAT_INDEX_KEY,
  CHAT_KEY_PREFIX,
  LEGACY_CHAT_KEY,
  MAX_CHATS,
  MAX_MESSAGES_PER_CHAT,
  NEW_CHAT_TITLE,
  deleteChat,
  listChats,
  migrateLegacyChat,
  newChatId,
  readChat,
  saveChat,
  titleFrom,
} from './chatStore';

function memStore() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: async (k: string) => map.get(k) ?? null,
    setItem: async (k: string, v: string) => void map.set(k, v),
    removeItem: async (k: string) => void map.delete(k),
  };
}

const q = (text: string) => ({ role: 'user' as const, text });
const a = (text: string) => ({ role: 'model' as const, text });

describe('대화 기록 저장 — 여러 대화', () => {
  it('대화를 여러 개 만들고 각각 따로 읽는다', async () => {
    const s = memStore();
    await saveChat(s, 'c1', [q('왜 안 팔아요?'), a('4선이 아직 안 꺾였어요.')], 100);
    await saveChat(s, 'c2', [q('NVDA 시세 알려줘')], 200);

    expect(await readChat(s, 'c1')).toEqual([q('왜 안 팔아요?'), a('4선이 아직 안 꺾였어요.')]);
    expect(await readChat(s, 'c2')).toEqual([q('NVDA 시세 알려줘')]);
    // 목록은 최신순.
    expect((await listChats(s)).map((c) => c.id)).toEqual(['c2', 'c1']);
  });

  it('제목은 첫 사용자 질문에서 뽑는다 — 길면 자르고, 질문이 없으면 "새 대화"', async () => {
    expect(titleFrom([a('답변부터 있을 수는 없지만')])).toBe(NEW_CHAT_TITLE);
    expect(titleFrom([])).toBe(NEW_CHAT_TITLE);
    expect(titleFrom([q('  왜  안\n팔아요?  '), q('두 번째는 안 본다')])).toBe('왜 안 팔아요?');
    const long = 'ㄱ'.repeat(60);
    expect(titleFrom([q(long)])).toBe(`${'ㄱ'.repeat(40)}…`);
  });

  it('빈 대화는 저장하지 않고 지운다 — 열었다 그냥 나간 대화가 목록에 쌓이지 않게', async () => {
    const s = memStore();
    await saveChat(s, 'c1', [q('안녕')], 100);
    expect(await listChats(s)).toHaveLength(1);
    await saveChat(s, 'c1', [], 200);
    expect(await listChats(s)).toEqual([]);
    expect(s.map.has(`${CHAT_KEY_PREFIX}c1`)).toBe(false);
  });

  it('지우면 본문과 목록에서 함께 사라진다', async () => {
    const s = memStore();
    await saveChat(s, 'c1', [q('a')], 100);
    await saveChat(s, 'c2', [q('b')], 200);
    const rest = await deleteChat(s, 'c1');
    expect(rest.map((c) => c.id)).toEqual(['c2']);
    expect(await readChat(s, 'c1')).toEqual([]);
    expect(s.map.has(`${CHAT_KEY_PREFIX}c1`)).toBe(false);
  });

  it('대화 수 상한을 넘으면 가장 오래 손대지 않은 것부터 본문까지 지운다', async () => {
    const s = memStore();
    for (let i = 0; i < MAX_CHATS + 3; i += 1) await saveChat(s, `c${i}`, [q(`질문 ${i}`)], 1000 + i);
    const list = await listChats(s);
    expect(list).toHaveLength(MAX_CHATS);
    expect(list[0].id).toBe(`c${MAX_CHATS + 2}`); // 최신
    expect(s.map.has(`${CHAT_KEY_PREFIX}c0`)).toBe(false); // 가장 오래된 것의 본문도 지워졌다
  });

  it('한 대화의 말풍선 상한을 넘으면 오래된 쪽부터 버린다', async () => {
    const s = memStore();
    const many = Array.from({ length: MAX_MESSAGES_PER_CHAT + 5 }, (_, i) => q(`q${i}`));
    await saveChat(s, 'c1', many, 100);
    const got = await readChat(s, 'c1');
    expect(got).toHaveLength(MAX_MESSAGES_PER_CHAT);
    expect(got[0].text).toBe('q5');
  });

  it('저장된 게 없거나 파손이면 빈 값 — 화면이 깨지지 않는다', async () => {
    const s = memStore();
    expect(await listChats(s)).toEqual([]);
    expect(await readChat(s, 'nope')).toEqual([]);
    s.map.set(CHAT_INDEX_KEY, '{ 이건 JSON이 아니다');
    expect(await listChats(s)).toEqual([]);
    s.map.set(CHAT_INDEX_KEY, JSON.stringify([{ id: 'x' }, 3, { title: 'y', updatedAt: 1 }]));
    expect(await listChats(s)).toEqual([]);
    s.map.set(`${CHAT_KEY_PREFIX}c1`, JSON.stringify([{ role: 'system', text: 'x' }, 3]));
    expect(await readChat(s, 'c1')).toEqual([]);
  });

  it('옛 단일 대화(help.chat)는 대화 하나로 옮기고 옛 키를 지운다 — 한 번만', async () => {
    const s = memStore();
    s.map.set(LEGACY_CHAT_KEY, JSON.stringify([q('예전에 물어본 것'), a('예전 답')]));
    const id = await migrateLegacyChat(s, 500);
    expect(id).toBe(newChatId(500));
    expect(s.map.has(LEGACY_CHAT_KEY)).toBe(false);
    expect(await readChat(s, id!)).toEqual([q('예전에 물어본 것'), a('예전 답')]);
    expect((await listChats(s))[0].title).toBe('예전에 물어본 것');
    expect(await migrateLegacyChat(s, 600)).toBeNull(); // 두 번째부터는 옮길 게 없다
  });

  it('옛 키가 비었거나 파손이면 이관하지 않는다', async () => {
    const s = memStore();
    expect(await migrateLegacyChat(s, 1)).toBeNull();
    s.map.set(LEGACY_CHAT_KEY, '망가진 값');
    expect(await migrateLegacyChat(s, 2)).toBeNull();
    s.map.set(LEGACY_CHAT_KEY, JSON.stringify([]));
    expect(await migrateLegacyChat(s, 3)).toBeNull();
    expect(await listChats(s)).toEqual([]);
  });
});
