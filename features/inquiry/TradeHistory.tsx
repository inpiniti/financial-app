// 오늘 거래 기록 — 앱이 직접 기록한 오늘의 매수→매도 사이클(features/scalper/tradeStore).
// KIS 세션 없이 AsyncStorage만 읽는다. 홈 트레이딩 섹션(AutoPilotScreen)의 헤더 패널로 들어가므로
// 자체 스크롤(FlatList) 없이 map 렌더만 한다 — 바깥 FlatList와 스크롤 중첩 금지.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { ListRow } from '../../components/ListRow';
import { Panel } from '../../components/Panel';
import { TickerAvatar } from '../../components/TickerAvatar';
import { formatKrw, formatSignedKrw, formatSignedPercentFromRatio, formatSignedUsd, formatUsd, pnlColor } from '../../lib/format';
import { readTodayTrades, type StoredTrade } from '../scalper/tradeStore';
import { EmptyState, SkeletonList } from './components';

const clock = { now: () => Date.now() };

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** epoch ms → 'HH:mm' (한국시간) — 진입·청산 체결 시각 표시용. */
function formatKstTime(tsMs: number): string {
  const kst = new Date(tsMs + KST_OFFSET_MS);
  const pad2 = (n: number) => String(n).padStart(2, '0');
  return `${pad2(kst.getUTCHours())}:${pad2(kst.getUTCMinutes())}`;
}

/**
 * 사이클 1건 행 — 색 규칙(이익=빨강, 손실=파랑)은 lib/format.pnlColor 하나로 통일한다
 * (개별 파일에서 직접 삼항연산 금지). 탭하면 종목상세로 들어간다.
 *
 * 기록은 전부 USD로 쌓이지만 체감은 원화라 환율(usdKrw)이 있으면 원화로 보여준다 —
 * 환율을 못 구했을 때만 예전처럼 USD로 폴백한다(잔고 조회 실패 시 usdKrw가 null).
 */
function CycleRow({ item, usdKrw }: { item: StoredTrade; usdKrw: number | null }) {
  const toKrw = (usd: number) => formatKrw(usd * (usdKrw as number));
  const entryText = usdKrw !== null ? toKrw(item.entryPrice) : formatUsd(item.entryPrice);
  const exitText = usdKrw !== null ? toKrw(item.exitPrice) : formatUsd(item.exitPrice);
  // 수수료를 켠 뒤 기록에만 fees가 있다(옛 기록은 undefined) — 있을 때만 덧붙인다.
  const feeNote =
    item.fees && item.fees > 0 ? ` · 수수료 ${usdKrw !== null ? toKrw(item.fees) : formatUsd(item.fees)}` : '';

  // 수익률(진입가 대비 청산가, 수수료 전) — 1주 실험에선 금액이 동전 단위라 %가 실제 정보다.
  const returnRatio = item.entryPrice > 0 ? (item.exitPrice - item.entryPrice) / item.entryPrice : null;

  const handlePress = () => {
    // market이 없는 옛 기록은 NAS 폴백 — 자동 트레이딩 미채용 티커 기본값(autopilotManager.marketOf)과 동일 관례.
    router.push({ pathname: '/stock/[ticker]', params: { ticker: item.ticker, market: item.market ?? 'NAS' } });
  };

  return (
    <ListRow
      onPress={handlePress}
      leading={<TickerAvatar ticker={item.ticker} />}
      // 옛 기록에는 종목명이 없다 — 그때만 예전처럼 티커를 제목으로 쓴다.
      title={item.name || item.ticker}
      subtitle={
        <View className="mt-0.5">
          <Text className="text-sm text-[#8b95a1]" numberOfLines={1}>
            {item.name ? `${item.ticker} · ` : ''}
            {item.qty}주 · {formatKstTime(item.entryTs)} ~ {formatKstTime(item.exitTs)}
          </Text>
          <Text className="mt-0.5 text-sm text-[#8b95a1]" numberOfLines={1}>
            진입 {entryText} → 청산 {exitText}
            {feeNote}
          </Text>
        </View>
      }
      trailing={
        <View className="items-end">
          <Text style={{ color: pnlColor(item.pnl) }} className="text-sm font-bold">
            {usdKrw !== null ? formatSignedKrw(item.pnl * usdKrw) : formatSignedUsd(item.pnl)}
          </Text>
          <Text style={{ color: pnlColor(returnRatio) }} className="mt-0.5 text-xs font-semibold">
            {formatSignedPercentFromRatio(returnRatio, 2)}
          </Text>
        </View>
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

/** 오늘 거래 기록 패널 — 스크롤 없는 순수 패널(부모 FlatList의 헤더로 들어간다). */
export function TradeHistoryPanel({
  trades,
  usdKrw = null,
}: {
  trades: StoredTrade[] | null;
  /** USD→KRW 환율. null이면 USD로 보여준다(환율 조회 실패 폴백). */
  usdKrw?: number | null;
}) {
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
        trades.map((item, idx) => (
          <CycleRow key={`${item.instanceId}-${item.exitTs}-${idx}`} item={item} usdKrw={usdKrw} />
        ))
      )}
      <View style={{ height: 8 }} />
    </Panel>
  );
}
