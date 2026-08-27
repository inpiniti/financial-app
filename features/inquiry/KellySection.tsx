// 켈리 조회 섹션(손익 화면 하단) — docs/domain/켈리 §5-2.
// Supabase trade_results에서 전략별·최근 n건(미입력=전체) 수익률을 읽어 core/kelly로 배율을 계산해 **보여주기만** 한다.
// 매매·설정·자동관리와 연결되지 않는다(문서 §6-1). 음수 엣지·표본 부족은 회색 뱃지로 표시만.
// app-ui-style: 풀폭 섹션 + ListRow, 선택 UI는 SelectBox(바텀시트), 이모지 금지(Ionicons).
import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { ListRow } from '../../components/ListRow';
import { SelectBox } from '../../components/SelectBox';
import { computeKelly, KELLY_DEFAULT_MIN_SAMPLES, type KellyResult } from '../../core/kelly';
import { loadApprovedAccountNo } from '../../lib/gateStorage';
import { getSupabaseClient, isSupabaseConfigured } from '../../lib/supabase';
import { fetchTradeReturns, type TradeResultsSelectClient, type TradeStrategy } from '../scalper/tradeResults';

const STRATEGY_OPTIONS: { value: TradeStrategy; label: string }[] = [
  { value: 'martingale', label: '물타기 시험' },
  { value: 'model', label: '모델' },
  { value: 'trend', label: '추세' },
  { value: 'inflection', label: '변곡점 조합' },
  { value: 'ladder', label: '사다리' },
  { value: 'grid', label: '그리드' },
];

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; result: KellyResult };

const pct = (v: number | null, digits = 1): string => (v === null ? '—' : `${(v * 100).toFixed(digits)}%`);
const num = (v: number | null, digits = 2): string => (v === null ? '—' : v.toFixed(digits));

function Badge({ text }: { text: string }) {
  return (
    <View className="ml-2 rounded-full bg-[#f2f4f6] px-2 py-0.5">
      <Text className="text-[11px] font-semibold text-[#8b95a1]">{text}</Text>
    </View>
  );
}

function ValueRow({ title, value, badge }: { title: string; value: string; badge?: string }) {
  return (
    <ListRow
      title={<Text className="text-sm text-[#4e5968]">{title}</Text>}
      trailing={
        <View className="flex-row items-center">
          <Text className="text-sm font-bold text-[#191f28]" style={{ fontVariant: ['tabular-nums'] }}>
            {value}
          </Text>
          {badge ? <Badge text={badge} /> : null}
        </View>
      }
    />
  );
}

export function KellySection() {
  const [strategy, setStrategy] = useState<TradeStrategy>('model');
  const [limitText, setLimitText] = useState('');
  const [state, setState] = useState<State>({ kind: 'idle' });

  const configured = isSupabaseConfigured();

  const query = useCallback(async () => {
    if (!configured) return;
    setState({ kind: 'loading' });
    try {
      const accountNo = await loadApprovedAccountNo();
      if (!accountNo) {
        setState({ kind: 'error', message: '게이트 계좌번호가 없어 조회할 수 없어요' });
        return;
      }
      const limit = limitText.trim() === '' ? undefined : Number(limitText);
      const returns = await fetchTradeReturns(
        getSupabaseClient() as unknown as TradeResultsSelectClient,
        accountNo,
        strategy,
        limit !== undefined && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : undefined,
      );
      setState({ kind: 'ready', result: computeKelly(returns) });
    } catch (e) {
      setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }, [configured, limitText, strategy]);

  // 전략이 바뀌면 바로 다시 조회 — 수량은 입력 후 "조회"로(타이핑마다 쿼리하지 않는다).
  useEffect(() => {
    void query();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategy]);

  const r = state.kind === 'ready' ? state.result : null;

  return (
    <View className="bg-white">
      {/* 패널 사이 갭 — 위 리스트와 같은 흰 패널 안에 있으므로 회색 띠로만 구분한다. */}
      <View className="bg-[#f2f4f6]" style={{ height: 8 }} />
      <View className="flex-row items-center justify-between px-5 pb-1 pt-4">
        <Text className="text-[15px] font-bold text-[#191f28]">켈리 배율 (조회)</Text>
        <Text className="text-xs text-[#8b95a1]">매매와 무관 · 척도만</Text>
      </View>
      <Text className="px-5 pb-3 text-xs leading-5 text-[#8b95a1]">
        기록된 거래 결과로 켈리 배율을 계산해 보여줘요. 최근 몇 건만 볼지 비우면 전체 기록으로 계산해요.
      </Text>

      {!configured ? (
        <Text className="px-5 pb-4 text-xs text-[#8b95a1]">Supabase 설정이 없어 조회할 수 없어요.</Text>
      ) : (
        <>
          <View className="flex-row items-center px-5 pb-3" style={{ gap: 8 }}>
            <SelectBox
              label="전략"
              value={strategy}
              options={STRATEGY_OPTIONS}
              onChange={(v) => setStrategy(v as TradeStrategy)}
            />
            <View className="flex-1 rounded-2xl bg-[#f2f4f6] px-3 py-2" style={{ minHeight: 44, justifyContent: 'center' }}>
              <Text className="text-[11px] text-[#8b95a1]">최근 n건 (비우면 전체)</Text>
              <TextInput
                value={limitText}
                onChangeText={setLimitText}
                keyboardType="number-pad"
                placeholder="전체"
                placeholderTextColor="#b0b8c1"
                className="p-0 text-sm font-semibold text-[#191f28]"
                onSubmitEditing={() => void query()}
                returnKeyType="done"
              />
            </View>
            <Pressable
              onPress={() => void query()}
              className="flex-row items-center rounded-2xl bg-[#3182f6] px-3 active:opacity-70"
              style={{ minHeight: 44, gap: 4 }}
            >
              <Ionicons name="search-outline" size={14} color="#ffffff" />
              <Text className="text-sm font-semibold text-white">조회</Text>
            </Pressable>
          </View>

          {state.kind === 'loading' && <Text className="px-5 pb-4 text-xs text-[#8b95a1]">불러오는 중…</Text>}
          {state.kind === 'error' && <Text className="px-5 pb-4 text-xs text-[#f04452]">{state.message}</Text>}
          {r && (
            <View className="pb-2">
              <ValueRow
                title="표본"
                value={`${r.n}건`}
                badge={r.flags.insufficientSamples ? `표본 부족 (<${KELLY_DEFAULT_MIN_SAMPLES})` : undefined}
              />
              <ValueRow title="승률" value={pct(r.winRate)} />
              <ValueRow title="평균 이익 / 평균 손실" value={`${pct(r.avgWin)} / ${pct(r.avgLoss)}`} />
              <ValueRow title="손익비 b" value={num(r.payoff)} />
              <ValueRow title="평균 수익률 μ / 표준편차 σ" value={`${pct(r.mean, 2)} / ${pct(r.variance === null ? null : Math.sqrt(r.variance), 2)}`} />
              <ValueRow title="켈리(이산형) p − (1−p)/b" value={pct(r.discrete)} />
              <ValueRow title="켈리(연속형) μ/σ²" value={pct(r.continuous)} />
              <ValueRow title="켈리 f (작은 쪽)" value={pct(r.raw)} badge={r.flags.negativeEdge ? '음수 엣지' : undefined} />
              <ValueRow title="반켈리 f × 0.5" value={pct(r.half)} />
            </View>
          )}
        </>
      )}
    </View>
  );
}
