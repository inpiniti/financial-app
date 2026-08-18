// 설정 화면 "순위" 패널 — 트레이딩 리스트를 어느 순위에서 몇 개씩 뽑을지(core/ranking 순위 도메인, 2026-08-18).
// 원천마다 체크(켬) + 개수 입력, 한투 원천은 기간창(SelectBox)까지. 저장은 부모(app/settings.tsx)가 한다 —
// 이 패널은 편집 상태(문자열 개수)를 들고 있다가 toRankingSelection으로 도메인 값을 돌려준다.
// UI 문법: .claude/skills/app-ui-style — 풀폭 Panel, 촘촘한 행(px-5), 선택은 SelectBox(바텀시트).
import { useMemo } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Panel } from '../../../components/Panel';
import { SelectBox } from '../../../components/SelectBox';
import {
  KIS_METRIC_WINDOW_UNIT,
  KIS_WINDOWS,
  RANKING_SOURCES,
  RANKING_TOTAL_MAX,
  kisWindowLabel,
  rankingSourceLabel,
  type KisWindow,
  type RankingSelection,
  type RankingSource,
} from '../../../core/ranking';

/** 화면 편집 상태 — 개수는 입력 중 빈 문자열을 허용하려고 문자열로 든다. */
export interface RankingSelectionDraftItem {
  enabled: boolean;
  countText: string;
  window?: KisWindow;
}
export type RankingSelectionDraft = Record<string, RankingSelectionDraftItem>;

/** 저장값 → 편집 상태. normalizeRankingSelection을 거친 값(전 원천 존재)을 기대한다. */
export function draftFromSelection(selection: RankingSelection): RankingSelectionDraft {
  const draft: RankingSelectionDraft = {};
  for (const source of RANKING_SOURCES) {
    const item = selection[source.id];
    draft[source.id] = {
      enabled: item?.enabled ?? false,
      countText: item && item.count > 0 ? String(item.count) : '',
      window: item?.window,
    };
  }
  return draft;
}

/** 편집 상태 → 도메인 선택값. 빈 칸·비정상 개수는 0으로(검증은 core/ranking.validateRankingSelection 몫). */
export function selectionFromDraft(draft: RankingSelectionDraft): RankingSelection {
  const out: Record<string, { enabled: boolean; count: number; window?: KisWindow }> = {};
  for (const source of RANKING_SOURCES) {
    const item = draft[source.id];
    const count = Number.parseInt(item?.countText ?? '', 10);
    out[source.id] = {
      enabled: item?.enabled ?? false,
      count: Number.isFinite(count) && count > 0 ? count : 0,
      ...(source.provider === 'kis' ? { window: item?.window } : {}),
    };
  }
  return out;
}

function draftTotal(draft: RankingSelectionDraft): number {
  let total = 0;
  for (const source of RANKING_SOURCES) {
    const item = draft[source.id];
    if (!item?.enabled) continue;
    const n = Number.parseInt(item.countText, 10);
    if (Number.isFinite(n) && n > 0) total += n;
  }
  return total;
}

function SourceRow(props: {
  source: RankingSource;
  item: RankingSelectionDraftItem;
  onChange: (next: RankingSelectionDraftItem) => void;
}) {
  const { source, item, onChange } = props;
  // 토스 라벨은 "토스 거래대금 실시간 위험미포함"처럼 길어 앞의 "토스 "/"한투 "는 섹션 제목으로 빼고 나머지만 그린다.
  const label = rankingSourceLabel(source).replace(/^(토스|한투) /, '');
  const windowOptions =
    source.provider === 'kis'
      ? KIS_WINDOWS.map((w) => ({ value: w, label: kisWindowLabel(source.metric, w) }))
      : [];
  return (
    <View className="px-5">
      <View className="flex-row items-center py-[9px]">
        <Pressable
          onPress={() => onChange({ ...item, enabled: !item.enabled })}
          hitSlop={8}
          className="flex-1 flex-row items-center active:opacity-70"
        >
          <Ionicons
            name={item.enabled ? 'checkbox' : 'square-outline'}
            size={22}
            color={item.enabled ? '#3182f6' : '#b0b8c1'}
          />
          <Text
            className={item.enabled ? 'ml-2 flex-1 text-sm text-[#191f28]' : 'ml-2 flex-1 text-sm text-[#8b95a1]'}
            numberOfLines={1}
          >
            {label}
          </Text>
        </Pressable>
        <TextInput
          value={item.countText}
          onChangeText={(t) => onChange({ ...item, countText: t.replace(/[^0-9]/g, '') })}
          keyboardType="number-pad"
          placeholder="0"
          placeholderTextColor="#b0b8c1"
          editable={item.enabled}
          className="w-14 rounded-xl border border-[#e5e8eb] px-2 py-1.5 text-center text-sm text-[#191f28]"
          style={item.enabled ? undefined : { opacity: 0.5 }}
        />
      </View>
      {source.provider === 'kis' && item.enabled ? (
        <View className="mb-2 flex-row">
          <SelectBox
            label={KIS_METRIC_WINDOW_UNIT[source.metric] === 'day' ? '기간(일)' : '기간(분)'}
            value={item.window ?? '0'}
            options={windowOptions}
            onChange={(v) => onChange({ ...item, window: v as KisWindow })}
          />
        </View>
      ) : null}
    </View>
  );
}

export function RankingSelectionPanel(props: {
  draft: RankingSelectionDraft;
  onChange: (next: RankingSelectionDraft) => void;
}) {
  const { draft, onChange } = props;
  const total = useMemo(() => draftTotal(draft), [draft]);
  const over = total > RANKING_TOTAL_MAX;
  const tossSources = RANKING_SOURCES.filter((s) => s.provider === 'toss');
  const kisSources = RANKING_SOURCES.filter((s) => s.provider === 'kis');

  const update = (id: string, next: RankingSelectionDraftItem) => onChange({ ...draft, [id]: next });

  return (
    <Panel
      title="순위"
      headerRight={
        <Text className="text-xs font-semibold" style={{ color: over ? '#f04452' : '#8b95a1' }}>
          {`합계 ${total} / ${RANKING_TOTAL_MAX}`}
        </Text>
      }
    >
      <View className="px-5 pb-3">
        <Text className="text-xs leading-5 text-[#8b95a1]">
          트레이딩 리스트를 어느 순위에서 몇 종목씩 뽑을지 정해요. 위에 있는 순위가 먼저 가져가고, 겹치는 종목은 아래
          순위가 다음 순번으로 채워요. 켜진 순위의 개수 합은 {RANKING_TOTAL_MAX}까지예요(실시간 구독 한도).
        </Text>
      </View>

      <Text className="px-5 pb-1 text-xs font-semibold text-[#4e5968]">토스 (실시간·1일 / 위험포함·위험미포함)</Text>
      {tossSources.map((s) => (
        <SourceRow key={s.id} source={s} item={draft[s.id]} onChange={(next) => update(s.id, next)} />
      ))}

      <Text className="px-5 pb-1 pt-3 text-xs font-semibold text-[#4e5968]">한투 (거래소 NAS·NYS 병합)</Text>
      {kisSources.map((s) => (
        <SourceRow key={s.id} source={s} item={draft[s.id]} onChange={(next) => update(s.id, next)} />
      ))}

      <View className="px-5 pb-5 pt-2">
        <View className="rounded-2xl bg-[#f2f4f6] px-4 py-3">
          <Text className="text-xs leading-5 text-[#4e5968]">
            위험미포함은 관리종목(투자위험·경고 계열)을 뺀 순위예요. 한투 순위는 KIS 키가 있어야 조회돼요. 저장하면
            트레이딩 화면으로 돌아올 때 반영되고, 감시 중이면 리스트를 바로 다시 뽑아요.
          </Text>
        </View>
      </View>
    </Panel>
  );
}
