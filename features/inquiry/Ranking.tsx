// 홈 순위 섹션 — 토스 실시간 순위 2종(거래량 기본·거래대금) + KIS 순위 7종(kis/ranking.ts).
// 행 탭 시 종목 상세화면으로 이동한다.
//
// 토스 순위(lib/tossRanking.ts)는 KIS 키가 없어도 보이는 공개 API라 세션 게이트를 걸지 않는다 —
// 그래서 안내(설정 필요·오류)는 화면 전체가 아니라 목록 자리에만 그린다(선택 상자를 남겨
// 사용자가 다시 토스 순위로 돌아올 수 있게).
import { useCallback, useEffect, useState } from 'react';
import { FlatList, RefreshControl, Text, View } from 'react-native';
import { router } from 'expo-router';
import { ListRow } from '../../components/ListRow';
import { Panel } from '../../components/Panel';
import { SelectBox } from '../../components/SelectBox';
import { TickerAvatar } from '../../components/TickerAvatar';
import { formatUsd } from '../../lib/format';
import {
  inquirePriceFluctRanking,
  inquireTradeGrowthRanking,
  inquireTradeTurnoverRanking,
  inquireTradeVolumeRanking,
  inquireUpDownRateRanking,
  inquireVolumePowerRanking,
  inquireVolumeSurgeRanking,
  mergeRankingRows,
  RANKING_KIND_LABEL,
  RANKING_TIME_UNIT,
  US_RANKING_EXCHANGES,
  type DayWindow,
  type MinuteWindow,
  type PriceFluctDirection,
  type RankingExchangeCode,
  type RankingKind,
} from '../../kis/ranking';
import { fetchTossRanking, type TossRankingKind } from '../../lib/tossRanking';
import { toStockMarketCode } from '../stock/marketCodes';
import { EmptyState, ErrorNotice, SetupNotice, SkeletonList } from './components';
import { useKisSession } from './useKisSession';

/** 토스 순위는 KIS 순위와 원천이 달라 UI에서만 종류로 합쳐 다룬다 — 거래량·거래대금 2종(2026-08-14 확장). */
const TOSS_KIND = 'tossVolume';
const TOSS_AMOUNT_KIND = 'tossAmount';
type TossUiKind = typeof TOSS_KIND | typeof TOSS_AMOUNT_KIND;
type UiRankingKind = TossUiKind | RankingKind;

/** UI 종류 → lib/tossRanking.ts 순위 종류. 화면 조회라 관리종목 필터는 걸지 않는다(토스 앱 화면과 동일). */
const TOSS_FETCH_KIND: Record<TossUiKind, TossRankingKind> = {
  [TOSS_KIND]: 'volume',
  [TOSS_AMOUNT_KIND]: 'amount',
};

function isTossKind(kind: UiRankingKind): kind is TossUiKind {
  return kind === TOSS_KIND || kind === TOSS_AMOUNT_KIND;
}

const KIND_ORDER: UiRankingKind[] = [
  TOSS_KIND, // 기본값 — 사용자가 가장 먼저 보는 순위(2026-08-11).
  TOSS_AMOUNT_KIND,
  'tradeVolume',
  'volumeSurge',
  'priceFluct',
  'tradeGrowth',
  'tradeTurnover',
  'volumePower',
  'upDownRate',
];

const KIND_LABEL: Record<UiRankingKind, string> = {
  [TOSS_KIND]: '토스거래량실시간순위',
  [TOSS_AMOUNT_KIND]: '토스거래대금실시간순위',
  ...RANKING_KIND_LABEL,
};

const KIND_OPTIONS = KIND_ORDER.map((k) => ({ value: k, label: KIND_LABEL[k] }));

// 방향(GUBN) — 가격급등락과 상승율/하락율이 값은 같고(0·1) 라벨만 다르다.
const DIRECTION_OPTIONS: Array<{ value: PriceFluctDirection; label: string }> = [
  { value: '1', label: '급등' },
  { value: '0', label: '급락' },
];

const UPDOWN_DIRECTION_OPTIONS: Array<{ value: PriceFluctDirection; label: string }> = [
  { value: '1', label: '상승율' },
  { value: '0', label: '하락율' },
];

/** 방향 셀렉트를 쓰는 순위 종류 — 둘 다 GUBN 0/1이라 상태를 하나로 공유한다. */
const DIRECTION_KINDS: UiRankingKind[] = ['priceFluct', 'upDownRate'];

// 일 단위 창(거래량순위·거래증가율순위·거래회전율순위) 프리셋 — 문서 설명 그대로.
const DAY_WINDOW_OPTIONS: Array<{ value: DayWindow; label: string }> = [
  { value: '0', label: '당일' },
  { value: '1', label: '2일' },
  { value: '3', label: '5일' },
  { value: '5', label: '20일' },
  { value: '9', label: '1년' },
];

// 분 단위 창(거래량급증·가격급등락·매수체결강도상위) 프리셋 — 매수체결강도상위는 파라미터명이 NDAY지만 값 단위는 분(kis/ranking.ts 주석 참고).
const MINUTE_WINDOW_OPTIONS: Array<{ value: MinuteWindow; label: string }> = [
  { value: '0', label: '1분전' },
  { value: '1', label: '2분전' },
  { value: '3', label: '5분전' },
  { value: '6', label: '20분전' },
  { value: '9', label: '120분전' },
];

interface RankingRowShape {
  symb: string;
  last: string;
  rate: string;
  sign: string;
  /** 요청 거래소(NAS·NYS) — 거래소 병합 조회에서 행마다 붙인다(상세화면 이동 시 market 파라미터). */
  excd?: string;
  [key: string]: unknown;
}

function rowName(row: RankingRowShape): string {
  return (row.name as string) ?? (row.knam as string) ?? row.symb;
}

/** sign: 1·2 상한/상승, 4 보합, 5 하한/하락 (KIS 공통 관례) — 상승 계열은 빨강, 하락 계열은 파랑(PRD 색 규칙). */
function signColor(sign: string): string {
  if (sign === '1' || sign === '2') return '#f04452';
  if (sign === '4') return '#8b95a1';
  return '#3182f6';
}

export function Ranking() {
  const [reloadKey, setReloadKey] = useState(0);
  const session = useKisSession(reloadKey);

  const [kind, setKind] = useState<UiRankingKind>(TOSS_KIND);
  const [dayWindow, setDayWindow] = useState<DayWindow>('0');
  const [minuteWindow, setMinuteWindow] = useState<MinuteWindow>('0');
  const [priceDirection, setPriceDirection] = useState<PriceFluctDirection>('1');

  const [rows, setRows] = useState<RankingRowShape[] | null>(null);
  const [loadingData, setLoadingData] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // 토스 순위 — KIS 세션 없이 바로 조회한다(공개 API). 세션에 의존하지 않아야
  // 세션 로딩 완료로 콜백이 새로 만들어질 때 같은 조회를 두 번 하지 않는다.
  const fetchToss = useCallback(async () => {
    if (!isTossKind(kind)) return;
    setLoadingData(true);
    setDataError(null);
    try {
      const tossRows = await fetchTossRanking(TOSS_FETCH_KIND[kind]);
      // 응답에 등락률 필드가 없어 기준가 대비로 계산된 값이 온다 — 색은 KIS의 sign 관례로 맞춘다.
      setRows(
        tossRows.map((r) => ({
          symb: r.symbol,
          last: String(r.price),
          rate: r.ratePct.toFixed(2),
          sign: r.ratePct > 0 ? '2' : r.ratePct < 0 ? '5' : '4',
          excd: r.market,
          name: r.name,
        })),
      );
    } catch (e) {
      setDataError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingData(false);
      setRefreshing(false);
    }
  }, [kind]);

  const fetchKisRanking = useCallback(async () => {
    if (isTossKind(kind)) return;
    if (session.kind !== 'ready') return;
    setLoadingData(true);
    setDataError(null);
    try {
      const { credentials, accessToken } = session.session;
      const fetchKind = async (excd: RankingExchangeCode): Promise<{ output2: RankingRowShape[] }> => {
        switch (kind) {
          case 'tradeVolume':
            return inquireTradeVolumeRanking(credentials, accessToken, { excd, nday: dayWindow });
          case 'volumeSurge':
            return inquireVolumeSurgeRanking(credentials, accessToken, { excd, minx: minuteWindow });
          case 'priceFluct':
            return inquirePriceFluctRanking(credentials, accessToken, { excd, gubn: priceDirection, minx: minuteWindow });
          case 'tradeGrowth':
            return inquireTradeGrowthRanking(credentials, accessToken, { excd, nday: dayWindow });
          case 'tradeTurnover':
            return inquireTradeTurnoverRanking(credentials, accessToken, { excd, nday: dayWindow });
          case 'volumePower':
            return inquireVolumePowerRanking(credentials, accessToken, { excd, nday: minuteWindow });
          case 'upDownRate':
            return inquireUpDownRateRanking(credentials, accessToken, { excd, gubn: priceDirection, nday: dayWindow });
        }
      };
      // 미국 거래소(NAS·NYS)를 직렬 조회(유량 보호) 후 순위 지표로 재정렬해 하나로 병합(2026-08-08, 아멕스는 2026-08-10 제외).
      // 일부 거래소 실패는 무시하고 나머지로 보여준다 — 전부 실패했을 때만 에러.
      const lists: RankingRowShape[][] = [];
      const errors: unknown[] = [];
      for (const excd of US_RANKING_EXCHANGES) {
        try {
          // 상세화면 이동(market 파라미터)의 근거라 응답 표기 대신 요청 거래소를 행에 박아둔다.
          lists.push((await fetchKind(excd)).output2.map((r) => ({ ...r, excd })));
        } catch (e) {
          errors.push(e);
        }
      }
      if (lists.length === 0) throw errors[0] ?? new Error('순위 조회 실패');
      setRows(mergeRankingRows(kind, lists));
    } catch (e) {
      setDataError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingData(false);
      setRefreshing(false);
    }
  }, [session, kind, dayWindow, minuteWindow, priceDirection]);

  // 원천이 둘이라 효과도 둘 — 토스 쪽이 세션 변화(로딩→준비)에 딸려 다시 돌지 않게 분리한다.
  useEffect(() => {
    if (isTossKind(kind)) void fetchToss();
  }, [kind, fetchToss]);

  useEffect(() => {
    if (!isTossKind(kind) && session.kind === 'ready') void fetchKisRanking();
  }, [kind, session, fetchKisRanking]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    if (isTossKind(kind)) {
      void fetchToss();
      return;
    }
    setReloadKey((k) => k + 1); // KIS는 토큰 만료도 함께 재확인한다.
    void fetchKisRanking();
  }, [kind, fetchToss, fetchKisRanking]);

  // 행 탭 → 종목 상세화면. 병합 조회라 행마다 거래소가 다르다 — 행에 박아둔 excd를 넘긴다.
  const handleRowPress = useCallback((row: RankingRowShape) => {
    router.push({
      pathname: '/stock/[ticker]',
      params: { ticker: row.symb, market: toStockMarketCode(row.excd) ?? 'NAS', name: rowName(row) },
    });
  }, []);

  const isToss = isTossKind(kind);
  // 토스 순위는 기간·방향 선택이 없다(항상 실시간). 시간창 라벨은 KIS 순위에서만 쓴다.
  const timeUnit = isToss ? 'none' : RANKING_TIME_UNIT[kind];
  // 토스 순위는 KIS 키 없이도 보인다 — 세션 안내는 KIS 순위를 골랐을 때만.
  const sessionBlocked = !isToss && (session.kind === 'needsSetup' || session.kind === 'error');

  const periodOptions = timeUnit === 'minute' ? MINUTE_WINDOW_OPTIONS : DAY_WINDOW_OPTIONS;
  const periodValue = timeUnit === 'minute' ? minuteWindow : dayWindow;
  const handlePeriodChange = timeUnit === 'minute' ? setMinuteWindow : setDayWindow;

  return (
    <View className="flex-1 bg-[#f2f4f6]">
      <View className="mb-2 bg-white px-4 pb-3 pt-3">
        <View className="flex-row" style={{ gap: 8 }}>
          <SelectBox
            label="순위 종류"
            value={kind}
            options={KIND_OPTIONS}
            onChange={(v) => {
              // 종류가 바뀌면 직전 결과를 비운다 — 원천이 달라 잔상이 남으면 오해를 부른다.
              setRows(null);
              setDataError(null);
              setKind(v as UiRankingKind);
            }}
          />
          {!isToss && (
            <SelectBox
              label={timeUnit === 'minute' ? '기간(분)' : '기간(일)'}
              value={periodValue}
              options={periodOptions}
              onChange={(v) => handlePeriodChange(v as DayWindow)}
            />
          )}
        </View>

        {DIRECTION_KINDS.includes(kind) && (
          <View className="mt-2 flex-row">
            <SelectBox
              label="방향"
              value={priceDirection}
              options={kind === 'upDownRate' ? UPDOWN_DIRECTION_OPTIONS : DIRECTION_OPTIONS}
              onChange={(v) => setPriceDirection(v as PriceFluctDirection)}
            />
          </View>
        )}
      </View>

      {sessionBlocked ? (
        session.kind === 'needsSetup' ? (
          <SetupNotice />
        ) : (
          <ErrorNotice message={session.kind === 'error' ? session.message : ''} />
        )
      ) : (!isToss && session.kind === 'loading') || (loadingData && rows === null) ? (
        <Panel style={{ flex: 1, marginBottom: 0 }}>
          <SkeletonList />
        </Panel>
      ) : dataError && rows === null ? (
        <ErrorNotice message={dataError} />
      ) : (
        <Panel style={{ flex: 1, marginBottom: 0 }}>
          <FlatList
            data={rows ?? []}
            keyExtractor={(item, idx) => `${item.symb}-${idx}`}
            renderItem={({ item }) => (
              <ListRow
                onPress={() => handleRowPress(item)}
                leading={<TickerAvatar ticker={item.symb} />}
                title={item.symb}
                subtitle={rowName(item)}
                trailing={
                  <>
                    <Text className="text-lg font-bold text-[#191f28]">{formatUsd(item.last)}</Text>
                    <Text style={{ color: signColor(item.sign) }} className="mt-0.5 text-sm font-bold">
                      {item.rate}%
                    </Text>
                  </>
                }
              />
            )}
            contentContainerStyle={{ flexGrow: 1 }}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#3182f6" />}
            ListEmptyComponent={<EmptyState icon="bar-chart-outline" title="조건에 맞는 종목이 없어요" description="다른 종류나 기간으로 바꿔보세요" />}
          />
        </Panel>
      )}
    </View>
  );
}
