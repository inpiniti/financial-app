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
import { APP_MANUAL, type HelpRuntimeState } from '../appManual';
import { SUGGESTED_QUESTIONS, askHelp, type HelpMessage } from '../helpChat';
import { HELP_TOOL_DECLARATIONS, runHelpTool, type HelpAutopilotSnapshot } from '../tools';
import { clearHelpChat, readHelpChat, writeHelpChat } from '../chatStore';

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
      trend: formatTrendForTool(row.view.trend),
    })),
  };
}

/** 추세 4선을 도구 결과에 넣을 한 줄로 — 화면 표기(5↑ 20↑ …)와 같은 읽기 방식. */
function formatTrendForTool(trend: { up: { ma5: boolean | null; ma20: boolean | null; ma60: boolean | null; ma120: boolean | null }; bars: number } | null): string {
  if (!trend) return '봉 부족';
  const arrow = (up: boolean | null) => (up === null ? '·' : up ? '상승' : '하락');
  return `5선 ${arrow(trend.up.ma5)}, 20선 ${arrow(trend.up.ma20)}, 60선 ${arrow(trend.up.ma60)}, 120선 ${arrow(trend.up.ma120)} (봉 ${trend.bars})`;
}

export function HelpChat() {
  const insets = useSafeAreaInsets();
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [showManual, setShowManual] = useState(false);
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

  // 지난 대화 복원(2026-08-22) — 화면을 나갔다 와도 이어서 물을 수 있게. 읽기 실패는 빈 대화로 넘긴다.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { default: AsyncStorage } = await import('@react-native-async-storage/async-storage');
        const saved = await readHelpChat(AsyncStorage);
        if (!cancelled && saved.length > 0) setBubbles(saved.map(({ role, text }) => ({ role, text })));
      } catch {
        // 저장소를 못 읽어도 대화는 시작할 수 있어야 한다.
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
    if (!restored || busy) return;
    const keep = bubbles.filter((b) => !b.pending && !b.failed).map(({ role, text }) => ({ role, text }));
    if (keep.length === 0) return;
    void (async () => {
      try {
        const { default: AsyncStorage } = await import('@react-native-async-storage/async-storage');
        await writeHelpChat(AsyncStorage, keep);
      } catch {
        // 저장 실패는 조용히 넘긴다 — 대화 자체를 막을 이유가 없다.
      }
    })();
  }, [bubbles, busy, restored]);

  /** 대화 지우기 — 화면과 저장소를 함께 비운다. */
  const clearChat = useCallback(() => {
    setBubbles([]);
    void (async () => {
      try {
        const { default: AsyncStorage } = await import('@react-native-async-storage/async-storage');
        await clearHelpChat(AsyncStorage);
      } catch {
        // 무시 — 화면은 이미 비었다.
      }
    })();
  }, []);

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
        {bubbles.length > 0 && !busy && (
          <Pressable
            onPress={clearChat}
            className="mb-2 flex-row items-center self-end active:opacity-60"
            style={{ minHeight: 32, gap: 4 }}
            accessibilityRole="button"
            accessibilityLabel="대화 지우기"
          >
            <Ionicons name="trash-outline" size={14} color="#8b95a1" />
            <Text className="text-xs text-[#8b95a1]">대화 지우기</Text>
          </Pressable>
        )}
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
