// 리스트 행 공통 원형 아바타 — 트레이딩뷰 로고가 있으면 로고(SVG), 없거나 로드 실패면 기존 이니셜 폴백.
// (보유종목/미체결/순위/오늘 거래/단타 카드/자동 단타 리스트에서 재사용 — 로고 도메인 plan §2-4.)
//
// SvgUri 대신 SVG 텍스트를 직접 받아 SvgXml로 그린다 — 트레이딩뷰 로고 일부는 viewBox가 없어
// SvgUri로는 스케일링이 안 되고 좌상단에 쏠린다(ensureViewBox로 보정). 받은 텍스트는 메모리에 캐시해
// 리스트 스크롤(행 재마운트)마다 재요청하지 않는다.
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { avatarColorFor, avatarInitial } from '../lib/format';
import { logoUriFor, subscribeLogos } from '../lib/logoStore';
import { ensureViewBox } from '../lib/tradingviewLogos';

export interface TickerAvatarProps {
  ticker: string;
  size?: number;
}

// URL → 보정된 SVG 텍스트 캐시(세션 한정). 'FAILED'는 재시도 방지 마커.
const svgCache = new Map<string, string | 'FAILED'>();
const inFlight = new Map<string, Promise<string | 'FAILED'>>();

async function loadSvg(uri: string): Promise<string | 'FAILED'> {
  const cached = svgCache.get(uri);
  if (cached !== undefined) return cached;
  let pending = inFlight.get(uri);
  if (!pending) {
    pending = (async () => {
      try {
        const res = await fetch(uri);
        if (!res.ok) throw new Error(String(res.status));
        const xml = ensureViewBox(await res.text());
        svgCache.set(uri, xml);
        return xml;
      } catch {
        svgCache.set(uri, 'FAILED');
        return 'FAILED' as const;
      } finally {
        inFlight.delete(uri);
      }
    })();
    inFlight.set(uri, pending);
  }
  return pending;
}

export function TickerAvatar({ ticker, size = 40 }: TickerAvatarProps) {
  const [xml, setXml] = useState<string | null>(null);

  // 로고 맵은 앱 시작 직후엔 비어 있다가 캐시/조회로 채워진다 — 교체 통지 때 다시 조회한다.
  useEffect(() => {
    let cancelled = false;
    const resolve = () => {
      const uri = logoUriFor(ticker);
      if (!uri) {
        if (!cancelled) setXml(null);
        return;
      }
      void loadSvg(uri).then((result) => {
        if (!cancelled) setXml(result === 'FAILED' ? null : result);
      });
    };
    setXml(null);
    resolve();
    const unsub = subscribeLogos(resolve);
    return () => {
      cancelled = true;
      unsub();
    };
  }, [ticker]);

  if (xml) {
    return (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          overflow: 'hidden',
          backgroundColor: '#f2f4f6',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <SvgXml xml={xml} width={size} height={size} />
      </View>
    );
  }

  const { bg, fg } = avatarColorFor(ticker);
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: bg,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ color: fg, fontSize: size * 0.42, fontWeight: '700' }}>{avatarInitial(ticker)}</Text>
    </View>
  );
}
