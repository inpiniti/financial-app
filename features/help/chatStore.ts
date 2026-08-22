// 도움말 챗봇 대화 기록 — 화면 상태로만 들고 있던 말풍선을 기기에 남긴다(2026-08-22 사용자 요청).
//
// 왜: 화면을 나갔다 오면 대화가 통째로 사라져 "아까 물어본 그거"를 이어서 물을 수 없었다. 특히 장중에
// 앱을 오가며 진단하는 흐름(문제 → 상태 조회 → 원인)이 매번 처음부터 다시였다.
//
// 어디에: 기기 로컬 AsyncStorage 한 곳(키 `help.chat`). 서버로 보내지 않는다 — 대화에는 보유 종목·계좌
// 진단 같은 개인 정보가 섞이고, 이건 이 기기 주인만 보면 되는 기록이다.
//
// 무엇을: **성공한 말풍선만** 저장한다(pending·failed는 다음 세션의 맥락으로 쓸모가 없다).
// 상한은 MAX_STORED_MESSAGES개 — 넘치면 오래된 쪽부터 버린다(프롬프트로 가는 히스토리는 helpChat의
// trimHistory가 따로 8턴으로 자르므로, 여기 상한은 "화면에서 거슬러 볼 수 있는 길이"다).
import type { KeyValueStore } from '../scalper/types';
import type { HelpMessage } from './helpChat';

export const HELP_CHAT_KEY = 'help.chat';

/** 저장 상한(말풍선 개수). 사용자·모델 합산. */
export const MAX_STORED_MESSAGES = 200;

/** 저장 레코드 — 표시 순서와 시각만 더한다. */
export interface StoredHelpMessage extends HelpMessage {
  /** 보낸 시각(epoch ms). 옛 기록에는 없을 수 있어 optional. */
  at?: number;
}

/** 저장된 대화를 읽는다. 없거나 파손이면 빈 배열(자연 복구 — 다음 저장이 덮어쓴다). */
export async function readHelpChat(storage: KeyValueStore): Promise<StoredHelpMessage[]> {
  const raw = await storage.getItem(HELP_CHAT_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is StoredHelpMessage =>
        typeof m === 'object' &&
        m !== null &&
        (( m as HelpMessage).role === 'user' || (m as HelpMessage).role === 'model') &&
        typeof (m as HelpMessage).text === 'string',
    );
  } catch {
    return [];
  }
}

/** 대화 전체를 덮어쓴다(상한 초과분은 앞에서 버린다). */
export async function writeHelpChat(
  storage: KeyValueStore,
  messages: readonly StoredHelpMessage[],
): Promise<void> {
  const kept = messages.slice(-MAX_STORED_MESSAGES);
  await storage.setItem(HELP_CHAT_KEY, JSON.stringify(kept));
}

/** 대화를 지운다(화면의 "대화 지우기"). */
export async function clearHelpChat(storage: KeyValueStore): Promise<void> {
  await storage.setItem(HELP_CHAT_KEY, JSON.stringify([]));
}
