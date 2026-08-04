// KIS(한국투자증권) 오픈API 실 API 스모크 스크립트.
// 9단계(실계좌 리허설) 전에 사람이 직접 돌려보는 용도 — 자동 테스트(vitest)에서는 절대 호출하지 않는다.
//
// 실행: npm run smoke  (Node 22+, tsx로 실행)
// 필요 환경변수:
//   KIS_ENV            live | paper (기본 live)
//   KIS_APP_KEY         앱키
//   KIS_APP_SECRET      앱시크릿
//   KIS_SYMBOL          예) AAPL (기본 AAPL)
//   KIS_PRICE_EXCD      현재가상세 EXCD (기본 NAS — 나스닥)
//   KIS_WS_MARKET       실시간 시세 시장구분 (기본 NAS — buildFreeQuoteTrKey 사용)
//   RAW_FIELD_DEBUG     "true"면 WS 원본 필드 배열을 그대로 콘솔에 출력 (9단계 필드맵 대조용)
//
// 순서: 토큰 발급 → 현재가상세 조회 → 웹소켓 접속키 발급 → 실시간지연체결가 10초 수신.

import {
  buildFreeQuoteTrKey,
  getAccessToken,
  getApprovalKey,
  inquireOverseasPriceDetail,
  OverseasRealtimePriceClient,
  type PriceDetailExchangeCode,
  type RealtimeMarketCode,
} from '../kis';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[kis-smoke] 환경변수 ${name}가 필요합니다.`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const environment = (process.env.KIS_ENV === 'paper' ? 'paper' : 'live') as 'live' | 'paper';
  const appKey = requireEnv('KIS_APP_KEY');
  const appSecret = requireEnv('KIS_APP_SECRET');
  const symbol = process.env.KIS_SYMBOL ?? 'AAPL';
  const priceExcd = (process.env.KIS_PRICE_EXCD ?? 'NAS') as PriceDetailExchangeCode;
  const wsMarket = (process.env.KIS_WS_MARKET ?? 'NAS') as RealtimeMarketCode;
  const rawFieldDebug = process.env.RAW_FIELD_DEBUG === 'true';
  const credentials = { appKey, appSecret };

  console.log(`[kis-smoke] environment=${environment} symbol=${symbol} priceExcd=${priceExcd} wsMarket=${wsMarket}`);

  console.log('\n[1/3] 토큰 발급 중...');
  const token = await getAccessToken(environment, credentials);
  console.log(`  access_token 앞 12자: ${token.accessToken.slice(0, 12)}... (만료 ${new Date(token.expiresAt).toISOString()})`);

  console.log('\n[2/3] 현재가상세 조회 중...');
  const priceDetail = await inquireOverseasPriceDetail(credentials, token.accessToken, { excd: priceExcd, symb: symbol });
  console.log(`  ${symbol} last=${priceDetail.last} open=${priceDetail.open} high=${priceDetail.high} low=${priceDetail.low}`);

  console.log('\n[3/3] 웹소켓 접속키 발급 후 실시간지연체결가 10초 수신...');
  const approvalKey = await getApprovalKey(environment, credentials);
  const trKey = buildFreeQuoteTrKey(wsMarket, symbol);

  await new Promise<void>((resolve) => {
    let tickCount = 0;
    let subscribed = false;
    const client = new OverseasRealtimePriceClient({
      approvalKey,
      rawFieldDebug,
      onStatusChange: (status) => {
        console.log(`  [ws] status=${status}`);
        if (status === 'open' && !subscribed) {
          subscribed = true;
          client.subscribe(trKey);
        }
      },
      onError: (err) => console.error('  [ws] error', err),
      onRawFields: (fields) => {
        if (rawFieldDebug) console.log('  [ws][RAW_FIELD_DEBUG]', fields);
      },
      onTick: (tick) => {
        tickCount += 1;
        console.log(`  [ws] tick#${tickCount} ${tick.SYMB} last=${tick.LAST} rate=${tick.RATE}%`);
      },
    });

    client.connect();

    const timer = setTimeout(() => {
      client.unsubscribe(trKey);
      client.close();
      console.log(`\n[kis-smoke] 완료 — 수신 틱 수: ${tickCount}`);
      resolve();
    }, 10_000);
    timer.unref?.();
  });
}

main().catch((err) => {
  console.error('[kis-smoke] 실패:', err);
  process.exit(1);
});
