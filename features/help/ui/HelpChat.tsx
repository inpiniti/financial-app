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
import { EmptyState } from '../../inquiry/components';
import { loadAppSettings, type AppSettings } from '../../../lib/appSettings';
import { peekManagerBootstrap } from '../../scalper/ui/managerProvider';
import { APP_MANUAL, type HelpRuntimeState } from '../appManual';
import { SUGGESTED_QUESTIONS, askHelp, type HelpMessage } from '../helpChat';

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

function ModelBubble({ bubble }: { bubble: Bubble }) {
  const empty = bubble.text.trim() === '';
  return (
    <View className="mb-3 items-start px-5">
      <View className="max-w-[92%] rounded-2xl bg-white px-4 py-3">
        {empty && bubble.pending ? (
          <Text className="text-[15px] leading-6 text-[#8b95a1]">설명서를 찾아보고 있어요…</Text>
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

export function HelpChat() {
  const insets = useSafeAreaInsets();
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  // 설정은 화면을 열 때 한 번 읽는다 — 답변에 "지금 내 값"을 넣기 위한 재료다.
  useEffect(() => {
    loadAppSettings()
      .then(setSettings)
      .catch(() => setSettings(null));
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
      try {
        const answer = await askHelp(
          history,
          { settings, runtime: readRuntimeState() },
          { onProgress: (acc) => patchLast({ text: acc }) },
        );
        patchLast({ text: answer, pending: false });
      } catch (e) {
        patchLast({
          text: `지금은 답변을 가져오지 못했어요. 잠시 뒤에 다시 물어봐 주세요. (${
            e instanceof Error ? e.message : String(e)
          })`,
          pending: false,
          failed: true,
        });
      } finally {
        setBusy(false);
      }
    },
    [bubbles, busy, settings],
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
      keyboardVerticalOffset={insets.top + 44}
      className="flex-1 bg-[#f2f4f6]"
    >
      <ScrollView
        ref={scrollRef}
        className="flex-1"
        contentContainerStyle={{ paddingTop: 12, paddingBottom: 12 }}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
        keyboardShouldPersistTaps="handled"
      >
        {bubbles.length === 0 ? (
          <>
            <EmptyState
              icon="chatbubble-ellipses-outline"
              title="앱 사용법을 물어보세요"
              description="설명서와 지금 걸린 설정을 보고 답해요"
            />
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
              <ModelBubble key={i} bubble={b} />
            ),
          )
        )}
      </ScrollView>

      <View className="bg-white px-5 pt-3" style={{ paddingBottom: insets.bottom + 12 }}>
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
