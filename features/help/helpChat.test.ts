import { describe, expect, it, vi } from 'vitest';
import {
  FN_CLOSE,
  FN_OPEN,
  HISTORY_MAX_TURNS,
  MAX_TOOL_ROUNDS,
  askHelp,
  buildHelpRequestBody,
  buildHelpSystemInstruction,
  splitToolCalls,
  stripMarkdown,
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
  it('매뉴얼과 답변 규칙(앱 동작은 설명서만·조언 금지)을 함께 넣는다', () => {
    const text = buildHelpSystemInstruction();
    expect(text).toContain('SEEDTICK 사용 설명서');
    expect(text).toContain('설명서에 없어서 확실하지 않아요');
    expect(text).toContain('종목 추천, 주가 예측, 매매 조언');
  });

  it('앱 밖 일반 지식은 답해도 된다고 허용한다 — 설명서만 답하던 딱딱함의 해소(2026-08-21)', () => {
    const text = buildHelpSystemInstruction();
    expect(text).toContain('일반 지식');
    expect(text).toContain('아는 대로 답해도 된다');
  });

  it('조회만 가능하다고 못박는다 — 주문·설정 변경 요청은 화면 안내로 돌린다', () => {
    const text = buildHelpSystemInstruction();
    expect(text).toContain('조회만 할 수 있다');
    expect(text).toContain('설정 변경은 할 수 없다');
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

describe('splitToolCalls — 스트림에서 도구 호출을 분리한다', () => {
  const part = { functionCall: { name: 'getHoldings', args: {} }, thoughtSignature: 'sig-abc' };
  const marker = `${FN_OPEN}${JSON.stringify(part)}${FN_CLOSE}`;

  it('마커가 없으면 전문이 텍스트다', () => {
    expect(splitToolCalls('그냥 답변이에요')).toEqual({ text: '그냥 답변이에요', calls: [] });
  });

  it('마커를 걷어내고 파트를 통째로 보존한다 — thoughtSignature가 빠지면 다음 턴이 400이다', () => {
    const { text, calls } = splitToolCalls(`확인해 볼게요${marker}`);
    expect(text).toBe('확인해 볼게요');
    expect(calls).toHaveLength(1);
    expect(calls[0].thoughtSignature).toBe('sig-abc');
    expect(calls[0].functionCall.name).toBe('getHoldings');
  });

  it('여러 도구 호출도 순서대로 모은다', () => {
    expect(splitToolCalls(`${marker}${marker}`).calls).toHaveLength(2);
  });

  it('스트리밍 도중 반쯤 온 마커는 화면에 새지 않는다', () => {
    const half = `앞말${FN_OPEN}{"functionCall":{"name":"get`;
    expect(splitToolCalls(half)).toEqual({ text: '앞말', calls: [] });
  });

  it('깨진 JSON 마커는 무시한다(대화를 끊지 않는다)', () => {
    expect(splitToolCalls(`${FN_OPEN}{깨짐}${FN_CLOSE}답변`)).toEqual({ text: '답변', calls: [] });
  });
});

describe('askHelp — 도구 왕복 루프', () => {
  const callPart = { functionCall: { name: 'getHoldings', args: {} }, thoughtSignature: 'sig' };
  const okText = (text: string) => ({ ok: true, body: null, text: async () => text }) as unknown as Response;

  it('functionCall이 오면 도구를 실행하고 결과를 붙여 다시 묻는다', async () => {
    const bodies: any[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init: any) => {
      bodies.push(JSON.parse(init.body));
      return bodies.length === 1
        ? okText(`${FN_OPEN}${JSON.stringify(callPart)}${FN_CLOSE}`)
        : okText('TSLA 3주를 들고 계세요.');
    });
    const runTool = vi.fn(async () => ({ positions: [{ ticker: 'TSLA', qty: 3 }] }));
    const answer = await askHelp([{ role: 'user', text: '내 보유 뭐야?' }], {}, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      tools: [{ name: 'getHoldings' }],
      runTool,
    });

    expect(answer).toBe('TSLA 3주를 들고 계세요.');
    expect(runTool).toHaveBeenCalledWith('getHoldings', {});
    // 2번째 요청에는 model(functionCall) + user(functionResponse) 턴이 붙는다.
    const second = bodies[1].contents;
    expect(second).toHaveLength(3);
    expect(second[1].parts[0].thoughtSignature).toBe('sig');
    expect(second[2].parts[0].functionResponse.response).toEqual({ positions: [{ ticker: 'TSLA', qty: 3 }] });
  });

  it('도구 결과가 객체가 아니면 { value }로 감싼다 — Gemini가 배열·원시값을 거절한다', async () => {
    const bodies: any[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init: any) => {
      bodies.push(JSON.parse(init.body));
      return bodies.length === 1 ? okText(`${FN_OPEN}${JSON.stringify(callPart)}${FN_CLOSE}`) : okText('끝');
    });
    await askHelp([{ role: 'user', text: 'q' }], {}, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      tools: [{ name: 'getHoldings' }],
      runTool: async () => [1, 2, 3],
    });
    expect(bodies[1].contents[2].parts[0].functionResponse.response).toEqual({ value: [1, 2, 3] });
  });

  it('도구를 계속 부르기만 하면 상한에서 멈춘다', async () => {
    const fetchImpl = vi.fn(async () => okText(`${FN_OPEN}${JSON.stringify(callPart)}${FN_CLOSE}`));
    const answer = await askHelp([{ role: 'user', text: 'q' }], {}, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      tools: [{ name: 'getHoldings' }],
      runTool: async () => ({ ok: true }),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS + 1);
    expect(answer).toContain('답을 정리하지 못했어요');
  });

  it('도구 실행기가 없으면 호출을 무시하고 텍스트만 쓴다', async () => {
    const fetchImpl = vi.fn(async () => okText(`잠깐만요${FN_OPEN}${JSON.stringify(callPart)}${FN_CLOSE}`));
    const answer = await askHelp([{ role: 'user', text: 'q' }], {}, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      tools: [{ name: 'getHoldings' }],
    });
    expect(answer).toBe('잠깐만요');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('tools를 주면 요청 바디에 functionDeclarations로 실린다', async () => {
    let body: any;
    const fetchImpl = vi.fn(async (_u: unknown, init: any) => {
      body = JSON.parse(init.body);
      return okText('답');
    });
    await askHelp([{ role: 'user', text: 'q' }], {}, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      tools: [{ name: 'getHoldings' }],
    });
    expect(body.tools[0].functionDeclarations[0].name).toBe('getHoldings');
  });

  it('도구 없이 쓰면 tools 필드 자체가 없다(기업 탭과 같은 단순 호출)', async () => {
    let body: any;
    const fetchImpl = vi.fn(async (_u: unknown, init: any) => {
      body = JSON.parse(init.body);
      return okText('답');
    });
    await askHelp([{ role: 'user', text: 'q' }], {}, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(body.tools).toBeUndefined();
  });
});

describe('stripMarkdown — 화면은 RN <Text>라 서식이 글자로 보인다', () => {
  it('굵게·제목 표시를 걷어낸다', () => {
    expect(stripMarkdown('**TSLA** 3주')).toBe('TSLA 3주');
    expect(stripMarkdown('### 보유 종목')).toBe('보유 종목');
  });

  it('목록 기호는 "- "로 통일하고 남긴다', () => {
    expect(stripMarkdown('* 첫째\n+ 둘째')).toBe('- 첫째\n- 둘째');
  });

  it('곱셈·강조 아닌 별표는 건드리지 않는다', () => {
    expect(stripMarkdown('수량 3 * 가격 10')).toBe('수량 3 * 가격 10');
  });
});
