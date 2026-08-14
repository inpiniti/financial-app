// 종목 상세화면 "호가" 탭 — 옛 QuoteSheet(수동 카드)·WatchQuoteSheet(자동 리스트)를 통합한 유일한 호가 뷰.
// 데이터는 useQuoteFeed(상세화면이 직접 acquireFeed한 실시간 구독)에서 받는다 — 카드/슬롯 여부와 무관하게 동작.
// 1호가·잔량은 체결가(HDFSCNT0) 페이로드에서 온다(별도 호가 TR 구독 없음) — 1호가·스프레드·수신 진단 중심 UI.
import { Text, View } from 'react-native';
import type { ScalperManager } from '../../scalper/scalperManager';
import { formatHHMM, formatPrice } from '../../scalper/ui/format';
import type { QuoteFeedState } from '../useQuoteFeed';

export interface QuotePanelProps {
  /** null이면(KIS 키 미설정 등 부트스트랩 실패) 구독을 못 한 상태 — 안내만 표시한다. */
  manager: ScalperManager | null;
  state: QuoteFeedState;
  trKey: string | null;
}

const WARN_COLOR = '#ff9500';
const ERROR_COLOR = '#f04452';
const NEUTRAL_COLOR = '#8b95a1';
const PRIMARY_COLOR = '#191f28';
/** 호가는 매도1호가(높은 쪽)=상승 관례 색, 매수1호가(낮은 쪽)=하락 관례 색 — pnlColor와 동일한 톤 배정. */
const ASK_COLOR = '#f04452';
const BID_COLOR = '#3182f6';

function SectionLabel({ children }: { children: string }) {
  return <Text className="text-xs font-semibold text-[#8b95a1]">{children}</Text>;
}

/** 구독 상태 1줄 — 성공/실패/응답없음 3분기(QuoteSheet 시절 문구 그대로). */
function SubscriptionLine({
  label,
  trKey,
  trId,
  manager,
}: {
  label: string;
  trKey: string;
  trId?: string;
  manager: ScalperManager;
}) {
  const status = manager.getSubscriptionStatus(trKey, trId);
  const text = !status
    ? '응답 없음'
    : status.success
      ? `구독 성공 · ${formatHHMM(status.at)}`
      : `구독 실패 · ${status.message || '알 수 없음'}`;
  const color = !status ? NEUTRAL_COLOR : status.success ? PRIMARY_COLOR : ERROR_COLOR;

  return (
    <View className="mt-2 flex-row items-center justify-between">
      <Text className="text-sm text-[#4e5968]">
        {label} <Text className="text-xs text-[#8b95a1]">· {trKey}</Text>
      </Text>
      <Text className="text-sm font-semibold" style={{ color }}>
        {text}
      </Text>
    </View>
  );
}

export function QuotePanel({ manager, state, trKey }: QuotePanelProps) {
  if (!manager || !trKey) {
    return (
      <View className="flex-1 items-center justify-center bg-white px-8">
        <Text className="text-center text-base font-semibold text-[#191f28]">
          실시간 호가를 받을 수 없어요
        </Text>
        <Text className="mt-1 text-center text-sm text-[#8b95a1]">
          설정 탭에서 KIS 키를 등록한 뒤 다시 들어와 주세요
        </Text>
      </View>
    );
  }

  const now = Date.now();
  const secondsSinceLastQuote =
    state.lastQuoteAt !== null ? Math.max(0, Math.floor((now - state.lastQuoteAt) / 1000)) : null;

  const spread = state.ask1 !== null && state.bid1 !== null ? state.ask1 - state.bid1 : null;
  const spreadPct = spread !== null && state.bid1 ? (spread / state.bid1) * 100 : null;

  return (
    <View className="flex-1 bg-white">
      <View className="px-5 pb-4 pt-4">
        <SectionLabel>구독 상태</SectionLabel>
        <SubscriptionLine label="체결가" trKey={trKey} manager={manager} />
      </View>

      <View className="px-5 pb-4 pt-4" style={{ borderTopWidth: 1, borderTopColor: '#f2f4f6' }}>
        <SectionLabel>호가 현황</SectionLabel>

        <View className="mt-3 items-center">
          <Text className="text-xs text-[#8b95a1]">매도1호가</Text>
          <Text className="text-2xl font-bold" style={{ color: ASK_COLOR }}>
            {formatPrice(state.ask1)}
          </Text>
          <Text className="text-xs text-[#8b95a1]">
            {state.askVol1 !== null ? `${state.askVol1.toLocaleString()}주` : '—'}
          </Text>
        </View>

        <View className="items-center py-2">
          <Text className="text-xs text-[#8b95a1]">
            {spread !== null
              ? `스프레드 $${spread.toFixed(2)} · ${(spreadPct ?? 0).toFixed(2)}%`
              : '스프레드 — (양쪽 호가가 아직 없어요)'}
          </Text>
        </View>

        <View className="items-center">
          <Text className="text-xs text-[#8b95a1]">매수1호가</Text>
          <Text className="text-2xl font-bold" style={{ color: BID_COLOR }}>
            {formatPrice(state.bid1)}
          </Text>
          <Text className="text-xs text-[#8b95a1]">
            {state.bidVol1 !== null ? `${state.bidVol1.toLocaleString()}주` : '—'}
          </Text>
        </View>

        {state.quoteCount === 0 ? (
          <Text className="mt-3 text-center text-xs font-semibold" style={{ color: WARN_COLOR }}>
            호가가 아직 안 들어와요 — 장 시간이 아니거나 구독이 거절됐을 수 있어요
          </Text>
        ) : (
          <Text className="mt-3 text-center text-xs" style={{ color: NEUTRAL_COLOR }}>
            {state.quoteCount}건 · 마지막 {secondsSinceLastQuote ?? 0}초 전
          </Text>
        )}
      </View>

      <View className="px-5 pb-6 pt-4" style={{ borderTopWidth: 1, borderTopColor: '#f2f4f6' }}>
        <SectionLabel>체결가</SectionLabel>
        <View className="mt-2 flex-row items-center justify-between">
          <Text className="text-lg font-bold text-[#191f28]">{formatPrice(state.price)}</Text>
          <Text className="text-xs" style={{ color: NEUTRAL_COLOR }}>
            {state.tickCount > 0 ? `${state.tickCount}틱 수신` : '수신 전'}
          </Text>
        </View>
      </View>
    </View>
  );
}
