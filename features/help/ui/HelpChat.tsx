// 도움말 챗봇 화면 본체 — 앱 사용법을 물어보면 매뉴얼(APP_MANUAL)과 지금 걸린 설정·상태로 답한다.
//
// app-ui-style: 풀폭 Panel + ListRow(추천 질문), 이모지 금지(Ionicons). 말풍선은 채팅 고유 형태라
// 라운딩을 쓴다 — "떠 있는 카드 금지" 규칙은 섹션·리스트 행에 대한 것이고 버블은 그 대상이 아니다.
//
// 상태·설정은 화면이 모아 넘긴다: 설정은 AsyncStorage에서 읽고, 오토파일럿은 **이미 돌고 있을 때만**
// (peekManagerBootstrap) 곁들인다 — 도움말을 열었다는 이유로 KIS 세션·WS를 만들지 않는다.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ListRow } from '../../../components/ListRow';
import { Panel } from '../../../components/Panel';
import { loadAppSettings, type AppSettings } from '../../../lib/appSettings';
import { peekManagerBootstrap } from '../../scalper/ui/managerProvider';
import { MODEL_MODE } from '../../scalper/modelMode';
import { MARTINGALE_MODE } from '../../scalper/martingaleMode';
import type { MartingaleBarEval } from '../../../core/martingale';
import type { ModelVerdictView } from '../../scalper/feedSlot';
import { loadModel } from '../../../core/model';
import { describeReject } from '../../../core/model/inspect';
import { APP_MANUAL, type HelpRuntimeState } from '../appManual';
import { SUGGESTED_QUESTIONS, askHelp, type HelpMessage } from '../helpChat';
import { HELP_TOOL_DECLARATIONS, runHelpTool, type HelpAutopilotSnapshot } from '../tools';
import {
  deleteChat,
  listChats,
  migrateLegacyChat,
  newChatId,
  readChat,
  saveChat,
  type ChatSummary,
} from '../chatStore';

/** 도구 이름 → 화면에 띄울 말. 목록에 없는 도구는 "확인하고 있어요"로 뭉뚱그린다. */
const TOOL_LABEL: Record<string, string> = {
  getAutopilotStatus: '자동 트레이딩 상태를 보고 있어요…',
  getWatchlist: '감시 중인 종목을 보고 있어요…',
  getHoldings: '보유 종목을 확인하고 있어요…',
  getPendingOrders: '미체결 주문을 확인하고 있어요…',
  getTodayTrades: '오늘 매매 기록을 읽고 있어요…',
  getQuote: '시세를 확인하고 있어요…',
  searchStock: '종목을 찾고 있어요…',
  getStockNews: '기사를 읽고 있어요…',
  searchNews: '뉴스를 찾아보고 있어요…',
  searchWeb: '인터넷에서 찾아보고 있어요…',
  getAccountBinding: '계좌 연결 상태를 보고 있어요…',
  getRawApiResponse: '원본 응답을 가져오고 있어요…',
  getMinuteCandles: '분봉과 추세 4선을 보고 있어요…',
  getPeriodChart: '일봉을 보고 있어요…',
  getEvents: '자동 트레이딩 기록을 되짚어 보고 있어요…',
  getSettings: '지금 걸린 설정을 확인하고 있어요…',
};

/**
 * 타이핑 표시 — **받는 속도와 그리는 속도를 분리한다.**
 * 프록시는 조각으로 흘려주지만(기업 탭과 같은 경로) 도움말 답변은 3~6문장이라 조각이 1초 안에 다 도착한다.
 * 그대로 그리면 "한참 기다렸다 툭" 뜬다(2026-08-21 제보). 그래서 받은 글자를 목표로 두고 화면은 일정 속도로
 * 따라 그린다 — 밀린 글자가 많을수록 빨리 따라잡되(backlog/CATCHUP), 최소 1글자씩은 항상 움직인다.
 */
const TYPE_TICK_MS = 24;
const TYPE_CATCHUP = 12;

/** 화면에 그리는 한 줄 — 답변은 스트리밍 중에도 그려야 해서 pending 플래그를 함께 둔다. */
interface Bubble extends HelpMessage {
  /** 아직 받는 중(커서 대신 점 애니메이션 대신 회색 안내). */
  pending?: boolean;
  /** 실패한 답변 — 다시 묻기 안내를 붙인다. */
  failed?: boolean;
}

function UserBubble({ text }: { text: string }) {
  return (
    <View className="mb-3 items-end px-5">
      <View className="max-w-[85%] rounded-2xl bg-[#3182f6] px-4 py-3">
        <Text className="text-[15px] leading-6 text-white">{text}</Text>
      </View>
    </View>
  );
}

function ModelBubble({ bubble, note }: { bubble: Bubble; note?: string | null }) {
  const empty = bubble.text.trim() === '';
  return (
    <View className="mb-3 items-start px-5">
      <View className="max-w-[92%] rounded-2xl bg-white px-4 py-3">
        {empty && bubble.pending ? (
          // 도구를 부르는 중이면 무엇을 하고 있는지(note), 아니면 기본 안내.
          <Text className="text-[15px] leading-6 text-[#8b95a1]">{note ?? '설명서를 찾아보고 있어요…'}</Text>
        ) : (
          <Text
            className="text-[15px] leading-6"
            style={{ color: bubble.failed ? '#f04452' : '#191f28' }}
          >
            {bubble.text}
          </Text>
        )}
      </View>
    </View>
  );
}

/** 지금 오토파일럿이 돌고 있으면 그 상황을 한 덩이로 — 안 돌고 있으면 null(상태 블록 자체를 안 만든다). */
function readRuntimeState(): HelpRuntimeState | null {
  const boot = peekManagerBootstrap();
  if (!boot) return null;
  const view = boot.autopilot.getView();
  return {
    state: view.state,
    activeTickers: view.activeTickers,
    listCount: boot.autopilot.getRows().length,
    cycles: view.cycles,
  };
}

/** 도구(getAutopilotStatus·getWatchlist)가 읽는 스냅샷 — 돌고 있을 때만. */
function readAutopilotSnapshot(): HelpAutopilotSnapshot | null {
  const boot = peekManagerBootstrap();
  if (!boot) return null;
  const view = boot.autopilot.getView();
  return {
    state: view.state,
    activeTickers: view.activeTickers,
    cycles: view.cycles,
    cumPnlUsd: view.cumPnl,
    maxGrids: view.maxGrids,
    // 진입 포기 사유·감시 교체·시드 결과 — "왜 안 샀어?"의 1차 증거(2026-08-22).
    events: boot.autopilot.recentEvents.map((e) => ({ at: e.at, text: e.text })),
    list: boot.autopilot.getRows().map((row) => ({
      ticker: row.entry.ticker,
      name: row.entry.name,
      price: row.view.price,
      tickRate: row.view.tickRate ?? null,
      signal: formatSignalForTool(row.view),
      candidate: view.watched.includes(row.entry.ticker),
    })),
  };
}

/**
 * 그 종목의 현행 감지 요약 한 줄 — **화면과 같은 기준**으로 만든다.
 * 모델 모드(현행)는 모델 확률, 추세 모드(롤백 경로)는 4선 방향. 2026-08-24까지 여기가 4선 고정이라
 * 모델 모드에서 챗봇이 전 종목을 "봉 부족"이라고 답했다.
 */
function formatSignalForTool(view: {
  modelProb: number | null;
  modelVerdict: ModelVerdictView | null;
  trend: TrendLike;
  martingale?: MartingaleBarEval | null;
}): string {
  if (MARTINGALE_MODE) {
    const m = view.martingale ?? null;
    if (m === null || m.aligned === null) return `물타기 시험 모드 — 1분봉 4선 계산 중(봉 ${m?.bars ?? 0}개)`;
    if (m.entry) return '물타기 시험 모드 — 정배열에서 5선 상향 돌파(진입 신호)';
    return `물타기 시험 모드 — ${m.aligned ? '정배열, 5선 돌파 대기' : '정배열 아님'}${m.ma5TurnUp ? ', 5선 변곡' : ''} (봉 ${m.bars})`;
  }
  if (MODEL_MODE) {
    const v = view.modelVerdict;
    if (v === null) return '아직 판정 전(봉 마감 대기)';
    if (v.reject === null) return `모델 확률 ${((v.prob ?? 0) * 100).toFixed(1)}% — 매수 신호`;
    const why = describeReject({ reject: v.reject, prob: v.prob, threshold: loadModel().threshold });
    return v.prob === null ? `판정 안 함 — ${why}` : `모델 확률 ${(v.prob * 100).toFixed(1)}% — ${why}`;
  }
  return formatTrendForTool(view.trend);
}

type TrendLike = {
  up: { ma5: boolean | null; ma20: boolean | null; ma60: boolean | null; ma120: boolean | null };
  bars: number;
} | null;

/** 추세 4선을 도구 결과에 넣을 한 줄로 — 화면 표기(5↑ 20↑ …)와 같은 읽기 방식(추세 모드에서만). */
function formatTrendForTool(trend: TrendLike): string {
  if (!trend) return '봉 부족';
  const arrow = (up: boolean | null) => (up === null ? '·' : up ? '상승' : '하락');
  return `5선 ${arrow(trend.up.ma5)}, 20선 ${arrow(trend.up.ma20)}, 60선 ${arrow(trend.up.ma60)}, 120선 ${arrow(trend.up.ma120)} (봉 ${trend.bars})`;
}

/**
 * 대화 목록의 시각 — 오늘이면 "오후 3:12", 어제면 "어제", 그 전이면 "8월 20일".
 * 기기 로컬 시각 기준(사용자가 그 대화를 한 시각이 곧 기기 시각이다).
 */
function formatChatTime(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay = (x: Date, y: Date) =>
    x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
  if (sameDay(d, now)) {
    const h = d.getHours();
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${h < 12 ? '오전' : '오후'} ${h % 12 === 0 ? 12 : h % 12}:${mm}`;
  }
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (sameDay(d, yesterday)) return '어제';
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

export function HelpChat() {
  const insets = useSafeAreaInsets();
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [showManual, setShowManual] = useState(false);
  /** 대화 목록 화면을 보고 있는가(2026-08-22) — 설명서와 같은 방식으로 전체 화면을 갈아 끼운다. */
  const [showChatList, setShowChatList] = useState(false);
  /** 지금 보고 있는 대화의 id. 복원이 끝나기 전엔 null. */
  const [chatId, setChatId] = useState<string | null>(null);
  const [chats, setChats] = useState<readonly ChatSummary[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [keyboardUp, setKeyboardUp] = useState(false);
  /** 저장된 대화를 아직 읽는 중인가 — 다 읽기 전에 저장하면 빈 배열로 덮어쓴다. */
  const [restored, setRestored] = useState(false);
  // 도구를 부르는 동안 답변 버블에 띄울 안내("보유 종목을 확인하고 있어요…").
  const [toolNote, setToolNote] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  // 타이핑 표시용 — target은 지금까지 받은 전문, shown은 화면에 그린 글자 수, settled는 요청이 끝났는지.
  const targetRef = useRef('');
  const shownRef = useRef(0);
  const settledRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /**
   * 마지막으로 저장한 내용의 지문("<id>:<말풍선 JSON>") — 지난 대화를 **열어보기만** 했을 때
   * 다시 저장돼 updatedAt이 밀리는(= 목록 순서가 바뀌는) 걸 막는다.
   */
  const savedFingerprintRef = useRef<string | null>(null);

  const stopTyping = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // 화면을 나가는 도중 인터벌이 살아 있으면 언마운트된 컴포넌트를 갱신한다.
  useEffect(() => stopTyping, [stopTyping]);

  // 키보드가 올라오면 홈 인디케이터 여백을 빼야 입력창이 키보드에 딱 붙는다.
  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      () => setKeyboardUp(true),
    );
    const hide = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setKeyboardUp(false),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  // 설정은 화면을 열 때 한 번 읽는다 — 답변에 "지금 내 값"을 넣기 위한 재료다.
  useEffect(() => {
    loadAppSettings()
      .then(setSettings)
      .catch(() => setSettings(null));
  }, []);

  // 화면을 열 때 한 번 — 옛 단일 대화를 이관하고, 목록을 읽어 **가장 최근 대화를 이어서** 연다.
  // 대화가 하나도 없으면 빈 새 대화로 시작한다(id는 여기서 미리 잡아 둔다 — 저장은 첫 답변 뒤).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { default: AsyncStorage } = await import('@react-native-async-storage/async-storage');
        await migrateLegacyChat(AsyncStorage, Date.now());
        const list = await listChats(AsyncStorage);
        if (cancelled) return;
        setChats(list);
        const latest = list[0];
        if (latest) {
          const saved = await readChat(AsyncStorage, latest.id);
          if (cancelled) return;
          const keep = saved.map(({ role, text }) => ({ role, text }));
          savedFingerprintRef.current = `${latest.id}:${JSON.stringify(keep)}`;
          setChatId(latest.id);
          setBubbles(keep);
        } else {
          setChatId(newChatId(Date.now()));
        }
      } catch {
        // 저장소를 못 읽어도 대화는 시작할 수 있어야 한다.
        if (!cancelled) setChatId(newChatId(Date.now()));
      } finally {
        if (!cancelled) setRestored(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 대화가 끝날 때마다(타이핑 완료 = busy 해제) 저장한다 — 한 글자씩 쓰면 저장소가 24ms마다 돈다.
  // 성공한 말풍선만 남긴다(pending·failed는 다음 세션 맥락으로 쓸모가 없다 — send의 history 규칙과 같다).
  useEffect(() => {
    if (!restored || busy || chatId === null) return;
    const keep = bubbles.filter((b) => !b.pending && !b.failed).map(({ role, text }) => ({ role, text }));
    if (keep.length === 0) return;
    const fingerprint = `${chatId}:${JSON.stringify(keep)}`;
    if (savedFingerprintRef.current === fingerprint) return; // 바뀐 게 없다 — 열어보기만 했다.
    savedFingerprintRef.current = fingerprint;
    void (async () => {
      try {
        const { default: AsyncStorage } = await import('@react-native-async-storage/async-storage');
        setChats(await saveChat(AsyncStorage, chatId, keep, Date.now()));
      } catch {
        // 저장 실패는 조용히 넘긴다 — 대화 자체를 막을 이유가 없다.
      }
    })();
  }, [bubbles, busy, restored, chatId]);

  /** 새 대화 — 화면을 비우고 새 id를 잡는다. 지금 대화는 이미 저장돼 있으니 목록에 남는다. */
  const startNewChat = useCallback(() => {
    if (busy) return;
    savedFingerprintRef.current = null;
    setBubbles([]);
    setChatId(newChatId(Date.now()));
    setShowChatList(false);
  }, [busy]);

  /** 목록에서 대화 하나를 연다. */
  const openChat = useCallback(
    (id: string) => {
      if (busy) return;
      setShowChatList(false);
      void (async () => {
        try {
          const { default: AsyncStorage } = await import('@react-native-async-storage/async-storage');
          const saved = await readChat(AsyncStorage, id);
          const keep = saved.map(({ role, text }) => ({ role, text }));
          // 방금 읽은 그대로는 저장하지 않는다 — 지문을 미리 맞춰 둔다.
          savedFingerprintRef.current = `${id}:${JSON.stringify(keep)}`;
          setChatId(id);
          setBubbles(keep);
        } catch {
          // 못 읽으면 그 대화는 열지 않는다(현재 대화 유지).
        }
      })();
    },
    [busy],
  );

  /** 대화 하나 지우기 — 확인 뒤 저장소에서 지우고, 보고 있던 대화면 새 대화로 넘어간다. */
  const removeChat = useCallback(
    (chat: ChatSummary) => {
      Alert.alert('이 대화를 지울까요?', chat.title, [
        { text: '아니요', style: 'cancel' },
        {
          text: '지우기',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                const { default: AsyncStorage } = await import('@react-native-async-storage/async-storage');
                const rest = await deleteChat(AsyncStorage, chat.id);
                setChats(rest);
                if (chat.id === chatId) {
                  setBubbles([]);
                  setChatId(newChatId(Date.now()));
                }
              } catch {
                // 무시 — 다음 시도에서 다시 지울 수 있다.
              }
            })();
          },
        },
      ]);
    },
    [chatId],
  );

  const send = useCallback(
    async (question: string) => {
      const text = question.trim();
      if (!text || busy) return;
      setInput('');
      setBusy(true);
      // 히스토리는 화면에 그려진 것 중 성공한 것만 — 실패 버블을 다음 질문의 맥락으로 보내지 않는다.
      const history: HelpMessage[] = [
        ...bubbles.filter((b) => !b.failed && !b.pending).map(({ role, text: t }) => ({ role, text: t })),
        { role: 'user' as const, text },
      ];
      setBubbles((prev) => [...prev, { role: 'user', text }, { role: 'model', text: '', pending: true }]);
      const patchLast = (next: Partial<Bubble>) =>
        setBubbles((prev) => prev.map((b, i) => (i === prev.length - 1 ? { ...b, ...next } : b)));

      // 타이핑 시작 — 조각이 오는 대로 targetRef만 키우고, 그리는 건 이 인터벌이 맡는다.
      targetRef.current = '';
      shownRef.current = 0;
      settledRef.current = false;
      setToolNote(null);
      stopTyping();
      timerRef.current = setInterval(() => {
        const target = targetRef.current;
        if (shownRef.current < target.length) {
          const backlog = target.length - shownRef.current;
          shownRef.current = Math.min(target.length, shownRef.current + Math.max(1, Math.ceil(backlog / TYPE_CATCHUP)));
          patchLast({ text: target.slice(0, shownRef.current) });
          setToolNote(null); // 글자가 나오기 시작하면 "확인하고 있어요" 안내는 물러난다.
        }
        // 다 받았고 다 그렸을 때만 끝낸다 — 응답이 먼저 끝나도 남은 글자는 계속 타이핑된다.
        if (settledRef.current && shownRef.current >= target.length) {
          stopTyping();
          patchLast({ pending: false });
          setBusy(false);
        }
      }, TYPE_TICK_MS);

      try {
        const answer = await askHelp(
          history,
          { settings, runtime: readRuntimeState() },
          {
            onProgress: (acc) => (targetRef.current = acc),
            tools: HELP_TOOL_DECLARATIONS,
            runTool: (name, args) => runHelpTool(name, args, { autopilot: readAutopilotSnapshot }),
            // 도구를 부르는 동안 답변 자리는 비어 있다 — 무엇을 하고 있는지 대신 보여 준다.
            onToolStart: (names) => setToolNote(TOOL_LABEL[names[0]] ?? '확인하고 있어요…'),
          },
        );
        targetRef.current = answer;
        settledRef.current = true;
      } catch (e) {
        // 실패는 타이핑하지 않는다 — 기다린 사람에게 오류 문구를 한 글자씩 보여줄 이유가 없다.
        stopTyping();
        settledRef.current = true;
        patchLast({
          text: `지금은 답변을 가져오지 못했어요. 잠시 뒤에 다시 물어봐 주세요. (${
            e instanceof Error ? e.message : String(e)
          })`,
          pending: false,
          failed: true,
        });
        setBusy(false);
      }
    },
    [bubbles, busy, settings, stopTyping],
  );

  const canSend = input.trim().length > 0 && !busy;

  if (showChatList) {
    return (
      <View className="flex-1 bg-[#f2f4f6]">
        <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}>
          <Panel
            title="대화 목록"
            headerRight={chats.length > 0 ? `${chats.length}개` : undefined}
          >
            {chats.length === 0 ? (
              <View className="px-5 py-8">
                <Text className="text-center text-sm text-[#8b95a1]">아직 저장된 대화가 없어요</Text>
              </View>
            ) : (
              chats.map((chat) => (
                <ListRow
                  key={chat.id}
                  title={
                    <Text
                      className="text-[15px] leading-6"
                      style={{ color: chat.id === chatId ? '#3182f6' : '#191f28', fontWeight: chat.id === chatId ? '700' : '400' }}
                      numberOfLines={1}
                    >
                      {chat.title}
                    </Text>
                  }
                  subtitle={`${formatChatTime(chat.updatedAt)} · ${chat.messageCount}개`}
                  onPress={() => openChat(chat.id)}
                  trailing={
                    <Pressable
                      onPress={() => removeChat(chat)}
                      hitSlop={12}
                      className="p-1 active:opacity-60"
                      accessibilityRole="button"
                      accessibilityLabel={`${chat.title} 대화 지우기`}
                    >
                      <Ionicons name="trash-outline" size={18} color="#8b95a1" />
                    </Pressable>
                  }
                />
              ))
            )}
          </Panel>
          <View className="px-5" style={{ gap: 10 }}>
            <Pressable
              onPress={startNewChat}
              className="flex-row items-center justify-center rounded-2xl bg-[#3182f6] py-4 active:opacity-80"
              style={{ minHeight: 52, gap: 6 }}
            >
              <Ionicons name="add" size={18} color="#ffffff" />
              <Text className="text-base font-semibold text-white">새 대화 시작하기</Text>
            </Pressable>
            <Pressable
              onPress={() => setShowChatList(false)}
              className="items-center py-3 active:opacity-60"
              style={{ minHeight: 44 }}
            >
              <Text className="text-sm font-semibold text-[#4e5968]">돌아가기</Text>
            </Pressable>
          </View>
        </ScrollView>
      </View>
    );
  }

  if (showManual) {
    return (
      <View className="flex-1 bg-[#f2f4f6]">
        <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}>
          <Panel title="사용 설명서" headerRight="챗봇이 이 내용을 보고 답해요">
            <View className="px-5 pb-5">
              <Text className="text-[15px] leading-7 text-[#4e5968]">{APP_MANUAL}</Text>
            </View>
          </Panel>
          <View className="px-5">
            <Pressable
              onPress={() => setShowManual(false)}
              className="items-center rounded-2xl bg-[#3182f6] py-4 active:opacity-80"
              style={{ minHeight: 52 }}
            >
              <Text className="text-base font-semibold text-white">질문하러 가기</Text>
            </Pressable>
          </View>
        </ScrollView>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      // ⚠ 0이어야 한다 — 이 뷰는 BackHeader **아래**에서 시작하고 자기 절대 좌표를 재서 키보드와의 겹침을 계산한다.
      // 여기에 헤더 높이(insets.top+44)를 더했더니 입력창이 키보드보다 그만큼 떠올랐다(2026-08-21 제보).
      keyboardVerticalOffset={0}
      className="flex-1 bg-[#f2f4f6]"
    >
      {/* 대화 도구줄 — 목록 열기 / 새 대화. 답변을 받는 중에는 눌러도 대화가 바뀌지 않게 흐리게 둔다. */}
      <View className="flex-row items-center justify-between bg-white px-5 py-2">
        <Pressable
          onPress={() => setShowChatList(true)}
          disabled={busy}
          className="flex-row items-center active:opacity-60"
          style={{ minHeight: 36, gap: 5, opacity: busy ? 0.4 : 1 }}
          accessibilityRole="button"
          accessibilityLabel="대화 목록 열기"
        >
          <Ionicons name="list-outline" size={16} color="#4e5968" />
          <Text className="text-sm font-semibold text-[#4e5968]">
            대화 목록{chats.length > 0 ? ` ${chats.length}` : ''}
          </Text>
        </Pressable>
        <Pressable
          onPress={startNewChat}
          disabled={busy || bubbles.length === 0}
          className="flex-row items-center active:opacity-60"
          style={{ minHeight: 36, gap: 5, opacity: busy || bubbles.length === 0 ? 0.4 : 1 }}
          accessibilityRole="button"
          accessibilityLabel="새 대화 시작"
        >
          <Ionicons name="create-outline" size={16} color="#3182f6" />
          <Text className="text-sm font-semibold text-[#3182f6]">새 대화</Text>
        </Pressable>
      </View>

      <ScrollView
        ref={scrollRef}
        className="flex-1"
        contentContainerStyle={{ paddingTop: 12, paddingBottom: 12 }}
        // 타이핑 중에는 애니메이션을 끈다 — 24ms마다 스크롤 애니메이션이 쌓이면 화면이 덜컹거린다.
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: !busy })}
        keyboardShouldPersistTaps="handled"
      >
        {bubbles.length === 0 ? (
          <>
            {/* 공용 EmptyState는 flex-1이라 추천 질문을 화면 밖으로 밀어낸다(2026-08-21 제보) — 여기서는 컴팩트한 인사 블록으로. */}
            <View className="items-center px-8 pb-6 pt-8">
              <Ionicons name="chatbubble-ellipses-outline" size={32} color="#8b95a1" style={{ marginBottom: 10 }} />
              <Text className="mb-1 text-base font-semibold text-[#191f28]">앱 사용법을 물어보세요</Text>
              <Text className="text-center text-sm text-[#8b95a1]">설명서와 지금 걸린 설정을 보고 답해요</Text>
            </View>
            <Panel title="이런 걸 물어봐요">
              {SUGGESTED_QUESTIONS.map((q) => (
                <ListRow
                  key={q}
                  // 질문은 문장이라 ListRow 기본 제목(굵게·1줄 말줄임) 대신 2줄까지 도는 본문 톤으로 그린다.
                  title={
                    <Text className="text-[15px] leading-6 text-[#191f28]" numberOfLines={2}>
                      {q}
                    </Text>
                  }
                  onPress={() => void send(q)}
                  trailing={<Ionicons name="chevron-forward" size={16} color="#8b95a1" />}
                />
              ))}
            </Panel>
            <View className="px-5 pt-2">
              <Pressable
                onPress={() => setShowManual(true)}
                className="flex-row items-center active:opacity-60"
                style={{ minHeight: 44, gap: 6 }}
              >
                <Ionicons name="document-text-outline" size={16} color="#3182f6" />
                <Text className="text-sm font-semibold text-[#3182f6]">설명서 전체 읽기</Text>
              </Pressable>
            </View>
          </>
        ) : (
          bubbles.map((b, i) =>
            b.role === 'user' ? (
              <UserBubble key={i} text={b.text} />
            ) : (
              <ModelBubble key={i} bubble={b} note={i === bubbles.length - 1 ? toolNote : null} />
            ),
          )
        )}
      </ScrollView>

      <View className="bg-white px-5 pt-3" style={{ paddingBottom: keyboardUp ? 12 : insets.bottom + 12 }}>
        <View className="flex-row items-end" style={{ gap: 8 }}>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder="궁금한 걸 물어보세요"
            placeholderTextColor="#8b95a1"
            multiline
            maxLength={300}
            className="flex-1 rounded-2xl bg-[#f2f4f6] px-4 py-3 text-[15px] text-[#191f28]"
            style={{ maxHeight: 120 }}
            onSubmitEditing={() => void send(input)}
          />
          <Pressable
            onPress={() => void send(input)}
            disabled={!canSend}
            className="items-center justify-center rounded-full active:opacity-80"
            style={{ width: 44, height: 44, backgroundColor: canSend ? '#3182f6' : '#e5e8eb' }}
            accessibilityRole="button"
            accessibilityLabel="질문 보내기"
          >
            {busy ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Ionicons name="arrow-up" size={20} color={canSend ? '#ffffff' : '#8b95a1'} />
            )}
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
