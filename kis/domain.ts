// 실전/모의 도메인 — kis-openapi 스킬 철칙 3: "실전/모의는 도메인·TR ID가 모두 다르다".
import type { KisEnvironment } from './types';

export const REST_DOMAIN: Record<KisEnvironment, string> = {
  live: 'https://openapi.koreainvestment.com:9443',
  paper: 'https://openapivts.koreainvestment.com:29443',
};

/**
 * 실시간(웹소켓) 시세 도메인 — 실전 전용 (실시간지연체결가.md: "모의 Domain: 모의투자 미지원").
 * 함정 목록: 웹소켓 "시세"는 모의투자 미지원 — 시세 구독은 항상 이 도메인으로 우회한다.
 * ⚠ KIS는 wss를 제공하지 않아 평문 ws:// 고정 — 안드로이드는 기본으로 평문 통신을 차단하므로
 *   app.json의 expo-build-properties(android.usesCleartextTraffic: true)가 없으면 빌드 APK에서
 *   REST(https)만 되고 실시간 수신만 조용히 실패한다(2026-08-10 갤럭시 실기기 실사고).
 */
export const WS_QUOTE_DOMAIN = 'ws://ops.koreainvestment.com:21000';
