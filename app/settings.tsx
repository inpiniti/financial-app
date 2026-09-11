// 설정 화면 — 상단바 "설정" 버튼으로 진입. 매매 파라미터 전용이다(계좌 연결·잔고는 app/account.tsx).
// 2026-08-12: 옛 설정 화면의 하단 메뉴(계좌연결|매매파라미터)를 없애고 두 화면으로 쪼갰다. 같은 정리에서
// 트레이딩 화면 시트에 있던 운용 설정(진입금액·동시 그리드·최소 속도)을 "트레이딩 설정" 패널로 흡수했다 —
// 흩어져 있던 매매 관련 값을 한 화면에서 다 보게 하려는 것이다.
//
// 저장은 전부 AsyncStorage(lib/appSettings)로만 간다. 실제 매매 엔진 반영은 managerProvider가
// 트레이딩 화면 포커스마다 하며, 저장 직후에도 캐시 매니저가 있으면 즉시 반영된다.
import { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import Slider from '@react-native-community/slider';
import { Ionicons } from '@expo/vector-icons';
import { BackHeader } from '../components/BackHeader';
import { Panel } from '../components/Panel';
import {
  DEFAULT_APP_SETTINGS,
  loadAppSettings,
  normalizeStrategyPair,
  saveAppSettings,
  snapToStep,
  type EntryStrategy,
  type ExitStrategy,
} from '../lib/appSettings';
import { MAX_GRIDS_LIMIT, WATCH_COUNT_LIMIT } from '../features/scalper/autopilot';
import { MODEL_BAR_MINUTES } from '../features/scalper/modelMode';
import { MARTINGALE_BAR_MINUTES } from '../features/scalper/martingaleMode';
import { MARTINGALE_CONFIG } from '../core/martingale';
import { SLOPE_CONFIG, SLOPE_EXIT_TICK_MS } from '../core/slope';
import { DEFAULT_BBDIP_CONFIG, type BbDipConfig } from '../core/bbDip';
import { DEFAULT_REALTIME_MA5_CONFIG } from '../core/realtime-ma5';
import { DEFAULT_ENGINE_OPTIONS, type EngineOptions } from '../features/scalper/engineMode';
import { ORDER_PRICING_LABEL, type OrderPricing } from '../features/scalper/orderStrategy';
import { MODEL_SYMMETRIC_EXIT_CONFIG } from '../core/model/exitRule';
import { refreshCachedManagerSettings } from '../features/scalper/ui/managerProvider';
import {
  RankingSelectionPanel,
  draftFromSelection,
  selectionFromDraft,
  type RankingSelectionDraft,
} from '../features/scalper/ui/RankingSelectionPanel';
import { normalizeRankingSelection, validateRankingSelection } from '../core/ranking';

/** 주문 전략 카드 3장 + (시간 취소일 때) 취소 대기 슬라이더 — 매수·매도가 같은 컴포넌트를 쓴다(ADR 0013). */
function OrderStrategyPicker(props: {
  title: string;
  side: 'buy' | 'sell';
  value: OrderPricing;
  onChange: (v: OrderPricing) => void;
  cancelAfterSec: number;
  onCancelAfterSecChange: (v: number) => void;
  disabled?: boolean;
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
        const disabled = !!props.disabled;
        return (
          <Pressable
            key={opt.value}
            onPress={() => {
              if (disabled) return;
              props.onChange(opt.value);
            }}
            className={`mb-2 rounded-2xl border px-4 py-3 ${selected ? 'border-[#3182f6] bg-[#f2f7ff]' : 'border-[#e5e8eb] bg-white'} ${disabled ? 'opacity-50' : ''}`}
          >
            <View className="flex-row items-center justify-between">
              <Text className={`text-sm font-semibold ${selected ? 'text-[#3182f6]' : disabled ? 'text-[#8b95a1]' : 'text-[#191f28]'}`}>
                {ORDER_PRICING_LABEL[opt.value]}
              </Text>
              {selected ? (
                <Text className="text-xs font-semibold text-[#3182f6]">선택됨</Text>
              ) : disabled ? (
                <Text className="text-[11px] font-semibold text-[#8b95a1]">고정됨</Text>
              ) : null}
            </View>
            <Text className={`mt-1 text-xs leading-5 ${disabled ? 'text-[#96a2ae]' : 'text-[#8b95a1]'}`}>{opt.desc}</Text>
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

/** 종목당 진입금액 상한(USD) — 오타 하나(100 → 10000)가 그대로 발주 금액이 된다. */
const START_AMOUNT_MAX_USD = 100_000;
const DEFAULT_MIN_TICK_RATE_PER_MIN = DEFAULT_APP_SETTINGS.minTickRate * 60;
const FIXED_ENTRY_STRATEGY: EntryStrategy = 'realtimeMa5';
const FIXED_EXIT_STRATEGY: ExitStrategy = 'realtimeMa5';
const FIXED_ENGINE_OPTIONS: EngineOptions = { ordered: false, ma5Up: false, allUp: false, martingale: false };
const FIXED_BUY_STRATEGY: OrderPricing = 'lastChase';
const FIXED_SELL_STRATEGY: OrderPricing = 'lastChase';

type EntrySizingMode = 'amount' | 'qty';

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
  helper?: string;
  offAtZero?: boolean;
  color?: string;
}) {
  const tint = props.color ?? '#3182f6';
  const off = (props.offAtZero ?? false) && props.value <= 0;
  return (
    <View className="mb-3">
      {props.label !== '' && (
        <View className="mb-1 flex-row items-center justify-between">
          <Text className="text-xs text-[#8b95a1]">{props.label}</Text>
          <Text
            className="text-sm font-semibold"
            style={{ color: off ? '#8b95a1' : tint }}
          >
            {off ? '꺼짐' : props.formatValue(props.value)}
          </Text>
        </View>
      )}
      <Slider
        value={props.value}
        onValueChange={(v) => props.onChange(snapToStep(v, props.min, props.max, props.step))}
        minimumValue={props.min}
        maximumValue={props.max}
        step={props.step}
        minimumTrackTintColor={tint}
        maximumTrackTintColor="#e5e8eb"
        thumbTintColor={tint}
        style={{ height: 36 }}
      />
      <View className="flex-row items-center justify-between">
        <Text className="text-[11px] text-[#8b95a1]">
          {props.offAtZero ? '0 (꺼짐)' : props.formatValue(props.min)}
        </Text>
        <Text className="text-[11px] text-[#8b95a1]">{props.formatValue(props.max)}</Text>
      </View>
      {props.helper ? <Text className="mt-1 text-xs leading-4 text-[#8b95a1]">{props.helper}</Text> : null}
    </View>
  );
}

/** 볼린저 하단 투매 반등 & 맞춤 대칭 청산 엔진 세부 조절 패널 (financial-lab 최적 파라미터 기반) */
function BbDipDetailPanel(props: {
  config: BbDipConfig;
  onChange: (next: BbDipConfig) => void;
}) {
  const { config, onChange } = props;

  return (
    <Panel title="볼린저 반등 세부 설정 (BB Dip)">
      <View className="px-5 pb-5">
        <Text className="mb-4 text-xs leading-5 text-[#8b95a1]">
          백테스트 시뮬레이션(Lab)에서 검증된 최적 파라미터를 실전 매매에 맞추어 세세하게 조절해요. 저장 후{' '}
          <Text className="font-semibold text-[#191f28]">앱을 완전히 종료했다가 다시 켜면</Text> 적용돼요.
        </Text>

        {/* 1. 진입 조건 (BUY) */}
        <View className="mb-4 rounded-2xl border border-[#e5e8eb] bg-[#f9fafb] p-4">
          <View className="mb-3 flex-row items-center justify-between border-b border-[#e5e8eb] pb-2">
            <View className="flex-row items-center">
              <View className="mr-1.5 h-2.5 w-2.5 rounded-full bg-[#10b981]" />
              <Text className="text-sm font-bold text-[#191f28]">진입 조건 (BUY)</Text>
            </View>
            <View className="rounded-md bg-[#e6fcf5] px-2 py-0.5">
              <Text className="text-[11px] font-semibold text-[#0ca678]">4대 필터 동시만족</Text>
            </View>
          </View>

          {/* 1) 최소 체결강도 */}
          <SettingSlider
            label="최소 체결강도 (FlowRatio)"
            value={Math.round(config.minFr * 100)}
            onChange={(v) => onChange({ ...config, minFr: Number((v / 100).toFixed(2)) })}
            min={-10}
            max={30}
            step={1}
            formatValue={(v) => `+${v}% (${100 + v}%)`}
            helper={`매수세가 매도세보다 ${Math.round(config.minFr * 100)}% 이상 우위일 때만 진입`}
            color="#10b981"
          />

          {/* 2) 최소 틱속도 */}
          <SettingSlider
            label="최소 틱속도 (RPM)"
            value={config.minRm}
            onChange={(v) => onChange({ ...config, minRm: v })}
            min={10}
            max={100}
            step={5}
            formatValue={(v) => `${v}건/분 (${(v / 60).toFixed(2)}건/초)`}
            helper={`호가 거래가 분당 ${config.minRm}건 이상 활발하게 체결되는 종목만`}
            color="#10b981"
          />

          {/* 3) 볼린저 하단 이탈률 */}
          <SettingSlider
            label="볼린저 하단 이탈률 (BB Dip)"
            value={Number((config.dipThreshold * 100).toFixed(1))}
            onChange={(v) => onChange({ ...config, dipThreshold: Number((v / 100).toFixed(4)) })}
            min={-1.5}
            max={-0.1}
            step={0.1}
            formatValue={(v) => `${v.toFixed(1)}% 이하 급락`}
            helper={`현재가 ≤ BB하단 × ${(1 + config.dipThreshold).toFixed(4)} (극단 투매 과매도)`}
            color="#0284c7"
          />

          {/* 4) 10초 가격 기울기 반등 */}
          <SettingSlider
            label="10초 가격 기울기 반등 (s10)"
            value={Number(config.s10Min.toFixed(2))}
            onChange={(v) => onChange({ ...config, s10Min: Number(v.toFixed(2)) })}
            min={0.01}
            max={0.20}
            step={0.01}
            formatValue={(v) => `s10 > +${v.toFixed(2)}%`}
            helper="바닥을 터치한 후 직전 10초간 양의 기울기로 첫 반등 확인"
            color="#0284c7"
          />
        </View>

        {/* 2. 청산 엔진 (SELL) */}
        <View className="rounded-2xl border border-[#e5e8eb] bg-[#f9fafb] p-4">
          <View className="mb-3 flex-row items-center justify-between border-b border-[#e5e8eb] pb-2">
            <View className="flex-row items-center">
              <Ionicons name="shield-checkmark" size={16} color="#f43f5e" style={{ marginRight: 4 }} />
              <Text className="text-sm font-bold text-[#191f28]">청산 엔진 (SELL)</Text>
            </View>
            <View className="rounded-md bg-[#fff1f2] px-2 py-0.5">
              <Text className="text-[11px] font-semibold text-[#f43f5e]">스마트 청산</Text>
            </View>
          </View>

          {/* 1순위: MA20 중심선 회귀 익절 */}
          <Pressable
            onPress={() => onChange({ ...config, exitOnMa20: config.exitOnMa20 === false })}
            className="mb-3 rounded-xl border border-[#fef3c7] bg-[#fffbeb] p-3 active:opacity-80"
          >
            <View className="flex-row items-center justify-between">
              <View className="flex-1 flex-row items-center">
                <View className="mr-2 h-5 w-5 items-center justify-center rounded-full bg-[#f59e0b]">
                  <Text className="text-xs font-bold text-white">1</Text>
                </View>
                <Text className="text-xs font-bold text-[#b45309]">핵심 대칭: MA20 중심선 회귀</Text>
              </View>
              <Ionicons
                name={config.exitOnMa20 !== false ? 'checkbox' : 'square-outline'}
                size={22}
                color={config.exitOnMa20 !== false ? '#f59e0b' : '#b0b8c1'}
              />
            </View>
            <Text className="mt-1 text-[11px] leading-4 text-[#92400e]">
              20틱 이동평균선(MA20) 도달 즉시 평균회귀 전량 익절 (price ≥ ma20)
            </Text>
          </Pressable>

          {/* 2순위: 목표 익절률 */}
          <View className="mb-3 rounded-xl border border-[#e5e8eb] bg-white p-3">
            <View className="mb-1 flex-row items-center justify-between">
              <View className="flex-row items-center">
                <View className="mr-2 h-5 w-5 items-center justify-center rounded-full bg-[#3b82f6]">
                  <Text className="text-xs font-bold text-white">2</Text>
                </View>
                <Text className="text-xs font-bold text-[#191f28]">목표 익절률</Text>
              </View>
              <Text className="text-sm font-bold text-[#3b82f6]">
                +{(config.takeProfitPct * 100).toFixed(1)}%
              </Text>
            </View>
            <SettingSlider
              label=""
              value={Number((config.takeProfitPct * 100).toFixed(1))}
              onChange={(v) => onChange({ ...config, takeProfitPct: Number((v / 100).toFixed(3)) })}
              min={0.5}
              max={3.0}
              step={0.1}
              formatValue={(v) => `+${v.toFixed(1)}%`}
              helper={`진입 평단가 대비 +${(config.takeProfitPct * 100).toFixed(1)}% 도달 시 즉시 전량 매도`}
              color="#3b82f6"
            />
          </View>

          {/* 3순위: 홈런 트레일링 */}
          <View className="mb-3 rounded-xl border border-[#e5e8eb] bg-white p-3">
            <View className="mb-1 flex-row items-center justify-between">
              <View className="flex-row items-center">
                <View className="mr-2 h-5 w-5 items-center justify-center rounded-full bg-[#10b981]">
                  <Text className="text-xs font-bold text-white">3</Text>
                </View>
                <Text className="text-xs font-bold text-[#191f28]">홈런 트레일링</Text>
              </View>
              <Text className="text-xs font-bold text-[#10b981]">
                +{(config.trailingTriggerPct * 100).toFixed(1)}% 발동 / -{(config.trailingDropPct * 100).toFixed(1)}% 반납
              </Text>
            </View>
            <View className="mt-2">
              <SettingSlider
                label="발동 상승률"
                value={Number((config.trailingTriggerPct * 100).toFixed(1))}
                onChange={(v) => onChange({ ...config, trailingTriggerPct: Number((v / 100).toFixed(3)) })}
                min={0.5}
                max={2.5}
                step={0.1}
                formatValue={(v) => `+${v.toFixed(1)}%`}
                color="#10b981"
              />
              <SettingSlider
                label="고점 반납폭"
                value={Number((config.trailingDropPct * 100).toFixed(1))}
                onChange={(v) => onChange({ ...config, trailingDropPct: Number((v / 100).toFixed(3)) })}
                min={0.1}
                max={1.0}
                step={0.1}
                formatValue={(v) => `${v.toFixed(1)}%`}
                color="#10b981"
                helper={`+${(config.trailingTriggerPct * 100).toFixed(1)}% 이상 폭등 후 최고점 대비 ${(config.trailingDropPct * 100).toFixed(1)}% 하락 시 익절`}
              />
            </View>
          </View>

          {/* 4순위: 본절 방어 */}
          <View className="mb-3 rounded-xl border border-[#e5e8eb] bg-white p-3">
            <View className="mb-1 flex-row items-center justify-between">
              <View className="flex-row items-center">
                <View className="mr-2 h-5 w-5 items-center justify-center rounded-full bg-[#8b5cf6]">
                  <Text className="text-xs font-bold text-white">4</Text>
                </View>
                <Text className="text-xs font-bold text-[#191f28]">본절 방어 (Breakeven)</Text>
              </View>
              <Text className="text-xs font-bold text-[#8b5cf6]">
                +{(config.breakevenTriggerPct * 100).toFixed(1)}% 터치 → +{((config.breakevenBufferPct ?? 0.0005) * 100).toFixed(2)}%
              </Text>
            </View>
            <View className="mt-2">
              <SettingSlider
                label="터치 기준"
                value={Number((config.breakevenTriggerPct * 100).toFixed(1))}
                onChange={(v) => onChange({ ...config, breakevenTriggerPct: Number((v / 100).toFixed(3)) })}
                min={0.3}
                max={1.5}
                step={0.1}
                formatValue={(v) => `+${v.toFixed(1)}%`}
                color="#8b5cf6"
              />
              <SettingSlider
                label="원금 보존선"
                value={Number(((config.breakevenBufferPct ?? 0.0005) * 100).toFixed(2))}
                onChange={(v) => onChange({ ...config, breakevenBufferPct: Number((v / 100).toFixed(4)) })}
                min={0.00}
                max={0.20}
                step={0.01}
                formatValue={(v) => `+${v.toFixed(2)}%`}
                color="#8b5cf6"
                helper={`+${(config.breakevenTriggerPct * 100).toFixed(1)}% 이상 터치 후 진입가 부근(+${((config.breakevenBufferPct ?? 0.0005) * 100).toFixed(2)}%)으로 밀리면 수수료 보존 매도`}
              />
            </View>
          </View>

          {/* 5순위: 조기 칼손절 */}
          <View className="rounded-xl border border-[#fee2e2] bg-[#fef2f2] p-3">
            <View className="mb-1 flex-row items-center justify-between">
              <View className="flex-row items-center">
                <View className="mr-2 h-5 w-5 items-center justify-center rounded-full bg-[#ef4444]">
                  <Text className="text-xs font-bold text-white">5</Text>
                </View>
                <Text className="text-xs font-bold text-[#991b1b]">조기 칼손절 (비상 탈출)</Text>
              </View>
              <Text className="text-sm font-bold text-[#ef4444]">
                -{(config.stopLossPct * 100).toFixed(1)}%
              </Text>
            </View>
            <SettingSlider
              label=""
              value={Number((config.stopLossPct * 100).toFixed(1))}
              onChange={(v) => onChange({ ...config, stopLossPct: Number((v / 100).toFixed(3)) })}
              min={0.3}
              max={2.0}
              step={0.1}
              formatValue={(v) => `-${v.toFixed(1)}%`}
              helper={`평단가 대비 -${(config.stopLossPct * 100).toFixed(1)}% 도달 시 어떤 조건보다 우선하여 즉시 전량 손절`}
              color="#ef4444"
            />
          </View>
        </View>
      </View>
    </Panel>
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
  const [entrySizingMode, setEntrySizingMode] = useState<EntrySizingMode>('amount');
  const [startAmountUsd, setStartAmountUsd] = useState(String(DEFAULT_APP_SETTINGS.startAmountUsd));
  // 진입 수량(2026-08-18) — 0/빈 칸 = 미설정(진입금액으로 계산). 지정하면 가격과 무관하게 이 수량만 산다.
  const [entryQty, setEntryQty] = useState('');
  // 리스트 가격 상한(2026-08-20 풀데이 시뮬) — 수량 모드에서만 쓰는 상한. 0/빈 칸 = 진입금액이 상한(옛 동작).
  const [maxPriceUsd, setMaxPriceUsd] = useState(String(DEFAULT_APP_SETTINGS.maxPriceUsd));
  // 가격 하한(2026-08-29 데스크탑에서 이식) — 빈 칸/0 = 없음. 초저가 급등주 편중 방어.
  const [minPriceUsd, setMinPriceUsd] = useState('');
  const [minTickRatePerMin, setMinTickRatePerMin] = useState(String(DEFAULT_MIN_TICK_RATE_PER_MIN));
  // 동시 그리드 수·매수 후보 수는 슬라이더(2026-08-30 데스크탑에서 이식) — 정수 범위가 좁아 입력창보다 슬라이더가 맞다.
  const [watchCount, setWatchCount] = useState<number>(DEFAULT_APP_SETTINGS.watchCount);
  const [maxConcurrentGrids, setMaxConcurrentGrids] = useState<number>(DEFAULT_APP_SETTINGS.maxConcurrentGrids);
  // 순위 선택(2026-08-18 순위 도메인) — 트레이딩 리스트 원천별 켬·개수·(한투) 기간창.
  const [rankingDraft, setRankingDraft] = useState<RankingSelectionDraft>(() =>
    draftFromSelection(normalizeRankingSelection(DEFAULT_APP_SETTINGS.rankingSelection)),
  );

  // 진입 전략 & 청산 전략(2026-09-04 분리) — 저장 후 앱을 완전히 껐다 켜야 반영된다(engineMode.ts).
  const [entryStrategy, setEntryStrategy] = useState<EntryStrategy>(DEFAULT_APP_SETTINGS.entryStrategy);
  const savedEntryStrategyRef = useRef<EntryStrategy>(DEFAULT_APP_SETTINGS.entryStrategy);
  const [exitStrategy, setExitStrategy] = useState<ExitStrategy>(DEFAULT_APP_SETTINGS.exitStrategy);
  const savedExitStrategyRef = useRef<ExitStrategy>(DEFAULT_APP_SETTINGS.exitStrategy);
  // 볼린저 투매 반등(BB Dip) 세부 설정
  const [bbDipConfig, setBbDipConfig] = useState<BbDipConfig>(DEFAULT_APP_SETTINGS.bbDipConfig);
  const savedBbDipConfigRef = useRef<BbDipConfig>(DEFAULT_APP_SETTINGS.bbDipConfig);
  // 실시간 MA5 설정은 현재 화면에서 수정하지 않는다 — 저장 스키마 필수 키를 유지하기 위해 로드값을 보존한다.
  const savedRealtimeMa5ConfigRef = useRef(DEFAULT_APP_SETTINGS.realtimeMa5Config);
  // 엔진 옵션(2026-09-03 ADR 0012) — 전략과 별개로 중복 선택. 반영은 전략과 같은 규약(앱 재시작).
  const [engineOptions, setEngineOptions] = useState<EngineOptions>(DEFAULT_ENGINE_OPTIONS);
  const savedEngineOptionsRef = useRef<EngineOptions>(DEFAULT_ENGINE_OPTIONS);

  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const appSettings = await loadAppSettings();
      savedOrderQtyRef.current = appSettings.orderQty;
      setBuyCancelAfterSec(0);
      setBuyStrategy(FIXED_BUY_STRATEGY);
      setSellStrategy(FIXED_SELL_STRATEGY);
      setSellCancelAfterSec(0);
      savedRollbackRef.current = {
        gridBuyWidthPct: appSettings.gridBuyWidthPct,
        gridSellWidthPct: appSettings.gridSellWidthPct,
        gridBuyMultiplier: appSettings.gridBuyMultiplier,
        entryLadderIntervalPct: appSettings.entryLadderIntervalPct,
        entryLadderCount: appSettings.entryLadderCount,
      };
      setStartAmountUsd(appSettings.startAmountUsd > 0 ? String(appSettings.startAmountUsd) : '');
      setEntryQty(appSettings.entryQty > 0 ? String(appSettings.entryQty) : '');
      setEntrySizingMode(appSettings.entryQty > 0 ? 'qty' : 'amount');
      setMaxPriceUsd(appSettings.maxPriceUsd > 0 ? String(appSettings.maxPriceUsd) : '');
      setMinPriceUsd(appSettings.minPriceUsd > 0 ? String(appSettings.minPriceUsd) : '');
      setMinTickRatePerMin(String((appSettings.minTickRate * 60).toFixed(1)));
      setWatchCount(appSettings.watchCount);
      setMaxConcurrentGrids(appSettings.maxConcurrentGrids);
      setRankingDraft(draftFromSelection(appSettings.rankingSelection));
      const normalized = normalizeStrategyPair(FIXED_ENTRY_STRATEGY, FIXED_EXIT_STRATEGY);
      const initEntry = normalized.entryStrategy;
      const initExit = normalized.exitStrategy;
      setEntryStrategy(initEntry);
      savedEntryStrategyRef.current = initEntry;
      setExitStrategy(initExit);
      savedExitStrategyRef.current = initExit;
      setEngineOptions(FIXED_ENGINE_OPTIONS);
      savedEngineOptionsRef.current = FIXED_ENGINE_OPTIONS;
      setBbDipConfig(appSettings.bbDipConfig ?? DEFAULT_BBDIP_CONFIG);
      savedBbDipConfigRef.current = appSettings.bbDipConfig ?? DEFAULT_BBDIP_CONFIG;
      savedRealtimeMa5ConfigRef.current = appSettings.realtimeMa5Config ?? DEFAULT_APP_SETTINGS.realtimeMa5Config;
    })();
  }, []);

  const handleSave = async () => {
    // 상한을 둔다 — 오타 하나(10 → 100)가 그대로 발주가에 들어가면 되돌릴 수 없다.
    const rawStartAmountUsd = Number(startAmountUsd);

    let parsedStartAmountUsd = rawStartAmountUsd;
    let parsedEntryQty = 0;
    if (entrySizingMode === 'amount') {
      if (!Number.isFinite(rawStartAmountUsd) || rawStartAmountUsd <= 0 || rawStartAmountUsd > START_AMOUNT_MAX_USD) {
        Alert.alert('알림', `진입금액은 0보다 크고 ${START_AMOUNT_MAX_USD.toLocaleString('en-US')} 이하인 달러 금액으로 입력해 주세요.`);
        return;
      }
      parsedEntryQty = 0;
    } else {
      // 수량 모드에서는 진입 수량이 필수다.
      const qty = Number(entryQty);
      if (!Number.isFinite(qty) || !Number.isInteger(qty) || qty < 1) {
        Alert.alert('알림', '수량 모드에서는 진입 수량을 1 이상의 정수로 입력해 주세요.');
        return;
      }
      parsedEntryQty = qty;
      // 내부 엔진은 startAmountUsd > 0 검증을 공유하므로 수량 모드에서도 기준 금액은 유지한다.
      parsedStartAmountUsd =
        Number.isFinite(rawStartAmountUsd) && rawStartAmountUsd > 0 && rawStartAmountUsd <= START_AMOUNT_MAX_USD
          ? rawStartAmountUsd
          : DEFAULT_APP_SETTINGS.startAmountUsd;
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

    const parsedMinTickRatePerMin = Number(minTickRatePerMin);
    if (!Number.isFinite(parsedMinTickRatePerMin) || parsedMinTickRatePerMin <= 0) {
      Alert.alert('알림', `최소 속도는 0보다 크게 입력해 주세요. (기본 ${DEFAULT_MIN_TICK_RATE_PER_MIN}틱/분)`);
      return;
    }
    const parsedMinTickRate = parsedMinTickRatePerMin / 60;

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
      const normalized = normalizeStrategyPair(FIXED_ENTRY_STRATEGY, FIXED_EXIT_STRATEGY);
      const normalizedEntryStrategy: EntryStrategy = normalized.entryStrategy;
      const normalizedExitStrategy: ExitStrategy = normalized.exitStrategy;

      await saveAppSettings({
        environment: 'live',
        entryStrategy: normalizedEntryStrategy,
        exitStrategy: normalizedExitStrategy,
        engineMode: normalized.engineMode, // 하위 호환 유지
        engineOptions: FIXED_ENGINE_OPTIONS,
        bbDipConfig: DEFAULT_BBDIP_CONFIG,
        realtimeMa5Config: savedRealtimeMa5ConfigRef.current,
        orderQty: savedOrderQtyRef.current,
        buyCancelAfterSec: 0,
        buyStrategy: FIXED_BUY_STRATEGY,
        sellStrategy: FIXED_SELL_STRATEGY,
        sellCancelAfterSec: 0,
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
      savedEntryStrategyRef.current = normalizedEntryStrategy;
      savedExitStrategyRef.current = normalizedExitStrategy;
      if (entryStrategy !== normalizedEntryStrategy) setEntryStrategy(normalizedEntryStrategy);
      if (exitStrategy !== normalizedExitStrategy) setExitStrategy(normalizedExitStrategy);
      savedEngineOptionsRef.current = FIXED_ENGINE_OPTIONS;
      savedBbDipConfigRef.current = DEFAULT_BBDIP_CONFIG;
      await refreshCachedManagerSettings().catch(() => {
        // 매니저 미생성/일시 오류는 저장 성공을 막지 않는다.
      });
      Alert.alert('알림', '설정을 저장했어요. 실시간 MA5 단일 전략으로 고정되어 동작해요.');
    } finally {
      setSaving(false);
    }
  };

  /** 첫 진입에 한 번에 들어갈 수 있는 최대 금액 — 진입금액 × 동시 그리드 수. */
    const exposure = (() => {
    const amount = Number(startAmountUsd);
    const grids = maxConcurrentGrids;
    if (entrySizingMode === 'qty') return null; // 고정 수량이면 금액 노출은 종목 가격에 달렸다.
    if (!Number.isFinite(amount) || amount <= 0) return null;
    if (!Number.isFinite(grids) || grids < 1) return null;
    return (amount * Math.min(Math.floor(grids), MAX_GRIDS_LIMIT)).toFixed(2);
  })();

  const realtimeMa5Dedicated = entryStrategy === 'realtimeMa5';
  const realtimeMa5SellLocked = exitStrategy === 'realtimeMa5';

  return (
    <View className="flex-1 bg-[#f2f4f6]">
      <BackHeader title="설정" />
      <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 48 }}>
        <Panel title="트레이딩 설정">
          <View className="px-5 pb-5">
            <Text className="mb-4 text-xs leading-5 text-[#8b95a1]">
              선택한 진입 전략 신호가 잡힐 때마다 종목에 진입하고, 진입한 종목은 청산 전략이 이어받아 관리해요.
              이미 보유 중인 종목은 다시 진입하지 않고(물타기 옵션 제외), 매도가 끝나면 그 자리에 새 종목이 들어와요.
            </Text>

            <Text className="mb-1 text-xs font-semibold text-[#191f28]">진입 크기 기준 (양자선택)</Text>
            <Text className="mb-3 text-xs leading-5 text-[#8b95a1]">
              진입금액과 수량 중 하나만 선택해 써요. 선택하지 않은 값은 저장만 유지되고, 실제 진입 계산에는 쓰지 않아요.
            </Text>
            <View className="mb-3 rounded-2xl border border-[#e5e8eb] bg-white p-2">
              <Pressable
                onPress={() => setEntrySizingMode('amount')}
                className={`mb-2 flex-row items-center rounded-xl border px-3 py-3 ${entrySizingMode === 'amount' ? 'border-[#3182f6] bg-[#f2f7ff]' : 'border-[#e5e8eb] bg-white'}`}
              >
                <View className={`mr-3 h-5 w-5 items-center justify-center rounded-full border ${entrySizingMode === 'amount' ? 'border-[#3182f6]' : 'border-[#d1d6db]'}`}>
                  {entrySizingMode === 'amount' ? <View className="h-2.5 w-2.5 rounded-full bg-[#3182f6]" /> : null}
                </View>
                <View className="flex-1">
                  <Text className={`text-sm font-semibold ${entrySizingMode === 'amount' ? 'text-[#3182f6]' : 'text-[#191f28]'}`}>진입금액 기준</Text>
                  <Text className="mt-0.5 text-xs text-[#8b95a1]">진입 수량 = floor(진입금액 ÷ 현재가)</Text>
                </View>
              </Pressable>
              <Pressable
                onPress={() => setEntrySizingMode('qty')}
                className={`flex-row items-center rounded-xl border px-3 py-3 ${entrySizingMode === 'qty' ? 'border-[#3182f6] bg-[#f2f7ff]' : 'border-[#e5e8eb] bg-white'}`}
              >
                <View className={`mr-3 h-5 w-5 items-center justify-center rounded-full border ${entrySizingMode === 'qty' ? 'border-[#3182f6]' : 'border-[#d1d6db]'}`}>
                  {entrySizingMode === 'qty' ? <View className="h-2.5 w-2.5 rounded-full bg-[#3182f6]" /> : null}
                </View>
                <View className="flex-1">
                  <Text className={`text-sm font-semibold ${entrySizingMode === 'qty' ? 'text-[#3182f6]' : 'text-[#191f28]'}`}>수량 기준</Text>
                  <Text className="mt-0.5 text-xs text-[#8b95a1]">종목 가격과 무관하게 고정 수량으로 진입</Text>
                </View>
              </Pressable>
            </View>

            <Text className={`mb-1 text-xs ${entrySizingMode === 'amount' ? 'text-[#8b95a1]' : 'text-[#b0b8c1]'}`}>진입금액 (USD) — 종목 하나를 살 때 쓰는 금액</Text>
            <TextInput
              value={startAmountUsd}
              onChangeText={setStartAmountUsd}
              keyboardType="decimal-pad"
              editable={entrySizingMode === 'amount'}
              placeholder={`기본 ${DEFAULT_APP_SETTINGS.startAmountUsd}`}
              placeholderTextColor="#8b95a1"
              className={`mb-4 rounded-2xl border px-4 py-3 text-base ${entrySizingMode === 'amount' ? 'border-[#e5e8eb] text-[#191f28] bg-white' : 'border-[#eceff2] text-[#8b95a1] bg-[#f8fafc]'}`}
            />

            <Text className={`mb-1 text-xs ${entrySizingMode === 'qty' ? 'text-[#8b95a1]' : 'text-[#b0b8c1]'}`}>수량 (주) — 수량 기준에서만 사용해요</Text>
            <TextInput
              value={entryQty}
              onChangeText={setEntryQty}
              keyboardType="number-pad"
              editable={entrySizingMode === 'qty'}
              placeholder="예: 1"
              placeholderTextColor="#8b95a1"
              className={`mb-1 rounded-2xl border px-4 py-3 text-base ${entrySizingMode === 'qty' ? 'border-[#e5e8eb] text-[#191f28] bg-white' : 'border-[#eceff2] text-[#8b95a1] bg-[#f8fafc]'}`}
            />
            <Text className="mb-4 text-xs leading-5 text-[#8b95a1]">
              수량 기준을 고르면 종목 가격과 상관없이 딱 이 수량만 사요($0.01짜리도 $9짜리도 같은 수량). 물타기도 이 수량씩 해요.
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
              최소 속도 (틱/분) — 이보다 조용한 종목은 매수 후보에서 빼요
            </Text>
            <TextInput
              value={minTickRatePerMin}
              onChangeText={setMinTickRatePerMin}
              keyboardType="decimal-pad"
              placeholder={`기본 ${DEFAULT_MIN_TICK_RATE_PER_MIN}`}
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

        <Panel title="전략 상태">
          <View className="px-5 pb-5">
            <Text className="mb-3 text-xs leading-5 text-[#8b95a1]">
              진입 전략, 진입 필터, 청산 전략, 포지션 옵션, 주문 전략 선택은 모두 제거했어요.
            </Text>
            <View className="rounded-2xl border border-[#bfdbfe] bg-[#eff6ff] px-4 py-3">
              <Text className="text-sm font-semibold text-[#1d4ed8]">실시간 MA5 단일 전략 고정</Text>
              <Text className="mt-1 text-xs leading-5 text-[#1d4ed8]">
                이전틱 &lt; 현재 MA5 &lt; 현재틱 돌파에서 즉시 매수하고, 보유 중에는 낙폭 조건에서 물타기 후 평단 기준 +3% 매도 주문을 바로 재등록해요.
              </Text>
            </View>
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
