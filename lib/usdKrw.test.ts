import { describe, expect, it } from 'vitest';

import { pickUsdKrwRate } from './usdKrw';

describe('pickUsdKrwRate — 잔고 응답에서 USD/KRW 환율 고르기', () => {
  it('통화별 행(output2)의 USD 최초고시환율을 쓴다', () => {
    const rate = pickUsdKrwRate([
      { crcy_cd: 'JPY', frst_bltn_exrt: '9.1' },
      { crcy_cd: 'USD', frst_bltn_exrt: '1387.50' },
    ]);
    expect(rate).toBe(1387.5);
  });

  it('USD 행이 없으면 보유 종목 행(output1)의 기준환율로 폴백한다', () => {
    const rate = pickUsdKrwRate(
      [{ crcy_cd: 'JPY', frst_bltn_exrt: '9.1' }],
      [{ buy_crcy_cd: 'USD', bass_exrt: '1390' }],
    );
    expect(rate).toBe(1390);
  });

  it('환율이 0·빈 문자열·비정상이면 그 행은 건너뛴다', () => {
    expect(pickUsdKrwRate([{ crcy_cd: 'USD', frst_bltn_exrt: '0' }])).toBeNull();
    expect(pickUsdKrwRate([{ crcy_cd: 'USD', frst_bltn_exrt: '' }])).toBeNull();
    expect(
      pickUsdKrwRate([
        { crcy_cd: 'USD', frst_bltn_exrt: 'N/A' },
        { crcy_cd: 'usd', frst_bltn_exrt: '1400' },
      ]),
    ).toBe(1400);
  });

  it('아무 행도 없으면 null — 화면은 USD 표시로 폴백한다', () => {
    expect(pickUsdKrwRate(undefined)).toBeNull();
    expect(pickUsdKrwRate([], [])).toBeNull();
  });
});
