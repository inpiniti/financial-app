// 오늘 거래 기록 — 앱이 직접 기록한 오늘의 진입, 추가진입(물타기), 청산 체결 기록.
// KIS 세션 없이 AsyncStorage만 읽는다. 홈 트레이딩 섹션 및 /trades 화면에서 재사용된다.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { ListRow } from '../../components/ListRow';
import { Panel } from '../../components/Panel';
import { TickerAvatar } from '../../components/TickerAvatar';
import type { ExitReason } from '../../core/cycle';
import {
  formatKrw,
  formatSignedKrw,
  formatSignedPercentFromRatio,
  formatSignedUsd,
  formatUsd,
  pnlColor,
} from '../../lib/format';
import {
  readTodayTradeActions,
  readTodayTrades,
  type StoredTrade,
  type TradeActionRecord,
  type TradeActionType,
} from '../scalper/tradeStore';
import { EmptyState, SkeletonList } from './components';

const clock = { now: () => Date.now() };
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** epoch ms → 'HH:mm:ss' 또는 'HH:mm' (한국시간). */
function formatKstTime(tsMs: number, withSeconds: boolean = true): string {
  const kst = new Date(tsMs + KST_OFFSET_MS);
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const hm = `${pad2(kst.getUTCHours())}:${pad2(kst.getUTCMinutes())}`;
  return withSeconds ? `${hm}:${pad2(kst.getUTCSeconds())}` : hm;
}

function exitReasonLabel(reason?: ExitReason): string {
  switch (reason) {
    case 'TAKE_PROFIT':
      return '익절(+3%)';
    case 'STOP_LOSS':
      return '손절';
    case 'CIRCUIT':
      return '서킷 청산';
    case 'MANUAL':
      return '수동/외부 매도';
    case 'USER_SELL':
      return '사용자 직접 매도';
    case 'TIMEOUT':
      return '마감 청산';
    case 'SELL_SIGNAL':
      return '매도 신호';
    default:
      return '청산 완료';
  }
}

export type FilterActionType = 'ALL' | TradeActionType;

/**
 * 개별 체결 액션 행 (진입, 추가진입, 청산)
 */
function ActionRow({ item, usdKrw }: { item: TradeActionRecord; usdKrw: number | null }) {
  const toKrw = (usd: number) => formatKrw(usd * (usdKrw as number));
  const priceText = formatUsd(item.price);
  const amountText = formatUsd(item.amountUsd);
  const krwAmountText = usdKrw !== null ? ` (약 ${toKrw(item.amountUsd)})` : '';

  const handlePress = () => {
    router.push({
      pathname: '/stock/[ticker]',
      params: { ticker: item.ticker, market: item.market ?? 'NAS' },
    });
  };

  // 액션 뱃지 스타일
  let badgeText = '진입';
  let badgeBg = 'bg-[#e8f3ff]';
  let badgeTextColor = 'text-[#1b64da]';

  if (item.action === 'SCALE_IN') {
    badgeText = '추가진입';
    badgeBg = 'bg-[#fff4e6]';
    badgeTextColor = 'text-[#d97706]';
  } else if (item.action === 'EXIT') {
    const isProfit = (item.pnl ?? 0) >= 0;
    badgeText = isProfit ? '청산(익절)' : '청산(손절)';
    badgeBg = isProfit ? 'bg-[#fef2f2]' : 'bg-[#f0f4ff]';
    badgeTextColor = isProfit ? 'text-[#f04452]' : 'text-[#3182f6]';
  }

  return (
    <ListRow
      onPress={handlePress}
      leading={<TickerAvatar ticker={item.ticker} />}
      title={
        <View className="flex-row items-center">
          <View className={`mr-2 rounded px-1.5 py-0.5 ${badgeBg}`}>
            <Text className={`text-xs font-bold ${badgeTextColor}`}>{badgeText}</Text>
          </View>
          <Text className="text-base font-semibold text-[#191f28]" numberOfLines={1}>
            {item.name || item.ticker}
          </Text>
          {item.name && (
            <Text className="ml-1 text-xs text-[#8b95a1]" numberOfLines={1}>
              {item.ticker}
            </Text>
          )}
        </View>
      }
      subtitle={
        <View className="mt-1">
          {/* 1행: 체결 시각, 체결 단가 및 수량 */}
          <Text className="text-sm text-[#4e5968]" numberOfLines={1}>
            {formatKstTime(item.ts)} · {item.qty}주 @ {priceText} ({amountText}{krwAmountText})
          </Text>

          {/* 2행: 액션별 상세 맥락 */}
          {item.action === 'ENTRY' && (
            <Text className="mt-0.5 text-xs text-[#8b95a1]" numberOfLines={1}>
              {item.targetPrice ? `익절 목표가 ${formatUsd(item.targetPrice)} (+3.0%)` : '신규 매수 체결'}
            </Text>
          )}
          {item.action === 'SCALE_IN' && (
            <Text className="mt-0.5 text-xs text-[#d97706]" numberOfLines={1}>
              {item.prevAvgPrice && item.newAvgPrice
                ? `평단 ${formatUsd(item.prevAvgPrice)} → ${formatUsd(item.newAvgPrice)} · 총 보유 ${item.totalQty ?? item.qty}주`
                : '물타기 매수 체결'}
            </Text>
          )}
          {item.action === 'EXIT' && (
            <Text className="mt-0.5 text-xs text-[#8b95a1]" numberOfLines={1}>
              {item.entryAvgPrice ? `평단 ${formatUsd(item.entryAvgPrice)} → ` : ''}
              {priceText} · {exitReasonLabel(item.exitReason)}
              {item.fees && item.fees > 0
                ? ` · 수수료 ${usdKrw !== null ? toKrw(item.fees) : formatUsd(item.fees)}`
                : ''}
            </Text>
          )}
        </View>
      }
      trailing={
        item.action === 'EXIT' && item.pnl !== undefined ? (
          <View className="items-end">
            <Text style={{ color: pnlColor(item.pnl) }} className="text-sm font-bold">
              {usdKrw !== null ? formatSignedKrw(item.pnl * usdKrw) : formatSignedUsd(item.pnl)}
            </Text>
            {item.returnRatio !== undefined && (
              <Text style={{ color: pnlColor(item.returnRatio) }} className="mt-0.5 text-xs font-semibold">
                {formatSignedPercentFromRatio(item.returnRatio, 2)}
              </Text>
            )}
          </View>
        ) : (
          <View className="items-end">
            <Text className="text-sm font-semibold text-[#191f28]">
              {usdKrw !== null ? toKrw(item.amountUsd) : amountText}
            </Text>
            <Text className="mt-0.5 text-xs text-[#8b95a1]">{formatKstTime(item.ts, false)}</Text>
          </View>
        )
      }
    />
  );
}

/**
 * 레거시 StoredTrade 행 (하위 호환)
 */
function CycleRow({ item, usdKrw }: { item: StoredTrade; usdKrw: number | null }) {
  const toKrw = (usd: number) => formatKrw(usd * (usdKrw as number));
  const entryText = usdKrw !== null ? toKrw(item.entryPrice) : formatUsd(item.entryPrice);
  const exitText = usdKrw !== null ? toKrw(item.exitPrice) : formatUsd(item.exitPrice);
  const feeNote =
    item.fees && item.fees > 0
      ? ` · 수수료 ${usdKrw !== null ? toKrw(item.fees) : formatUsd(item.fees)}`
      : '';
  const returnRatio = item.entryPrice > 0 ? (item.exitPrice - item.entryPrice) / item.entryPrice : null;

  const handlePress = () => {
    router.push({ pathname: '/stock/[ticker]', params: { ticker: item.ticker, market: item.market ?? 'NAS' } });
  };

  return (
    <ListRow
      onPress={handlePress}
      leading={<TickerAvatar ticker={item.ticker} />}
      title={item.name || item.ticker}
      subtitle={
        <View className="mt-0.5">
          <Text className="text-sm text-[#8b95a1]" numberOfLines={1}>
            {item.name ? `${item.ticker} · ` : ''}
            {item.qty}주 · {formatKstTime(item.entryTs, false)} ~ {formatKstTime(item.exitTs, false)}
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
 * 오늘 체결 액션 로드 훅 — reloadKey가 바뀌면 다시 읽는다.
 */
export function useTodayTradeActions(reloadKey: number = 0): TradeActionRecord[] | null {
  const [actions, setActions] = useState<TradeActionRecord[] | null>(null);

  const load = useCallback(async () => {
    const list = await readTodayTradeActions(AsyncStorage, clock);
    // 최신 체결순(내림차순) 정렬
    setActions([...list].sort((a, b) => b.ts - a.ts));
  }, []);

  useEffect(() => {
    load();
  }, [load, reloadKey]);

  return actions;
}

/**
 * 오늘 거래 기록 로드 훅 (기존 호환)
 */
export function useTodayTrades(reloadKey: number = 0): StoredTrade[] | null {
  const [trades, setTrades] = useState<StoredTrade[] | null>(null);

  const load = useCallback(async () => {
    const local = await readTodayTrades(AsyncStorage, clock);
    setTrades([...local].sort((a, b) => a.entryTs - b.entryTs));
  }, []);

  useEffect(() => {
    load();
  }, [load, reloadKey]);

  return trades;
}

/** 오늘 거래 기록 패널 — 필터 탭(전체/진입/추가진입/청산)과 체결 타임라인 렌더 */
export function TradeHistoryPanel({
  actions,
  trades,
  usdKrw = null,
}: {
  actions?: TradeActionRecord[] | null;
  trades?: StoredTrade[] | null;
  /** USD→KRW 환율. null이면 USD로 보여준다. */
  usdKrw?: number | null;
}) {
  const [filter, setFilter] = useState<FilterActionType>('ALL');

  // 통계 계산
  const stats = useMemo(() => {
    if (!actions) return { entries: 0, scaleIns: 0, exits: 0, totalPnl: 0 };
    let entries = 0;
    let scaleIns = 0;
    let exits = 0;
    let totalPnl = 0;
    for (const a of actions) {
      if (a.action === 'ENTRY') entries++;
      else if (a.action === 'SCALE_IN') scaleIns++;
      else if (a.action === 'EXIT') {
        exits++;
        totalPnl += a.pnl ?? 0;
      }
    }
    return { entries, scaleIns, exits, totalPnl };
  }, [actions]);

  // 필터 적용
  const filteredActions = useMemo(() => {
    if (!actions) return null;
    if (filter === 'ALL') return actions;
    return actions.filter((a) => a.action === filter);
  }, [actions, filter]);

  // actions가 전달된 경우 신규 체결 액션 타임라인 렌더
  if (actions !== undefined) {
    return (
      <Panel
        title="오늘 거래 기록"
        headerRight={actions && actions.length > 0 ? `총 ${actions.length}건` : undefined}
      >
        {actions === null ? (
          <SkeletonList count={3} />
        ) : actions.length === 0 ? (
          <EmptyState
            icon="receipt-outline"
            title="오늘 발생한 거래 체결이 없어요"
            description="진입·추가진입·청산이 실행되면 여기에 실시간으로 기록돼요"
          />
        ) : (
          <View>
            {/* 요약 통계 카드 */}
            <View className="mx-4 mb-3 rounded-xl bg-[#f8f9fa] p-3.5">
              <View className="flex-row items-center justify-between">
                <Text className="text-xs font-semibold text-[#8b95a1]">오늘 실현 손익</Text>
                <Text style={{ color: pnlColor(stats.totalPnl) }} className="text-sm font-bold">
                  {usdKrw !== null
                    ? `${formatSignedKrw(stats.totalPnl * usdKrw)} (${formatSignedUsd(stats.totalPnl)})`
                    : formatSignedUsd(stats.totalPnl)}
                </Text>
              </View>
              <View className="mt-2 flex-row items-center pt-2 border-t border-[#e5e8eb]">
                <Text className="text-xs text-[#6b7684]">
                  진입 <Text className="font-bold text-[#1b64da]">{stats.entries}건</Text>
                  {'  '}·{'  '}
                  추가진입 <Text className="font-bold text-[#d97706]">{stats.scaleIns}건</Text>
                  {'  '}·{'  '}
                  청산 <Text className="font-bold text-[#f04452]">{stats.exits}건</Text>
                </Text>
              </View>
            </View>

            {/* 필터 칩 */}
            <View className="flex-row px-4 pb-2">
              <Pressable
                onPress={() => setFilter('ALL')}
                className={`mr-2 rounded-full px-3 py-1.5 ${
                  filter === 'ALL' ? 'bg-[#191f28]' : 'bg-[#e5e8eb]'
                }`}
              >
                <Text
                  className={`text-xs font-semibold ${
                    filter === 'ALL' ? 'text-white' : 'text-[#4e5968]'
                  }`}
                >
                  전체 ({actions.length})
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setFilter('ENTRY')}
                className={`mr-2 rounded-full px-3 py-1.5 ${
                  filter === 'ENTRY' ? 'bg-[#1b64da]' : 'bg-[#e8f3ff]'
                }`}
              >
                <Text
                  className={`text-xs font-semibold ${
                    filter === 'ENTRY' ? 'text-white' : 'text-[#1b64da]'
                  }`}
                >
                  진입 ({stats.entries})
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setFilter('SCALE_IN')}
                className={`mr-2 rounded-full px-3 py-1.5 ${
                  filter === 'SCALE_IN' ? 'bg-[#d97706]' : 'bg-[#fff4e6]'
                }`}
              >
                <Text
                  className={`text-xs font-semibold ${
                    filter === 'SCALE_IN' ? 'text-white' : 'text-[#d97706]'
                  }`}
                >
                  추가진입 ({stats.scaleIns})
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setFilter('EXIT')}
                className={`rounded-full px-3 py-1.5 ${
                  filter === 'EXIT' ? 'bg-[#e11d48]' : 'bg-[#fef2f2]'
                }`}
              >
                <Text
                  className={`text-xs font-semibold ${
                    filter === 'EXIT' ? 'text-white' : 'text-[#e11d48]'
                  }`}
                >
                  청산 ({stats.exits})
                </Text>
              </Pressable>
            </View>

            {/* 체결 리스트 */}
            {filteredActions && filteredActions.length === 0 ? (
              <View className="py-8 items-center">
                <Text className="text-sm text-[#8b95a1]">해당하는 거래 내역이 없어요</Text>
              </View>
            ) : (
              filteredActions?.map((item, idx) => (
                <ActionRow key={`${item.id}-${idx}`} item={item} usdKrw={usdKrw} />
              ))
            )}
          </View>
        )}
        <View style={{ height: 8 }} />
      </Panel>
    );
  }

  // trades만 전달된 경우 레거시 사이클 렌더
  return (
    <Panel title="오늘 거래 기록" headerRight={trades && trades.length > 0 ? `${trades.length}건` : undefined}>
      {!trades ? (
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

