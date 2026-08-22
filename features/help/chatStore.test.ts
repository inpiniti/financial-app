import { describe, expect, it } from 'vitest';
import {
  HELP_CHAT_KEY,
  MAX_STORED_MESSAGES,
  clearHelpChat,
  readHelpChat,
  writeHelpChat,
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

describe('도움말 대화 기록 저장', () => {
  it('쓴 대로 읽힌다 — 화면을 나갔다 와도 말풍선이 남는다', async () => {
    const s = memStore();
    await writeHelpChat(s, [
      { role: 'user', text: '왜 안 팔아요?', at: 1 },
      { role: 'model', text: '4선이 아직 안 꺾였어요.', at: 2 },
    ]);
    expect(await readHelpChat(s)).toEqual([
      { role: 'user', text: '왜 안 팔아요?', at: 1 },
      { role: 'model', text: '4선이 아직 안 꺾였어요.', at: 2 },
    ]);
  });

  it('저장된 게 없거나 파손이면 빈 배열 — 화면이 깨지지 않는다', async () => {
    const s = memStore();
    expect(await readHelpChat(s)).toEqual([]);
    s.map.set(HELP_CHAT_KEY, '{ 이건 JSON이 아니다');
    expect(await readHelpChat(s)).toEqual([]);
    s.map.set(HELP_CHAT_KEY, JSON.stringify([{ role: 'system', text: 'x' }, { role: 'user' }, 3]));
    expect(await readHelpChat(s)).toEqual([]);
  });

  it('상한을 넘으면 오래된 쪽부터 버린다', async () => {
    const s = memStore();
    const many = Array.from({ length: MAX_STORED_MESSAGES + 5 }, (_, i) => ({
      role: 'user' as const,
      text: `q${i}`,
    }));
    await writeHelpChat(s, many);
    const got = await readHelpChat(s);
    expect(got).toHaveLength(MAX_STORED_MESSAGES);
    expect(got[0].text).toBe('q5');
    expect(got[got.length - 1].text).toBe(`q${MAX_STORED_MESSAGES + 4}`);
  });

  it('지우면 빈 대화가 된다', async () => {
    const s = memStore();
    await writeHelpChat(s, [{ role: 'user', text: 'a' }]);
    await clearHelpChat(s);
    expect(await readHelpChat(s)).toEqual([]);
  });
});
