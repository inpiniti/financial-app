// 실시간(웹소켓) 접속키 발급 [실시간-000] — docs/koreainvestment/웹소켓키발급.md 그대로.
// 주의(문서 원문): appsecret와 secretkey는 동일한 값이나 필드명만 다르다.
import { REST_DOMAIN } from './domain';
import type { FetchLike, KisCredentials, KisEnvironment } from './types';

export interface WsApprovalDeps {
  fetchImpl?: FetchLike;
}

export async function getApprovalKey(
  environment: KisEnvironment,
  credentials: KisCredentials,
  deps: WsApprovalDeps = {},
): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const res = await fetchImpl(`${REST_DOMAIN[environment]}/oauth2/Approval`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; utf-8' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: credentials.appKey,
      secretkey: credentials.appSecret,
    }),
  });
  const body = (await res.json()) as { approval_key?: string };
  if (!body.approval_key) {
    throw new Error(`KIS 웹소켓 접속키 발급 실패: approval_key가 없습니다. 응답=${JSON.stringify(body)}`);
  }
  return body.approval_key;
}
