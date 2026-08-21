import { describe, expect, it, vi } from 'vitest';
import {
  HISTORY_MAX_TURNS,
  askHelp,
  buildHelpRequestBody,
  buildHelpSystemInstruction,
  trimHistory,
  type HelpMessage,
} from './helpChat';
import { DEFAULT_APP_SETTINGS } from '../../lib/appSettings';

type Body = {
  contents: Array<{ role: string; parts: Array<{ text: string }> }>;
  systemInstruction: { parts: Array<{ text: string }> };
  generationConfig: Record<string, unknown>;
};

const bodyOf = (...args: Parameters<typeof buildHelpRequestBody>) =>
  buildHelpRequestBody(...args) as Body;

describe('buildHelpSystemInstruction', () => {
  it('매뉴얼과 답변 규칙(모르면 모른다·조언 금지)을 함께 넣는다', () => {
    const text = buildHelpSystemInstruction();
    expect(text).toContain('SEEDTICK 사용 설명서');
    expect(text).toContain('설명서에 없어서 확실하지 않아요');
    expect(text).toContain('종목 추천·주가 예측·매매 조언');
  });

  it('설정을 주면 "지금 실제로 걸린 값"으로 덧붙인다', () => {
    const text = buildHelpSystemInstruction({
      settings: { ...DEFAULT_APP_SETTINGS, entryQty: 3 },
    });
    expect(text).toContain('[사용자의 현재 상태]');
    expect(text).toContain('수량 고정 3주');
  });

  it('상태를 안 주면 상태 블록 자체가 없다 — 모델이 빈 값을 채워 넣지 않게', () => {
    expect(buildHelpSystemInstruction()).not.toContain('[사용자의 현재 상태]');
    expect(buildHelpSystemInstruction({ runtime: {} })).not.toContain('[사용자의 현재 상태]');
  });
});

describe('trimHistory — 최근 턴만 보낸다', () => {
  it('상한 이하는 그대로 둔다', () => {
    const msgs: HelpMessage[] = [{ role: 'user', text: 'a' }];
    expect(trimHistory(msgs)).toEqual(msgs);
  });

  it('넘치면 오래된 턴부터 버리고 마지막 질문은 반드시 남긴다', () => {
    const msgs: HelpMessage[] = Array.from({ length: HISTORY_MAX_TURNS + 4 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('model' as const),
      text: `m${i}`,
    }));
    const trimmed = trimHistory(msgs);
    expect(trimmed).toHaveLength(HISTORY_MAX_TURNS);
    expect(trimmed[trimmed.length - 1]).toEqual(msgs[msgs.length - 1]);
    expect(trimmed[0].text).toBe('m4');
  });
});

describe('buildHelpRequestBody', () => {
  it('대화를 contents 배열로 그대로 넘긴다(멀티턴)', () => {
    const body = bodyOf([
      { role: 'user', text: '어떻게 시작해요?' },
      { role: 'model', text: '설정에서…' },
      { role: 'user', text: '그럼 정지는요?' },
    ]);
    expect(body.contents).toHaveLength(3);
    expect(body.contents[1].role).toBe('model');
    expect(body.contents[2].parts[0].text).toBe('그럼 정지는요?');
  });

  it('기업 탭과 달리 JSON 모드가 아니다 — 답변은 자유 텍스트다', () => {
    expect(bodyOf([{ role: 'user', text: 'q' }]).generationConfig.responseMimeType).toBeUndefined();
  });
});

describe('askHelp', () => {
  const okResponse = (text: string) =>
    ({ ok: true, body: null, text: async () => text }) as unknown as Response;

  it('응답 본문을 다듬어 돌려준다', async () => {
    const fetchImpl = vi.fn(async () => okResponse('  네, 설정에서 정해요.  '));
    const answer = await askHelp([{ role: 'user', text: 'q' }], {}, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      endpoint: 'https://example.test/gemini',
    });
    expect(answer).toBe('네, 설정에서 정해요.');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('프록시가 200이 아니면 본문을 메시지로 던진다', async () => {
    const fetchImpl = vi.fn(
      async () => ({ ok: false, status: 429, text: async () => '할당량 초과' }) as unknown as Response,
    );
    await expect(
      askHelp([{ role: 'user', text: 'q' }], {}, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow('할당량 초과');
  });

  it('스트리밍 응답은 조각마다 onProgress로 흘린다', async () => {
    const chunks = ['안녕', '하세요'].map((s) => new TextEncoder().encode(s));
    let i = 0;
    const res = {
      ok: true,
      body: {
        getReader: () => ({
          read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }),
        }),
      },
      text: async () => '',
    } as unknown as Response;
    const seen: string[] = [];
    const answer = await askHelp([{ role: 'user', text: 'q' }], {}, {
      fetchImpl: (async () => res) as unknown as typeof fetch,
      onProgress: (t) => seen.push(t),
    });
    expect(seen).toEqual(['안녕', '안녕하세요']);
    expect(answer).toBe('안녕하세요');
  });
});
