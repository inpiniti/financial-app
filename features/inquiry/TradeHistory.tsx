// 오늘 거래 기록 — 앱이 직접 기록한 오늘의 매수→매도 사이클(features/scalper/tradeStore).
// KIS 세션 없이 AsyncStorage만 읽는다. 홈 트레이딩 섹션(AutoPilotScreen)의 푸터 패널로 들어가므로
// 자체 스크롤(FlatList) 없이 map 렌더만 한다 — 바깥 FlatList와 스크롤 중첩 금지.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { ListRow } from '../../components/ListRow';
import { Panel } from '../../components/Panel';
import { TickerAvatar } from '../../components/TickerAvatar';
import { formatSignedUsd, formatUsd, pnlColor } from '../../lib/format';
import { readTodayTrades, type StoredTrade } from '../scalper/tradeStore';
import { EmptyState, SkeletonList } from './components';

const clock = { now: () => Date.now() };

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** epoch ms → 'HH:mm' (한국시간) — 청산 체결 시각 표시용. */
function formatKstTime(tsMs: number): string {
  const kst = new Date(tsMs + KST_OFFSET_MS);
  const pad2 = (n: number) => String(n).padStart(2, '0');
  return `${pad2(kst.getUTCHours())}:${pad2(kst.getUTCMinutes())}`;
}

/**
 * 사이클 1건 행 — 색 규칙(이익=빨강, 손실=파랑)은 lib/format.pnlColor 하나로 통일한다
 * (개별 파일에서 직접 삼항연산 금지). 탭하면 종목상세로 들어간다.
 */
function CycleRow({ item }: { item: StoredTrade }) {
  // 수수료를 켠 뒤 기록에만 fees가 있다(옛 기록은 undefined) — 있을 때만 덧붙인다.
  const feeNote = item.fees && item.fees > 0 ? ` · 수수료 ${formatUsd(item.fees)}` : '';
  const handlePress = () => {
    // market이 없는 옛 기록은 NAS 폴백 — 자동단타 미채용 티커 기본값(autopilotManager.marketOf)과 동일 관례.
    router.push({ pathname: '/stock/[ticker]', params: { ticker: item.ticker, market: item.market ?? 'NAS' } });
  };
  return (
    <ListRow
      onPress={handlePress}
      leading={<TickerAvatar ticker={item.ticker} />}
      title={item.ticker}
      subtitle={`진입 ${formatUsd(item.entryPrice)} → 청산 ${formatUsd(item.exitPrice)}${feeNote}`}
      trailing={
        <>
          <Text style={{ color: pnlColor(item.pnl) }} className="text-sm font-bold">
            {formatSignedUsd(item.pnl)}
          </Text>
          <Text className="mt-0.5 text-xs font-semibold text-[#8b95a1]">{formatKstTime(item.exitTs)}</Text>
        </>
      }
    />
  );
}

/**
 * 오늘 거래 기록 로드 훅 — reloadKey가 바뀌면 다시 읽는다(사이클 완료 시 부모가 키를 올려 갱신).
 * null = 아직 로드 전(스켈레톤 대상).
 */
export function useTodayTrades(reloadKey: number = 0): StoredTrade[] | null {
  const [trades, setTrades] = useState<StoredTrade[] | null>(null);

  const load = useCallback(async () => {
    const local = await readTodayTrades(AsyncStorage, clock);
    // 시간순(진입 시각 기준) 정렬 — "오늘 매수→매도 사이클을 시간순으로" 요구사항 계승.
    setTrades([...local].sort((a, b) => a.entryTs - b.entryTs));
  }, []);

  useEffect(() => {
    load();
  }, [load, reloadKey]);

  return trades;
}

/** 오늘 거래 기록 패널 — 스크롤 없는 순수 패널(부모 FlatList의 푸터로 들어간다). */
export function TradeHistoryPanel({ trades }: { trades: StoredTrade[] | null }) {
  return (
    <Panel title="오늘 거래 기록" headerRight={trades && trades.length > 0 ? `${trades.length}건` : undefined}>
      {trades === null ? (
        <SkeletonList count={2} />
      ) : trades.length === 0 ? (
        <EmptyState
          icon="receipt-outline"
          title="오늘 완료한 사이클이 없어요"
          description="매수→매도가 끝나면 여기에 나타나요"
        />
      ) : (
        trades.map((item, idx) => <CycleRow key={`${item.instanceId}-${item.exitTs}-${idx}`} item={item} />)
      )}
      <View style={{ height: 8 }} />
    </Panel>
  );
}
