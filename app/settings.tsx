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
import { MAX_GRIDS_LIMIT } from '../features/scalper/autopilot';

/** 그리드 폭 상한(%) — 오타 방어. 중앙값 ±50%를 넘는 칸은 사실상 관리가 아니다. */
const GRID_WIDTH_MAX_PCT = 50;
/** 사다리 진입 간격 상한(%) — 오타 방어. 간격 10% × 횟수면 이미 대폭락에서만 진입한다. */
const LADDER_INTERVAL_MAX_PCT = 10;
/** 사다리 홀 횟수 상한 — 간격과 곱해 누적 낙폭이 되므로 10이면 충분히 보수적 끝단이다. */
const LADDER_COUNT_MAX = 10;
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
  // 매도 관리 그리드 폭 — 텍스트 입력 + 저장 시 검증 패턴. (매수 배율은 사다리 재설계로 제거 — 2026-08-13)
  const [gridWidthPct, setGridWidthPct] = useState(String(DEFAULT_APP_SETTINGS.gridWidthPct));
  // 사다리 진입 감지(2026-08-07 plan) — 간격 %·홀 횟수.
  const [entryLadderIntervalPct, setEntryLadderIntervalPct] = useState(
    String(DEFAULT_APP_SETTINGS.entryLadderIntervalPct),
  );
  const [entryLadderCount, setEntryLadderCount] = useState(String(DEFAULT_APP_SETTINGS.entryLadderCount));
  // 트레이딩 운용 설정 — 옛 자동 단타 설정 시트에서 옮겨 왔다(2026-08-12). 진입금액 0 = 미설정(빈 칸).
  const [startAmountUsd, setStartAmountUsd] = useState(String(DEFAULT_APP_SETTINGS.startAmountUsd));
  const [minTickRate, setMinTickRate] = useState(String(DEFAULT_APP_SETTINGS.minTickRate));
  const [maxConcurrentGrids, setMaxConcurrentGrids] = useState(String(DEFAULT_APP_SETTINGS.maxConcurrentGrids));

  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const appSettings = await loadAppSettings();
      savedOrderQtyRef.current = appSettings.orderQty;
      setBuyCancelAfterSec(appSettings.buyCancelAfterSec);
      setGridWidthPct(String(appSettings.gridWidthPct));
      setEntryLadderIntervalPct(String(appSettings.entryLadderIntervalPct));
      setEntryLadderCount(String(appSettings.entryLadderCount));
      setStartAmountUsd(appSettings.startAmountUsd > 0 ? String(appSettings.startAmountUsd) : '');
      setMinTickRate(String(appSettings.minTickRate));
      setMaxConcurrentGrids(String(appSettings.maxConcurrentGrids));
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

    const parsedMinTickRate = Number(minTickRate);
    if (!Number.isFinite(parsedMinTickRate) || parsedMinTickRate <= 0) {
      Alert.alert('알림', '최소 속도는 0보다 크게 입력해 주세요. (기본 1틱/초)');
      return;
    }

    const parsedMaxGrids = Number(maxConcurrentGrids);
    if (
      !Number.isFinite(parsedMaxGrids) ||
      !Number.isInteger(parsedMaxGrids) ||
      parsedMaxGrids < 1 ||
      parsedMaxGrids > MAX_GRIDS_LIMIT
    ) {
      Alert.alert('알림', `동시 그리드 수는 1~${MAX_GRIDS_LIMIT} 사이 정수로 입력해 주세요.`);
      return;
    }

    const parsedGridWidthPct = Number(gridWidthPct);
    if (!Number.isFinite(parsedGridWidthPct) || parsedGridWidthPct <= 0 || parsedGridWidthPct > GRID_WIDTH_MAX_PCT) {
      Alert.alert('알림', `그리드 폭은 0보다 크고 ${GRID_WIDTH_MAX_PCT} 이하인 숫자로 입력해 주세요.`);
      return;
    }

    const parsedLadderIntervalPct = Number(entryLadderIntervalPct);
    if (
      !Number.isFinite(parsedLadderIntervalPct) ||
      parsedLadderIntervalPct <= 0 ||
      parsedLadderIntervalPct > LADDER_INTERVAL_MAX_PCT
    ) {
      Alert.alert('알림', `진입 간격은 0보다 크고 ${LADDER_INTERVAL_MAX_PCT} 이하인 숫자로 입력해 주세요.`);
      return;
    }

    const parsedLadderCount = Number(entryLadderCount);
    if (
      !Number.isFinite(parsedLadderCount) ||
      !Number.isInteger(parsedLadderCount) ||
      parsedLadderCount < 1 ||
      parsedLadderCount > LADDER_COUNT_MAX
    ) {
      Alert.alert('알림', `진입 횟수는 1~${LADDER_COUNT_MAX} 사이 정수로 입력해 주세요.`);
      return;
    }

    setSaving(true);
    try {
      // 미체결 취소는 슬라이더가 범위·스텝 격자를 보장하므로 별도 검증이 없다.
      await saveAppSettings({
        environment: 'live',
        orderQty: savedOrderQtyRef.current,
        buyCancelAfterSec,
        gridWidthPct: parsedGridWidthPct,
        entryLadderIntervalPct: parsedLadderIntervalPct,
        entryLadderCount: parsedLadderCount,
        startAmountUsd: parsedStartAmountUsd,
        minTickRate: parsedMinTickRate,
        maxConcurrentGrids: parsedMaxGrids,
      });
      Alert.alert('알림', '설정을 저장했어요.');
    } finally {
      setSaving(false);
    }
  };

  /**
   * 사다리 진입의 즉시 미리보기 — 간격×횟수가 실제로 "몇 % 떨어져야 진입"인지 그 자리에서 보여준다.
   * 누적 낙폭은 복리(1−(1−g)^N)라 단순곱(g×N)보다 조금 작다.
   */
  const ladderPreview = (() => {
    const g = Number(entryLadderIntervalPct);
    const n = Number(entryLadderCount);
    if (!Number.isFinite(g) || g <= 0 || g > LADDER_INTERVAL_MAX_PCT) return null;
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > LADDER_COUNT_MAX) return null;
    return { dropPct: ((1 - Math.pow(1 - g / 100, n)) * 100).toFixed(2) };
  })();

  /**
   * 그리드 폭의 즉시 미리보기 — 입력값이 실제 칸 간격·발주가로 어떻게 번역되는지 그 자리에서 보여준다.
   * 입력이 유효 범위를 벗어나면 null — 저장 시 Alert로 막히므로 여기서는 미리보기만 숨긴다.
   */
  const gridPreview = (() => {
    const w = Number(gridWidthPct);
    if (!Number.isFinite(w) || w <= 0 || w > GRID_WIDTH_MAX_PCT) return null;
    return {
      buy: (100 - w).toFixed(2),
      sell: (100 + w).toFixed(2),
    };
  })();

  /** 첫 진입에 한 번에 들어갈 수 있는 최대 금액 — 진입금액 × 동시 그리드 수. */
  const exposure = (() => {
    const amount = Number(startAmountUsd);
    const grids = Number(maxConcurrentGrids);
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
              변곡점이 잡힐 때마다 한 종목씩 진입하고, 진입한 종목은 ±폭 그리드가 이어받아 관리해요. 이미 보유 중인
              종목은 다시 사지 않고, 그리드가 익절되면 그 자리에 새 종목이 들어와요.
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

            <Text className="mb-1 text-xs text-[#8b95a1]">
              동시 그리드 수 (1~{MAX_GRIDS_LIMIT}) — 한 번에 관리할 종목 개수
            </Text>
            <TextInput
              value={maxConcurrentGrids}
              onChangeText={setMaxConcurrentGrids}
              keyboardType="number-pad"
              placeholder={`기본 ${DEFAULT_APP_SETTINGS.maxConcurrentGrids}`}
              placeholderTextColor="#8b95a1"
              className="mb-1 rounded-2xl border border-[#e5e8eb] px-4 py-3 text-base text-[#191f28]"
            />
            <Text className="mb-4 text-xs leading-5 text-[#8b95a1]">
              {exposure
                ? `첫 진입에만 최대 $${exposure}가 들어가요. 그리드가 물타기(−폭 매수)를 하면 종목당 금액이 더 늘어날 수 있어요.`
                : '그리드가 물타기(−폭 매수)를 하면 종목당 금액이 더 늘어날 수 있어요.'}
            </Text>

            <Text className="mb-1 text-xs text-[#8b95a1]">
              최소 속도 (틱/초) — 이보다 조용한 종목은 감시하지 않아요
            </Text>
            <TextInput
              value={minTickRate}
              onChangeText={setMinTickRate}
              keyboardType="decimal-pad"
              placeholder={`기본 ${DEFAULT_APP_SETTINGS.minTickRate}`}
              placeholderTextColor="#8b95a1"
              className="mb-4 rounded-2xl border border-[#e5e8eb] px-4 py-3 text-base text-[#191f28]"
            />

            <View className="rounded-2xl bg-[#f2f4f6] px-4 py-3">
              <Text className="text-xs leading-5 text-[#4e5968]">
                이 세 값은 <Text className="font-semibold text-[#191f28]">정지 상태에서만</Text> 적용돼요. 매매 중에
                저장하면 정지한 뒤 트레이딩 화면으로 돌아올 때 반영돼요.
              </Text>
            </View>
          </View>
        </Panel>

        <Panel title="진입 감지">
          <View className="px-5 pb-5">
            <Text className="mb-1 text-xs text-[#8b95a1]">진입 간격 (%) — 최대 {LADDER_INTERVAL_MAX_PCT}</Text>
            <TextInput
              value={entryLadderIntervalPct}
              onChangeText={setEntryLadderIntervalPct}
              keyboardType="decimal-pad"
              placeholder={`기본 ${DEFAULT_APP_SETTINGS.entryLadderIntervalPct}`}
              placeholderTextColor="#8b95a1"
              className="mb-1 rounded-2xl border border-[#e5e8eb] px-4 py-3 text-base text-[#191f28]"
            />
            <Text className="mb-4 text-xs leading-5 text-[#8b95a1]">
              최근 고점에서 이 %씩 내려올 때마다 한 칸으로 세요.
            </Text>

            <Text className="mb-1 text-xs text-[#8b95a1]">진입 횟수 — 최대 {LADDER_COUNT_MAX}</Text>
            <TextInput
              value={entryLadderCount}
              onChangeText={setEntryLadderCount}
              keyboardType="number-pad"
              placeholder={`기본 ${DEFAULT_APP_SETTINGS.entryLadderCount}`}
              placeholderTextColor="#8b95a1"
              className="mb-1 rounded-2xl border border-[#e5e8eb] px-4 py-3 text-base text-[#191f28]"
            />
            <Text className="mb-1 text-xs leading-5 text-[#8b95a1]">
              이 횟수만큼 칸이 쌓이면 바닥으로 보고 매수해요. 중간에 한 칸 이상 반등하면 처음부터 다시 세요.
              {ladderPreview && (
                <Text className="text-[#4e5968]">
                  {' '}지금 설정이면 고점에서 약 {ladderPreview.dropPct}% 떨어져야 진입해요.
                </Text>
              )}
            </Text>
            <Text className="text-xs leading-5 text-[#8b95a1]">
              잔파동(간격 미만의 오르내림)에서는 진입하지 않아요. 매수 뒤 관리는 아래 그리드가 맡아요.
            </Text>
          </View>
        </Panel>

        <Panel title="매도 그리드">
          <View className="px-5 pb-5">
            <Text className="mb-1 text-xs text-[#8b95a1]">그리드 폭 (%) — 최대 {GRID_WIDTH_MAX_PCT}</Text>
            <TextInput
              value={gridWidthPct}
              onChangeText={setGridWidthPct}
              keyboardType="decimal-pad"
              placeholder={`기본 ${DEFAULT_APP_SETTINGS.gridWidthPct}`}
              placeholderTextColor="#8b95a1"
              className="mb-1 rounded-2xl border border-[#e5e8eb] px-4 py-3 text-base text-[#191f28]"
            />
            <Text className="mb-1 text-xs leading-5 text-[#8b95a1]">
              마지막 체결가(중앙값) 위아래 이 %에 매도·매수 지정가를 걸어요. 체결될 때마다 그 가격 기준으로 다시 계산해요.
              {gridPreview && (
                <Text className="text-[#4e5968]">
                  {' '}중앙값이 $100이면 매수 ${gridPreview.buy} · 매도 ${gridPreview.sell}에 걸려요.
                </Text>
              )}
            </Text>
            <Text className="mb-4 text-xs leading-5 text-[#8b95a1]">
              수량은 사다리 방식이에요. 한 칸 내려가 매수될 때마다 진입 수량만큼 한 단위씩 늘려 사고(1, 2, 3, …배),
              한 칸 올라가면 마지막에 산 만큼만 팔아서 그 매수를 그대로 되돌려요. 배수로 불리는 물타기보다
              수량이 훨씬 완만하게 늘어요.
            </Text>

            <View className="rounded-2xl bg-[#f2f4f6] px-4 py-3">
              <Text className="text-xs leading-5 text-[#4e5968]">
                폭은 <Text className="font-semibold text-[#191f28]">다음에 새로 여는 그리드부터</Text> 적용돼요.
                지금 돌고 있는 그리드는 이미 주문이 접수돼 있어서 그대로 관리돼요.
              </Text>
            </View>
          </View>
        </Panel>

        <Panel title="주문">
          <View className="px-5 pb-5">
            <SettingSlider
              label="매수 미체결 취소 (초)"
              value={buyCancelAfterSec}
              onChange={setBuyCancelAfterSec}
              min={0}
              max={10}
              step={1}
              formatValue={(v) => `${v}초`}
              helper="매수 주문이 이 시간 안에 안 붙으면 취소하고 다시 변곡점을 기다려요. 권장 2~3초. 일부라도 체결됐으면 취소하지 않고 그대로 기다려요. 취소가 3번 이어지면 그 종목은 1분간 쉬어요. 0이면 체결될 때까지 계속 기다려요."
              offAtZero
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
