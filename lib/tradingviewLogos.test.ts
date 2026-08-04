import { describe, expect, it, vi } from 'vitest';
import {
  buildScanBody,
  ensureViewBox,
  fetchLogoPairs,
  logoUrlOf,
  parseScanRow,
  TRADINGVIEW_SCAN_URL,
} from './tradingviewLogos';

// 사용자 제공 실응답 예시(NVDA 행) 축약 — d[0]이 ticker-view 객체.
const NVDA_ROW = {
  s: 'NASDAQ:NVDA',
  d: [{ description: 'NVIDIA Corporation', exchange: 'NASDAQ', logo: { logoid: 'nvidia', style: 'single' }, name: 'NVDA' }],
};

describe('tradingviewLogos — 요청 본문·파싱', () => {
  it('요청 본문 — 컬럼은 ticker-view 하나, 범위 [0,9000], primary 필터 유지', () => {
    const body = JSON.parse(buildScanBody());
    expect(body.columns).toEqual(['ticker-view']);
    expect(body.range).toEqual([0, 9000]);
    expect(body.markets).toEqual(['america']);
    expect(body.filter[0]).toEqual({ left: 'is_primary', operation: 'equal', right: true });
  });

  it('행 파싱 — 티커는 s의 콜론 뒤, 로고는 d[0].logo.logoid', () => {
    expect(parseScanRow(NVDA_ROW)).toEqual(['NVDA', 'nvidia']);
  });

  it('로고 없는 행·티커 없는 행은 null', () => {
    expect(parseScanRow({ s: 'NASDAQ:ABC', d: [{ name: 'ABC' }] })).toBeNull();
    expect(parseScanRow({ d: [{ logo: { logoid: 'x' } }] })).toBeNull();
    expect(parseScanRow({})).toBeNull();
  });

  it('BRK.A 같은 특수 표기는 그대로 보존한다', () => {
    expect(parseScanRow({ s: 'NYSE:BRK.A', d: [{ name: 'BRK.A', logo: { logoid: 'berkshire-hathaway' } }] })).toEqual([
      'BRK.A',
      'berkshire-hathaway',
    ]);
  });

  it('fetchLogoPairs — 최소 헤더(쿠키 없음) POST, 로고 있는 행만 수집', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      json: async () => ({
        data: [NVDA_ROW, { s: 'NASDAQ:NOLOGO', d: [{ name: 'NOLOGO' }] }],
        totalCount: 8018,
      }),
    });
    const pairs = await fetchLogoPairs({ fetchImpl });

    expect(pairs).toEqual([['NVDA', 'nvidia']]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(TRADINGVIEW_SCAN_URL);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ accept: 'application/json', 'content-type': 'text/plain;charset=UTF-8' });
    expect(JSON.stringify(init.headers)).not.toContain('cookie'); // 세션ID 금지(plan §4-1).
  });

  it('data 배열이 없으면 throw(호출부가 캐시 유지로 처리)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ json: async () => ({}) });
    await expect(fetchLogoPairs({ fetchImpl })).rejects.toThrow(/data/);
  });

  it('로고 URL — https://s3-symbol-logo.tradingview.com/{logoid}.svg', () => {
    expect(logoUrlOf('nvidia')).toBe('https://s3-symbol-logo.tradingview.com/nvidia.svg');
  });
});

describe('ensureViewBox — viewBox 없는 로고 보정(좌상단 쏠림 수정)', () => {
  it('viewBox가 없으면 width/height로 주입한다 — nvidia 실물 형태', () => {
    const svg = '<!-- by TradingView --><svg width="18" height="18" xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';
    expect(ensureViewBox(svg)).toContain('<svg viewBox="0 0 18 18" width="18" height="18"');
  });

  it('fill 등 다른 속성이 있어도 동작한다 — meta-platforms 실물 형태', () => {
    const svg = '<svg width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg"><path/></svg>';
    expect(ensureViewBox(svg)).toContain('viewBox="0 0 18 18"');
  });

  it('이미 viewBox가 있으면 그대로 둔다 — microsoft 실물 형태', () => {
    const svg = '<svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg"><path/></svg>';
    expect(ensureViewBox(svg)).toBe(svg);
  });

  it('width/height가 없으면 손대지 않는다', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path/></svg>';
    expect(ensureViewBox(svg)).toBe(svg);
  });
});
