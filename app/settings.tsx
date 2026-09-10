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
import { Ionicons } from '@expo/vector-icons';
import { BackHeader } from '../components/BackHeader';
import { Panel } from '../components/Panel';
import {
  DEFAULT_APP_SETTINGS,
  loadAppSettings,
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
  // 엔진 옵션(2026-09-03 ADR 0012) — 전략과 별개로 중복 선택. 반영은 전략과 같은 규약(앱 재시작).
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
      setEntrySizingMode(appSettings.entryQty > 0 ? 'qty' : 'amount');
      setMaxPriceUsd(appSettings.maxPriceUsd > 0 ? String(appSettings.maxPriceUsd) : '');
      setMinPriceUsd(appSettings.minPriceUsd > 0 ? String(appSettings.minPriceUsd) : '');
      setMinTickRatePerMin(String((appSettings.minTickRate * 60).toFixed(1)));
      setWatchCount(appSettings.watchCount);
      setMaxConcurrentGrids(appSettings.maxConcurrentGrids);
      setRankingDraft(draftFromSelection(appSettings.rankingSelection));
      const loadedEntry = appSettings.entryStrategy ?? appSettings.engineMode ?? 'martingale';
      const loadedExit = appSettings.exitStrategy ?? appSettings.engineMode ?? 'martingale';
      const forceRealtimeMa5 = loadedEntry === 'realtimeMa5' || loadedExit === 'realtimeMa5';
      const initEntry = forceRealtimeMa5 ? 'realtimeMa5' : loadedEntry;
      const initExit = forceRealtimeMa5 ? 'realtimeMa5' : loadedExit;
      setEntryStrategy(initEntry);
      savedEntryStrategyRef.current = initEntry;
      setExitStrategy(initExit);
      savedExitStrategyRef.current = initExit;
      setEngineOptions(appSettings.engineOptions);
      savedEngineOptionsRef.current = appSettings.engineOptions;
      setBbDipConfig(appSettings.bbDipConfig ?? DEFAULT_BBDIP_CONFIG);
      savedBbDipConfigRef.current = appSettings.bbDipConfig ?? DEFAULT_BBDIP_CONFIG;
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
      const normalizedEntryStrategy: EntryStrategy =
        entryStrategy === 'realtimeMa5' || exitStrategy === 'realtimeMa5' ? 'realtimeMa5' : entryStrategy;
      const normalizedExitStrategy: ExitStrategy = normalizedEntryStrategy === 'realtimeMa5' ? 'realtimeMa5' : exitStrategy;

      await saveAppSettings({
        environment: 'live',
        entryStrategy: normalizedEntryStrategy,
        exitStrategy: normalizedExitStrategy,
        engineMode: normalizedEntryStrategy, // 하위 호환 유지
        engineOptions,
        bbDipConfig,
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
      const bbDipChanged = JSON.stringify(bbDipConfig) !== JSON.stringify(savedBbDipConfigRef.current);
      const strategyChanged =
        normalizedEntryStrategy !== savedEntryStrategyRef.current ||
        normalizedExitStrategy !== savedExitStrategyRef.current ||
        optionsChanged ||
        bbDipChanged;
      savedEntryStrategyRef.current = normalizedEntryStrategy;
      savedExitStrategyRef.current = normalizedExitStrategy;
      if (entryStrategy !== normalizedEntryStrategy) setEntryStrategy(normalizedEntryStrategy);
      if (exitStrategy !== normalizedExitStrategy) setExitStrategy(normalizedExitStrategy);
      savedEngineOptionsRef.current = engineOptions;
      savedBbDipConfigRef.current = bbDipConfig;
      Alert.alert(
        '알림',
        strategyChanged
          ? '설정을 저장했어요. 진입/청산 전략·옵션은 앱을 완전히 종료했다가 다시 켜면 적용돼요 — 보유·미체결이 없는 상태에서 바꾸는 걸 권해요.'
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

        {/* 진입 전략 패널(2026-09-04 분리) */}
        <Panel title="진입 전략">
          <View className="px-5 pb-5">
            <Text className="mb-3 text-xs leading-5 text-[#8b95a1]">
              어떤 신호에서 매수 진입할지 골라요. 저장한 뒤 <Text className="font-semibold text-[#191f28]">앱을 완전히 종료했다가 다시 켜면</Text>{' '}
              적용돼요 — 보유·미체결이 없는 상태에서 바꾸는 걸 권해요.
            </Text>
            {realtimeMa5Dedicated && (
              <View className="mb-3 rounded-2xl border border-[#bfdbfe] bg-[#eff6ff] px-4 py-3">
                <Text className="text-xs leading-5 text-[#1d4ed8]">
                  실시간 MA5 단타는 현재 선택된 진입 전략입니다. 진입 전략 자체는 이 화면에서 고정 표시만 하고, 매도 전략은 독립적으로 잠금 여부를 판단합니다.
                </Text>
              </View>
            )}
            {(
              [
                {
                  value: 'bbDip' as const,
                  title: '볼린저 하단 투매 반등 (기본)',
                  desc: `20틱 볼린저 밴드 하단 -${Math.abs(DEFAULT_BBDIP_CONFIG.dipThreshold * 100).toFixed(1)}% 이하 투매 이탈 + 10초 가격 기울기 +${DEFAULT_BBDIP_CONFIG.s10Min}% 반등 + 틱속도 ${DEFAULT_BBDIP_CONFIG.minRm}건/분 + 체결강도 +${(DEFAULT_BBDIP_CONFIG.minFr * 100).toFixed(0)}% 충족 시 매수 진입`,
                },
                {
                  value: 'martingale' as const,
                  title: '5선 돌파',
                  desc: `${MARTINGALE_BAR_MINUTES}분봉 종가가 5선(최근 5봉 평균)을 아래→위로 뚫는 순간 매수 진입 (진입 필터는 아래 옵션으로)`,
                },
                {
                  value: 'model' as const,
                  title: '예측 모델',
                  desc: `${MODEL_BAR_MINUTES}분봉 지표 33개로 "+3%가 −3%보다 먼저 올 확률"을 계산해 상위 1% 기준값을 넘으면 매수 진입`,
                },
                {
                  value: 'slope' as const,
                  title: '기울기 돌파',
                  desc: `리스트의 10초 가격 변화율(기울기)이 +${SLOPE_CONFIG.entryPct}% 이상으로 올라서는 순간 즉시 매수 진입`,
                },
                {
                  value: 'realtimeMa5' as const,
                  title: '실시간 MA5 단타',
                  desc: `현재틱이 직전 MA5를 상향 돌파하면서 기울기가 상승하면 매수. 기본값은 ${DEFAULT_REALTIME_MA5_CONFIG.orderQty}주·익절 +${(DEFAULT_REALTIME_MA5_CONFIG.sellTargetMultiplier - 1) * 100}%·물타기 낙폭 ${DEFAULT_REALTIME_MA5_CONFIG.averagingDownThresholdPct}% 이하`,
                },
              ]
            ).map((opt) => {
              const selected = entryStrategy === opt.value;
              return (
                <Pressable
                  key={opt.value}
                  onPress={() => {
                    setEntryStrategy(opt.value);
                    if (opt.value === 'realtimeMa5') setExitStrategy('realtimeMa5');
                  }}
                  className={`mb-2 rounded-2xl border px-4 py-3 ${selected ? 'border-[#3182f6] bg-[#f2f7ff]' : 'border-[#e5e8eb] bg-white'}`}
                >
                  <View className="flex-row items-center justify-between">
                    <Text className={`text-sm font-semibold ${selected ? 'text-[#3182f6]' : 'text-[#191f28]'}`}>
                      {opt.title}
                    </Text>
                    {selected && <Text className="text-xs font-semibold text-[#3182f6]">선택됨</Text>}
                  </View>
                  <Text className="mt-1 text-xs leading-5 text-[#8b95a1]">{opt.desc}</Text>
                </Pressable>
              );
            })}

            {/* 진입 필터 옵션(중복 선택) */}
            <Text className="mb-1 mt-4 text-xs font-semibold text-[#191f28]">진입 필터 옵션 (중복 선택)</Text>
            <Text className="mb-3 text-xs leading-5 text-[#8b95a1]">
              어느 진입 전략을 골랐든 함께 걸려요. {MARTINGALE_BAR_MINUTES}분봉 이동평균(5·20·60·120) 기준 진입 조건이며 체크한 조건이 전부 맞아야 사요.
            </Text>
            {(
              [
                { key: 'ordered' as const, title: '정배열', desc: '5선 > 20선 > 60선 > 120선일 때만' },
                { key: 'ma5Up' as const, title: '5선만 상승', desc: '5선이 직전 봉보다 오르는 중일 때만' },
                { key: 'allUp' as const, title: '5·20·60·120 모두 상승', desc: '네 선이 전부 직전 봉보다 오르는 중일 때만' },
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

        {/* 청산 전략 패널(2026-09-04 분리) */}
        <Panel title="청산 전략">
          <View className="px-5 pb-5">
            <Text className="mb-3 text-xs leading-5 text-[#8b95a1]">
              보유 포지션을 어떻게 익절/손절하고 마감할지 골라요. 저장한 뒤 <Text className="font-semibold text-[#191f28]">앱을 완전히 종료했다가 다시 켜면</Text>{' '}
              적용돼요.
            </Text>
            {realtimeMa5SellLocked && (
              <View className="mb-3 rounded-2xl border border-[#bfdbfe] bg-[#eff6ff] px-4 py-3">
                <Text className="text-xs leading-5 text-[#1d4ed8]">
                  실시간 MA5 익절·물타기 모드에서는 매도 주문 전략은 고정돼 있고, 매수 전략은 별도로 선택할 수 있어요.
                </Text>
              </View>
            )}
            {(
              [
                {
                  value: 'bbDip' as const,
                  title: 'MA20 중심선 회귀 · 맞춤 대칭 청산 (기본)',
                  desc: `20틱 중심선(MA20) 도달 즉시 전량 익절 · +${(DEFAULT_BBDIP_CONFIG.takeProfitPct * 100).toFixed(1)}% 목표 익절 · +${(DEFAULT_BBDIP_CONFIG.trailingTriggerPct * 100).toFixed(1)}% 트레일링 · -${(DEFAULT_BBDIP_CONFIG.stopLossPct * 100).toFixed(1)}% 칼손절`,
                },
                {
                  value: 'martingale' as const,
                  title: '+3% 익절 · 마감 청산',
                  desc: `평단보다 +${Math.round(MARTINGALE_CONFIG.tpPct * 100)}% 오르면 전량 익절, 안 닿으면 ${Math.floor(MARTINGALE_CONFIG.closeAtMin / 60)}:${String(MARTINGALE_CONFIG.closeAtMin % 60).padStart(2, '0')} ET 마감 전량 청산 (손절 없음)`,
                },
                {
                  value: 'model' as const,
                  title: '±3% 대칭 밴드 · 래칫',
                  desc: `+${Math.round(MODEL_SYMMETRIC_EXIT_CONFIG.tpPct * 100)}% 익절 / −${Math.round(MODEL_SYMMETRIC_EXIT_CONFIG.stopLossPct * 100)}% 손절(동적 래칫 방어) · 최장 ${MODEL_SYMMETRIC_EXIT_CONFIG.maxHoldMin}분 만기 청산`,
                },
                {
                  value: 'slope' as const,
                  title: '기울기 하락 즉시 매도',
                  desc: `리스트의 10초 기울기가 +${SLOPE_CONFIG.exitPct}% 아래로 내려오거나 끊기면 조건 없이 즉시 전량 매도 (익절·손절·마감청산 없음)`,
                },
                {
                  value: 'realtimeMa5' as const,
                  title: '실시간 MA5 익절·물타기',
                  desc: `평단 × ${DEFAULT_REALTIME_MA5_CONFIG.sellTargetMultiplier} 목표가를 걸고, 낙폭 ${DEFAULT_REALTIME_MA5_CONFIG.averagingDownThresholdPct}% 이하에서 상승 기울기와 돌파가 맞으면 추가 매수`,
                },
              ]
            ).map((opt) => {
              const selected = exitStrategy === opt.value;
              return (
                <Pressable
                  key={opt.value}
                  onPress={() => setExitStrategy(opt.value)}
                  className={`mb-2 rounded-2xl border px-4 py-3 ${selected ? 'border-[#3182f6] bg-[#f2f7ff]' : 'border-[#e5e8eb] bg-white'}`}
                >
                  <View className="flex-row items-center justify-between">
                    <Text className={`text-sm font-semibold ${selected ? 'text-[#3182f6]' : 'text-[#191f28]'}`}>
                      {opt.title}
                    </Text>
                    {selected && <Text className="text-xs font-semibold text-[#3182f6]">선택됨</Text>}
                  </View>
                  <Text className="mt-1 text-xs leading-5 text-[#8b95a1]">{opt.desc}</Text>
                </Pressable>
              );
            })}

            {/* 청산/포지션 옵션: 물타기 */}
            <Text className="mb-1 mt-4 text-xs font-semibold text-[#191f28]">포지션 옵션</Text>
            <Text className="mb-3 text-xs leading-5 text-[#8b95a1]">
              보유 중 선택한 진입 신호가 다시 왔을 때, 평단보다 −{Math.round(MARTINGALE_CONFIG.dropStartPct * 100)}% 넘게 내려가 있으면 추가 매수해요.
            </Text>
            {(() => {
              const on = engineOptions.martingale;
              return (
                <Pressable
                  onPress={() => setEngineOptions({ ...engineOptions, martingale: !on })}
                  className={`mb-2 flex-row items-center rounded-2xl border px-4 py-3 ${on ? 'border-[#3182f6] bg-[#f2f7ff]' : 'border-[#e5e8eb] bg-white'}`}
                >
                  <View
                    className={`mr-3 h-5 w-5 items-center justify-center rounded-md border ${on ? 'border-[#3182f6] bg-[#3182f6]' : 'border-[#d1d6db] bg-white'}`}
                  >
                    {on && <Text className="text-xs font-bold text-white">✓</Text>}
                  </View>
                  <View className="flex-1">
                    <Text className={`text-sm font-semibold ${on ? 'text-[#3182f6]' : 'text-[#191f28]'}`}>(k−1)배 물타기</Text>
                    <Text className="mt-0.5 text-xs leading-5 text-[#8b95a1]">
                      평단 −k%(k≥{Math.round(MARTINGALE_CONFIG.dropStartPct * 100)})에서 진입 신호면 보유량 ×(k−1) 추가 매수 · 상한 −{Math.round(MARTINGALE_CONFIG.dropMaxPct * 100)}%
                    </Text>
                  </View>
                </Pressable>
              );
            })()}
          </View>
        </Panel>

        {/* 볼린저 반등 세부 설정 (BB Dip) 패널 — 진입 또는 청산 전략이 bbDip일 때 활성화 */}
        {(entryStrategy === 'bbDip' || exitStrategy === 'bbDip') && (
          <BbDipDetailPanel config={bbDipConfig} onChange={setBbDipConfig} />
        )}

        {/* 진입 전략 고정값 안내 패널 (bbDip 외 고정값 전략일 때) */}
        {entryStrategy !== 'bbDip' && (
          <Panel
            title={`진입 전략: ${
              entryStrategy === 'martingale'
                ? '5선 돌파'
                : entryStrategy === 'model'
                  ? '예측 모델'
                  : entryStrategy === 'realtimeMa5'
                    ? '실시간 MA5 단타'
                    : '기울기 돌파'
            } (고정값)`}
          >
            <View className="px-5 pb-5">
              {entryStrategy === 'martingale' ? (
                <>
                  <Text className="mb-3 text-xs leading-5 text-[#8b95a1]">
                    진입은 {MARTINGALE_BAR_MINUTES}분봉 5선 돌파가 정해요. 진입 조건 필터는 위 옵션에서 골라요. 아래 값은 설계 고정값이라 여기서 바꿀 수 없어요.
                  </Text>
                  <View className="mb-1 flex-row items-center justify-between">
                    <Text className="text-xs text-[#8b95a1]">진입 규칙</Text>
                    <Text className="text-sm font-semibold text-[#191f28]">5선 돌파{describeFilters(engineOptions)}</Text>
                  </View>
                  <Text className="text-xs leading-5 text-[#8b95a1]">
                    {MARTINGALE_BAR_MINUTES}분봉 종가가 5선(최근 5봉 평균)을 아래에서 위로 뚫는 봉에 사요{engineOptions.ordered || engineOptions.ma5Up || engineOptions.allUp ? ' — 위에서 체크한 조건이 그 봉에서 함께 맞아야 해요' : ''}. 봉이 닫히기를 기다리지 않고 진행 중 봉을 현재가로 넣어 실시간으로 판단해요(봉당 1회). 프리·정규·애프터에서만 진입하고 주간거래 시간엔 쉬어요.
                  </Text>
                </>
              ) : entryStrategy === 'model' ? (
                <>
                  <Text className="mb-3 text-xs leading-5 text-[#8b95a1]">
                    진입은 LightGBM 예측 모델이 결정해요. 아래 값은 설계 고정값이라 여기서 바꿀 수 없어요.
                  </Text>
                  <View className="mb-1 flex-row items-center justify-between">
                    <Text className="text-xs text-[#8b95a1]">진입 규칙</Text>
                    <Text className="text-sm font-semibold text-[#191f28]">모델 확률 ≥ 상위 1% 기준값</Text>
                  </View>
                  <Text className="text-xs leading-5 text-[#8b95a1]">
                    {MODEL_BAR_MINUTES}분봉이 닫힐 때마다 리스트 전 종목에 대해 "+3%가 −3%보다 먼저 올 확률"을 지표 33개로 계산해요. 3년 반치 과거에서 상위 1%에 해당하는 값을 넘어야 사요. 정규장·그날 거래대금 $2M 이상·주가 $1 초과 종목만 봐요.
                  </Text>
                </>
              ) : entryStrategy === 'realtimeMa5' ? (
                <>
                  <Text className="mb-3 text-xs leading-5 text-[#8b95a1]">
                    진입은 실시간 MA5 단타 규칙이 결정해요. 현재 선택된 진입 전략은 이 값으로 고정 표시됩니다.
                  </Text>
                  <View className="mb-1 flex-row items-center justify-between">
                    <Text className="text-xs text-[#8b95a1]">진입 규칙</Text>
                    <Text className="text-sm font-semibold text-[#191f28]">현재 틱이 직전 MA5를 상향 돌파 + 기울기 상승</Text>
                  </View>
                  <Text className="text-xs leading-5 text-[#8b95a1]">
                    현재가가 직전 5틱 평균을 상향 돌파하면서 동시에 기울기가 상승 중일 때 사요. 실시간 MA5는 매도 타이밍과 물타기 규칙이 함께 내부에서 관리돼요.
                  </Text>
                </>
              ) : (
                <>
                  <Text className="mb-3 text-xs leading-5 text-[#8b95a1]">
                    진입은 10초간 가격 변화율(기울기)이 결정해요. 아래 값은 설계 고정값이라 여기서 바꿀 수 없어요.
                  </Text>
                  <View className="mb-1 flex-row items-center justify-between">
                    <Text className="text-xs text-[#8b95a1]">진입 규칙</Text>
                    <Text className="text-sm font-semibold text-[#191f28]">기울기 ≥ +{SLOPE_CONFIG.entryPct}%</Text>
                  </View>
                  <Text className="text-xs leading-5 text-[#8b95a1]">
                    체결 틱이 올 때마다 다시 재서, 10초 기울기가 +{SLOPE_CONFIG.entryPct}% 아래에서 이상으로 올라서는 순간 즉시 사요. 봉·이동평균 조건은 없으며 매수는 신호 순간 현재가로 내요.
                  </Text>
                </>
              )}
            </View>
          </Panel>
        )}

        {/* 청산 전략 고정값 안내 패널 (bbDip 외 고정값 전략일 때) */}
        {exitStrategy !== 'bbDip' && (
          <Panel
            title={`청산 전략: ${
              exitStrategy === 'martingale'
                ? '+3% 익절 · 마감 청산'
                : exitStrategy === 'model'
                  ? '±3% 대칭 밴드 · 래칫'
                  : exitStrategy === 'realtimeMa5'
                    ? '실시간 MA5 익절·물타기'
                    : '기울기 하락 즉시 매도'
            } (고정값)`}
          >
            <View className="px-5 pb-5">
              {exitStrategy === 'martingale' ? (
                <>
                  <Text className="mb-3 text-xs leading-5 text-[#8b95a1]">
                    매도는 +3% 익절선과 마감 시각이 정해요. 물타기 여부는 위 옵션에서 골라요.
                  </Text>
                  <View className="mb-1 flex-row items-center justify-between">
                    <Text className="text-xs text-[#8b95a1]">익절 및 마감</Text>
                    <Text className="text-sm font-semibold text-[#191f28]">+{Math.round(MARTINGALE_CONFIG.tpPct * 100)}% 익절 · {Math.floor(MARTINGALE_CONFIG.closeAtMin / 60)}:{String(MARTINGALE_CONFIG.closeAtMin % 60).padStart(2, '0')} ET 마감</Text>
                  </View>
                  <Text className="mb-3 text-xs leading-5 text-[#8b95a1]">
                    평단보다 +{Math.round(MARTINGALE_CONFIG.tpPct * 100)}% 오르면 전량 익절해요. 안 닿으면 {Math.floor(MARTINGALE_CONFIG.closeAtMin / 60)}:{String(MARTINGALE_CONFIG.closeAtMin % 60).padStart(2, '0')} ET에 전량 청산해요 — 손절은 없으며 다음 날로 들고 가지 않아요.
                  </Text>
                  <View className="mb-1 flex-row items-center justify-between">
                    <Text className="text-xs text-[#8b95a1]">물타기 동작</Text>
                    <Text className="text-sm font-semibold text-[#191f28]">
                      {engineOptions.martingale ? `평단 −${Math.round(MARTINGALE_CONFIG.dropStartPct * 100)}% 아래 진입 신호 → (k−1)배` : '없음(옵션 꺼짐)'}
                    </Text>
                  </View>
                  <Text className="text-xs leading-5 text-[#8b95a1]">
                    {engineOptions.martingale
                      ? `보유 중 현재가가 평단보다 −${Math.round(MARTINGALE_CONFIG.dropStartPct * 100)}% 이상 내려간 상태에서 진입 신호가 오면 추가로 사요. 낙폭 k%(내림)면 지금 보유량의 (k−1)배가 추가 매수됩니다.`
                      : '옵션에서 (k−1)배 물타기를 체크하면 보유 중 진입 신호에서 낙폭 배수로 추가 매수해요. 지금은 단일 포지션만 유지해요.'}
                  </Text>
                </>
              ) : exitStrategy === 'model' ? (
                <>
                  <Text className="mb-3 text-xs leading-5 text-[#8b95a1]">
                    매도는 ±3% 대칭 밴드와 동적 래칫, 그리고 120분 만기 청산이 정해요.
                  </Text>
                  <View className="mb-1 flex-row items-center justify-between">
                    <Text className="text-xs text-[#8b95a1]">밴드 & 래칫</Text>
                    <Text className="text-sm font-semibold text-[#191f28]">익절 +{Math.round(MODEL_SYMMETRIC_EXIT_CONFIG.tpPct * 100)}% / 손절 −{Math.round(MODEL_SYMMETRIC_EXIT_CONFIG.stopLossPct * 100)}%</Text>
                  </View>
                  <Text className="mb-3 text-xs leading-5 text-[#8b95a1]">
                    산 가격보다 +3% 오르면 익절, −3% 내리면 손절해요. 익절선에 닿는 순간 모델이 여전히 상승 우위면 밴드를 그 자리 기준 ±3%로 올려 달아(래칫) 수익을 극대화해요.
                  </Text>
                  <View className="mb-1 flex-row items-center justify-between">
                    <Text className="text-xs text-[#8b95a1]">시간 청산</Text>
                    <Text className="text-sm font-semibold text-[#191f28]">최장 {MODEL_SYMMETRIC_EXIT_CONFIG.maxHoldMin}분 만기</Text>
                  </View>
                  <Text className="text-xs leading-5 text-[#8b95a1]">
                    산 지 {MODEL_SYMMETRIC_EXIT_CONFIG.maxHoldMin}분이 지나도 밴드에 닿지 않으면 전량 매도해요. 봉 마감을 기다리지 않고 체결가가 닿는 즉시 판단해요.
                  </Text>
                </>
              ) : exitStrategy === 'realtimeMa5' ? (
                <>
                  <Text className="mb-3 text-xs leading-5 text-[#8b95a1]">
                    매도는 실시간 MA5 익절·물타기 규칙이 결정해요. 이 모드에서는 매도 전략이 내부 규칙으로 고정됩니다.
                  </Text>
                  <View className="mb-1 flex-row items-center justify-between">
                    <Text className="text-xs text-[#8b95a1]">청산 조건</Text>
                    <Text className="text-sm font-semibold text-[#191f28]">평단 × {DEFAULT_REALTIME_MA5_CONFIG.sellTargetMultiplier} 목표가 + 낙폭 재진입</Text>
                  </View>
                  <Text className="text-xs leading-5 text-[#8b95a1]">
                    평단 대비 {DEFAULT_REALTIME_MA5_CONFIG.sellTargetMultiplier}배 목표가에 닿으면 익절하고, 낙폭 {DEFAULT_REALTIME_MA5_CONFIG.averagingDownThresholdPct}% 이하에서 상승 기울기와 돌파가 맞으면 추가 매수해요. 이 규칙은 별도 주문 전략과는 독립적으로 동작합니다.
                  </Text>
                </>
              ) : (
                <>
                  <Text className="mb-3 text-xs leading-5 text-[#8b95a1]">
                    매도는 10초간 가격 변화율(기울기) 하락이 결정해요.
                  </Text>
                  <View className="mb-1 flex-row items-center justify-between">
                    <Text className="text-xs text-[#8b95a1]">청산 조건</Text>
                    <Text className="text-sm font-semibold text-[#191f28]">기울기 &lt; +{SLOPE_CONFIG.exitPct}% → 즉시 전량</Text>
                  </View>
                  <Text className="text-xs leading-5 text-[#8b95a1]">
                    보유 중 기울기가 +{SLOPE_CONFIG.exitPct}% 아래로 내려오면 수익이든 손실이든 보지 않고 그 자리에서 즉시 전량 매도해요. 체결 틱마다 및 {SLOPE_EXIT_TICK_MS}ms마다 다시 재며, 10초 넘게 체결이 끊겨도 팔아요. 익절·손절·마감 청산은 없어요.
                  </Text>
                </>
              )}
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
              disabled={exitStrategy === 'realtimeMa5'}
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
