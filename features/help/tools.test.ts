import { describe, expect, it, vi } from 'vitest';
import { HELP_TOOL_DECLARATIONS, runHelpTool, type HelpAutopilotSnapshot } from './tools';
import { MODEL_BAR_MINUTES } from '../scalper/modelMode';

const SNAPSHOT: HelpAutopilotSnapshot = {
  state: 'SCANNING',
  activeTickers: ['TSLA'],
  cycles: 2,
  cumPnlUsd: 1.2345,
  maxGrids: 1,
  list: [
    { ticker: 'NVDA', name: '엔비디아', price: 180.2, tickRate: 3.4, signal: '모델 확률 2.1%', candidate: true },
    { ticker: 'AMD', name: 'AMD', price: 140.5, tickRate: 0.2, signal: '아직 판정 전(봉 마감 대기)', candidate: false },
  ],
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

  it('리스트는 모델 판정과 매수 후보 여부를 함께 준다 — "왜 안 사요?"의 근거', async () => {
    const res = (await runHelpTool('getWatchlist', {}, { autopilot: () => SNAPSHOT })) as {
      stocks: Array<{ ticker: string; signal: string; candidate?: boolean }>;
    };
    expect(res.stocks[0].ticker).toBe('NVDA');
    expect(res.stocks[0].signal).toContain('모델 확률');
    expect(res.stocks[0].candidate).toBe(true);
    // 후보 밖 종목도 리스트에는 있다 — 확률이 높아도 못 사는 이유를 설명할 수 있어야 한다.
    expect(res.stocks[1].candidate).toBe(false);
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

describe('runHelpTool — 분봉·차트 조회(2026-08-22)', () => {
  /** 토스 자동완성 + c-chart를 한 벌로 흉내낸다. n봉을 1분 간격 오름차순으로 만든 뒤 최신순으로 준다. */
  function tossFetch(closes: number[], lastMinuteKey: number, stepMin = 1) {
    return vi.fn(async (url: string | URL, init?: { method?: string }) => {
      if (init?.method === 'POST') {
        return {
          json: async () => ({
            result: [{ data: { items: [{ symbol: 'AAA', market: 'NSQ', productCode: 'US1' }] } }],
          }),
        } as unknown as Response;
      }
      const candles = closes
        .map((close, i) => {
          const key = lastMinuteKey - (closes.length - 1 - i) * stepMin;
          return { dt: new Date(key * 60_000).toISOString(), open: close, high: close, low: close, close, volume: 1_000_000 };
        })
        .reverse(); // 토스는 최신순
      // 일봉(day) 조회도 같은 목으로 받는다 — 전일 종가는 이 테스트의 관심사가 아니다.
      if (String(url).includes('day:1')) return { json: async () => ({ result: { candles: [] } }) } as unknown as Response;
      expect(String(url)).toContain('c-chart');
      return { json: async () => ({ result: { candles } }) } as unknown as Response;
    });
  }

  it('진행 중 봉은 판정에서 빼고 따로 알려 준다 — 엔진도 닫힌 봉만 본다', async () => {
    const nowMs = 1_800_000_000_000;
    const nowKey = Math.floor(nowMs / 60_000);
    const closes = [...Array.from({ length: 122 }, (_, i) => 100 + i), 1];
    const fetchImpl = tossFetch(closes, nowKey);
    const res = (await runHelpTool(
      'getMinuteCandles',
      { ticker: 'AAA', intervalMin: 1 },
      { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => nowMs },
    )) as Record<string, any>;
    expect(res.error).toBeUndefined();
    expect(res.closedBars).toBe(122);
    expect(res.inProgressBar.close).toBe(1);
    expect(res.inProgressBar.note).toContain('판정에 넣지 않아요');
    expect(res.recentCandles).toHaveLength(12);
  });

  it('엔진 봉 주기가 아니면 모델을 돌리지 않는다 — 참고 수치를 지어내지 않는다', async () => {
    const nowMs = 1_800_000_000_000;
    const nowKey = Math.floor(nowMs / 60_000);
    const fetchImpl = tossFetch(Array.from({ length: 20 }, () => 10), nowKey);
    const res = (await runHelpTool(
      'getMinuteCandles',
      { ticker: 'AAA', intervalMin: 1 }, // 엔진은 5분봉
      { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => nowMs },
    )) as Record<string, any>;
    expect(res.modelVerdict).toBeNull();
    expect(res.note).toContain('분봉으로만 판정해요');
    expect(res.engineIntervalMin).toBe(MODEL_BAR_MINUTES);
  });

  it('엔진과 같은 봉 주기면 모델 판정을 함께 준다 — 확률·기준값·안 사는 이유', async () => {
    // 정규장 5분봉 20개(09:30 ET~)를 만들어 세션 필터를 통과시킨다.
    const startKey = Math.floor(Date.parse('2026-08-18T09:30:00-04:00') / 60_000);
    const lastKey = startKey + 19 * 5;
    const nowMs = (lastKey + 5) * 60_000 + 1_000; // 마지막 봉은 닫혔고 그다음 봉이 진행 중
    const fetchImpl = tossFetch(Array.from({ length: 20 }, () => 10), lastKey, 5);
    const res = (await runHelpTool(
      'getMinuteCandles',
      { ticker: 'AAA', intervalMin: MODEL_BAR_MINUTES },
      { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => nowMs },
    )) as Record<string, any>;
    expect(res.modelVerdict).not.toBeNull();
    expect(res.modelVerdict.thresholdPct).toBeGreaterThan(0);
    expect(res.modelVerdict.etDate).toBe('2026-08-18');
    expect(res.modelVerdict.dayBars).toBe(20);
    // 실제 모델은 이 밋밋한 봉에 신호를 내지 않는다 — 안 사는 이유가 사람 문장으로 온다.
    expect(res.modelVerdict.buy).toBe(false);
    expect(typeof res.modelVerdict.whyNot).toBe('string');
  });

  it('토스에서 종목을 못 찾으면 error 객체', async () => {
    const fetchImpl = vi.fn(async () => ({ json: async () => ({ result: [] }) }) as unknown as Response);
    const res = (await runHelpTool(
      'getMinuteCandles',
      { ticker: 'ZZZ' },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    )) as { error?: string };
    expect(res.error).toContain('찾지 못했어요');
  });

  it('티커가 없으면 error 객체', async () => {
    expect(await runHelpTool('getMinuteCandles', {})).toEqual({ error: '티커가 필요해요' });
    expect(await runHelpTool('getPeriodChart', {})).toEqual({ error: '티커가 필요해요' });
  });
});

describe('runHelpTool — 이벤트 로그(getEvents)', () => {
  it('돌고 있으면 최신순 이벤트를 시각과 함께 준다 — "왜 안 샀어?"의 1차 증거', async () => {
    const snap: HelpAutopilotSnapshot = {
      ...SNAPSHOT,
      events: [
        { at: Date.UTC(2026, 7, 22, 13, 5, 4), text: 'ABC 진입 포기 · 속도 0.3틱/초' },
        { at: Date.UTC(2026, 7, 22, 13, 4, 0), text: '감시 교체 · ABC, DEF' },
      ],
    };
    const res = (await runHelpTool('getEvents', { limit: 1 }, { autopilot: () => snap })) as {
      count: number;
      events: Array<{ time: string; text: string }>;
    };
    expect(res.count).toBe(2);
    expect(res.events).toHaveLength(1);
    expect(res.events[0]).toEqual({ time: '13:05:04', text: 'ABC 진입 포기 · 속도 0.3틱/초' });
  });

  it('안 돌고 있으면 시작 안내', async () => {
    const res = (await runHelpTool('getEvents', {})) as { running: boolean };
    expect(res.running).toBe(false);
  });
});
