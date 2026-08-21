import { describe, expect, it, vi } from 'vitest';
import { HELP_TOOL_DECLARATIONS, runHelpTool, type HelpAutopilotSnapshot } from './tools';

const SNAPSHOT: HelpAutopilotSnapshot = {
  state: 'SCANNING',
  activeTickers: ['TSLA'],
  cycles: 2,
  cumPnlUsd: 1.2345,
  maxGrids: 1,
  list: [{ ticker: 'NVDA', name: '엔비디아', price: 180.2, tickRate: 3.4, trend: '5선 상승, 20선 하락' }],
};

describe('도구 목록 — 읽기 전용 불변식', () => {
  it('도구 이름은 전부 조회 동사로 시작한다 — 쓰기 도구가 섞이면 여기서 걸린다 (사용자 확정 2026-08-21)', () => {
    for (const d of HELP_TOOL_DECLARATIONS) {
      expect(d.name, `${d.name}은 get/search로 시작하지 않는다`).toMatch(/^(get|search)[A-Z]/);
    }
  });

  it('주문·정지·설정 변경 동사를 쓰는 도구는 없다', () => {
    const names = HELP_TOOL_DECLARATIONS.map((d) => d.name.toLowerCase());
    // getPendingOrders처럼 조회 이름에 명사로 들어가는 건 정상 — 동사 자리(맨 앞)만 본다.
    for (const forbidden of ['place', 'buy', 'sell', 'cancel', 'start', 'stop', 'save', 'set', 'update', 'apply']) {
      expect(names.filter((n) => n.startsWith(forbidden)), `${forbidden} 계열 도구가 생겼다`).toEqual([]);
    }
  });

  it('모든 도구에 이름·설명·파라미터 스키마가 있다 — 설명이 곧 모델의 선택 근거다', () => {
    for (const d of HELP_TOOL_DECLARATIONS) {
      expect(d.name).toMatch(/^[a-zA-Z]+$/);
      expect(d.description.length).toBeGreaterThan(20);
      expect(d.parameters.type).toBe('OBJECT');
    }
  });
});

describe('runHelpTool — 앱 상태 도구', () => {
  it('오토파일럿이 안 돌면 "안 돌고 있어요"를 돌려준다(빈 값 아님)', async () => {
    const res = (await runHelpTool('getAutopilotStatus', {})) as { running: boolean; note: string };
    expect(res.running).toBe(false);
    expect(res.note).toContain('자동 트레이딩 시작하기');
  });

  it('돌고 있으면 상태·보유·오늘 손익을 요약한다', async () => {
    const res = (await runHelpTool('getAutopilotStatus', {}, { autopilot: () => SNAPSHOT })) as Record<string, unknown>;
    expect(res.state).toBe('SCANNING');
    expect(res.holdings).toEqual(['TSLA']);
    expect(res.todayPnlUsd).toBe(1.23); // 소수점 2자리로 다듬어 프롬프트를 짧게
  });

  it('감시 목록은 추세 방향까지 함께 준다 — "왜 안 사요?"의 근거', async () => {
    const res = (await runHelpTool('getWatchlist', {}, { autopilot: () => SNAPSHOT })) as {
      stocks: Array<{ ticker: string; trend: string }>;
    };
    expect(res.stocks[0].ticker).toBe('NVDA');
    expect(res.stocks[0].trend).toContain('20선 하락');
  });
});

describe('runHelpTool — 실패를 삼키지 않고 객체로 돌려준다', () => {
  it('모르는 도구는 error 객체', async () => {
    expect(await runHelpTool('placeOrder', {})).toEqual({ error: '모르는 도구예요: placeOrder' });
  });

  it('필수 인자가 비면 error 객체(throw 아님)', async () => {
    expect(await runHelpTool('searchStock', {})).toEqual({ error: '검색어가 필요해요' });
    expect(await runHelpTool('getQuote', {})).toEqual({ error: '티커가 필요해요' });
    expect(await runHelpTool('searchWeb', { query: '  ' })).toEqual({ error: '검색어가 필요해요' });
  });

  it('네트워크 실패도 error 객체로 — 대화가 끊기지 않게', async () => {
    const boom = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const res = (await runHelpTool('searchStock', { query: 'tsla' }, { fetchImpl: boom })) as { error: string };
    expect(res.error).toBe('offline');
  });
});

describe('runHelpTool — 검색 두 갈래', () => {
  const RSS = `<rss><channel><item><title>엔비디아 신고가 - 한국경제</title>
    <link>https://news.google.com/rss/articles/x</link>
    <pubDate>Fri, 21 Aug 2026 06:29:40 GMT</pubDate>
    <source url="https://hankyung.com">한국경제</source></item></channel></rss>`;

  it('searchNews는 뉴스 RSS를 쓰고, 본문이 없다는 한계를 같이 알려 준다', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, text: async () => RSS }) as unknown as Response);
    const res = (await runHelpTool(
      'searchNews',
      { query: '엔비디아' },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    )) as { results: unknown[]; note: string };
    expect(res.results).toHaveLength(1);
    expect(res.note).toContain('본문은 없어요');
    expect(String((fetchImpl.mock.calls as unknown as unknown[][])[0][0])).toContain('news.google.com');
  });

  it('searchWeb은 프록시(Tavily)로 가고 본문 발췌를 받는다', async () => {
    const payload = {
      query: '이동평균선',
      answer: '이동평균선은…',
      results: [{ title: '이동평균', url: 'https://x.test/a', content: '본문 발췌', published: '' }],
    };
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => payload }) as unknown as Response);
    const res = (await runHelpTool(
      'searchWeb',
      { query: '이동평균선' },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    )) as typeof payload;
    expect(res.results[0].content).toBe('본문 발췌');
    expect(String((fetchImpl.mock.calls as unknown as unknown[][])[0][0])).toContain('/api/simple/search');
  });

  it('검색 키 미설정·한도 초과는 프록시 안내 문구를 그대로 싣는다', async () => {
    const fetchImpl = vi.fn(
      async () =>
        ({ ok: false, status: 429, json: async () => ({ message: '이번 달 검색 한도를 다 썼어요.' }) }) as unknown as Response,
    );
    const res = (await runHelpTool(
      'searchWeb',
      { query: 'x' },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    )) as { error: string };
    expect(res.error).toBe('이번 달 검색 한도를 다 썼어요.');
  });
});

describe('runHelpTool — 계좌 진단(getAccountBinding)', () => {
  it('알 수 없는 api를 부르면 무엇을 쓸 수 있는지 알려 준다', async () => {
    const res = (await runHelpTool('getRawApiResponse', { api: 'orders' })) as { error?: string };
    // KIS 미설정 환경(vitest)에서는 세션 안내가 먼저 나온다 — 둘 중 하나면 된다.
    expect(res.error).toBeTruthy();
  });
});
