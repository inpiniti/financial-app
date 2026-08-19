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
import { pnlColor } from '../../../lib/format';
import {
  fetchCompanyBrief,
  loadCachedCompanyBrief,
  parsePartialCompanyBrief,
  saveCachedCompanyBrief,
  type CompanyBrief,
  type CompanyBriefProgress,
  type CompanyPoint,
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
  /** progress가 없으면 캐시 확인 중(아직 단계 시작 전). */
  | { kind: 'loading'; progress: CompanyBriefProgress | null }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; brief: CompanyBrief; fromCache: boolean };

/** 본문 섹션 — writing이면 끝에 커서(▍)를 붙여 지금 쓰는 중임을 보인다(2026-08-19 스트리밍). */
function Section({ title, body, writing = false }: { title: string; body: string; writing?: boolean }) {
  if (!body && !writing) return null;
  return (
    <View className="px-5 pb-4">
      <Text className="mb-1 text-xs font-semibold text-[#8b95a1]">{title}</Text>
      <Text className="text-[15px] leading-[22px] text-[#191f28]">
        {body}
        {writing ? <Text className="text-[#3182f6]">▍</Text> : null}
      </Text>
    </View>
  );
}

const STEP_LABELS = ['시세 확인', '뉴스·프로필 검색', '기사 읽기', 'AI 정리'] as const;

/** 진행 단계 인덱스 — 시세(0)는 이 패널이 열릴 때 이미 끝나 있으므로 search 단계부터 1. */
function stepIndexOf(progress: CompanyBriefProgress | null): number {
  if (!progress) return 0;
  if (progress.stage === 'search') return 1;
  if (progress.stage === 'articles') return 2;
  return 3;
}

/**
 * 진행 표시 — 단계 4개를 한 줄씩(끝난 단계 체크, 진행 중 스피너, 남은 단계 회색).
 * 기다림의 대부분이 "기사 읽기"와 "AI 정리"라 각 단계에 짧은 설명을 붙인다.
 */
function ProgressSteps({ progress }: { progress: CompanyBriefProgress | null }) {
  const current = stepIndexOf(progress);
  const detail = (i: number): string => {
    if (i === 2 && progress?.stage === 'articles') return progress.total > 0 ? `최신 기사 ${progress.total}건 본문을 읽고 있어요` : '읽을 기사가 없어요';
    if (i === 3 && progress?.stage === 'generate') return progress.text ? '쓰는 중이에요' : '재료를 넘기고 첫 문장을 기다려요';
    if (i === 1 && progress?.stage === 'search') return 'Yahoo Finance에서 찾고 있어요';
    return '';
  };
  return (
    <View className="px-5 pb-3">
      {STEP_LABELS.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <View key={label} className="flex-row items-center py-[5px]">
            <View className="w-5 items-center">
              {done ? (
                <Ionicons name="checkmark-circle" size={16} color="#3182f6" />
              ) : active ? (
                <ActivityIndicator size="small" color="#3182f6" />
              ) : (
                <Ionicons name="ellipse-outline" size={14} color="#d1d6db" />
              )}
            </View>
            <Text
              className={
                done ? 'ml-2 text-sm text-[#8b95a1]' : active ? 'ml-2 text-sm font-semibold text-[#191f28]' : 'ml-2 text-sm text-[#b0b8c1]'
              }
            >
              {label}
            </Text>
            {active && detail(i) ? <Text className="ml-2 flex-1 text-xs text-[#8b95a1]" numberOfLines={1}>{detail(i)}</Text> : null}
          </View>
        );
      })}
    </View>
  );
}

function SkeletonLine({ width }: { width: number | `${number}%` }) {
  return <View className="mb-2 h-[14px] rounded-full bg-[#f7f9fc]" style={{ width }} />;
}

/** 호재/악재 한 줄 — 앞의 색 점 + 문장 + 근거 기사 번호(회색). */
function PointRow({ point, color }: { point: CompanyPoint; color: string }) {
  return (
    <View className="flex-row items-start px-5 py-[7px]">
      <View className="mr-2.5 mt-[8px] h-[6px] w-[6px] rounded-full" style={{ backgroundColor: color }} />
      <Text className="flex-1 text-[15px] leading-[22px] text-[#191f28]">
        {point.text}
        {point.refs.length ? <Text className="text-xs text-[#8b95a1]"> [{point.refs.join(',')}]</Text> : null}
      </Text>
    </View>
  );
}

function SubLabel({ children }: { children: string }) {
  return <Text className="px-5 pb-1 pt-3 text-xs font-semibold text-[#8b95a1]">{children}</Text>;
}

/**
 * 뉴스 분석 패널 — 사용자는 뉴스 "목록"이 아니라 읽고 분석한 결과를 원한다(2026-08-19).
 * 종합 → 호재/악재(근거 번호) → 지켜볼 점 → 근거 기사(접힘, 탭하면 원문).
 */
function NewsAnalysisPanel({ brief }: { brief: CompanyBrief }) {
  const [showSources, setShowSources] = useState(false);
  const readCount = brief.news.filter((item) => item.read).length;
  const hasAnalysis = Boolean(brief.newsDigest) || brief.positives.length > 0 || brief.negatives.length > 0;

  return (
    <Panel
      title="최근 뉴스 분석"
      headerRight={brief.news.length ? `기사 ${brief.news.length}건 · 본문 ${readCount}건 읽음` : undefined}
    >
      {!hasAnalysis ? (
        <View className="px-5 pb-4">
          <Text className="text-sm text-[#8b95a1]">
            {brief.news.length ? '기사에서 분석할 만한 내용을 찾지 못했어요' : '최근 뉴스를 찾지 못했어요'}
          </Text>
        </View>
      ) : (
        <>
          {brief.newsDigest ? (
            <View className="px-5 pb-2">
              <Text className="text-[15px] leading-[22px] text-[#191f28]">{brief.newsDigest}</Text>
            </View>
          ) : null}
          {brief.positives.length ? (
            <>
              <SubLabel>호재</SubLabel>
              {brief.positives.map((p, i) => (
                <PointRow key={`p${i}`} point={p} color={pnlColor(1)} />
              ))}
            </>
          ) : null}
          {brief.negatives.length ? (
            <>
              <SubLabel>악재</SubLabel>
              {brief.negatives.map((p, i) => (
                <PointRow key={`n${i}`} point={p} color={pnlColor(-1)} />
              ))}
            </>
          ) : null}
          {brief.watch.length ? (
            <>
              <SubLabel>지켜볼 점</SubLabel>
              {brief.watch.map((w, i) => (
                <PointRow key={`w${i}`} point={{ text: w, refs: [] }} color="#8b95a1" />
              ))}
            </>
          ) : null}
          <View style={{ height: 8 }} />
        </>
      )}

      {brief.news.length ? (
        <>
          <Pressable
            onPress={() => setShowSources((v) => !v)}
            className="flex-row items-center px-5 py-3"
            style={({ pressed }) => ({ backgroundColor: pressed ? '#f7f9fc' : 'transparent' })}
            accessibilityRole="button"
            accessibilityState={{ expanded: showSources }}
          >
            <Ionicons name={showSources ? 'chevron-up' : 'chevron-down'} size={14} color="#3182f6" />
            <Text className="ml-1 text-sm font-semibold text-[#3182f6]">
              근거 기사 {brief.news.length}건 {showSources ? '접기' : '보기'}
            </Text>
          </Pressable>
          {showSources
            ? brief.news.map((item, idx) => (
                <Pressable
                  key={`${item.link}-${idx}`}
                  className="flex-row items-start px-5 py-[10px]"
                  disabled={!item.link}
                  onPress={() => void Linking.openURL(item.link)}
                  style={({ pressed }) => ({ backgroundColor: pressed ? '#f7f9fc' : 'transparent' })}
                  accessibilityRole={item.link ? 'link' : undefined}
                >
                  <Text className="mr-2 w-5 text-sm text-[#8b95a1]">{idx + 1}</Text>
                  <View className="flex-1">
                    <Text className="text-sm text-[#191f28]" numberOfLines={2}>
                      {item.title}
                    </Text>
                    <Text className="mt-0.5 text-xs text-[#8b95a1]">
                      {[item.source, item.date, item.read ? '본문 읽음' : '헤드라인만'].filter(Boolean).join(' · ')}
                    </Text>
                  </View>
                </Pressable>
              ))
            : null}
        </>
      ) : null}
    </Panel>
  );
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
      setState({ kind: 'loading', progress: null });
      try {
        if (!force) {
          const cached = await loadCachedCompanyBrief(ticker, excd, Date.now());
          if (cached) {
            setState({ kind: 'ready', brief: cached, fromCache: true });
            return;
          }
        }
        // 단계·조각마다 상태를 갱신 — 스트리밍 조각은 초당 여러 번 올 수 있지만 텍스트 setState라 부담이 작다.
        const brief = await fetchCompanyBrief(
          { ticker, market: excd, name, detail: detail ?? null },
          { onProgress: (progress) => setState({ kind: 'loading', progress }) },
        );
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
          (() => {
            const progress = state.kind === 'loading' ? state.progress : null;
            const partial = progress?.stage === 'generate' && progress.text ? parsePartialCompanyBrief(progress.text) : null;
            return (
              <>
                <ProgressSteps progress={progress} />
                {partial ? (
                  // 모델이 쓰는 대로 섹션에 글자가 차오른다 — 목록(호재/악재 등)은 완성 후 NewsAnalysisPanel에서.
                  <>
                    <Section title="어떤 회사인가요" body={partial.about} writing={partial.writing === 'about'} />
                    <Section title="주력 사업·수익원" body={partial.business} writing={partial.writing === 'business'} />
                    <Section title="현재 상황" body={partial.situation} writing={partial.writing === 'situation'} />
                    <Section title="최근 뉴스 종합" body={partial.newsDigest} writing={partial.writing === 'newsDigest'} />
                  </>
                ) : (
                  <View className="px-5 pb-4">
                    <SkeletonLine width="90%" />
                    <SkeletonLine width="70%" />
                    <SkeletonLine width="80%" />
                  </View>
                )}
              </>
            );
          })()
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
        <NewsAnalysisPanel brief={state.brief} />
      ) : null}

      <Panel style={{ marginBottom: 0 }}>
        <FeedDiagnostic manager={manager} trKey={trKey} quoteState={quoteState} />
      </Panel>
    </ScrollView>
  );
}
