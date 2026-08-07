import { describe, expect, it, vi } from 'vitest';
import {
  inquirePriceFluctRanking,
  inquireTradeGrowthRanking,
  inquireTradeTurnoverRanking,
  inquireTradeVolumeRanking,
  inquireUpDownRateRanking,
  inquireVolumePowerRanking,
  inquireVolumeSurgeRanking,
  mergeRankingRows,
  RANKING_TR_ID,
  US_RANKING_EXCHANGES,
} from './ranking';

const credentials = { appKey: 'appkey-value', appSecret: 'appsecret-value' };

function mockFetch(output2: unknown[] = []) {
  return vi.fn().mockResolvedValue({
    json: async () => ({
      rt_cd: '0',
      msg_cd: 'MSG',
      msg1: 'ok',
      output1: { zdiv: '0', stat: 'ok' },
      output2,
    }),
  });
}

describe('거래량순위 (HHDFS76310010, NDAY=일 단위)', () => {
  it('TR ID·URL·파라미터가 거래량순위.md와 일치한다', async () => {
    const fetchImpl = mockFetch();
    await inquireTradeVolumeRanking(credentials, 'token', { excd: 'NAS', nday: '0' }, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain('https://openapi.koreainvestment.com:9443/uapi/overseas-stock/v1/ranking/trade-vol');
    expect(url).toContain('EXCD=NAS');
    expect(url).toContain('NDAY=0');
    expect(url).toContain('VOL_RANG=0');
    expect((init.headers as Record<string, string>).tr_id).toBe(RANKING_TR_ID.tradeVolume);
    expect((init.headers as Record<string, string>).tr_id).toBe('HHDFS76310010');
  });

  it('PRC1/PRC2 기본값은 0~999999다', async () => {
    const fetchImpl = mockFetch();
    await inquireTradeVolumeRanking(credentials, 'token', { excd: 'NYS', nday: '9' }, { fetchImpl });
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toContain('PRC1=0');
    expect(url).toContain('PRC2=999999');
  });
});

describe('거래량급증 (HHDFS76270000, MINX=분 단위)', () => {
  it('TR ID·파라미터가 거래량급증.md와 일치한다', async () => {
    const fetchImpl = mockFetch();
    await inquireVolumeSurgeRanking(credentials, 'token', { excd: 'AMS', minx: '3' }, { fetchImpl });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain('/ranking/volume-surge');
    expect(url).toContain('EXCD=AMS');
    expect(url).toContain('MINX=3');
    expect((init.headers as Record<string, string>).tr_id).toBe(RANKING_TR_ID.volumeSurge);
    expect((init.headers as Record<string, string>).tr_id).toBe('HHDFS76270000');
  });
});

describe('가격급등락 (HHDFS76260000, GUBN+MINX=분 단위)', () => {
  it('TR ID·GUBN·MINX가 가격급등락.md와 일치한다', async () => {
    const fetchImpl = mockFetch();
    await inquirePriceFluctRanking(credentials, 'token', { excd: 'NAS', gubn: '1', minx: '0' }, { fetchImpl });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain('/ranking/price-fluct');
    expect(url).toContain('GUBN=1');
    expect(url).toContain('MINX=0');
    expect((init.headers as Record<string, string>).tr_id).toBe(RANKING_TR_ID.priceFluct);
    expect((init.headers as Record<string, string>).tr_id).toBe('HHDFS76260000');
  });
});

describe('거래증가율순위 (HHDFS76330000, NDAY=일 단위)', () => {
  it('TR ID·NDAY가 거래증가율순위.md와 일치한다', async () => {
    const fetchImpl = mockFetch();
    await inquireTradeGrowthRanking(credentials, 'token', { excd: 'NYS', nday: '4' }, { fetchImpl });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain('/ranking/trade-growth');
    expect(url).toContain('NDAY=4');
    expect((init.headers as Record<string, string>).tr_id).toBe(RANKING_TR_ID.tradeGrowth);
    expect((init.headers as Record<string, string>).tr_id).toBe('HHDFS76330000');
  });
});

describe('거래회전율순위 (HHDFS76340000, NDAY=일 단위)', () => {
  it('TR ID·NDAY가 거래회전율순위.md와 일치한다', async () => {
    const fetchImpl = mockFetch();
    await inquireTradeTurnoverRanking(credentials, 'token', { excd: 'NAS', nday: '2' }, { fetchImpl });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain('/ranking/trade-turnover');
    expect(url).toContain('NDAY=2');
    expect((init.headers as Record<string, string>).tr_id).toBe(RANKING_TR_ID.tradeTurnover);
    expect((init.headers as Record<string, string>).tr_id).toBe('HHDFS76340000');
  });
});

describe('매수체결강도상위 (HHDFS76280000, ⚠ NDAY지만 값 단위는 분)', () => {
  it('TR ID가 매수체결강도상위.md와 일치한다', async () => {
    const fetchImpl = mockFetch();
    await inquireVolumePowerRanking(credentials, 'token', { excd: 'NAS', nday: '0' }, { fetchImpl });

    const [, init] = fetchImpl.mock.calls[0];
    expect((init.headers as Record<string, string>).tr_id).toBe(RANKING_TR_ID.volumePower);
    expect((init.headers as Record<string, string>).tr_id).toBe('HHDFS76280000');
  });

  it('NDAY=9는 문서 원문상 "120분전"이지 "1년전"이 아니다 (다른 5종의 NDAY=9=1년전과 단위가 다르다)', async () => {
    const fetchImpl = mockFetch();
    // 매수체결강도상위: 문서 Description "N분전 : ... 9(120분전)" — 값 '9'를 그대로 분 단위 파라미터로 보낸다.
    await inquireVolumePowerRanking(credentials, 'token', { excd: 'NAS', nday: '9' }, { fetchImpl });
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toContain('NDAY=9');

    // 반면 거래량순위(같은 파라미터명 NDAY, 일 단위)는 값 '9'가 "1년전"을 의미한다 — 단위가 다름을 회귀 방지로 고정.
    const fetchImplDay = mockFetch();
    await inquireTradeVolumeRanking(credentials, 'token', { excd: 'NAS', nday: '9' }, { fetchImpl: fetchImplDay });
    const [dayUrl] = fetchImplDay.mock.calls[0];
    expect(dayUrl).toContain('NDAY=9');
    // 두 호출 모두 같은 파라미터명(NDAY)·같은 값('9')을 쓰지만 TR ID/엔드포인트가 달라 의미가 갈린다.
    expect(dayUrl).not.toContain('/ranking/volume-power');
  });
});

describe('상승율/하락율 (HHDFS76290000, GUBN+NDAY=일 단위)', () => {
  it('TR ID·URL·파라미터가 상승율하락율.md와 일치한다', async () => {
    const fetchImpl = mockFetch();
    await inquireUpDownRateRanking(credentials, 'token', { excd: 'NAS', gubn: '1', nday: '0' }, { fetchImpl });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain('https://openapi.koreainvestment.com:9443/uapi/overseas-stock/v1/ranking/updown-rate');
    expect(url).toContain('EXCD=NAS');
    expect(url).toContain('GUBN=1');
    expect(url).toContain('NDAY=0');
    expect(url).toContain('VOL_RANG=0');
    expect((init.headers as Record<string, string>).tr_id).toBe(RANKING_TR_ID.upDownRate);
    expect((init.headers as Record<string, string>).tr_id).toBe('HHDFS76290000');
  });

  it('volRang을 주면 그대로 전달한다 (단타 리스트는 1만주 이상=3으로 저유동성 종목을 거른다)', async () => {
    const fetchImpl = mockFetch();
    await inquireUpDownRateRanking(
      credentials,
      'token',
      { excd: 'NAS', gubn: '1', nday: '0', volRang: '3' },
      { fetchImpl },
    );
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toContain('VOL_RANG=3');
  });

  it('가격급등락과 달리 시간창은 MINX(분)가 아니라 NDAY(일)다', async () => {
    const fetchImpl = mockFetch();
    await inquireUpDownRateRanking(credentials, 'token', { excd: 'NAS', gubn: '0', nday: '9' }, { fetchImpl });
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toContain('NDAY=9'); // 9 = 1년전(일 단위)
    expect(url).not.toContain('MINX');
  });
});

describe('rt_cd 비정상 응답', () => {
  it('rt_cd가 0이 아니면 KisApiError를 던진다', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      json: async () => ({ rt_cd: '1', msg_cd: 'EGW00123', msg1: '조회 실패' }),
    });

    await expect(
      inquireTradeVolumeRanking(credentials, 'token', { excd: 'NAS', nday: '0' }, { fetchImpl }),
    ).rejects.toMatchObject({ rtCd: '1', msgCd: 'EGW00123', msg1: '조회 실패' });
  });
});

describe('mergeRankingRows — 미국 3거래소 병합 (2026-08-08)', () => {
  it('병합 대상은 NAS·NYS·AMS 3거래소다', () => {
    expect(US_RANKING_EXCHANGES).toEqual(['NAS', 'NYS', 'AMS']);
  });

  it('거래소별 리스트를 종류별 지표(거래량=tvol, 콤마 허용)로 재정렬해 하나로 합친다', () => {
    const nas = [
      { symb: 'AAA', tvol: '9,000' },
      { symb: 'BBB', tvol: '100' },
    ];
    const nys = [
      { symb: 'CCC', tvol: '5000' },
      { symb: 'DDD', tvol: '200' },
    ];
    const merged = mergeRankingRows('tradeVolume', [nas, nys]);
    expect(merged.map((r) => r.symb)).toEqual(['AAA', 'CCC', 'DDD', 'BBB']);
  });

  it('음수 지표(급락·하락율)는 절대값으로 비교한다 — 더 극단이 위', () => {
    const merged = mergeRankingRows('upDownRate', [
      [{ symb: 'A', n_rate: '-9.5' }],
      [
        { symb: 'B', n_rate: '-3.1' },
        { symb: 'C', n_rate: '-12.0' },
      ],
    ]);
    expect(merged.map((r) => r.symb)).toEqual(['C', 'A', 'B']);
  });

  it('지표를 못 읽는 행은 맨 뒤로 보내되 원래 순번(거래소 내 순위)을 보존한다', () => {
    const merged = mergeRankingRows('tradeVolume', [
      [{ symb: 'X' }, { symb: 'A', tvol: '10' }],
      [{ symb: 'Y' }],
    ]);
    expect(merged.map((r) => r.symb)).toEqual(['A', 'X', 'Y']);
  });
});
