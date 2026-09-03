// 설정 화면 — 상단바 "설정" 버튼으로 진입. 매매 파라미터 전용이다(계좌 연결·잔고는 app/account.tsx).
// 2026-08-12: 옛 설정 화면의 하단 메뉴(계좌연결|매매파라미터)를 없애고 두 화면으로 쪼갰다. 같은 정리에서
// 트레이딩 화면 시트에 있던 운용 설정(진입금액·동시 그리드·최소 속도)을 "트레이딩 설정" 패널로 흡수했다 —
// 흩어져 있던 매매 관련 값을 한 화면에서 다 보게 하려는 것이다.
//
// 저장은 전부 AsyncStorage(lib/appSettings)로만 간다. 실제 매매 엔진 반영은 managerProvider가
// 트레이딩 화면 포커스마다 하며, 진입금액·속도·그리드 수는 **정지(IDLE) 상태에서만** 적용된다.
import { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import Slider from '@react-native-community/slider';
import { BackHeader } from '../components/BackHeader';
import { Panel } from '../components/Panel';
import { DEFAULT_APP_SETTINGS, loadAppSettings, saveAppSettings, snapToStep } from '../lib/appSettings';
import { MAX_GRIDS_LIMIT, WATCH_COUNT_LIMIT } from '../features/scalper/autopilot';
import { MODEL_BAR_MINUTES } from '../features/scalper/modelMode';
import { MARTINGALE_BAR_MINUTES } from '../features/scalper/martingaleMode';
import { MARTINGALE_CONFIG } from '../core/martingale';
import { SLOPE_CONFIG, SLOPE_EXIT_TICK_MS } from '../core/slope';
import { DEFAULT_ENGINE_OPTIONS, type EngineOptions } from '../features/scalper/engineMode';
import { ORDER_PRICING_LABEL, type OrderPricing } from '../features/scalper/orderStrategy';

/** 주문 전략 카드 3장 + (시간 취소일 때) 취소 대기 슬라이더 — 매수·매도가 같은 컴포넌트를 쓴다(ADR 0013). */
function OrderStrategyPicker(props: {
  title: string;
  side: 'buy' | 'sell';
  value: OrderPricing;
  onChange: (v: OrderPricing) => void;
  cancelAfterSec: number;
  onCancelAfterSecChange: (v: number) => void;
}) {
  const buy = props.side === 'buy';
  const cross = buy ? '매도1호가' : '매수1호가';
  const options: Array<{ value: OrderPricing; desc: string }> = [
    {
      value: 'quote',
      desc: `${cross}에 걸어 바로 붙여요. 안 붙으면 ${cross}가 바뀔 때마다 그 가격으로 정정해 따라가요 — 가장 빠르지만 호가 한 칸만큼 불리하게 ${buy ? '사요' : '팔아요'}.`,
    },
    {
      value: 'lastChase',
      desc: `지금 체결가에 걸어요. 안 붙으면 틱이 올 때마다 현재가가 바뀌면 그 가격으로 정정해 따라가요.`,
    },
    {
      value: 'lastCancel',
      desc: `지금 체결가에 걸고 정정하지 않아요. 아래 시간 안에 안 붙으면 취소해요 — ${
        buy ? '다음 신호를 기다려요' : '다음 판정에서 새 현재가로 다시 내요'
      }.`,
    },
  ];
  return (
    <View className="mb-4">
      <Text className="mb-2 text-xs font-semibold text-[#191f28]">{props.title}</Text>
      {options.map((opt) => {
        const selected = props.value === opt.value;
        return (
          <Pressable
            key={opt.value}
            onPress={() => props.onChange(opt.value)}
            className={`mb-2 rounded-2xl border px-4 py-3 ${selected ? 'border-[#3182f6] bg-[#f2f7ff]' : 'border-[#e5e8eb] bg-white'}`}
          >
            <View className="flex-row items-center justify-between">
              <Text className={`text-sm font-semibold ${selected ? 'text-[#3182f6]' : 'text-[#191f28]'}`}>{ORDER_PRICING_LABEL[opt.value]}</Text>
              {selected && <Text className="text-xs font-semibold text-[#3182f6]">선택됨</Text>}
            </View>
            <Text className="mt-1 text-xs leading-5 text-[#8b95a1]">{opt.desc}</Text>
          </Pressable>
        );
      })}
      {props.value === 'lastCancel' && (
        <SettingSlider
          label={`${buy ? '매수' : '매도'} 미체결 취소 (초)`}
          value={props.cancelAfterSec}
          onChange={props.onCancelAfterSecChange}
          min={0}
          max={10}
          step={1}
          formatValue={(v) => `${v}초`}
          helper={
            buy
              ? '이 시간 안에 안 붙으면 취소하고 다음 신호를 기다려요. 권장 2~3초. 일부라도 체결됐으면 취소하지 않아요. 취소가 3번 이어지면 그 종목은 1분간 쉬어요. 0이면 체결될 때까지 기다려요.'
              : '이 시간 안에 안 붙으면 취소하고, 다음 틱 판정이 새 현재가로 다시 내요(청산 조건이 계속 맞는 동안 반복). 0이면 체결될 때까지 그대로 둬요.'
          }
          offAtZero
        />
      )}
    </View>
  );
}

/** 엔진 옵션의 진입 필터를 짧게 — " + 정배열 · 5선 상승" / "". 5선 돌파 패널 머리줄용. */
function describeFilters(o: EngineOptions): string {
  const parts: string[] = [];
  if (o.ordered) parts.push('정배열');
  if (o.ma5Up) parts.push('5선 상승');
  if (o.allUp) parts.push('4선 모두 상승');
  return parts.length ? ` + ${parts.join(' · ')}` : '';
}
import { MODEL_SYMMETRIC_EXIT_CONFIG } from '../core/model/exitRule';
import {
  RankingSelectionPanel,
  draftFromSelection,
  selectionFromDraft,
  type RankingSelectionDraft,
} from '../features/scalper/ui/RankingSelectionPanel';
import { normalizeRankingSelection, validateRankingSelection } from '../core/ranking';

/** 종목당 진입금액 상한(USD) — 오타 하나(100 → 10000)가 그대로 발주 금액이 된다. */
const START_AMOUNT_MAX_USD = 100_000;

/**
 * 값 조절 슬라이더 한 벌 — 라벨 + 현재 값 + 슬라이더 + 양끝 범위 + 안내 문구.
 * offAtZero면 0을 "꺼짐"으로 표시한다(미체결 취소 등 0=끔 관례).
 */
function SettingSlider(props: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  formatValue: (v: number) => string;
  helper: string;
  offAtZero?: boolean;
}) {
  const off = (props.offAtZero ?? false) && props.value <= 0;
  return (
    <View className="mb-4">
      <View className="mb-1 flex-row items-center justify-between">
        <Text className="text-xs text-[#8b95a1]">{props.label}</Text>
        <Text className={off ? 'text-sm font-semibold text-[#8b95a1]' : 'text-sm font-semibold text-[#3182f6]'}>
          {off ? '꺼짐' : props.formatValue(props.value)}
        </Text>
      </View>
      <Slider
        value={props.value}
        onValueChange={(v) => props.onChange(snapToStep(v, props.min, props.max, props.step))}
        minimumValue={props.min}
        maximumValue={props.max}
        step={props.step}
        minimumTrackTintColor="#3182f6"
        maximumTrackTintColor="#e5e8eb"
        thumbTintColor="#3182f6"
        style={{ height: 40 }}
      />
      <View className="flex-row items-center justify-between">
        <Text className="text-[11px] text-[#8b95a1]">
          {props.offAtZero ? '0 (꺼짐)' : props.formatValue(props.min)}
        </Text>
        <Text className="text-[11px] text-[#8b95a1]">{props.formatValue(props.max)}</Text>
      </View>
      <Text className="mt-1 text-xs text-[#8b95a1]">{props.helper}</Text>
    </View>
  );
}

export default function SettingsScreen() {
  // 주문 수량 입력란은 수동 카드 제거(2026-08-08)와 함께 내렸다 — 저장 스키마 호환을 위해 값만 유지한다.
  const savedOrderQtyRef = useRef(DEFAULT_APP_SETTINGS.orderQty);
  // 청크·버퍼·모멘텀 문턱·BUY 게이트·수수료율 설정은 2026-08-08 제거 — 코드 기본값 고정 동작.
  const [buyCancelAfterSec, setBuyCancelAfterSec] = useState(DEFAULT_APP_SETTINGS.buyCancelAfterSec);
  // 주문 전략(2026-09-03 ADR 0013) — 매수·매도 각각. 저장 즉시 반영(엔진 모드와 달리 재시작 불필요).
  const [buyStrategy, setBuyStrategy] = useState<OrderPricing>(DEFAULT_APP_SETTINGS.buyStrategy);
  const [sellStrategy, setSellStrategy] = useState<OrderPricing>(DEFAULT_APP_SETTINGS.sellStrategy);
  const [sellCancelAfterSec, setSellCancelAfterSec] = useState(DEFAULT_APP_SETTINGS.sellCancelAfterSec);
  // 매도 그리드(폭·배율)·사다리 진입(간격·횟수) 입력란은 변곡점+그리드 조합(2026-08-15)으로 내렸다 —
  // 조합 모드에서는 미사용이라 화면에 두면 "바꾸면 반영되는 것처럼" 보인다. 값은 롤백 스위치
  // (INFLECTION_ENTRY/INFLECTION_GRID=false)로 옛 경로에 돌아갈 때 그대로 쓰이므로 저장은 유지한다.
  const savedRollbackRef = useRef({
    gridBuyWidthPct: DEFAULT_APP_SETTINGS.gridBuyWidthPct,
    gridSellWidthPct: DEFAULT_APP_SETTINGS.gridSellWidthPct,
    gridBuyMultiplier: DEFAULT_APP_SETTINGS.gridBuyMultiplier,
    entryLadderIntervalPct: DEFAULT_APP_SETTINGS.entryLadderIntervalPct,
    entryLadderCount: DEFAULT_APP_SETTINGS.entryLadderCount,
  });
  // 트레이딩 운용 설정 — 옛 자동 단타 설정 시트에서 옮겨 왔다(2026-08-12). 진입금액 0 = 미설정(빈 칸).
  const [startAmountUsd, setStartAmountUsd] = useState(String(DEFAULT_APP_SETTINGS.startAmountUsd));
  // 진입 수량(2026-08-18) — 0/빈 칸 = 미설정(진입금액으로 계산). 지정하면 가격과 무관하게 이 수량만 산다.
  const [entryQty, setEntryQty] = useState('');
  // 리스트 가격 상한(2026-08-20 풀데이 시뮬) — 수량 모드에서만 쓰는 상한. 0/빈 칸 = 진입금액이 상한(옛 동작).
  const [maxPriceUsd, setMaxPriceUsd] = useState(String(DEFAULT_APP_SETTINGS.maxPriceUsd));
  // 가격 하한(2026-08-29 데스크탑에서 이식) — 빈 칸/0 = 없음. 초저가 급등주 편중 방어.
  const [minPriceUsd, setMinPriceUsd] = useState('');
  const [minTickRate, setMinTickRate] = useState(String(DEFAULT_APP_SETTINGS.minTickRate));
  // 동시 그리드 수·매수 후보 수는 슬라이더(2026-08-30 데스크탑에서 이식) — 정수 범위가 좁아 입력창보다 슬라이더가 맞다.
  const [watchCount, setWatchCount] = useState<number>(DEFAULT_APP_SETTINGS.watchCount);
  const [maxConcurrentGrids, setMaxConcurrentGrids] = useState<number>(DEFAULT_APP_SETTINGS.maxConcurrentGrids);
  // 순위 선택(2026-08-18 순위 도메인) — 트레이딩 리스트 원천별 켬·개수·(한투) 기간창.
  const [rankingDraft, setRankingDraft] = useState<RankingSelectionDraft>(() =>
    draftFromSelection(normalizeRankingSelection(DEFAULT_APP_SETTINGS.rankingSelection)),
  );

  // 엔진 모드(2026-09-01) — 5선 물타기 단타 ↔ 예측 모델. 저장 후 앱을 완전히 껐다 켜야 반영된다(engineMode.ts).
  const [engineMode, setEngineMode] = useState<'martingale' | 'model' | 'slope'>(DEFAULT_APP_SETTINGS.engineMode);
  const savedEngineModeRef = useRef<'martingale' | 'model' | 'slope'>(DEFAULT_APP_SETTINGS.engineMode);
  // 엔진 옵션(2026-09-03 ADR 0012) — 엔진과 별개로 중복 선택. 반영은 엔진 모드와 같은 규약(앱 재시작).
  const [engineOptions, setEngineOptions] = useState<EngineOptions>(DEFAULT_ENGINE_OPTIONS);
  const savedEngineOptionsRef = useRef<EngineOptions>(DEFAULT_ENGINE_OPTIONS);

  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const appSettings = await loadAppSettings();
      savedOrderQtyRef.current = appSettings.orderQty;
      setBuyCancelAfterSec(appSettings.buyCancelAfterSec);
      setBuyStrategy(appSettings.buyStrategy);
      setSellStrategy(appSettings.sellStrategy);
      setSellCancelAfterSec(appSettings.sellCancelAfterSec);
      savedRollbackRef.current = {
        gridBuyWidthPct: appSettings.gridBuyWidthPct,
        gridSellWidthPct: appSettings.gridSellWidthPct,
        gridBuyMultiplier: appSettings.gridBuyMultiplier,
        entryLadderIntervalPct: appSettings.entryLadderIntervalPct,
        entryLadderCount: appSettings.entryLadderCount,
      };
      setStartAmountUsd(appSettings.startAmountUsd > 0 ? String(appSettings.startAmountUsd) : '');
      setEntryQty(appSettings.entryQty > 0 ? String(appSettings.entryQty) : '');
      setMaxPriceUsd(appSettings.maxPriceUsd > 0 ? String(appSettings.maxPriceUsd) : '');
      setMinPriceUsd(appSettings.minPriceUsd > 0 ? String(appSettings.minPriceUsd) : '');
      setMinTickRate(String(appSettings.minTickRate));
      setWatchCount(appSettings.watchCount);
      setMaxConcurrentGrids(appSettings.maxConcurrentGrids);
      setRankingDraft(draftFromSelection(appSettings.rankingSelection));
      setEngineMode(appSettings.engineMode);
      savedEngineModeRef.current = appSettings.engineMode;
      setEngineOptions(appSettings.engineOptions);
      savedEngineOptionsRef.current = appSettings.engineOptions;
    })();
  }, []);

  const handleSave = async () => {
    // 상한을 둔다 — 오타 하나(10 → 100)가 그대로 발주가에 들어가면 되돌릴 수 없다.
    const parsedStartAmountUsd = Number(startAmountUsd);
    if (
      !Number.isFinite(parsedStartAmountUsd) ||
      parsedStartAmountUsd <= 0 ||
      parsedStartAmountUsd > START_AMOUNT_MAX_USD
    ) {
      Alert.alert('알림', `진입금액은 0보다 크고 ${START_AMOUNT_MAX_USD.toLocaleString('en-US')} 이하인 달러 금액으로 입력해 주세요.`);
      return;
    }

    // 진입 수량 — 빈 칸/0은 미설정(0 저장). 지정하면 1 이상 정수.
    const parsedEntryQty = entryQty.trim() === '' ? 0 : Number(entryQty);
    if (!Number.isFinite(parsedEntryQty) || !Number.isInteger(parsedEntryQty) || parsedEntryQty < 0) {
      Alert.alert('알림', '진입 수량은 1 이상의 정수로 입력하거나, 비워 두면 진입금액으로 계산해요.');
      return;
    }

    // 가격 상한 — 빈 칸/0은 옛 동작(진입금액이 상한). 지정하면 0보다 큰 금액, 진입금액과 같은 상한 캡.
    const parsedMaxPriceUsd = maxPriceUsd.trim() === '' ? 0 : Number(maxPriceUsd);
    if (!Number.isFinite(parsedMaxPriceUsd) || parsedMaxPriceUsd < 0 || parsedMaxPriceUsd > START_AMOUNT_MAX_USD) {
      Alert.alert('알림', `가격 상한은 비우거나 0보다 크고 ${START_AMOUNT_MAX_USD.toLocaleString('en-US')} 이하인 달러 금액으로 입력해 주세요.`);
      return;
    }

    // 가격 하한 — 빈 칸/0은 없음. 상한과 달리 진입금액과의 대소는 검증하지 않는다(하한만 걸고 싶을 수 있다).
    const parsedMinPriceUsd = minPriceUsd.trim() === '' ? 0 : Number(minPriceUsd);
    if (!Number.isFinite(parsedMinPriceUsd) || parsedMinPriceUsd < 0 || parsedMinPriceUsd > START_AMOUNT_MAX_USD) {
      Alert.alert('알림', '가격 하한은 비우거나 0 이상인 달러 금액으로 입력해 주세요.');
      return;
    }

    const parsedMinTickRate = Number(minTickRate);
    if (!Number.isFinite(parsedMinTickRate) || parsedMinTickRate <= 0) {
      Alert.alert('알림', '최소 속도는 0보다 크게 입력해 주세요. (기본 1틱/초)');
      return;
    }

    const parsedWatchCount = watchCount;
    if (
      !Number.isFinite(parsedWatchCount) ||
      !Number.isInteger(parsedWatchCount) ||
      parsedWatchCount < 1 ||
      parsedWatchCount > WATCH_COUNT_LIMIT
    ) {
      Alert.alert('알림', `매수 후보 수는 1~${WATCH_COUNT_LIMIT} 사이 정수로 입력해 주세요. (기본 ${DEFAULT_APP_SETTINGS.watchCount})`);
      return;
    }

    const parsedMaxGrids = maxConcurrentGrids;
    if (
      !Number.isFinite(parsedMaxGrids) ||
      !Number.isInteger(parsedMaxGrids) ||
      parsedMaxGrids < 1 ||
      parsedMaxGrids > MAX_GRIDS_LIMIT
    ) {
      Alert.alert('알림', `동시 그리드 수는 1~${MAX_GRIDS_LIMIT} 사이 정수로 입력해 주세요.`);
      return;
    }

    const rankingSelection = selectionFromDraft(rankingDraft);
    const rankingError = validateRankingSelection(rankingSelection);
    if (rankingError) {
      Alert.alert('알림', rankingError);
      return;
    }

    setSaving(true);
    try {
      // 미체결 취소는 슬라이더가 범위·스텝 격자를 보장하므로 별도 검증이 없다.
      // 그리드 폭·배율·사다리 값은 화면에서 내렸다(조합 모드 미사용) — 로드해 둔 저장값 그대로 되쓴다(롤백 보존).
      await saveAppSettings({
        environment: 'live',
        engineMode,
        engineOptions,
        orderQty: savedOrderQtyRef.current,
        buyCancelAfterSec,
        buyStrategy,
        sellStrategy,
        sellCancelAfterSec,
        ...savedRollbackRef.current,
        startAmountUsd: parsedStartAmountUsd,
        entryQty: parsedEntryQty,
        maxPriceUsd: parsedMaxPriceUsd,
        minPriceUsd: parsedMinPriceUsd,
        minTickRate: parsedMinTickRate,
        watchCount: parsedWatchCount,
        maxConcurrentGrids: parsedMaxGrids,
        rankingSelection,
      });
      const optionsChanged = (Object.keys(engineOptions) as Array<keyof EngineOptions>).some(
        (k) => engineOptions[k] !== savedEngineOptionsRef.current[k],
      );
      const modeChanged = engineMode !== savedEngineModeRef.current || optionsChanged;
      savedEngineModeRef.current = engineMode;
      savedEngineOptionsRef.current = engineOptions;
      Alert.alert(
        '알림',
        modeChanged
          ? '설정을 저장했어요. 엔진 모드·옵션은 앱을 완전히 종료했다가 다시 켜면 적용돼요 — 보유·미체결이 없는 상태에서 바꾸는 걸 권해요.'
          : '설정을 저장했어요.',
      );
    } finally {
      setSaving(false);
    }
  };

  /** 첫 진입에 한 번에 들어갈 수 있는 최대 금액 — 진입금액 × 동시 그리드 수. */
  const exposure = (() => {
    const amount = Number(startAmountUsd);
    const grids = maxConcurrentGrids;
    if (entryQty.trim() !== '' && Number(entryQty) > 0) return null; // 고정 수량이면 금액 노출은 종목 가격에 달렸다.
    if (!Number.isFinite(amount) || amount <= 0) return null;
    if (!Number.isFinite(grids) || grids < 1) return null;
    return (amount * Math.min(Math.floor(grids), MAX_GRIDS_LIMIT)).toFixed(2);
  })();

  return (
    <View className="flex-1 bg-[#f2f4f6]">
      <BackHeader title="설정" />
      <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 48 }}>
        <Panel title="트레이딩 설정">
          <View className="px-5 pb-5">
            <Text className="mb-4 text-xs leading-5 text-[#8b95a1]">
              상승 변곡점이 잡힐 때마다 한 종목씩 진입하고, 진입한 종목은 변곡점 그리드가 이어받아 관리해요(주문을
              미리 걸지 않고 변곡점 신호 때만 사고팔아요). 이미 보유 중인 종목은 다시 진입하지 않고, 매도가 끝나면
              그 자리에 새 종목이 들어와요.
            </Text>

            <Text className="mb-1 text-xs text-[#8b95a1]">진입금액 (USD) — 종목 하나를 살 때 쓰는 금액</Text>
            <TextInput
              value={startAmountUsd}
              onChangeText={setStartAmountUsd}
              keyboardType="decimal-pad"
              placeholder={`기본 ${DEFAULT_APP_SETTINGS.startAmountUsd}`}
              placeholderTextColor="#8b95a1"
              className="mb-4 rounded-2xl border border-[#e5e8eb] px-4 py-3 text-base text-[#191f28]"
            />

            <Text className="mb-1 text-xs text-[#8b95a1]">수량 (주) — 비우면 진입금액으로 계산해요</Text>
            <TextInput
              value={entryQty}
              onChangeText={setEntryQty}
              keyboardType="number-pad"
              placeholder="미설정 (진입금액 ÷ 현재가)"
              placeholderTextColor="#8b95a1"
              className="mb-1 rounded-2xl border border-[#e5e8eb] px-4 py-3 text-base text-[#191f28]"
            />
            <Text className="mb-4 text-xs leading-5 text-[#8b95a1]">
              수량을 정하면 종목 가격과 상관없이 딱 이 수량만 사요($0.01짜리도 $9짜리도 같은 수량). 물타기도 이
              수량씩 해요.
            </Text>

            <Text className="mb-1 text-xs text-[#8b95a1]">
              가격 상한 (USD) — 수량을 정했을 때, 이 가격 이하 종목만 감시해요
            </Text>
            <TextInput
              value={maxPriceUsd}
              onChangeText={setMaxPriceUsd}
              keyboardType="decimal-pad"
              placeholder="비우면 진입금액이 상한이에요"
              placeholderTextColor="#8b95a1"
              className="mb-1 rounded-2xl border border-[#e5e8eb] px-4 py-3 text-base text-[#191f28]"
            />
            <Text className="mb-4 text-xs leading-5 text-[#8b95a1]">
              상한이 낮으면 리스트가 초저가 급등주로만 채워져요. 수량 1주 운용이면 상한을 올려도(기본 $
              {DEFAULT_APP_SETTINGS.maxPriceUsd}) 종목당 리스크는 1주 가격이에요. 수량을 비워 두면(금액 모드) 이
              값과 무관하게 진입금액이 상한이에요.
            </Text>

            <Text className="mb-1 text-xs text-[#8b95a1]">가격 하한 (USD) — 이보다 싼 종목은 감시하지 않아요</Text>
            <TextInput
              value={minPriceUsd}
              onChangeText={setMinPriceUsd}
              keyboardType="decimal-pad"
              placeholder="하한 없음"
              placeholderTextColor="#8b95a1"
              className="mb-1 rounded-2xl border border-[#e5e8eb] px-4 py-3 text-base text-[#191f28]"
            />
            <Text className="mb-4 text-xs leading-5 text-[#8b95a1]">
              하한이 없으면 리스트가 초저가 급등주로만 채워질 수 있어요. 하한을 두면 그보다 싼 동전주는 리스트에서
              빠지고 다음 순위 종목이 올라와요.
            </Text>

            <SettingSlider
              label={`동시 그리드 수 (1~${MAX_GRIDS_LIMIT}) — 한 번에 관리할 종목 개수`}
              value={maxConcurrentGrids}
              onChange={setMaxConcurrentGrids}
              min={1}
              max={MAX_GRIDS_LIMIT}
              step={1}
              formatValue={(v) => `${v}개`}
              helper={
                exposure
                  ? `첫 진입에만 최대 $${exposure}가 들어가요. 물타기는 매번 최초 진입 수량만큼이라, 물탈 때마다 종목당 금액이 진입금액만큼씩 더 들어가요.`
                  : entryQty.trim() !== '' && Number(entryQty) > 0
                    ? `종목당 ${Number(entryQty)}주 × 현재가만큼 들어가고, 물타기도 매번 ${Number(entryQty)}주씩이에요.`
                    : '물타기는 매번 최초 진입 수량만큼이라, 물탈 때마다 종목당 금액이 진입금액만큼씩 더 들어가요.'
              }
            />

            <Text className="mb-1 text-xs text-[#8b95a1]">
              최소 속도 (틱/초) — 이보다 조용한 종목은 매수 후보에서 빼요
            </Text>
            <TextInput
              value={minTickRate}
              onChangeText={setMinTickRate}
              keyboardType="decimal-pad"
              placeholder={`기본 ${DEFAULT_APP_SETTINGS.minTickRate}`}
              placeholderTextColor="#8b95a1"
              className="mb-4 rounded-2xl border border-[#e5e8eb] px-4 py-3 text-base text-[#191f28]"
            />

            <SettingSlider
              label="매수 후보 수 — 최소 속도를 넘긴 종목 중 빠른 순으로 몇 개까지"
              value={watchCount}
              onChange={setWatchCount}
              min={1}
              max={WATCH_COUNT_LIMIT}
              step={1}
              formatValue={(v) => `${v}종목`}
              helper={'판정은 리스트 전 종목에 대해 계속 돌지만, 매수는 이 후보 안에서만 일어나요. 조용한 종목은 호가가 얇아 사고팔 때 불리해요. 보유·진입 중인 종목은 후보에서 빠지니 자리가 놀지 않아요. 후보 밖 신호는 트레이딩 화면 기록에 "매수 후보 밖이에요"로 남아요.'}
            />

            <View className="rounded-2xl bg-[#f2f4f6] px-4 py-3">
              <Text className="text-xs leading-5 text-[#4e5968]">
                이 값들은 <Text className="font-semibold text-[#191f28]">정지 상태에서만</Text> 적용돼요. 매매 중에
                저장하면 정지한 뒤 트레이딩 화면으로 돌아올 때 반영돼요.
              </Text>
            </View>
          </View>
        </Panel>

        <RankingSelectionPanel draft={rankingDraft} onChange={setRankingDraft} />

        <Panel title="엔진 모드">
          <View className="px-5 pb-5">
            <Text className="mb-3 text-xs leading-5 text-[#8b95a1]">
              무엇으로 매매할지 골라요. 저장한 뒤 <Text className="font-semibold text-[#191f28]">앱을 완전히 종료했다가 다시 켜면</Text>{' '}
              적용돼요 — 보유·미체결이 없는 상태에서 바꾸는 걸 권해요.
            </Text>
            {(
              [
                {
                  value: 'martingale' as const,
                  title: '5선 돌파',
                  desc: `${MARTINGALE_BAR_MINUTES}분봉 종가가 5선을 아래→위로 뚫으면 사고, 익절 +${Math.round(MARTINGALE_CONFIG.tpPct * 100)}% · ${Math.floor(MARTINGALE_CONFIG.closeAtMin / 60)}:${String(MARTINGALE_CONFIG.closeAtMin % 60).padStart(2, '0')} ET 마감 청산 · 손절 없음 — 진입 조건·물타기는 아래 옵션으로`,
                },
                {
                  value: 'model' as const,
                  title: '예측 모델',
                  desc: `${MODEL_BAR_MINUTES}분봉 지표 33개로 "+3%가 −3%보다 먼저 올 확률"을 계산해 상위 1% 기준값을 넘으면 매수`,
                },
                {
                  value: 'slope' as const,
                  title: '기울기 단타',
                  desc: `리스트의 기울기/10초가 +${SLOPE_CONFIG.entryPct}% 이상이면 사고, +${SLOPE_CONFIG.exitPct}% 아래로 내려오면 조건 없이 즉시 전량 매도 — 익절·손절 없음`,
                },
              ]
            ).map((opt) => {
              const selected = engineMode === opt.value;
              return (
                <Pressable
                  key={opt.value}
                  onPress={() => setEngineMode(opt.value)}
                  className={`mb-2 rounded-2xl border px-4 py-3 ${selected ? 'border-[#3182f6] bg-[#f2f7ff]' : 'border-[#e5e8eb] bg-white'}`}
                >
                  <View className="flex-row items-center justify-between">
                    <Text className={`text-sm font-semibold ${selected ? 'text-[#3182f6]' : 'text-[#191f28]'}`}>{opt.title}</Text>
                    {selected && <Text className="text-xs font-semibold text-[#3182f6]">선택됨</Text>}
                  </View>
                  <Text className="mt-1 text-xs leading-5 text-[#8b95a1]">{opt.desc}</Text>
                </Pressable>
              );
            })}

            {/* 엔진 옵션(2026-09-03 ADR 0012) — 엔진과 별개로 중복 선택. 세 엔진 공통. */}
            <Text className="mb-1 mt-4 text-xs font-semibold text-[#191f28]">옵션 (중복 선택)</Text>
            <Text className="mb-3 text-xs leading-5 text-[#8b95a1]">
              어느 엔진을 골랐든 함께 걸려요. 위 셋은 {MARTINGALE_BAR_MINUTES}분봉 이동평균(5·20·60·120) 기준 <Text className="font-semibold text-[#191f28]">진입 조건</Text>
              이고 체크한 것끼리 모두 맞아야 사요. 물타기는 <Text className="font-semibold text-[#191f28]">보유 중</Text> 그 엔진의 매수 신호가 다시 왔을 때
              평단보다 −{Math.round(MARTINGALE_CONFIG.dropStartPct * 100)}% 넘게 내려가 있으면 낙폭 k%당 보유량의 (k−1)배를 더 사요.
            </Text>
            {(
              [
                { key: 'ordered' as const, title: '정배열', desc: '5선 > 20선 > 60선 > 120선일 때만' },
                { key: 'ma5Up' as const, title: '5선만 상승', desc: '5선이 직전 봉보다 오르는 중일 때만' },
                { key: 'allUp' as const, title: '5·20·60·120 모두 상승', desc: '네 선이 전부 직전 봉보다 오르는 중일 때만' },
                { key: 'martingale' as const, title: '(k−1)배 물타기', desc: `보유 중 평단 −k%(k≥${Math.round(MARTINGALE_CONFIG.dropStartPct * 100)})에서 매수 신호면 보유량 ×(k−1) 추가 매수 · 상한 −${Math.round(MARTINGALE_CONFIG.dropMaxPct * 100)}%` },
              ]
            ).map((opt) => {
              const on = engineOptions[opt.key];
              return (
                <Pressable
                  key={opt.key}
                  onPress={() => setEngineOptions({ ...engineOptions, [opt.key]: !on })}
                  className={`mb-2 flex-row items-center rounded-2xl border px-4 py-3 ${on ? 'border-[#3182f6] bg-[#f2f7ff]' : 'border-[#e5e8eb] bg-white'}`}
                >
                  <View
                    className={`mr-3 h-5 w-5 items-center justify-center rounded-md border ${on ? 'border-[#3182f6] bg-[#3182f6]' : 'border-[#d1d6db] bg-white'}`}
                  >
                    {on && <Text className="text-xs font-bold text-white">✓</Text>}
                  </View>
                  <View className="flex-1">
                    <Text className={`text-sm font-semibold ${on ? 'text-[#3182f6]' : 'text-[#191f28]'}`}>{opt.title}</Text>
                    <Text className="mt-0.5 text-xs leading-5 text-[#8b95a1]">{opt.desc}</Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        </Panel>

        {engineMode === 'martingale' ? (
          // 5선 돌파 엔진(2026-09-02 ADR 0010 · 옵션 분리 2026-09-03 ADR 0012) — 아래 고정값 패널은 선택한 엔진 것을 보여준다.
          <Panel title="5선 돌파 (고정값)">
            <View className="px-5 pb-5">
              <Text className="mb-3 text-xs leading-5 text-[#8b95a1]">
                진입은 {MARTINGALE_BAR_MINUTES}분봉 5선 돌파가, 매도는 +3% 선과 마감 시각이 정해요. 진입 조건 추가·물타기는 위 옵션에서 골라요.
                아래 값은 설계 고정값이라 여기서 바꿀 수 없어요.
              </Text>

              <View className="mb-1 flex-row items-center justify-between">
                <Text className="text-xs text-[#8b95a1]">진입</Text>
                <Text className="text-sm font-semibold text-[#191f28]">5선 돌파{describeFilters(engineOptions)}</Text>
              </View>
              <Text className="mb-3 text-xs leading-5 text-[#8b95a1]">
                {MARTINGALE_BAR_MINUTES}분봉 종가가 5선(최근 5봉 평균)을 아래에서 위로 뚫는 봉에 사요{engineOptions.ordered || engineOptions.ma5Up || engineOptions.allUp ? ' — 위에서 체크한 조건이 그 봉에서 함께 맞아야 해요' : ''}. 봉이
                닫히기를 기다리지 않고 진행 중 봉을 현재가로 넣어 실시간으로 판단해요(봉당 1회). 프리·정규·애프터에서만 진입하고 주간거래 시간엔
                쉬어요.
              </Text>

              <View className="mb-1 flex-row items-center justify-between">
                <Text className="text-xs text-[#8b95a1]">물타기</Text>
                <Text className="text-sm font-semibold text-[#191f28]">
                  {engineOptions.martingale ? `평단 −${Math.round(MARTINGALE_CONFIG.dropStartPct * 100)}% 아래 5선 돌파 → (k−1)배` : '없음(옵션 꺼짐)'}
                </Text>
              </View>
              <Text className="mb-3 text-xs leading-5 text-[#8b95a1]">
                {engineOptions.martingale
                  ? `보유 중 현재가가 평단보다 −${Math.round(MARTINGALE_CONFIG.dropStartPct * 100)}% 이상 내려간 상태에서 같은 5선 돌파가 오면 추가로 사요. 낙폭 k%(내림)면 지금 보유량의 (k−1)배 — −3% 2배 · −4% 3배 · … · −${Math.round(MARTINGALE_CONFIG.dropMaxPct * 100)}% ${Math.round(MARTINGALE_CONFIG.dropMaxPct * 100) - 1}배가 상한이에요. 횟수·금액 상한은 없고, 현금이 모자라면 그 물타기만 건너뛰어요. 손절은 없어요.`
                  : '옵션에서 (k−1)배 물타기를 체크하면 보유 중 같은 5선 돌파에서 낙폭 배수로 추가 매수해요. 지금은 한 번 사고 한 번 팔아요. 손절은 없어요.'}
              </Text>

              <View className="mb-1 flex-row items-center justify-between">
                <Text className="text-xs text-[#8b95a1]">매도</Text>
                <Text className="text-sm font-semibold text-[#191f28]">익절 +{Math.round(MARTINGALE_CONFIG.tpPct * 100)}%</Text>
              </View>
              <Text className="mb-3 text-xs leading-5 text-[#8b95a1]">
                평단보다 +{Math.round(MARTINGALE_CONFIG.tpPct * 100)}% 오르면 전량 익절해요(물타기로 평단이 내려가면 목표가도 따라 내려와요).
                안 닿으면 {Math.floor(MARTINGALE_CONFIG.closeAtMin / 60)}:{String(MARTINGALE_CONFIG.closeAtMin % 60).padStart(2, '0')} ET에
                전량 청산해요 — 다음 날로 들고 가지 않아요. 봉 마감을 기다리지 않고 체결가가 닿는 순간 판단해요.
              </Text>

              <View className="rounded-2xl bg-[#f2f4f6] px-4 py-3">
                <Text className="text-xs leading-5 text-[#4e5968]">
                  이 규칙은 시험 운용 중이에요(2026-09-02 물타기 복원·손절 제거). 손절이 없어서 한 종목에 돈이 크게 몰릴 수 있어요 —
                  낙폭이 깊을수록 배수가 커져요. 잃어도 되는 금액으로만 하세요.
                </Text>
              </View>
            </View>
          </Panel>
        ) : engineMode === 'slope' ? (
          // 기울기 단타 모드(2026-09-02, ADR 0011) — 조건이 둘뿐이라 패널도 짧다.
          <Panel title="기울기 단타 (고정값)">
            <View className="px-5 pb-5">
              <Text className="mb-3 text-xs leading-5 text-[#8b95a1]">
                살 때도 팔 때도 트레이딩 리스트에 보이는 <Text className="font-semibold text-[#191f28]">기울기/10초</Text> 하나만 봐요 —
                직전 10초 평균가 대비 지금 10초 평균가가 몇 % 움직였는지예요. 아래 값은 설계 고정값이라 여기서 바꿀 수 없어요.
              </Text>

              <View className="mb-1 flex-row items-center justify-between">
                <Text className="text-xs text-[#8b95a1]">진입</Text>
                <Text className="text-sm font-semibold text-[#191f28]">기울기 ≥ +{SLOPE_CONFIG.entryPct}%</Text>
              </View>
              <Text className="mb-3 text-xs leading-5 text-[#8b95a1]">
                체결 틱이 올 때마다 다시 재서, 기울기가 +{SLOPE_CONFIG.entryPct}% 아래에서 이상으로 올라서는 순간 사요. 봉·이동평균·확률·
                시간대 조건은 없어요(매수 후보 안·최소 속도·현금·자리 같은 공통 게이트만). 매수는 신호 순간의 현재가로 한 번 걸고 호가를 따라 정정하지 않아요 —
                안 붙으면 아래 "주문"의 매수 미체결 취소(초)가 취소해요(0이면 체결까지 대기 — 이 모드에선 2~3초를 권해요).
              </Text>

              <View className="mb-1 flex-row items-center justify-between">
                <Text className="text-xs text-[#8b95a1]">매도</Text>
                <Text className="text-sm font-semibold text-[#191f28]">기울기 &lt; +{SLOPE_CONFIG.exitPct}% → 즉시 전량</Text>
              </View>
              <Text className="mb-3 text-xs leading-5 text-[#8b95a1]">
                보유 중 기울기가 +{SLOPE_CONFIG.exitPct}% 아래로 내려오면 수익이든 손실이든 보지 않고 그 자리에서 전량 매도해요. 체결 틱마다,
                그리고 틱이 없어도 {SLOPE_EXIT_TICK_MS}ms마다 다시 재요(기울기는 시간이 흐르면 저절로 내려가요). 10초 넘게 체결이 끊겨
                기울기를 잴 수 없어도 팔아요. 매도 주문은 접지 않고 체결될 때까지 매수1호가를 따라가요.
              </Text>

              <View className="rounded-2xl bg-[#f2f4f6] px-4 py-3">
                <Text className="text-xs leading-5 text-[#4e5968]">
                  익절·손절·물타기·마감 청산이 전부 없어요. 기울기 +{SLOPE_CONFIG.exitPct}%는 오래 유지되기 어려워 보유 시간이 매우 짧고 거래가
                  잦아요 — 슬리피지가 성과를 정해요. 잃어도 되는 금액으로만 하세요.
                </Text>
              </View>
            </View>
          </Panel>
        ) : (
        <Panel title="모델 (고정값)">
          <View className="px-5 pb-5">
            <Text className="mb-3 text-xs leading-5 text-[#8b95a1]">
              진입은 예측 모델이, 매도는 ±3% 선이 정해요. 아래 값은 설계 고정값이라 여기서 바꿀 수 없어요.
            </Text>

            <View className="mb-1 flex-row items-center justify-between">
              <Text className="text-xs text-[#8b95a1]">진입</Text>
              <Text className="text-sm font-semibold text-[#191f28]">모델 확률 ≥ 상위 1% 기준값</Text>
            </View>
            <Text className="mb-3 text-xs leading-5 text-[#8b95a1]">
              {MODEL_BAR_MINUTES}분봉이 닫힐 때마다 리스트 전 종목에 대해 "+{Math.round(MODEL_SYMMETRIC_EXIT_CONFIG.tpPct * 100)}%가 −
              {Math.round(MODEL_SYMMETRIC_EXIT_CONFIG.stopLossPct * 100)}%보다 먼저 올 확률"을 지표 33개로 계산해요. 3년 반치 과거에서
              상위 1%에 해당하는 값을 넘어야 사요 — 신호가 드문 게 정상이에요. 정규장·그날 거래대금 $2M 이상·주가 $1 초과만 봐요.
              물타기는 하지 않아요.
            </Text>

            <View className="mb-1 flex-row items-center justify-between">
              <Text className="text-xs text-[#8b95a1]">매도</Text>
              <Text className="text-sm font-semibold text-[#191f28]">
                익절 +{Math.round(MODEL_SYMMETRIC_EXIT_CONFIG.tpPct * 100)}% / 손절 −{Math.round(MODEL_SYMMETRIC_EXIT_CONFIG.stopLossPct * 100)}% ·
                최장 {MODEL_SYMMETRIC_EXIT_CONFIG.maxHoldMin}분
              </Text>
            </View>
            <Text className="mb-3 text-xs leading-5 text-[#8b95a1]">
              산 가격보다 +{Math.round(MODEL_SYMMETRIC_EXIT_CONFIG.tpPct * 100)}% 오르면 익절, −
              {Math.round(MODEL_SYMMETRIC_EXIT_CONFIG.stopLossPct * 100)}% 내리면 손절해요 — 모델이 예측한 사건과 똑같은 기하예요.
              단, 익절선에 닿는 순간 모델을 다시 물어 <Text className="font-semibold text-[#191f28]">아직 오를 가능성이 높으면(상위
              10%) 팔지 않고 밴드를 그 자리 기준 ±{Math.round(MODEL_SYMMETRIC_EXIT_CONFIG.tpPct * 100)}%로 올려 달아요(래칫)</Text> —
              한 계단만 올라도 아래끝이 본전 근처로 잠겨 "+3% 벌었다가 −3% 반납"이 없어요. 산 지{' '}
              {MODEL_SYMMETRIC_EXIT_CONFIG.maxHoldMin}분이 지나면 전량 매도해요(시간 청산). 봉 마감을 기다리지 않고 체결가가 닿는
              순간 판단해요.
            </Text>

            <View className="mb-1 flex-row items-center justify-between">
              <Text className="text-xs text-[#8b95a1]">봉</Text>
              <Text className="text-sm font-semibold text-[#191f28]">{MODEL_BAR_MINUTES}분봉 · 토스 차트</Text>
            </View>
            <Text className="mb-3 text-xs leading-5 text-[#8b95a1]">
              모델을 학습시킬 때 쓴 것과 같은 원천(토스 {MODEL_BAR_MINUTES}분봉)에서 그대로 받아와요. 봉이 닫히고 몇 초 뒤에 한 번씩
              읽어 판정해요.
            </Text>

            <View className="rounded-2xl bg-[#f2f4f6] px-4 py-3">
              <Text className="text-xs leading-5 text-[#4e5968]">
                검증: 과거 4구간(2024-07~2026-04) 19,610거래 · 승률 58% ·{' '}
                <Text className="font-semibold text-[#191f28]">거래당 평균 +0.2% 언저리</Text>(비용 포함) · 4구간 전부 플러스
                (2026-09-01 ±3% 대칭·1분봉 재학습). 건당 이익이 얇아 체결이 조금만 불리해도 우위가 줄어요 — 잃어도 되는 금액으로만
                하세요.
              </Text>
            </View>
          </View>
        </Panel>
        )}

        <Panel title="주문">
          <View className="px-5 pb-5">
            <Text className="mb-3 text-xs leading-5 text-[#8b95a1]">
              어떤 가격에 걸고, 안 붙으면 어떻게 할지 매수·매도 따로 골라요. 저장하면 <Text className="font-semibold text-[#191f28]">바로 적용</Text>돼요(재시작
              불필요) — 이미 걸린 주문도 다음 틱부터 새 전략으로 다뤄요.
            </Text>
            <OrderStrategyPicker
              title="매수 전략"
              side="buy"
              value={buyStrategy}
              onChange={setBuyStrategy}
              cancelAfterSec={buyCancelAfterSec}
              onCancelAfterSecChange={setBuyCancelAfterSec}
            />
            <OrderStrategyPicker
              title="매도 전략"
              side="sell"
              value={sellStrategy}
              onChange={setSellStrategy}
              cancelAfterSec={sellCancelAfterSec}
              onCancelAfterSecChange={setSellCancelAfterSec}
            />
          </View>
        </Panel>

        <View className="px-5">
          <Pressable
            onPress={handleSave}
            disabled={saving}
            className="items-center justify-center rounded-2xl bg-[#3182f6] active:opacity-80"
            style={{ minHeight: 52 }}
          >
            <Text className="text-base font-semibold text-white">{saving ? '저장 중이에요…' : '저장하기'}</Text>
          </Pressable>

          <Text className="mt-6 text-center text-xs text-[#8b95a1]">매매 중에는 화면을 켠 채로 두세요.</Text>
        </View>
      </ScrollView>
    </View>
  );
}
