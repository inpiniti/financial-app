// 공통 요청 헤더 조립 + rt_cd 비정상 응답 에러 처리 (kis-openapi 스킬 공통 절차).
import { KisApiError, type KisCredentials } from './types';

/** 주문/계좌/시세 REST 계열이 공통으로 요구하는 헤더 (각 .md "요청 > Header" 표 기준). */
export function buildAuthHeaders(
  accessToken: string,
  credentials: KisCredentials,
  trId: string,
  extra?: Record<string, string>,
): Record<string, string> {
  return {
    'content-type': 'application/json; charset=utf-8',
    authorization: `Bearer ${accessToken}`,
    appkey: credentials.appKey,
    appsecret: credentials.appSecret,
    tr_id: trId,
    // custtype은 문서상 선택(N)이지만, 계좌성 조회에서 누락 시 개인/법인 구분 실패로
    // "처리계좌의 ID와 사용자정보가 상이"(APTR0058) 오류가 나는 사례가 있어 항상 P(개인)를 보낸다.
    // 공식 샘플(inquire_ccnl.py)도 custtype="P"를 포함한다. 법인 지원은 범위 밖.
    custtype: 'P',
    ...extra,
  };
}

/** rt_cd 필드를 갖는 응답 바디(주문/정정취소/잔고/체결내역 계열)의 공통 형태. */
export interface KisRtCdResponse {
  rt_cd: string;
  msg_cd: string;
  msg1: string;
  [key: string]: unknown;
}

/** rt_cd !== '0'이면 msg_cd/msg1을 포함한 KisApiError로 던진다. */
export function assertRtCdOk(body: KisRtCdResponse): void {
  if (body.rt_cd !== '0') {
    throw new KisApiError(body.rt_cd, body.msg_cd, body.msg1);
  }
}

/** Query Parameter 객체를 GET URL에 붙인다 (undefined 값은 생략). */
export function appendQuery(url: string, query: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}
