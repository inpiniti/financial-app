// 종목 상세화면 상단 간략 가격정보 — 원화 환산가 크게 + 달러 원가 작게, 아래에 전일 대비.
// 진입 시 현재가상세(HHDFS76200200) 1회 조회로 전일종가(base)·당일환율(t_rate)을 얻고,
// 이후 실시간 체결가(livePrice, useQuoteFeed)가 오면 그 값으로 원화가·대비를 다시 계산한다.
// 대비/등락률은 응답의 t_xdif/t_xrat(부호가 t_xsgn에 분리돼 있어 헷갈림) 대신 last·base·t_rate로 직접 계산한다.
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { inquireOverseasPriceDetail, type OverseasPriceDetail } from '../../../kis/priceDetail';
import { useKisSession } from '../../inquiry/useKisSession';
import { formatKrw, formatSignedKrw, formatUsd, pnlColor } from '../../../lib/format';
import type { StockMarketCode } from '../marketCodes';

export interface PriceHeaderProps {
  ticker: string;
  excd: StockMarketCode;
  /** useQuoteFeed의 실시간 체결가(USD) — 아직 수신 전이면 null. */
  livePrice: number | null;
}

type DetailState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; detail: OverseasPriceDetail };

function SkeletonLine({ width, height }: { width: number; height: number }) {
  return <View className="rounded-full bg-[#f7f9fc]" style={{ width, height }} />;
}

export function PriceHeader({ ticker, excd, livePrice }: PriceHeaderProps) {
  const sessionState = useKisSession(0);
  const [state, setState] = useState<DetailState>({ kind: 'loading' });

  useEffect(() => {
    if (sessionState.kind === 'error' || sessionState.kind === 'needsSetup') {
      setState({ kind: 'error' });
      return;
    }
    if (sessionState.kind !== 'ready') return;

    let cancelled = false;
    (async () => {
      try {
        const detail = await inquireOverseasPriceDetail(
          sessionState.session.credentials,
          sessionState.session.accessToken,
          { excd, symb: ticker },
        );
        if (!cancelled) setState({ kind: 'ready', detail });
      } catch {
        if (!cancelled) setState({ kind: 'error' });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionState, excd, ticker]);

  if (state.kind === 'loading') {
    return (
      <View className="bg-white px-5 pb-3 pt-1">
        <SkeletonLine width={140} height={26} />
        <View style={{ height: 6 }} />
        <SkeletonLine width={180} height={14} />
      </View>
    );
  }

  if (state.kind === 'error') {
    // 상세 조회 실패 — 실시간 체결가라도 있으면 달러가만 보여주고, 없으면 조용히 숨긴다.
    if (livePrice === null) return null;
    return (
      <View className="bg-white px-5 pb-3 pt-1">
        <Text className="text-[22px] font-bold text-[#191f28]">{formatUsd(livePrice)}</Text>
      </View>
    );
  }

  const { detail } = state;
  const base = Number(detail.base);
  const rate = Number(detail.t_rate);
  const usd = livePrice ?? Number(detail.last);

  if (!Number.isFinite(usd)) return null;

  const krw = Number.isFinite(rate) && rate > 0 ? usd * rate : null;
  const diffUsd = Number.isFinite(base) && base > 0 ? usd - base : null;
  const diffKrw = diffUsd !== null && krw !== null ? diffUsd * rate : null;
  const diffPct = diffUsd !== null ? (diffUsd / base) * 100 : null;

  return (
    <View className="bg-white px-5 pb-3 pt-1">
      <View className="flex-row items-baseline">
        <Text className="text-[22px] font-bold text-[#191f28]">
          {krw !== null ? formatKrw(krw) : formatUsd(usd)}
        </Text>
        {krw !== null ? <Text className="ml-2 text-[13px] text-[#8b95a1]">{formatUsd(usd)}</Text> : null}
      </View>
      {diffKrw !== null && diffPct !== null ? (
        <Text className="mt-0.5 text-[13px] text-[#8b95a1]">
          지난 정규장보다{' '}
          <Text className="font-semibold" style={{ color: pnlColor(diffKrw) }}>
            {formatSignedKrw(diffKrw)} ({Math.abs(diffPct).toFixed(1)}%)
          </Text>
        </Text>
      ) : null}
    </View>
  );
}
