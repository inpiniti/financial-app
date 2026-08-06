// 설정 화면 — 옛 (tabs)/settings.tsx. 좌상단 뒤로가기로 홈 복귀, 하단 고정 메뉴(계좌연결|매매파라미터).
// 상태·저장 로직은 원본 그대로 이 화면(부모) 레벨에 두고, 섹션 전환은 렌더링만 바꾼다 —
// "저장하기" 버튼은 매매파라미터 섹션에 있지만 handleSave가 계좌 정보까지 함께 저장하는 동작은 원본과 동일하다.
import { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import Slider from '@react-native-community/slider';
import { BackHeader } from '../components/BackHeader';
import { BottomMenu, type BottomMenuItem } from '../components/BottomMenu';
import { Panel } from '../components/Panel';
import { ToggleRow } from '../components/ToggleRow';
import { getAccessToken } from '../kis/token';
import { secureTokenStorage } from '../lib/secureTokenStorage';
import { formatAccountNo, loadKisSettings, parseAccountNo, saveKisSettings } from '../lib/kisSettings';
import { DEFAULT_APP_SETTINGS, loadAppSettings, saveAppSettings, snapToStep } from '../lib/appSettings';

/** 버퍼 슬라이더 격자 — 최소 7 · 2칸 간격이라 항상 홀수만 나온다(SG 윈도 요건). */
const BUFFER_MIN = 7;
const BUFFER_MAX = 51;
const BUFFER_STEP = 2;

type TokenStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'success'; expiresAt: number }
  | { kind: 'failure'; reason: string };

type SettingsSection = 'account' | 'params';

const MENU_ITEMS: BottomMenuItem<SettingsSection>[] = [
  { key: 'account', label: '계좌연결', icon: 'card-outline', activeIcon: 'card' },
  { key: 'params', label: '매매파라미터', icon: 'options-outline', activeIcon: 'options' },
];

/** 그리드 폭 상한(%) — 오타 방어. 평단 ±50%를 넘는 브래킷은 사실상 관리가 아니다. */
const GRID_WIDTH_MAX_PCT = 50;
/** 매수 배율 상한 — 1이면 보유수량만큼 더 사서 총 2배가 된다. 5면 한 번에 6배라 그 위는 막는다. */
const GRID_BUY_MULTIPLIER_MAX = 5;

function formatHHmm(epochMs: number): string {
  const d = new Date(epochMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}


/**
 * 값 조절 슬라이더 한 벌 — 라벨 + 현재 값 + 슬라이더 + 양끝 범위 + 안내 문구.
 * offAtZero면 0을 "꺼짐"으로 표시한다(문턱 4종의 detector 관례). 나머지(청크·버퍼)는 항상 값이 있다.
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

/**
 * 설정 화면 — KIS 키/계좌 저장(secure-store), 토큰 발급, LIVE/PAPER 전환, 매매 파라미터(AsyncStorage) (PRD §4-E).
 */
export default function SettingsScreen() {
  const [section, setSection] = useState<SettingsSection>('account');

  const [appKey, setAppKey] = useState('');
  const [appSecret, setAppSecret] = useState('');
  // 저장된 AppSecret 실제 값은 화면에 노출하지 않는다 — 입력칸은 비워 두고 배지로만 "저장돼 있어요"를 알린다.
  // 사용자가 빈 칸으로 둔 채 저장하면(재입력 안 함) 기존 저장값을 그대로 유지한다.
  const [hasSavedAppSecret, setHasSavedAppSecret] = useState(false);
  const [accountNoInput, setAccountNoInput] = useState('');

  // 실전(LIVE) 전용 — 모의 전환 옵션은 2026-07-30 제거 (loadAppSettings가 'live'로 강제).
  const environment = 'live' as const;
  const [orderQty, setOrderQty] = useState(String(DEFAULT_APP_SETTINGS.orderQty));
  // 청크·버퍼·문턱은 슬라이더로 조절한다(숫자 state). 문턱 4종만 0="끔"이다.
  const [chunkSeconds, setChunkSeconds] = useState(DEFAULT_APP_SETTINGS.chunkSeconds);
  const [bufferSize, setBufferSize] = useState(DEFAULT_APP_SETTINGS.bufferSize);
  const [momentumThresholdPct, setMomentumThresholdPct] = useState(DEFAULT_APP_SETTINGS.momentumThresholdPct);
  const [sellMomentumThresholdPct, setSellMomentumThresholdPct] = useState(
    DEFAULT_APP_SETTINGS.sellMomentumThresholdPct,
  );
  const [buyVolumeSpikeRatio, setBuyVolumeSpikeRatio] = useState(DEFAULT_APP_SETTINGS.buyVolumeSpikeRatio);
  const [buyStrengthThreshold, setBuyStrengthThreshold] = useState(DEFAULT_APP_SETTINGS.buyStrengthThreshold);
  const [commissionRatePct, setCommissionRatePct] = useState(DEFAULT_APP_SETTINGS.commissionRatePct);
  const [buyCancelAfterSec, setBuyCancelAfterSec] = useState(DEFAULT_APP_SETTINGS.buyCancelAfterSec);
  // 매도 관리 그리드 폭·매수 배율 — 주문 수량과 같은 텍스트 입력 + 저장 시 검증 패턴.
  const [gridWidthPct, setGridWidthPct] = useState(String(DEFAULT_APP_SETTINGS.gridWidthPct));
  const [gridBuyMultiplier, setGridBuyMultiplier] = useState(String(DEFAULT_APP_SETTINGS.gridBuyMultiplier));
  const [simulationMode, setSimulationMode] = useState(DEFAULT_APP_SETTINGS.simulationMode);

  const [tokenStatus, setTokenStatus] = useState<TokenStatus>({ kind: 'idle' });
  const [saving, setSaving] = useState(false);
  // 저장된 AppSecret 실제 값 — 화면 상태(appSecret)에는 절대 넣지 않고, "재입력 안 하고 저장" 시에만 참조한다.
  const savedAppSecretRef = useRef('');

  useEffect(() => {
    (async () => {
      const [kisSettings, appSettings] = await Promise.all([loadKisSettings(), loadAppSettings()]);
      if (kisSettings) {
        setAppKey(kisSettings.appKey);
        // AppSecret은 입력칸에 값을 채우지 않는다(노출 금지) — 배지로 저장 여부만 알린다.
        savedAppSecretRef.current = kisSettings.appSecret;
        setHasSavedAppSecret(true);
        setAccountNoInput(formatAccountNo(kisSettings));
      }
      setOrderQty(String(appSettings.orderQty));
      setChunkSeconds(appSettings.chunkSeconds);
      // 격자 밖(짝수) 값이 저장돼 있을 수 있다 — 예전 스냅 버그의 잔재. 표시와 실제를 일치시키려 격자로 맞춘다.
      // (Resampler가 어차피 홀수로 올림하므로 실제 동작은 늘 홀수였고, 화면 표시만 어긋나 있었다.)
      setBufferSize(snapToStep(appSettings.bufferSize, BUFFER_MIN, BUFFER_MAX, BUFFER_STEP));
      setMomentumThresholdPct(appSettings.momentumThresholdPct);
      setSellMomentumThresholdPct(appSettings.sellMomentumThresholdPct);
      setBuyVolumeSpikeRatio(appSettings.buyVolumeSpikeRatio);
      setBuyStrengthThreshold(appSettings.buyStrengthThreshold);
      setCommissionRatePct(appSettings.commissionRatePct);
      setBuyCancelAfterSec(appSettings.buyCancelAfterSec);
      setGridWidthPct(String(appSettings.gridWidthPct));
      setGridBuyMultiplier(String(appSettings.gridBuyMultiplier));
      setSimulationMode(appSettings.simulationMode);
    })();
  }, []);

  // 새로 입력했으면 그 값을, 비워 뒀고 이전에 저장돼 있었으면 기존 값을 그대로 쓴다(덮어쓰기는 재입력할 때만).
  const effectiveAppSecret = appSecret.trim() || (hasSavedAppSecret ? savedAppSecretRef.current : '');

  const handleSave = async () => {
    const account = parseAccountNo(accountNoInput);
    if (!appKey.trim() || !effectiveAppSecret || !account) {
      Alert.alert('알림', 'AppKey·AppSecret·계좌번호(8-2 형식)를 모두 채워 주세요.');
      return;
    }

    const parsedOrderQty = Number(orderQty);
    if (!Number.isFinite(parsedOrderQty) || parsedOrderQty <= 0) {
      Alert.alert('알림', '주문 수량은 0보다 큰 숫자로 입력해 주세요.');
      return;
    }

    // 상한을 둔다 — 오타 하나(10 → 100)가 그대로 발주가에 들어가면 되돌릴 수 없다.
    const parsedGridWidthPct = Number(gridWidthPct);
    if (!Number.isFinite(parsedGridWidthPct) || parsedGridWidthPct <= 0 || parsedGridWidthPct > GRID_WIDTH_MAX_PCT) {
      Alert.alert('알림', `그리드 폭은 0보다 크고 ${GRID_WIDTH_MAX_PCT} 이하인 숫자로 입력해 주세요.`);
      return;
    }

    const parsedGridBuyMultiplier = Number(gridBuyMultiplier);
    if (
      !Number.isFinite(parsedGridBuyMultiplier) ||
      parsedGridBuyMultiplier <= 0 ||
      parsedGridBuyMultiplier > GRID_BUY_MULTIPLIER_MAX
    ) {
      Alert.alert('알림', `매수 배율은 0보다 크고 ${GRID_BUY_MULTIPLIER_MAX} 이하인 숫자로 입력해 주세요.`);
      return;
    }

    setSaving(true);
    try {
      await saveKisSettings({ appKey: appKey.trim(), appSecret: effectiveAppSecret, ...account });
      // 청크·버퍼·문턱은 슬라이더가 범위·스텝 격자(버퍼는 홀수)를 보장하므로 별도 검증이 없다.
      await saveAppSettings({
        environment,
        orderQty: parsedOrderQty,
        chunkSeconds,
        bufferSize,
        momentumThresholdPct,
        sellMomentumThresholdPct,
        buyVolumeSpikeRatio,
        buyStrengthThreshold,
        commissionRatePct,
        buyCancelAfterSec,
        gridWidthPct: parsedGridWidthPct,
        gridBuyMultiplier: parsedGridBuyMultiplier,
        simulationMode,
      });
      // 저장 성공 — 이후 재입력 없이도 배지가 최신 저장값을 가리키게 갱신한다.
      savedAppSecretRef.current = effectiveAppSecret;
      setHasSavedAppSecret(true);
      setAppSecret('');
      Alert.alert('알림', '설정을 저장했어요.');
    } finally {
      setSaving(false);
    }
  };

  const handleIssueToken = async () => {
    if (!appKey.trim() || !effectiveAppSecret) {
      Alert.alert('알림', 'AppKey·AppSecret을 먼저 입력하고 저장해 주세요.');
      return;
    }

    setTokenStatus({ kind: 'checking' });
    try {
      const token = await getAccessToken(
        environment,
        { appKey: appKey.trim(), appSecret: effectiveAppSecret },
        { storage: secureTokenStorage },
      );
      setTokenStatus({ kind: 'success', expiresAt: token.expiresAt });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      setTokenStatus({ kind: 'failure', reason });
    }
  };

  // 신호 지연 — SG 미분은 창 "중심점" 기준이라 변곡점 판정이 (버퍼-1)/2 청크만큼 늦게 잡힌다.
  // 버퍼·청크를 키우면 노이즈에 둔감해지는 대신 이 지연이 커지므로, 값을 조절할 때 바로 보이게 표시한다.
  const signalLagSeconds = ((bufferSize - 1) / 2) * chunkSeconds;

  /**
   * 그리드 폭·배율의 즉시 미리보기 — 입력값이 실제 발주가·수량으로 어떻게 번역되는지 그 자리에서 보여준다.
   * ("매수 배율 1"이 왜 수량 2배가 되는지가 숫자로 보이지 않아 오해가 잦았다.)
   * 입력이 유효 범위를 벗어나면 null — 저장 시 Alert로 막히므로 여기서는 미리보기만 숨긴다.
   */
  const gridPreview = (() => {
    const w = Number(gridWidthPct);
    const m = Number(gridBuyMultiplier);
    if (!Number.isFinite(w) || w <= 0 || w > GRID_WIDTH_MAX_PCT) return null;
    if (!Number.isFinite(m) || m <= 0 || m > GRID_BUY_MULTIPLIER_MAX) return null;
    return {
      buy: (100 * (1 - w / 100)).toFixed(2),
      sell: (100 * (1 + w / 100)).toFixed(2),
      addQty: Math.floor(10 * m),
    };
  })();

  return (
    <View className="flex-1 bg-[#f2f4f6]">
      <BackHeader title="설정" />
      <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 48 }}>
        {section === 'account' && (
          <>
            <Panel title="계좌 연결">
              <View className="px-5 pb-5">
                <Text className="mb-1 text-xs text-[#8b95a1]">AppKey</Text>
                <TextInput
                  value={appKey}
                  onChangeText={setAppKey}
                  placeholder="KIS AppKey"
                  placeholderTextColor="#8b95a1"
                  autoCapitalize="none"
                  autoCorrect={false}
                  className="mb-4 rounded-2xl border border-[#e5e8eb] px-4 py-3 text-base text-[#191f28]"
                />

                <View className="mb-1 flex-row items-center justify-between">
                  <Text className="text-xs text-[#8b95a1]">AppSecret</Text>
                  {hasSavedAppSecret && (
                    <View className="rounded-full bg-[#e6f4ea] px-2 py-0.5">
                      <Text className="text-[11px] font-semibold text-[#03b26c]">저장돼 있어요</Text>
                    </View>
                  )}
                </View>
                <TextInput
                  value={appSecret}
                  onChangeText={setAppSecret}
                  placeholder={hasSavedAppSecret ? '●●●●●● 저장돼 있어요 · 바꾸려면 새로 입력하세요' : 'KIS AppSecret'}
                  placeholderTextColor="#8b95a1"
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry
                  className="mb-4 rounded-2xl border border-[#e5e8eb] px-4 py-3 text-base text-[#191f28]"
                />

                <Text className="mb-1 text-xs text-[#8b95a1]">계좌번호 (8-2 형식)</Text>
                <TextInput
                  value={accountNoInput}
                  onChangeText={setAccountNoInput}
                  placeholder="예: 12345678-01"
                  placeholderTextColor="#8b95a1"
                  keyboardType="numbers-and-punctuation"
                  autoCapitalize="none"
                  autoCorrect={false}
                  className="mb-2 rounded-2xl border border-[#e5e8eb] px-4 py-3 text-base text-[#191f28]"
                />

                <Pressable
                  onPress={handleIssueToken}
                  className="mt-4 items-center justify-center rounded-2xl bg-[#191f28] active:opacity-80"
                  style={{ minHeight: 52 }}
                >
                  <Text className="text-base font-semibold text-white">
                    {tokenStatus.kind === 'checking' ? '발급 중이에요…' : '토큰 발급'}
                  </Text>
                </Pressable>

                {tokenStatus.kind === 'success' && (
                  <View className="mt-3 items-center rounded-2xl bg-[#e6f4ea] py-2">
                    <Text className="text-sm font-medium text-[#03b26c]">
                      연결됐어요 · 만료 {formatHHmm(tokenStatus.expiresAt)}
                    </Text>
                  </View>
                )}
                {tokenStatus.kind === 'failure' && (
                  <View className="mt-3 rounded-2xl bg-[#fdecee] px-3 py-2">
                    <Text className="text-sm text-[#f04452]">연결하지 못했어요: {tokenStatus.reason}</Text>
                  </View>
                )}
              </View>
            </Panel>

            <Panel title="거래 모드">
              <View className="px-5 pb-5">
                <Text className="text-sm text-[#4e5968]">
                  실전(LIVE) 전용이에요 — 모의투자는 KIS가 시세·순위 API를 지원하지 않아 쓸 수 없어요.
                </Text>
              </View>
            </Panel>
          </>
        )}

        {section === 'params' && (
          <>
            <Panel title="시뮬레이션">
              <View className="px-5 pb-5">
                <ToggleRow
                  title="시뮬레이션 모드"
                  description="자동 단타의 주문을 KIS로 보내지 않고 실시세로만 모의 체결해요"
                  value={simulationMode}
                  onValueChange={setSimulationMode}
                  className="flex-row items-center justify-between rounded-2xl bg-[#f7f9fc] px-3 py-2 active:opacity-80"
                />
                <Text className="mt-2 text-xs leading-5 text-[#8b95a1]">
                  수동 단타 카드는 이 설정과 무관하게 항상 실거래예요. 변경은 자동 단타를 정지한 뒤 단타 탭에
                  다시 들어가면 적용돼요. 시뮬 결과(전략별 탈출 시간·물타기·최대 투입)는 Supabase에 쌓여요.
                </Text>
              </View>
            </Panel>

            <Panel title="매매 파라미터">
              <View className="px-5 pb-5">
                <Text className="mb-1 text-xs text-[#8b95a1]">주문 수량</Text>
                <TextInput
                  value={orderQty}
                  onChangeText={setOrderQty}
                  keyboardType="number-pad"
                  className="mb-4 rounded-2xl border border-[#e5e8eb] px-4 py-3 text-base text-[#191f28]"
                />

                <Text className="mb-1 text-xs text-[#8b95a1]">그리드 폭 (%) — 최대 {GRID_WIDTH_MAX_PCT}</Text>
                <TextInput
                  value={gridWidthPct}
                  onChangeText={setGridWidthPct}
                  keyboardType="decimal-pad"
                  placeholder="예: 10"
                  placeholderTextColor="#8b95a1"
                  className="mb-1 rounded-2xl border border-[#e5e8eb] px-4 py-3 text-base text-[#191f28]"
                />
                <Text className="mb-4 text-xs leading-5 text-[#8b95a1]">
                  평단 ±이 %에 매도·매수 지정가를 걸어요.
                  {gridPreview && (
                    <Text className="text-[#4e5968]">
                      {' '}평단 $100이면 매수 ${gridPreview.buy} · 매도 ${gridPreview.sell}에 걸려요.
                    </Text>
                  )}
                </Text>

                <Text className="mb-1 text-xs text-[#8b95a1]">
                  매수 배율 — 최대 {GRID_BUY_MULTIPLIER_MAX}
                </Text>
                <TextInput
                  value={gridBuyMultiplier}
                  onChangeText={setGridBuyMultiplier}
                  keyboardType="decimal-pad"
                  placeholder="예: 1"
                  placeholderTextColor="#8b95a1"
                  className="mb-1 rounded-2xl border border-[#e5e8eb] px-4 py-3 text-base text-[#191f28]"
                />
                <Text className="mb-1 text-xs leading-5 text-[#8b95a1]">
                  물타기 매수는 보유수량 × 이 배율만큼 발주해요.
                  {gridPreview && (
                    <Text className="text-[#4e5968]">
                      {' '}10주를 갖고 있으면 {gridPreview.addQty}주를 더 사서 총 {10 + gridPreview.addQty}주가 돼요.
                    </Text>
                  )}
                </Text>
                <Text className="mb-4 text-xs leading-5 text-[#8b95a1]">
                  배율을 1로 두면 물타기마다 수량이 2배가 돼요. 0.5로 낮추면 1.5배씩 늘어나요.
                </Text>

                <View className="mb-4 rounded-2xl bg-[#f2f4f6] px-4 py-3">
                  <Text className="text-xs leading-5 text-[#4e5968]">
                    폭·배율은 <Text className="font-semibold text-[#191f28]">다음에 새로 여는 그리드부터</Text>{' '}
                    적용돼요. 지금 돌고 있는 그리드는 이미 주문이 접수돼 있어서 그대로 관리돼요.
                  </Text>
                </View>

                <SettingSlider
                  label="리샘플 청크 (초)"
                  value={chunkSeconds}
                  onChange={setChunkSeconds}
                  min={1}
                  max={10}
                  step={1}
                  formatValue={(v) => `${v}초`}
                  helper="이 시간 동안의 평균가 하나로 묶어서 봐요. 권장 2~5초 — 짧을수록 민감하고, 길수록 노이즈가 줄어요."
                />

                <SettingSlider
                  label="버퍼 크기 (칸)"
                  value={bufferSize}
                  onChange={setBufferSize}
                  min={BUFFER_MIN}
                  max={BUFFER_MAX}
                  step={BUFFER_STEP}
                  formatValue={(v) => `${v}칸`}
                  helper="변곡점을 볼 때 함께 보는 청크 개수예요. 홀수만 고를 수 있어요 — 권장 15~31, 클수록 안정적이지만 신호가 늦어요."
                />

                <View className="mb-4 rounded-2xl bg-[#f2f4f6] px-4 py-3">
                  <Text className="text-xs text-[#4e5968]">
                    지금 설정이면 변곡점을 <Text className="font-semibold text-[#191f28]">약 {signalLagSeconds}초</Text> 뒤에
                    알아채요 (버퍼 {bufferSize}칸 × 청크 {chunkSeconds}초 기준).
                  </Text>
                  <Text className="mt-1 text-xs text-[#8b95a1]">
                    짧을수록 바닥·고점에 가깝게 잡지만 헛신호가 늘어요. 20~30초 안쪽을 권해요.
                  </Text>
                </View>

                <SettingSlider
                  label="매수 모멘텀 문턱 (%)"
                  value={momentumThresholdPct}
                  onChange={setMomentumThresholdPct}
                  min={0}
                  max={0.05}
                  step={0.005}
                  formatValue={(v) => `${v}%`}
                  helper="변곡점 뒤 상승 힘이 이 값 이상일 때만 매수해요. 권장 0.005~0.02 — 0.03부터는 확실한 추세에서만 매수해요."
                  offAtZero
                />

                <SettingSlider
                  label="매도 모멘텀 문턱 (%)"
                  value={sellMomentumThresholdPct}
                  onChange={setSellMomentumThresholdPct}
                  min={0}
                  max={0.03}
                  step={0.003}
                  formatValue={(v) => `${v}%`}
                  helper="권장 0.003~0.02 — 낮을수록 빨리 팔아요. 얕은 눌림은 잠깐 지켜보다 힘이 실릴 때 팔아요. 0이면 변곡점에서 바로 팔아요."
                  offAtZero
                />

                <SettingSlider
                  label="매수 거래량 스파이크 (배수)"
                  value={buyVolumeSpikeRatio}
                  onChange={setBuyVolumeSpikeRatio}
                  min={0}
                  max={3}
                  step={0.1}
                  formatValue={(v) => `${v.toFixed(1)}배`}
                  helper="최근 거래량이 과거 평균의 이 배수 이상일 때만 매수해요. 권장 1.5~2 — 3에 가까울수록 드문 폭증에서만 매수해요. 매도에는 영향이 없어요."
                  offAtZero
                />

                <SettingSlider
                  label="매수 체결강도 문턱"
                  value={buyStrengthThreshold}
                  onChange={setBuyStrengthThreshold}
                  min={0}
                  max={200}
                  step={10}
                  formatValue={(v) => String(v)}
                  helper="체결강도가 이 값 이상일 때만 매수해요 (100이 매수·매도 균형). 권장 80~150 — 150을 넘기면 기회가 많이 줄어요. 매도에는 영향이 없어요."
                  offAtZero
                />

                <SettingSlider
                  label="거래 수수료율 (편도, %)"
                  value={commissionRatePct}
                  onChange={setCommissionRatePct}
                  min={0}
                  max={0.3}
                  step={0.005}
                  formatValue={(v) => `${v}%`}
                  helper="매수·매도 체결대금에 각각 이만큼 수수료를 빼서 손익을 계산해요. 왕복이면 두 번 빠져요. 증권사 앱에서 해외주식 온라인 수수료를 확인해 넣어 주세요. 0이면 빼지 않아요."
                  offAtZero
                />

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
          </>
        )}
      </ScrollView>
      <BottomMenu items={MENU_ITEMS} value={section} onChange={setSection} />
    </View>
  );
}
