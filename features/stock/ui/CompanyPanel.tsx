// 종목 상세화면 "기업" 탭 — 2026-08-19 호가 탭 대체. 기업 소개·주력 사업·현재 상황·최근 뉴스를 AI 요약으로 보여준다.
// 데이터 흐름: KIS 현재가상세(1회) + Yahoo 검색(뉴스·프로필) → companyBrief.fetchCompanyBrief(bitcoin-simulation Gemini 프록시)
// → 종목+거래일 캐시. 캐시가 있으면 호출하지 않고, 헤더 우측 "새로고침"으로만 다시 만든다.
// 옛 호가 탭이 갖고 있던 실시간 구독 진단(구독 성공/실패·마지막 수신)은 이 탭 하단 한 줄로 옮겼다 —
// 실기기에서 "왜 시세가 안 오지?"를 확인할 유일한 자리이기 때문.
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Panel } from '../../../components/Panel';
import { inquireOverseasPriceDetail, type OverseasPriceDetail } from '../../../kis/priceDetail';
import { useKisSession } from '../../inquiry/useKisSession';
import type { ScalperManager } from '../../scalper/scalperManager';
import { formatHHMM } from '../../scalper/ui/format';
import {
  fetchCompanyBrief,
  loadCachedCompanyBrief,
  saveCachedCompanyBrief,
  type CompanyBrief,
} from '../companyBrief';
import type { StockMarketCode } from '../marketCodes';
import type { QuoteFeedState } from '../useQuoteFeed';

export interface CompanyPanelProps {
  ticker: string;
  excd: StockMarketCode;
  name?: string;
  /** 실시간 구독 진단용 — null이면(KIS 키 미설정 등) 진단 줄을 "구독 안 함"으로 표시. */
  manager: ScalperManager | null;
  quoteState: QuoteFeedState;
  trKey: string | null;
}

type BriefState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; brief: CompanyBrief; fromCache: boolean };

function Section({ title, body }: { title: string; body: string }) {
  if (!body) return null;
  return (
    <View className="px-5 pb-4">
      <Text className="mb-1 text-xs font-semibold text-[#8b95a1]">{title}</Text>
      <Text className="text-[15px] leading-[22px] text-[#191f28]">{body}</Text>
    </View>
  );
}

function SkeletonLine({ width }: { width: number | `${number}%` }) {
  return <View className="mb-2 h-[14px] rounded-full bg-[#f7f9fc]" style={{ width }} />;
}

/** 실시간 구독 진단 한 줄 — 옛 QuotePanel의 SubscriptionLine 축약. */
function FeedDiagnostic({
  manager,
  trKey,
  quoteState,
}: {
  manager: ScalperManager | null;
  trKey: string | null;
  quoteState: QuoteFeedState;
}) {
  let text = '실시간 시세 구독 안 함 (KIS 키 미설정)';
  let color = '#8b95a1';
  if (manager && trKey) {
    const status = manager.getSubscriptionStatus(trKey);
    if (!status) {
      text = `실시간 구독 응답 없음 · ${trKey}`;
    } else if (status.success) {
      const last = quoteState.lastTickAt ? ` · 마지막 체결 ${formatHHMM(quoteState.lastTickAt)}` : ' · 아직 체결 없음';
      text = `실시간 구독 성공 ${formatHHMM(status.at)}${last}`;
      color = '#4e5968';
    } else {
      text = `실시간 구독 실패 · ${status.message || '알 수 없음'}`;
      color = '#f04452';
    }
  }
  return (
    <View className="px-5 py-3">
      <Text className="text-xs" style={{ color }} numberOfLines={2}>
        {text}
      </Text>
    </View>
  );
}

export function CompanyPanel({ ticker, excd, name, manager, quoteState, trKey }: CompanyPanelProps) {
  const sessionState = useKisSession(0);
  const [detail, setDetail] = useState<OverseasPriceDetail | null | undefined>(undefined);
  const [state, setState] = useState<BriefState>({ kind: 'idle' });

  // 1) 현재가상세 — 세션이 없으면(null) 시세 없이 진행한다.
  useEffect(() => {
    if (sessionState.kind === 'error' || sessionState.kind === 'needsSetup') {
      setDetail(null);
      return;
    }
    if (sessionState.kind !== 'ready') return;
    let cancelled = false;
    (async () => {
      try {
        const d = await inquireOverseasPriceDetail(sessionState.session.credentials, sessionState.session.accessToken, {
          excd,
          symb: ticker,
        });
        if (!cancelled) setDetail(d);
      } catch {
        if (!cancelled) setDetail(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionState, excd, ticker]);

  const generate = useCallback(
    async (force: boolean) => {
      setState({ kind: 'loading' });
      try {
        if (!force) {
          const cached = await loadCachedCompanyBrief(ticker, excd, Date.now());
          if (cached) {
            setState({ kind: 'ready', brief: cached, fromCache: true });
            return;
          }
        }
        const brief = await fetchCompanyBrief({ ticker, market: excd, name, detail: detail ?? null });
        await saveCachedCompanyBrief(ticker, excd, brief);
        setState({ kind: 'ready', brief, fromCache: false });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setState({ kind: 'error', message: message.slice(0, 200) });
      }
    },
    [ticker, excd, name, detail],
  );

  // 2) 시세 조회가 끝나면(성공이든 실패든) 자동으로 한 번 생성 — 캐시 우선.
  useEffect(() => {
    if (detail === undefined) return;
    if (state.kind !== 'idle') return;
    void generate(false);
  }, [detail, state.kind, generate]);

  const headerRight =
    state.kind === 'ready' ? (
      <Pressable
        onPress={() => void generate(true)}
        hitSlop={8}
        className="flex-row items-center active:opacity-60"
        accessibilityRole="button"
        accessibilityLabel="기업 정보 새로고침"
      >
        <Ionicons name="refresh" size={14} color="#3182f6" />
        <Text className="ml-1 text-xs font-semibold text-[#3182f6]">새로고침</Text>
      </Pressable>
    ) : undefined;

  return (
    <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 24 }}>
      <Panel title="기업 정보" headerRight={headerRight}>
        {state.kind === 'idle' || state.kind === 'loading' ? (
          <View className="px-5 pb-4">
            <View className="mb-3 flex-row items-center">
              <ActivityIndicator size="small" color="#3182f6" />
              <Text className="ml-2 text-sm text-[#8b95a1]">기업 정보와 최근 뉴스를 정리하고 있어요</Text>
            </View>
            <SkeletonLine width="90%" />
            <SkeletonLine width="70%" />
            <SkeletonLine width="80%" />
          </View>
        ) : state.kind === 'error' ? (
          <View className="px-5 pb-4">
            <Text className="text-[15px] font-semibold text-[#191f28]">기업 정보를 불러오지 못했어요</Text>
            <Text className="mt-1 text-sm text-[#8b95a1]" numberOfLines={3}>
              {state.message}
            </Text>
            <Pressable
              onPress={() => void generate(true)}
              className="mt-3 flex-row items-center self-start active:opacity-60"
              accessibilityRole="button"
            >
              <Ionicons name="refresh" size={14} color="#3182f6" />
              <Text className="ml-1 text-sm font-semibold text-[#3182f6]">다시 시도</Text>
            </Pressable>
          </View>
        ) : state.brief.rawText ? (
          <View className="px-5 pb-4">
            <Text className="text-[15px] leading-[22px] text-[#191f28]">{state.brief.rawText}</Text>
          </View>
        ) : (
          <>
            <Section title="어떤 회사인가요" body={state.brief.about} />
            <Section title="주력 사업·수익원" body={state.brief.business} />
            <Section title="현재 상황" body={state.brief.situation} />
          </>
        )}
        {state.kind === 'ready' ? (
          <View className="px-5 pb-3">
            <Text className="text-[11px] text-[#8b95a1]">
              AI 요약 · {formatHHMM(state.brief.generatedAt)} 생성{state.fromCache ? ' (저장됨)' : ''} · 투자 판단의 근거로 쓰기 전에
              원문을 확인해 주세요
            </Text>
          </View>
        ) : null}
      </Panel>

      {state.kind === 'ready' && !state.brief.rawText ? (
        <Panel title="최근 뉴스" headerRight={state.brief.news.length ? `${state.brief.news.length}건` : undefined}>
          {state.brief.news.length === 0 ? (
            <View className="px-5 pb-4">
              <Text className="text-sm text-[#8b95a1]">최근 1~2주 내 찾은 뉴스가 없어요</Text>
            </View>
          ) : (
            state.brief.news.map((item, idx) => (
              <Pressable
                key={`${item.title}-${idx}`}
                className="px-5 py-[13px]"
                disabled={!item.link}
                onPress={() => void Linking.openURL(item.link)}
                style={({ pressed }) => ({ backgroundColor: pressed ? '#f7f9fc' : 'transparent' })}
                accessibilityRole={item.link ? 'link' : undefined}
              >
                <Text className="text-[15px] font-bold text-[#191f28]">{item.title}</Text>
                {item.source || item.date ? (
                  <Text className="mt-0.5 text-xs text-[#8b95a1]">
                    {[item.source, item.date].filter(Boolean).join(' · ')}
                  </Text>
                ) : null}
                {item.summary ? <Text className="mt-1 text-sm leading-5 text-[#4e5968]">{item.summary}</Text> : null}
              </Pressable>
            ))
          )}
        </Panel>
      ) : null}

      <Panel style={{ marginBottom: 0 }}>
        <FeedDiagnostic manager={manager} trKey={trKey} quoteState={quoteState} />
      </Panel>
    </ScrollView>
  );
}
