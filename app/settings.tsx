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
import { INFLECTION_THRESHOLDS, MAX_GRIDS_LIMIT } from '../features/scalper/autopilot';
import { INFLECTION_BUFFER_SIZE, INFLECTION_CHUNK_SECONDS } from '../features/scalper/feedSlot';

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
  const [minTickRate, setMinTickRate] = useState(String(DEFAULT_APP_SETTINGS.minTickRate));
  const [maxConcurrentGrids, setMaxConcurrentGrids] = useState(String(DEFAULT_APP_SETTINGS.maxConcurrentGrids));

  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const appSettings = await loadAppSettings();
      savedOrderQtyRef.current = appSettings.orderQty;
      setBuyCancelAfterSec(appSettings.buyCancelAfterSec);
      savedRollbackRef.current = {
        gridBuyWidthPct: appSettings.gridBuyWidthPct,
        gridSellWidthPct: appSettings.gridSellWidthPct,
        gridBuyMultiplier: appSettings.gridBuyMultiplier,
        entryLadderIntervalPct: appSettings.entryLadderIntervalPct,
        entryLadderCount: appSettings.entryLadderCount,
      };
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

    setSaving(true);
    try {
      // 미체결 취소는 슬라이더가 범위·스텝 격자를 보장하므로 별도 검증이 없다.
      // 그리드 폭·배율·사다리 값은 화면에서 내렸다(조합 모드 미사용) — 로드해 둔 저장값 그대로 되쓴다(롤백 보존).
      await saveAppSettings({
        environment: 'live',
        orderQty: savedOrderQtyRef.current,
        buyCancelAfterSec,
        ...savedRollbackRef.current,
        startAmountUsd: parsedStartAmountUsd,
        minTickRate: parsedMinTickRate,
        maxConcurrentGrids: parsedMaxGrids,
      });
      Alert.alert('알림', '설정을 저장했어요.');
    } finally {
      setSaving(false);
    }
  };

  /** 조합 고정 문턱(%) — 표시용. INFLECTION_THRESHOLDS가 단일 출처다. */
  const sellPct = (INFLECTION_THRESHOLDS.sellProfitPct * 100).toFixed(0);
  const dropPct = (INFLECTION_THRESHOLDS.buyDropPct * 100).toFixed(0);

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
                ? `첫 진입에만 최대 $${exposure}가 들어가요. 물타기는 매번 최초 진입 수량만큼이라, 물탈 때마다 종목당 금액이 진입금액만큼씩 더 들어가요.`
                : '물타기는 매번 최초 진입 수량만큼이라, 물탈 때마다 종목당 금액이 진입금액만큼씩 더 들어가요.'}
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

        <Panel title="변곡점 그리드 (고정값)">
          <View className="px-5 pb-5">
            <Text className="mb-3 text-xs leading-5 text-[#8b95a1]">
              진입·매도·물타기는 전부 변곡점 신호로만 움직여요. 아래 값은 설계 고정값이라 여기서 바꿀 수 없어요.
            </Text>

            <View className="mb-1 flex-row items-center justify-between">
              <Text className="text-xs text-[#8b95a1]">진입 · 물타기</Text>
              <Text className="text-sm font-semibold text-[#191f28]">상승 변곡점</Text>
            </View>
            <Text className="mb-3 text-xs leading-5 text-[#8b95a1]">
              바닥(상승 변곡점)이 확인될 때만 사요. 물타기는 평단보다 {dropPct}% 이상 떨어진 바닥에서만, 매번 최초
              진입 수량만큼(고정 수량) 사요. 낙폭이 모자라면 신호가 와도 사지 않아요.
            </Text>

            <View className="mb-1 flex-row items-center justify-between">
              <Text className="text-xs text-[#8b95a1]">매도</Text>
              <Text className="text-sm font-semibold text-[#191f28]">고점 변곡점 · +{sellPct}% 이상</Text>
            </View>
            <Text className="mb-3 text-xs leading-5 text-[#8b95a1]">
              천장(고점 변곡점)에서 평단 대비 {sellPct}% 이상 이익일 때만 전량 매도해요. 그보다 이익이 작으면 팔지
              않고 계속 지켜봐요.
            </Text>

            <View className="mb-1 flex-row items-center justify-between">
              <Text className="text-xs text-[#8b95a1]">변곡점 판정</Text>
              <Text className="text-sm font-semibold text-[#191f28]">
                청크 {INFLECTION_CHUNK_SECONDS}초 · 버퍼 {INFLECTION_BUFFER_SIZE}
              </Text>
            </View>
            <Text className="mb-3 text-xs leading-5 text-[#8b95a1]">
              체결가를 {INFLECTION_CHUNK_SECONDS}초 단위로 평균해 최근 {INFLECTION_BUFFER_SIZE}개로 곡선을 그리고,
              기울기의 방향이 바뀌는 지점을 바닥·천장으로 봐요.
            </Text>

            <View className="rounded-2xl bg-[#f2f4f6] px-4 py-3">
              <Text className="text-xs leading-5 text-[#4e5968]">
                주문은 미리 걸어두지 않고 신호가 온 순간 <Text className="font-semibold text-[#191f28]">현재가</Text>로
                내요. 체결 전에 가격이 움직이면 새 현재가로 따라가고, 그 사이 조건({sellPct}%/{dropPct}%)이 깨지면
                주문을 거두고 다음 변곡점을 기다려요.
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
