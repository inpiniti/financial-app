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
import { MAX_GRIDS_LIMIT, MODEL_CONFIG } from '../features/scalper/autopilot';
import { MODEL_BAR_MINUTES } from '../features/scalper/modelMode';
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
  const [minTickRate, setMinTickRate] = useState(String(DEFAULT_APP_SETTINGS.minTickRate));
  const [maxConcurrentGrids, setMaxConcurrentGrids] = useState(String(DEFAULT_APP_SETTINGS.maxConcurrentGrids));
  // 순위 선택(2026-08-18 순위 도메인) — 트레이딩 리스트 원천별 켬·개수·(한투) 기간창.
  const [rankingDraft, setRankingDraft] = useState<RankingSelectionDraft>(() =>
    draftFromSelection(normalizeRankingSelection(DEFAULT_APP_SETTINGS.rankingSelection)),
  );

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
      setEntryQty(appSettings.entryQty > 0 ? String(appSettings.entryQty) : '');
      setMaxPriceUsd(appSettings.maxPriceUsd > 0 ? String(appSettings.maxPriceUsd) : '');
      setMinTickRate(String(appSettings.minTickRate));
      setMaxConcurrentGrids(String(appSettings.maxConcurrentGrids));
      setRankingDraft(draftFromSelection(appSettings.rankingSelection));
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
        orderQty: savedOrderQtyRef.current,
        buyCancelAfterSec,
        ...savedRollbackRef.current,
        startAmountUsd: parsedStartAmountUsd,
        entryQty: parsedEntryQty,
        maxPriceUsd: parsedMaxPriceUsd,
        minTickRate: parsedMinTickRate,
        maxConcurrentGrids: parsedMaxGrids,
        rankingSelection,
      });
      Alert.alert('알림', '설정을 저장했어요.');
    } finally {
      setSaving(false);
    }
  };

  /** 첫 진입에 한 번에 들어갈 수 있는 최대 금액 — 진입금액 × 동시 그리드 수. */
  const exposure = (() => {
    const amount = Number(startAmountUsd);
    const grids = Number(maxConcurrentGrids);
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
                : entryQty.trim() !== '' && Number(entryQty) > 0
                  ? `종목당 ${Number(entryQty)}주 × 현재가만큼 들어가고, 물타기도 매번 ${Number(entryQty)}주씩이에요.`
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

        <RankingSelectionPanel draft={rankingDraft} onChange={setRankingDraft} />
        <Panel title="모델 (고정값)">
          <View className="px-5 pb-5">
            <Text className="mb-3 text-xs leading-5 text-[#8b95a1]">
              진입은 예측 모델이, 매도는 정해진 세 가격선이 정해요. 아래 값은 설계 고정값이라 여기서 바꿀 수 없어요.
            </Text>

            <View className="mb-1 flex-row items-center justify-between">
              <Text className="text-xs text-[#8b95a1]">진입</Text>
              <Text className="text-sm font-semibold text-[#191f28]">모델 확률 ≥ 상위 1% 기준값</Text>
            </View>
            <Text className="mb-3 text-xs leading-5 text-[#8b95a1]">
              {MODEL_BAR_MINUTES}분봉이 닫힐 때마다 리스트 전 종목에 대해 "지금 사면 −{Math.round(MODEL_CONFIG.stopLossPct * 100)}%
              전에 +{Math.round(MODEL_CONFIG.takeProfitPct * 100)}%에 닿을 확률"을 계산해요(지표 33개). 3년 반치 과거에서 상위 1%에
              해당하는 값을 넘어야 사요 — 신호가 드문 게 정상이에요. 정규장·그날 거래대금 $2M 이상·주가 $1 초과만 봐요. 물타기는 하지 않아요.
            </Text>

            <View className="mb-1 flex-row items-center justify-between">
              <Text className="text-xs text-[#8b95a1]">매도</Text>
              <Text className="text-sm font-semibold text-[#191f28]">
                +{Math.round(MODEL_CONFIG.takeProfitPct * 100)}% / −{Math.round(MODEL_CONFIG.stopLossPct * 100)}% /{' '}
                {MODEL_CONFIG.timeoutMinutes}분
              </Text>
            </View>
            <Text className="mb-3 text-xs leading-5 text-[#8b95a1]">
              평단 기준 세 선 중 먼저 닿는 것으로 전량 매도해요 — 익절 +{Math.round(MODEL_CONFIG.takeProfitPct * 100)}%, 손절 −
              {Math.round(MODEL_CONFIG.stopLossPct * 100)}%, 시간 청산 {MODEL_CONFIG.timeoutMinutes}분. 봉 마감을 기다리지 않고
              체결가가 닿는 순간 판단해요. 매도 주문은 체결될 때까지 현재가를 따라가고 도중에 거두지 않아요.
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
                검증: 한 번도 안 본 2026-05~08 구간 3,116거래 · 승률 39% ·{' '}
                <Text className="font-semibold text-[#191f28]">거래당 평균 +0.42%</Text>(비용 포함) · 4개월 전부 플러스.
                다만 12연패 구간이 있었어요 — 한 번 −{Math.round(MODEL_CONFIG.stopLossPct * 100)}%를 감당할 금액으로만 하세요.
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
              helper="매수 주문이 이 시간 안에 안 붙으면 취소하고 다음 신호를 기다려요. 권장 2~3초. 일부라도 체결됐으면 취소하지 않고 그대로 기다려요. 취소가 3번 이어지면 그 종목은 1분간 쉬어요. 0이면 체결될 때까지 계속 기다려요."
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
